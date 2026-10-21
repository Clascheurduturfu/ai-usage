import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsFile } from '../paths'
import { DB, UpsertEvent, UpsertTool, upsertEvents, upsertTools, openExternalDb, kvGet, kvSet } from '../db'
import { n } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'


/**
 * Watermarks make ZCode scans incremental: rows older than a short grace
 * window are never re-read (they are immutable once completed), so a scan
 * touches a handful of rows instead of the whole 2.5k+ row ledger.
 */
const WATERMARK_GRACE_MS = 5 * 60 * 1000

function getWatermark(db: DB, kind: 'model' | 'tool'): number {
  const v = kvGet<number>(db, `zcode:watermark:${kind}`)
  return typeof v === 'number' && v > 0 ? v : 0
}

function setWatermark(db: DB, kind: 'model' | 'tool', at: number): void {
  kvSet(db, `zcode:watermark:${kind}`, at)
}

export function zcodeRoot(settings: Settings): string {
  return settings.paths.zcode ?? path.join(os.homedir(), '.zcode', 'cli')
}

/**
 * ZCode keeps a first-class usage ledger (`~/.zcode/cli/db/db.sqlite`) with a
 * `model_usage` row per model request (tokens, durations, status, upstream
 * provider) and a `tool_usage` row per tool call.
 */
export const zcodeAdapter: ProviderAdapter = {
  id: 'zcode',
  watchRoots(settings) {
    return [{ path: path.join(zcodeRoot(settings), 'db'), recursive: false }]
  },
  status(settings) {
    const root = zcodeRoot(settings)
    const dbFile = path.join(root, 'db', 'db.sqlite')
    return {
      status: existsFile(dbFile) ? 'ok' : 'no-data',
      path: dbFile,
      note: existsFile(dbFile) ? undefined : 'No ZCode usage database found.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const dbFile = path.join(zcodeRoot(settings), 'db', 'db.sqlite')
    if (!existsFile(dbFile)) return outcome

    let external: DB | null = null
    try {
      external = openExternalDb(dbFile)
      // Incremental: re-read only rows from the last few minutes (running rows
      // update their status/duration) plus everything newer than the watermark.
      const watermark = getWatermark(db, 'model')
      const since = Math.min(watermark, Date.now() - WATERMARK_GRACE_MS)
      const rows = external
        .prepare(
          `SELECT m.id, m.session_id, m.provider_id, m.model_id, m.status, m.started_at,
                  m.duration_ms, m.time_to_first_token_ms, m.tool_call_count,
                  m.input_tokens, m.output_tokens, m.reasoning_tokens,
                  m.cache_creation_input_tokens, m.cache_read_input_tokens,
                  s.directory, s.title
           FROM model_usage m LEFT JOIN session s ON s.id = m.session_id
           WHERE m.started_at >= ?`
        )
        .all(since) as Array<{
        id: string
        session_id: string
        provider_id: string
        model_id: string
        status: string
        started_at: number
        duration_ms: number | null
        time_to_first_token_ms: number | null
        tool_call_count: number
        input_tokens: number
        output_tokens: number
        reasoning_tokens: number
        cache_creation_input_tokens: number
        cache_read_input_tokens: number
        directory: string | null
        title: string | null
      }>

      const events: UpsertEvent[] = rows.map((r) => ({
        id: `zcode:${r.id}`,
        provider: 'zcode',
        ts: n(r.started_at),
        session_id: r.session_id,
        project: r.directory ?? null,
        model: r.model_id,
        kind: 'tokens',
        input_tokens: n(r.input_tokens),
        output_tokens: n(r.output_tokens),
        cache_read_tokens: n(r.cache_read_input_tokens),
        cache_write_tokens: n(r.cache_creation_input_tokens),
        reasoning_tokens: n(r.reasoning_tokens),
        cost_usd: null,
        source_file: dbFile,
        meta: JSON.stringify({
          upstream: r.provider_id,
          status: r.status,
          durationMs: n(r.duration_ms),
          ttftMs: n(r.time_to_first_token_ms),
          toolCalls: n(r.tool_call_count),
          title: r.title ?? null
        })
      }))
      upsertEvents(db, events)
      setWatermark(db, 'model', Date.now())

      const toolWatermark = getWatermark(db, 'tool')
      const toolSince = Math.min(toolWatermark, Date.now() - WATERMARK_GRACE_MS)
      const toolRows = external
        .prepare(
          `SELECT t.id, t.session_id, t.tool_name, t.started_at, t.status, s.directory
           FROM tool_usage t LEFT JOIN session s ON s.id = t.session_id
           WHERE t.started_at >= ?`
        )
        .all(toolSince) as Array<{
        id: string
        session_id: string
        tool_name: string
        started_at: number
        status: string
        directory: string | null
      }>
      const tools: UpsertTool[] = toolRows.map((t) => ({
        id: `zcode:${t.id}`,
        provider: 'zcode',
        ts: n(t.started_at),
        name: t.tool_name,
        session_id: t.session_id,
        project: t.directory ?? null,
        source_file: dbFile
      }))
      upsertTools(db, tools)
      setWatermark(db, 'tool', Date.now())

      outcome.filesScanned = 1
      outcome.eventsAdded = events.length
    } catch (err) {
      outcome.errors.push(`zcode: ${(err as Error).message}`)
    } finally {
      external?.close()
    }
    return outcome
  }
}
