import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { scanJsonlFile } from '../src/main/providers/jsonl'
import { createMistralParser, mistralAdapter } from '../src/main/providers/mistral'
import type { Settings } from '../src/shared/types'

const tmpDirs: string[] = []

function workspace(): { root: string; dbPath: string; settings: Settings; sessionsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-vibe-'))
  tmpDirs.push(root)
  const sessionsDir = path.join(root, 'logs', 'session')
  fs.mkdirSync(path.join(sessionsDir, 'session-abc123'), { recursive: true })
  fs.writeFileSync(path.join(root, 'config.toml'), '# vibe config\n')
  const settings = { paths: { mistral: root } } as unknown as Settings
  return { root, dbPath: path.join(root, 'usage.db'), settings, sessionsDir }
}

function seedSession(sessionsDir: string, extra: boolean): void {
  const dir = path.join(sessionsDir, 'session-abc123')
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      session_id: 'abc123',
      title: 'Build the thing',
      active_model: 'mistral-large-latest',
      environment: { working_directory: 'C:\\Users\\example\\Documents\\GitHub\\Projects\\thing' },
      created_at: '2026-09-21T09:00:00.000Z'
    })
  )
  const messages = [
    JSON.stringify({ role: 'user', content: 'hello', timestamp: '2026-09-21T09:00:05.000Z' }),
    JSON.stringify({ role: 'assistant', content: 'hi', timestamp: '2026-09-21T09:00:12.000Z' }),
    JSON.stringify({ role: 'user', content: 'do the task', timestamp: '2026-09-21T09:01:00.000Z' })
  ]
  if (extra) {
    messages.push(JSON.stringify({ role: 'user', content: 'and another', timestamp: '2026-09-21T09:02:00.000Z' }))
  }
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), messages.join('\n') + '\n')
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

describe('Mistral Vibe parser', () => {
  it('counts user messages as request events with model + project from meta.json', () => {
    const { sessionsDir, dbPath } = workspace()
    seedSession(sessionsDir, false)
    const db = openDb(dbPath)
    try {
      const file = path.join(sessionsDir, 'session-abc123', 'messages.jsonl')
      const r = scanJsonlFile(db, 'mistral', file, (prior) => createMistralParser(file, prior as never))
      expect(r.added).toBe(2) // assistant messages are ignored

      const rows = db
        .prepare('SELECT * FROM usage_events WHERE provider = ? ORDER BY ts')
        .all('mistral') as Array<{
        id: string
        ts: number
        session_id: string
        project: string | null
        model: string | null
        kind: string
      }>
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        session_id: 'abc123',
        project: 'C:\\Users\\example\\Documents\\GitHub\\Projects\\thing',
        model: 'mistral-large-latest',
        kind: 'request'
      })
      expect(rows[0].ts).toBe(Date.parse('2026-09-21T09:00:05.000Z'))

      // Incremental append picks up only the new user message
      const before = fs.readFileSync(file, 'utf8')
      fs.appendFileSync(file, JSON.stringify({ role: 'user', content: 'more', timestamp: '2026-09-21T09:05:00.000Z' }) + '\n')
      expect(before.length).toBeGreaterThan(0)
      const r2 = scanJsonlFile(db, 'mistral', file, (prior) => createMistralParser(file, prior as never))
      expect(r2.added).toBe(1)
      expect((db.prepare("SELECT COUNT(*) c FROM usage_events WHERE provider='mistral'").get() as { c: number }).c).toBe(3)
    } finally {
      db.close()
    }
  })

  it('falls back to meta timestamps when messages carry none', () => {
    const { sessionsDir, dbPath } = workspace()
    const dir = path.join(sessionsDir, 'session-abc123')
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ session_id: 'abc123', created_at: '2026-09-21T09:00:00.000Z' })
    )
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify({ role: 'user', content: 'x' }) + '\n')
    const db = openDb(dbPath)
    try {
      const file = path.join(dir, 'messages.jsonl')
      scanJsonlFile(db, 'mistral', file, (prior) => createMistralParser(file, prior as never))
      const row = db.prepare("SELECT ts, session_id FROM usage_events WHERE provider='mistral'").get() as {
        ts: number
        session_id: string
      }
      expect(row.ts).toBe(Date.parse('2026-09-21T09:00:00.000Z'))
      expect(row.session_id).toBe('abc123')
    } finally {
      db.close()
    }
  })

  it('reports not-installed when ~/.vibe is absent', () => {
    const { root, dbPath, settings, sessionsDir } = workspace()
    // The desktop app writes ~/.vibe/logs before any session, so only a bare folder counts as not set up.
    fs.rmSync(path.dirname(sessionsDir), { recursive: true, force: true })
    fs.unlinkSync(path.join(root, 'config.toml'))
    const db = openDb(dbPath)
    try {
      const status = mistralAdapter.status(settings)
      expect(status.status).toBe('no-data')
      expect(status.note).toContain('not set up')
      expect(mistralAdapter.scan(settings, db).eventsAdded).toBe(0)
    } finally {
      db.close()
    }
  })

  it('status is ok with config + sessions present', () => {
    const { settings, sessionsDir } = workspace()
    seedSession(sessionsDir, false)
    expect(mistralAdapter.status(settings).status).toBe('ok')
  })
})
