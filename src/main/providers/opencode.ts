import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsFile } from '../paths'
import { DB, UpsertEvent, upsertEvents, openExternalDb } from '../db'
import { n, parseJson } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

export function opencodeRoot(settings: Settings): string {
  return settings.paths.opencode ?? path.join(os.homedir(), '.local', 'share', 'opencode')
}

/**
 * OpenCode keeps a SQLite ledger (`opencode.db`). The `session` table carries
 * real recorded cost and per-session token totals, which we mirror 1:1.
 */
export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  watchRoots(settings) {
    return [{ path: opencodeRoot(settings), recursive: false }]
  },
  status(settings) {
    const root = opencodeRoot(settings)
    const dbFile = path.join(root, 'opencode.db')
    return {
      status: existsFile(dbFile) ? 'ok' : 'no-data',
      path: dbFile,
      note: existsFile(dbFile) ? undefined : 'No opencode.db found. Run OpenCode at least once.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const dbFile = path.join(opencodeRoot(settings), 'opencode.db')
    if (!existsFile(dbFile)) return outcome

    let external: DB | null = null
    try {
      external = openExternalDb(dbFile)
      const rows = external
        .prepare(
          `SELECT id, directory, model, cost, tokens_input, tokens_output, tokens_reasoning,
                  tokens_cache_read, tokens_cache_write, time_created, time_updated, title
           FROM session`
        )
        .all() as Array<{
        id: string
        directory: string | null
        model: string | null
        cost: number | null
        tokens_input: number | null
        tokens_output: number | null
        tokens_reasoning: number | null
        tokens_cache_read: number | null
        tokens_cache_write: number | null
        time_created: number | null
        time_updated: number | null
        title: string | null
      }>

      const events: UpsertEvent[] = []
      for (const r of rows) {
        const ts = n(r.time_created)
        if (ts <= 0) continue
        let model: string | null = null
        let providerTag: string | null = null
        const m = r.model ? (parseJson(r.model) as Record<string, unknown> | null) : null
        if (m) {
          model = typeof m.id === 'string' ? m.id : null
          providerTag = typeof m.providerID === 'string' ? m.providerID : null
        }
        events.push({
          id: `opencode:${r.id}`,
          provider: 'opencode',
          ts,
          session_id: r.id,
          project: r.directory ?? null,
          model,
          kind: 'tokens',
          input_tokens: n(r.tokens_input),
          output_tokens: n(r.tokens_output),
          cache_read_tokens: n(r.tokens_cache_read),
          cache_write_tokens: n(r.tokens_cache_write),
          reasoning_tokens: n(r.tokens_reasoning),
          cost_usd: r.cost != null && r.cost > 0 ? r.cost : null,
          source_file: dbFile,
          meta: JSON.stringify({ title: r.title ?? null, upstream: providerTag, granularity: 'session' })
        })
      }
      upsertEvents(db, events)
      outcome.filesScanned = 1
      outcome.eventsAdded = events.length
    } catch (err) {
      outcome.errors.push(`opencode: ${(err as Error).message}`)
    } finally {
      external?.close()
    }
    return outcome
  }
}
