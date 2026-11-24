import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsDir, existsFile, walkFiles } from '../paths'
import { deleteFileData, getFileIndex, saveFileIndex, upsertEvents, type DB, type UpsertEvent } from '../db'
import { JsonlParser, hashLine, n, parseJson, safeDate, scanJsonlFile } from './jsonl'
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

/**
 * Mistral Vibe 3.x (CLI and the Vibe desktop app, which runs the same engine and shares `~/.vibe`)
 * stores sessions in the unified harness format: `logs/session/unified/<id>/`, with `meta.json`
 * (cwd, model) and `generations/<n>/projection-state.json`, whose `snapshot.session.tokenUsage`
 * is the session's running total (input including cached input, output, cached input). Per-call
 * records exist only in a journal pruned to its last two segments, so AI Usage records how much the
 * total grew since its last scan, dated when the session last changed. After a reindex the whole
 * total comes back as one event.
 */
const UNIFIED = 'unified'
type Totals = { input: number; output: number; cached: number; seq: number }

function latestProjection(sessionDir: string): string | null {
  const generations = path.join(sessionDir, 'generations')
  try {
    const current = fs.readFileSync(path.join(sessionDir, 'CURRENT'), 'utf8').match(/\d{6,}/)?.[0]
    if (current && existsFile(path.join(generations, current, 'projection-state.json'))) return path.join(generations, current, 'projection-state.json')
  } catch { /* fall back to the newest generation */ }
  let names: string[] = []
  try { names = fs.readdirSync(generations).filter(name => /^\d+$/.test(name)).sort().reverse() } catch { return null }
  for (const name of names) { const file = path.join(generations, name, 'projection-state.json'); if (existsFile(file)) return file }
  return null
}
const when = (v: unknown): number | null => typeof v === 'number' && v > 0 ? (v < 1e12 ? v * 1000 : v) : safeDate(v)

export function readUnifiedSession(sessionDir: string): { id: string; totals: Omit<Totals, 'seq'>; at: number | null; model: string | null; project: string | null; file: string } | null {
  const file = latestProjection(sessionDir)
  if (!file) return null
  const state = parseJson(fs.readFileSync(file, 'utf8')) as { snapshot?: { session?: Record<string, any> } } | null
  const session = state?.snapshot?.session, usage = session?.tokenUsage
  if (!session || !usage || typeof usage !== 'object') return null
  let meta: Record<string, any> | null = null
  try { meta = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8')) } catch { /* projection alone is enough */ }
  const config = meta?.config ?? {}
  return {
    id: String(session.id ?? meta?.session_id ?? path.basename(sessionDir)),
    totals: { input: n(usage.inputTokens), output: n(usage.outputTokens), cached: Math.min(n(usage.cachedInputTokens), n(usage.inputTokens)) },
    at: when(session.updatedAt) ?? when(meta?.end_time) ?? when(session.createdAt) ?? when(meta?.start_time),
    model: typeof config.model_name === 'string' ? config.model_name : typeof config.active_model === 'string' ? config.active_model : null,
    project: meta?.environment?.working_directory ?? meta?.origin_directory ?? null,
    file
  }
}

function scanUnified(sessionsDir: string, db: DB, outcome: ScanOutcome): void {
  let dirs: string[] = []
  try { dirs = fs.readdirSync(path.join(sessionsDir, UNIFIED), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(sessionsDir, UNIFIED, d.name)) } catch { return }
  for (const dir of dirs) {
    try {
      const session = readUnifiedSession(dir)
      if (!session) continue
      const key = `${dir.replaceAll(path.sep, '/')}/#tokens`, stat = fs.statSync(session.file), row = getFileIndex(db, key)
      if (row && row.size === stat.size && row.mtime === Math.trunc(stat.mtimeMs)) continue
      let prior: Totals = row?.parser_state ? JSON.parse(row.parser_state) : { input: 0, output: 0, cached: 0, seq: 0 }
      const t = session.totals
      // A total that went down is a rewritten session: start it over.
      if (t.input < prior.input || t.output < prior.output || t.cached < prior.cached) { deleteFileData(db, key); prior = { input: 0, output: 0, cached: 0, seq: 0 } }
      const dIn = t.input - prior.input, dOut = t.output - prior.output, dCached = t.cached - prior.cached
      let added = 0
      if (dIn + dOut > 0) {
        upsertEvents(db, [{
          id: `mistral:${session.id}:${prior.seq + 1}`, provider: 'mistral', ts: session.at ?? stat.mtimeMs, session_id: session.id, project: session.project, model: session.model,
          kind: 'tokens', input_tokens: Math.max(0, dIn - dCached), output_tokens: dOut, cache_read_tokens: Math.max(0, dCached), cache_write_tokens: 0, reasoning_tokens: 0,
          cost_usd: null, source_file: key, meta: JSON.stringify({ granularity: 'session-delta' })
        }])
        added = 1
      }
      saveFileIndex(db, { path: key, provider: 'mistral', size: stat.size, mtime: Math.trunc(stat.mtimeMs), byte_offset: stat.size, event_count: (row?.event_count ?? 0) + added, parser_state: JSON.stringify({ ...t, seq: prior.seq + added }), added })
      outcome.filesScanned++; outcome.eventsAdded += added
    } catch (err) { outcome.errors.push(`mistral: ${path.basename(dir)}: ${(err as Error).message}`) }
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
    const installed = existsDir(root) && (existsFile(path.join(root, 'config.toml')) || existsDir(sessionsDir) || existsDir(path.join(root, 'logs')))
    return {
      status: installed ? 'ok' : 'no-data',
      path: sessionsDir,
      note: installed
        ? undefined
        : 'Mistral Vibe is not set up on this device. Install the Vibe desktop app or the CLI (docs.mistral.ai), run it once, and this page will light up.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const sessionsDir = path.join(mistralRoot(settings), SESSIONS_SUBDIR)
    scanUnified(sessionsDir, db, outcome)
    // Sessions from Vibe 2.x: one folder each, messages without token counts.
    const unified = path.join(sessionsDir, UNIFIED) + path.sep
    for (const file of walkFiles(sessionsDir, (p) => p.endsWith('messages.jsonl') && !p.startsWith(unified))) {
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
