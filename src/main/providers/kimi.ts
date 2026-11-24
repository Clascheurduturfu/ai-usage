import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Settings } from '../../shared/types'
import { existsDir, walkFiles } from '../paths'
import type { DB, UpsertEvent } from '../db'
import { JsonlParser, n, parseJson, scanJsonlFile } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

/** Kimi Code's home (CLI, desktop app and VS Code extension share it): `KIMI_CODE_HOME`, else `~/.kimi-code`. */
export function kimiHome(settings?: Pick<Settings, 'paths'>): string {
  return settings?.paths.kimi?.trim() || process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), '.kimi-code')
}

interface KimiState { sessionId?: string; cwd?: string | null; agent?: string }

/** `[models."<alias>"] model = "…"` in config.toml: the provider's real model id behind an alias. */
let aliasCache: { file: string; mtime: number; map: Record<string, string> } | null = null
export function kimiModelAliases(home: string): Record<string, string> {
  const file = path.join(home, 'config.toml')
  try {
    const mtime = fs.statSync(file).mtimeMs
    if (aliasCache?.file === file && aliasCache.mtime === mtime) return aliasCache.map
    const doc = parseToml(fs.readFileSync(file, 'utf8')) as { models?: Record<string, { model?: unknown }> }
    const map = Object.fromEntries(Object.entries(doc.models ?? {}).flatMap(([alias, v]) => typeof v?.model === 'string' ? [[alias, v.model]] : []))
    aliasCache = { file, mtime, map }
    return map
  } catch { return {} }
}

function readSessionState(sessionDir: string): { cwd: string | null } {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')) as { cwd?: unknown }
    return { cwd: typeof state.cwd === 'string' ? state.cwd : null }
  } catch { return { cwd: null } }
}

/**
 * Kimi Code (MoonshotAI/kimi-code) logs every model request as a `usage.record` line in
 * `<home>/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl`: per-request deltas of
 * non-cached input (`inputOther`), output (reasoning included), cache reads and cache writes,
 * with the config alias of the model. Step-end events repeat the same usage and are skipped.
 * Forked sessions copy wire lines, so events are keyed by time, model and counts, not by session.
 */
export function createKimiParser(filePath: string, prior: KimiState | null, aliases: Record<string, string>): JsonlParser {
  const agentDir = path.dirname(filePath), sessionDir = path.dirname(path.dirname(agentDir))
  const state: KimiState = prior ?? { sessionId: path.basename(sessionDir), cwd: readSessionState(sessionDir).cwd, agent: path.basename(agentDir) }
  const events: UpsertEvent[] = []
  return {
    line(s: string): void {
      const record = parseJson(s)
      if (!record || record.type !== 'usage.record' || !record.usage || typeof record.usage !== 'object') return
      const usage = record.usage as Record<string, unknown>
      const input = n(usage.inputOther), output = n(usage.output), cacheRead = n(usage.inputCacheRead), cacheWrite = n(usage.inputCacheCreation)
      const ts = n(record.time)
      if (ts <= 0 || input + output + cacheRead + cacheWrite <= 0) return
      const alias = typeof record.model === 'string' ? record.model : null
      events.push({
        id: `kimi:${ts}:${alias ?? ''}:${input}:${output}:${cacheRead}:${cacheWrite}`,
        provider: 'kimi', ts, session_id: state.sessionId ?? null, project: state.cwd ?? null,
        model: alias ? aliases[alias] ?? alias.replace(/^[^/]+\//, '') : null,
        kind: 'tokens', input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, reasoning_tokens: 0,
        cost_usd: null, source_file: filePath,
        meta: JSON.stringify({ alias, agent: typeof record.agentId === 'string' ? record.agentId : state.agent, scope: typeof record.usageScope === 'string' ? record.usageScope : null })
      })
    },
    state: () => ({ ...state }),
    events: () => events,
    tools: () => [],
    snapshots: () => []
  }
}

export const kimiAdapter: ProviderAdapter = {
  id: 'kimi',
  watchRoots(settings) { return [{ path: path.join(kimiHome(settings), 'sessions'), recursive: true }] },
  status(settings) {
    const dir = path.join(kimiHome(settings), 'sessions')
    return { status: existsDir(dir) ? 'ok' : 'no-data', path: dir, note: existsDir(dir) ? undefined : 'No Kimi Code sessions yet. Install Kimi Code (code.kimi.com), run it once, and this page will light up.' }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const home = kimiHome(settings), aliases = kimiModelAliases(home)
    for (const file of walkFiles(path.join(home, 'sessions'), p => p.endsWith('wire.jsonl'))) {
      try {
        const r = scanJsonlFile(db, 'kimi', file, prior => createKimiParser(file, prior as KimiState | null, aliases))
        if (!r.skipped) outcome.filesScanned++
        outcome.eventsAdded += r.added
      } catch (err) { outcome.errors.push(`kimi: ${path.basename(path.dirname(path.dirname(path.dirname(file))))}: ${(err as Error).message}`) }
    }
    return outcome
  }
}
