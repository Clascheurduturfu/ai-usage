import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsFile } from '../paths'
import { DB, UpsertEvent, upsertEvents, openExternalDb } from '../db'
import { ProviderAdapter, ScanOutcome } from './types'

export function copilotRoot(settings: Settings): string {
  return (
    settings.paths.copilot ??
    path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'Code',
      'User',
      'globalStorage',
      'github.copilot-chat'
    )
  )
}

const DB_FILE = 'session-store.db'

/** ISO timestamp from Copilot's strftime('%Y-%m-%dT%H:%M:%fZ') default. */
function parseCopilotTime(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * The GitHub Copilot Chat VS Code extension keeps a `session-store.db` SQLite
 * with chat sessions and turns (user_message + assistant_response pairs).
 * No token counts are stored, so each turn becomes one request-kind event;
 * the agent name (ask/explore/plan/…) is attached as the "model".
 */
export const copilotAdapter: ProviderAdapter = {
  id: 'copilot',
  watchRoots(settings) {
    return [{ path: copilotRoot(settings), recursive: false }]
  },
  status(settings) {
    const root = copilotRoot(settings)
    const dbFile = path.join(root, DB_FILE)
    return {
      status: existsFile(dbFile) ? 'ok' : 'no-data',
      path: dbFile,
      note: existsFile(dbFile)
        ? undefined
        : 'No Copilot Chat session store found (VS Code: github.copilot-chat extension).'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const dbFile = path.join(copilotRoot(settings), DB_FILE)
    if (!existsFile(dbFile)) return outcome

    let external: DB | null = null
    try {
      external = openExternalDb(dbFile)
      let tables: string[] = []
      try {
        const row = external
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as unknown as Array<{ name: string }>
        tables = row.map((r) => r.name)
      } catch {
        /* unreadable schema */
      }
      if (!tables.includes('turns') || !tables.includes('sessions')) {
        outcome.errors.push('copilot: session-store.db has no turns/sessions tables (newer schema?)')
        return outcome
      }

      const rows = external
        .prepare(
          `SELECT t.id, t.timestamp, t.user_message, t.session_id, s.cwd, s.agent_name
           FROM turns t LEFT JOIN sessions s ON s.id = t.session_id`
        )
        .all() as Array<{
        id: number
        timestamp: string
        user_message: string | null
        session_id: string
        cwd: string | null
        agent_name: string | null
      }>

      const events: UpsertEvent[] = []
      for (const r of rows) {
        const ts = parseCopilotTime(r.timestamp)
        if (ts === null) continue
        events.push({
          id: `copilot:${r.id}`,
          provider: 'copilot',
          ts,
          session_id: r.session_id,
          project: r.cwd ?? null,
          model: r.agent_name && r.agent_name.length > 0 ? r.agent_name : null,
          kind: 'request',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          cost_usd: null,
          source_file: dbFile,
          meta: JSON.stringify({ hasUser: r.user_message != null })
        })
      }
      upsertEvents(db, events)
      outcome.filesScanned = 1
      outcome.eventsAdded = events.length
    } catch (err) {
      outcome.errors.push(`copilot: ${(err as Error).message}`)
    } finally {
      external?.close()
    }
    return outcome
  }
}
