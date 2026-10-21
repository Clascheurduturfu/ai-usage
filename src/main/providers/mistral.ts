import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsDir, existsFile, walkFiles } from '../paths'
import type { DB, UpsertEvent } from '../db'
import { JsonlParser, hashLine, parseJson, safeDate, scanJsonlFile } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

export function mistralRoot(settings: Pick<Settings, 'paths'>): string {
  return settings.paths.mistral ?? path.join(os.homedir(), '.vibe')
}

/** The plan info vibe itself caches in `<root>/whoami_cache.json` (latest entry). */
export function readMistralWhoamiCache(root: string): { planType: string; planName: string; storedAt: number } | null {
  try {
    // path.posix.join would collapse the UNC double slash — concatenate instead
    const r = root.replaceAll('\\', '/')
    const cachePath = r.endsWith('/') ? r + 'whoami_cache.json' : `${r}/whoami_cache.json`
    if (!existsFile(cachePath)) return null
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<
      string,
      { stored_at_timestamp?: number; payload?: { plan_type?: string; plan_name?: string } }
    >
    let best: { planType: string; planName: string; storedAt: number } | null = null
    for (const entry of Object.values(parsed)) {
      if (!entry?.payload) continue
      const storedAt = typeof entry.stored_at_timestamp === 'number' ? entry.stored_at_timestamp * 1000 : 0
      if (!best || storedAt > best.storedAt) {
        best = {
          planType: entry.payload.plan_type ?? 'unknown',
          planName: entry.payload.plan_name ?? 'unknown',
          storedAt
        }
      }
    }
    return best
  } catch {
    return null
  }
}

const SESSIONS_SUBDIR = path.join('logs', 'session')
const METADATA_FILE = 'meta.json'

interface MistralParserState {
  sessionId?: string
  project?: string
  model?: string
  fallbackTs?: number
  counter: number
}

interface MistralMeta {
  session_id?: string
  title?: string
  active_model?: string
  environment?: { working_directory?: string }
  created_at?: string
  started_at?: string
}

function readMeta(sessionDir: string): MistralMeta | null {
  const metaPath = path.join(sessionDir, METADATA_FILE)
  if (!existsFile(metaPath)) return null
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MistralMeta
  } catch {
    return null
  }
}

function messageTimestamp(obj: Record<string, unknown>): number | null {
  for (const key of ['timestamp', 'ts', 'created_at', 'time']) {
    if (key in obj) {
      const t = safeDate(obj[key])
      if (t !== null) return t
    }
  }
  return null
}

/**
 * Mistral Vibe CLI 2.x writes per-session folders under `~/.vibe/logs/session/`
 * with a `meta.json` (session id, title, active model, working directory) and
 * an append-only `messages.jsonl` transcript. Message records don't carry
 * token counts, so each user message becomes one request-kind event.
 */
export function createMistralParser(filePath: string, prior: MistralParserState | null): JsonlParser {
  const state: MistralParserState = prior ?? { counter: 0 }
  const events: UpsertEvent[] = []

  const sessionDir = path.dirname(filePath)
  if (!state.sessionId || !state.fallbackTs) {
    const meta = readMeta(sessionDir)
    if (meta) {
      state.sessionId = meta.session_id ?? path.basename(sessionDir)
      state.project = meta.environment?.working_directory ?? state.project
      state.model = meta.active_model ?? state.model
      state.fallbackTs =
        safeDate(meta.created_at) ?? safeDate(meta.started_at) ?? fs.statSync(sessionDir).mtimeMs
    } else {
      state.sessionId = path.basename(sessionDir)
      state.fallbackTs = fs.statSync(sessionDir).mtimeMs
    }
  }

  return {
    line(s: string): void {
      const obj = parseJson(s)
      if (!obj) return
      const role = typeof obj.role === 'string' ? obj.role : typeof obj.type === 'string' ? obj.type : null
      if (role !== 'user') return
      state.counter++
      const ts = messageTimestamp(obj) ?? state.fallbackTs ?? Date.now()
      events.push({
        id: `mistral:${state.sessionId}:${hashLine(s)}`,
        provider: 'mistral',
        ts,
        session_id: state.sessionId ?? null,
        project: state.project ?? null,
        model: state.model ?? null,
        kind: 'request',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: null,
        source_file: filePath,
        meta: null
      })
    },
    state: () => ({ ...state }),
    events: () => events,
    tools: () => [],
    snapshots: () => []
  }
}

export const mistralAdapter: ProviderAdapter = {
  id: 'mistral',
  watchRoots(settings) {
    return [{ path: mistralRoot(settings), recursive: true }]
  },
  status(settings) {
    const root = mistralRoot(settings)
    const sessionsDir = path.join(root, SESSIONS_SUBDIR)
    const installed = existsDir(root) && (existsFile(path.join(root, 'config.toml')) || existsDir(sessionsDir))
    return {
      status: installed ? 'ok' : 'no-data',
      path: sessionsDir,
      note: installed
        ? undefined
        : 'Mistral Vibe CLI is not installed. Install it from docs.mistral.ai (uv tool install mistral-vibe), run `vibe` once, and this page will light up.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const sessionsDir = path.join(mistralRoot(settings), SESSIONS_SUBDIR)
    for (const file of walkFiles(sessionsDir, (p) => p.endsWith('messages.jsonl'))) {
      try {
        const r = scanJsonlFile(db, 'mistral', file, (prior) =>
          createMistralParser(file, prior as MistralParserState | null)
        )
        if (!r.skipped) outcome.filesScanned++
        outcome.eventsAdded += r.added
      } catch (err) {
        outcome.errors.push(`mistral: ${path.basename(path.dirname(file))}: ${(err as Error).message}`)
      }
    }
    return outcome
  }
}
