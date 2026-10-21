import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsDir, walkFiles } from '../paths'
import type { DB, UpsertEvent, UpsertTool } from '../db'
import { JsonlParser, SnapshotInput, hashLine, n, parseJson, safeDate, scanJsonlFile } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

export function codexRoot(settings: Settings): string {
  return settings.paths.codex ?? path.join(os.homedir(), '.codex')
}

export interface CodexLimitSnapshot {
  usedPercent: number
  windowMinutes: number
  resetsAt: number
  planType: string
  observedAt: number
}

interface CodexParserState {
  sessionId?: string
  project?: string
  lastModel?: string
  total?: Record<string, number>
  epoch?: number
}

export function createCodexParser(filePath: string, prior: CodexParserState | null): JsonlParser {
  const state: CodexParserState = prior ?? {}
  const events: UpsertEvent[] = []
  const tools: UpsertTool[] = []
  const snapshots: SnapshotInput[] = []

  return {
    line(s: string): void {
      const obj = parseJson(s)
      if (!obj) return
      const payload = obj.payload as Record<string, unknown> | undefined
      if (!payload) return

      const ts = safeDate(obj.timestamp) ?? Date.now()

      if (obj.type === 'session_meta') {
        state.sessionId =
          typeof payload.id === 'string' ? payload.id : path.basename(filePath, '.jsonl').replace(/^rollout-/, '')
        if (typeof payload.cwd === 'string') state.project = payload.cwd
        if (typeof payload.model === 'string') state.lastModel = payload.model
        return
      }

      // Any payload can carry the current model (response_item, turn_context, ...)
      if (typeof payload.model === 'string' && payload.model) state.lastModel = payload.model

      if (obj.type === 'event_msg' && payload.type === 'token_count') {
        const info = payload.info as Record<string, unknown> | undefined
        if (!info) return
        const last = info.last_token_usage as Record<string, unknown> | undefined
        const total = info.total_token_usage as Record<string, unknown> | undefined
        const fields = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens']
        let usage = last ?? total
        if (!usage) return
        let repeated = false
        if (total) {
          const current = Object.fromEntries(fields.map(key => [key, Math.max(0, n(total[key]))]))
          if (state.total) {
            const reset = current.input_tokens < state.total.input_tokens || current.output_tokens < state.total.output_tokens
            if (reset) state.epoch = (state.epoch ?? 0) + 1
            else { usage = Object.fromEntries(fields.map(key => [key, Math.max(0, current[key] - (state.total![key] ?? 0))])); repeated = fields.every(key => n(usage![key]) === 0) }
          }
          state.total = current
        }
        const inclusiveInput = Math.max(0, n(usage.input_tokens))
        const output_tokens = Math.max(0, n(usage.output_tokens))
        const cache_read = Math.min(inclusiveInput, Math.max(0, n(usage.cached_input_tokens)))
        const cache_write = Math.min(inclusiveInput - cache_read, Math.max(0, n(usage.cache_write_input_tokens)))
        const input_tokens = inclusiveInput - cache_read - cache_write
        const reasoning = Math.min(output_tokens, Math.max(0, n(usage.reasoning_output_tokens)))
        const hasUsage = input_tokens + output_tokens + cache_read + cache_write > 0

        const sessionId = state.sessionId ?? hashLine(filePath)
        const ordinal = typeof obj.ordinal === 'number' ? obj.ordinal : -1
        if (!repeated && hasUsage) events.push({
          id: ordinal >= 0 ? `codex:${sessionId}:${ordinal}` : `codex:${sessionId}:${state.epoch ?? 0}:${total ? hashLine(JSON.stringify(state.total)) : hashLine(s)}`,
          provider: 'codex',
          ts,
          session_id: sessionId,
          project: state.project ?? null,
          model: state.lastModel ?? null,
          kind: 'tokens',
          input_tokens,
          output_tokens,
          cache_read_tokens: cache_read,
          cache_write_tokens: cache_write,
          reasoning_tokens: reasoning,
          cost_usd: null,
          source_file: filePath,
          meta: JSON.stringify({ ordinal })
        })

        // Rate-limit snapshot (weekly usage window reported by OpenAI)
        const rl = payload.rate_limits as Record<string, unknown> | undefined
        if (rl) {
          const primary = rl.primary as Record<string, unknown> | null
          const data: CodexLimitSnapshot = {
            usedPercent: primary ? n(primary.used_percent) : 0,
            windowMinutes: primary ? n(primary.window_minutes) : 0,
            resetsAt: primary ? n(primary.resets_at) * 1000 : 0,
            planType: typeof rl.plan_type === 'string' ? rl.plan_type : 'unknown',
            observedAt: ts
          }
          snapshots.push({ key: `codex:limit:${sessionId}`, provider: 'codex', ts, data })
        }
        return
      }

      // Tool calls (function calls in responses)
      if (obj.type === 'response_item' && payload.type === 'function_call' && typeof payload.name === 'string') {
        const sessionId = state.sessionId ?? hashLine(filePath)
        const ordinal = typeof obj.ordinal === 'number' ? obj.ordinal : typeof payload.call_id === 'string' ? payload.call_id : hashLine(s)
        tools.push({
          id: `codex:${sessionId}:${ordinal}`,
          provider: 'codex',
          ts,
          name: payload.name,
          session_id: sessionId,
          project: state.project ?? null,
          source_file: filePath
        })
      }
    },
    state: () => state,
    events: () => events,
    tools: () => tools,
    snapshots: () => snapshots
  }
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  watchRoots(settings) {
    const root = codexRoot(settings)
    return [
      { path: path.join(root, 'sessions'), recursive: true },
      { path: path.join(root, 'archived_sessions'), recursive: true }
    ]
  },
  status(settings) {
    const root = codexRoot(settings)
    const a = path.join(root, 'sessions')
    const b = path.join(root, 'archived_sessions')
    let count = 0
    if (existsDir(a)) count += walkFiles(a, (p) => p.endsWith('.jsonl')).length
    if (existsDir(b)) count += walkFiles(b, (p) => p.endsWith('.jsonl')).length
    return {
      status: count > 0 ? 'ok' : 'no-data',
      path: a,
      note: count > 0 ? undefined : 'No Codex session rollouts found. Run Codex CLI at least once.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const root = codexRoot(settings)
    const dirs = [path.join(root, 'sessions'), path.join(root, 'archived_sessions')]
    for (const dir of dirs) {
      for (const file of walkFiles(dir, (p) => p.endsWith('.jsonl'))) {
        try {
          const r = scanJsonlFile(db, 'codex', file, (prior) =>
            createCodexParser(file, prior as CodexParserState | null), 2
          )
          if (!r.skipped) outcome.filesScanned++
          outcome.eventsAdded += r.added
        } catch (err) {
          outcome.errors.push(`codex: ${path.basename(file)}: ${(err as Error).message}`)
        }
      }
    }
    return outcome
  }
}
