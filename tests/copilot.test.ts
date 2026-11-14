import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync as Database } from 'node:sqlite'
import { openDb } from '../src/main/db'
import { copilotAdapter } from '../src/main/providers/copilot'
import type { Settings } from '../src/shared/types'

const tmpDirs: string[] = []

function workspace(): { root: string; dbPath: string; settings: Settings } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-cop-'))
  tmpDirs.push(root)
  const settings = { paths: { copilot: root } } as unknown as Settings
  return { root, dbPath: path.join(root, 'usage.db'), settings }
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

function seedSessionStore(root: string): void {
  const db = new Database(path.join(root, 'session-store.db'))
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
    summary TEXT, agent_name TEXT, agent_description TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT,
    timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(session_id, turn_index));`)
  db.prepare('INSERT INTO sessions (id, cwd, agent_name) VALUES (?, ?, ?)').run(
    'sess-1',
    'C:\\Users\\example\\Documents\\GitHub\\Projects\\my-app',
    'ask-agent'
  )
  const insertTurn = db.prepare('INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?, ?, ?, ?)')
  insertTurn.run('sess-1', 0, 'fix the bug', '2026-09-20T10:00:00.000Z')
  insertTurn.run('sess-1', 1, 'run the tests', '2026-09-20T10:05:00.000Z')
  db.close()
}

describe('GitHub Copilot adapter', () => {
  it('maps turns to request events attributed to their agent', () => {
    const { root, dbPath, settings } = workspace()
    seedSessionStore(root)
    const db = openDb(dbPath)
    try {
      const outcome = copilotAdapter.scan(settings, db)
      expect(outcome.errors).toEqual([])
      expect(outcome.eventsAdded).toBe(2)

      const rows = db
        .prepare('SELECT * FROM usage_events WHERE provider = ? ORDER BY ts')
        .all('copilot') as Array<{
        id: string
        ts: number
        session_id: string
        project: string | null
        model: string | null
        kind: string
      }>
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        id: 'copilot:1',
        session_id: 'sess-1',
        project: 'C:\\Users\\example\\Documents\\GitHub\\Projects\\my-app',
        model: 'ask-agent',
        kind: 'request'
      })
      expect(rows[0].ts).toBe(Date.parse('2026-09-20T10:00:00.000Z'))
      expect(copilotAdapter.status(settings).status).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('reports no-data without a session store', () => {
    const { root, dbPath, settings } = workspace()
    const db = openDb(dbPath)
    try {
      expect(copilotAdapter.status(settings).status).toBe('no-data')
      expect(copilotAdapter.scan(settings, db).eventsAdded).toBe(0)
    } finally {
      db.close()
    }
  })
})
