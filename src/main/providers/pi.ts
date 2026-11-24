import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsDir, walkFiles } from '../paths'
import type { DB, UpsertEvent } from '../db'
import { JsonlParser, n, parseJson, safeDate, scanJsonlFile } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

/** pi's agent folder: `PI_CODING_AGENT_DIR`, else `~/.pi/agent` (same on macOS and Windows). */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent')
}
export function piSessionsDir(settings: Pick<Settings, 'paths'>): string {
  return settings.paths.pi?.trim() || process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || path.join(piAgentDir(), 'sessions')
}

interface PiState { sessionId?: string; cwd?: string; provider?: string; model?: string }
type PiUsage = { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; reasoning?: unknown; cost?: { total?: unknown } }

/**
 * pi (earendil-works/pi) writes one JSONL file per session under
 * `<agentDir>/sessions/--<cwd>--/<iso>_<uuidv7>.jsonl`. Line 1 is the session header; every
 * assistant message carries the call's usage (input excludes cache; reasoning is part of output)
 * and its USD cost. `usage`, `compaction` and `branch_summary` entries and tool results also carry
 * usage that pi counts in its own totals. /fork and /clone copy entries verbatim (same entry id and
 * timestamp) into a new file, so events are keyed by those two and a copy lands on the same row.
 */
export function createPiParser(filePath: string, prior: PiState | null): JsonlParser {
  const state: PiState = prior ?? {}
  const events: UpsertEvent[] = []
  const push = (entry: Record<string, unknown>, usage: PiUsage, provider: string | undefined, model: string | undefined, at: number | null, kind: string): void => {
    const input = n(usage.input), output = n(usage.output), cacheRead = n(usage.cacheRead), cacheWrite = n(usage.cacheWrite)
    if (input + output + cacheRead + cacheWrite <= 0) return
    const ts = at ?? safeDate(entry.timestamp)
    if (ts === null) return
    const cost = n(usage.cost?.total)
    events.push({
      id: `pi:${String(entry.timestamp ?? ts)}:${String(entry.id ?? '')}:${kind}`,
      provider: 'pi', ts, session_id: state.sessionId ?? path.basename(filePath, '.jsonl'), project: state.cwd ?? null,
      model: model ?? null, kind: 'tokens',
      input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite,
      reasoning_tokens: Math.min(output, n(usage.reasoning)),
      // Custom and local models (for example Ollama) have no price in pi's catalog and report 0.
      cost_usd: cost > 0 ? cost : null,
      source_file: filePath,
      meta: JSON.stringify({ upstream: provider ?? null, entry: kind })
    })
  }
  return {
    line(s: string): void {
      const entry = parseJson(s)
      if (!entry) return
      const type = entry.type
      if (type === 'session') {
        state.sessionId = typeof entry.id === 'string' ? entry.id : state.sessionId
        state.cwd = typeof entry.cwd === 'string' ? entry.cwd : state.cwd
        return
      }
      if (type === 'model_change') {
        if (typeof entry.provider === 'string') state.provider = entry.provider
        if (typeof entry.modelId === 'string') state.model = entry.modelId
        return
      }
      if (type === 'message') {
        const message = entry.message as Record<string, unknown> | undefined
        if (!message || typeof message.usage !== 'object' || !message.usage) return
        if (message.role === 'assistant') {
          const provider = typeof message.provider === 'string' ? message.provider : state.provider
          const model = typeof message.responseModel === 'string' ? message.responseModel : typeof message.model === 'string' ? message.model : state.model
          if (provider) state.provider = provider
          if (typeof message.model === 'string') state.model = message.model
          // message.timestamp is Unix ms (request start); the entry's own timestamp is ISO.
          push(entry, message.usage as PiUsage, provider, model, typeof message.timestamp === 'number' && message.timestamp > 0 ? message.timestamp : null, 'assistant')
        } else if (message.role === 'toolResult') push(entry, message.usage as PiUsage, state.provider, state.model, null, 'tool')
        return
      }
      if (type === 'usage' && entry.usage && typeof entry.usage === 'object') {
        push(entry, entry.usage as PiUsage, typeof entry.provider === 'string' ? entry.provider : state.provider, typeof entry.model === 'string' ? entry.model : state.model, null, 'usage')
        return
      }
      if ((type === 'compaction' || type === 'branch_summary') && entry.usage && typeof entry.usage === 'object') push(entry, entry.usage as PiUsage, state.provider, state.model, null, type)
    },
    state: () => ({ ...state }),
    events: () => events,
    tools: () => [],
    snapshots: () => []
  }
}

export const piAdapter: ProviderAdapter = {
  id: 'pi',
  watchRoots(settings) { return [{ path: piSessionsDir(settings), recursive: true }] },
  status(settings) {
    const dir = piSessionsDir(settings)
    return { status: existsDir(dir) ? 'ok' : 'no-data', path: dir, note: existsDir(dir) ? undefined : 'No pi sessions yet. Install pi (pi.dev), run it once, and this page will light up.' }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    for (const file of walkFiles(piSessionsDir(settings), p => p.endsWith('.jsonl'))) {
      try {
        const r = scanJsonlFile(db, 'pi', file, prior => createPiParser(file, prior as PiState | null))
        if (!r.skipped) outcome.filesScanned++
        outcome.eventsAdded += r.added
      } catch (err) { outcome.errors.push(`pi: ${path.basename(file)}: ${(err as Error).message}`) }
    }
    return outcome
  }
}
