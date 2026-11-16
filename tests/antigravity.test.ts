import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync as Database } from 'node:sqlite'
import { openDb } from '../src/main/db'
import {
  antigravityAdapter,
  antigravityProject,
  createAntigravityUsageParser,
  parseAntigravityTime
} from '../src/main/providers/antigravity'
import type { Settings } from '../src/shared/types'

const tmpDirs: string[] = []

function workspace(): { root: string; dbPath: string; settings: Settings } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-agy-'))
  tmpDirs.push(root)
  const settings = { paths: { antigravity: root } } as unknown as Settings
  return { root, dbPath: path.join(root, 'usage.db'), settings }
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

function seedSummaries(root: string): void {
  const db = new Database(path.join(root, 'conversation_summaries.db'))
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id text, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
    step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL,
    workspace_uris text NOT NULL DEFAULT "", status text NOT NULL DEFAULT "",
    source text NOT NULL DEFAULT "", project_id text NOT NULL DEFAULT "",
    agent_name text NOT NULL DEFAULT "", parent_conversation_id text NOT NULL DEFAULT "",
    nesting_depth integer NOT NULL DEFAULT 0, killed numeric NOT NULL DEFAULT false,
    last_user_input_time datetime NOT NULL, last_user_input_step_index integer NOT NULL DEFAULT -1,
    app_data_dir text NOT NULL DEFAULT "", raw_summary blob, group_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (conversation_id))`)
  db.prepare(
    `INSERT INTO conversation_summaries (conversation_id, title, step_count, workspace_uris, agent_name, killed, last_modified_time, last_user_input_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'conv-1',
    'Fix the login bug',
    42,
    JSON.stringify(['file:///c%3A/Users/example/Documents/GitHub/Projects/my-app']),
    'puma',
    0,
    '2026-09-23 19:40:21.469698+00:00',
    '2026-09-23 18:00:00.000000+00:00'
  )
  db.close()
}

function usageRecord(seq: number, model: string, over: Partial<Record<string, number>> = {}, sessionId = 'conv-1'): string {
  return JSON.stringify({
    recordType: 'usage',
    sessionId,
    sequence: seq,
    model,
    inputTokens: over.input ?? 100,
    outputTokens: over.output ?? 50,
    cacheReadTokens: over.cacheRead ?? 1000,
    cacheWriteTokens: over.cacheWrite ?? 10,
    reasoningTokens: over.reasoning ?? 5,
    totalTokens: 1160,
    raw: {
      chatModel: {
        chatStartMetadata: { createdAt: '2026-09-23T18:00:05.000Z' },
        customMetadata: { used_non_gemini_model: model.includes('claude') }
      }
    }
  })
}

describe('Antigravity helpers', () => {
  it('parses Antigravity datetimes', () => {
    expect(parseAntigravityTime('2026-09-23 19:40:21.469698+00:00')).toBe(Date.parse('2026-09-23T19:40:21.469698+00:00'))
    expect(parseAntigravityTime('not a date')).toBeNull()
  })

  it('decodes workspace URIs to project paths', () => {
    expect(antigravityProject('["file:///c%3A/Users/example/Documents/GitHub/Projects/my-app"]')).toBe(
      'c:/Users/example/Documents/GitHub/Projects/my-app'
    )
    expect(antigravityProject('[]')).toBeNull()
    expect(antigravityProject(null)).toBeNull()
  })
})

describe('Antigravity usage.jsonl parser (token-monitor artifacts)', () => {
  it('maps usage records to token events with model + cache shares + project attribution', () => {
    const { root, dbPath, settings } = workspace()
    seedSummaries(root)
    const artifacts = path.join(root, '.token-monitor', 'rpc-cache', 'v1', 'conv-1')
    fs.mkdirSync(artifacts, { recursive: true })
    fs.writeFileSync(
      path.join(artifacts, 'usage.jsonl'),
      usageRecord(0, 'gemini-3.6-flash-tiered') + '\n' + usageRecord(1, 'claude-sonnet-4-6', { cacheRead: 500 }) + '\n'
    )

    const db = openDb(dbPath)
    try {
      const outcome = antigravityAdapter.scan(settings, db)
      expect(outcome.errors).toEqual([])
      expect(outcome.eventsAdded).toBe(2)

      const rows = db
        .prepare('SELECT * FROM usage_events WHERE provider = ? ORDER BY id')
        .all('antigravity') as Array<{
        id: string
        ts: number
        session_id: string
        project: string | null
        model: string
        kind: string
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number
        cache_write_tokens: number
        reasoning_tokens: number
        meta: string | null
      }>
      expect(rows).toHaveLength(2)
      const claude = rows.find((r) => r.id === 'antigravity:conv-1:1')!
      expect(claude).toMatchObject({
        id: 'antigravity:conv-1:1',
        session_id: 'conv-1',
        project: 'c:/Users/example/Documents/GitHub/Projects/my-app',
        model: 'claude-sonnet-4-6',
        kind: 'tokens',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 500,
        cache_write_tokens: 10
      })
      expect(claude.ts).toBe(Date.parse('2026-09-23T18:00:05.000Z'))
      expect(rows.find((r) => r.id === 'antigravity:conv-1:0')!.model).toBe('gemini-3.6-flash-tiered')
      // claude record carries the non-gemini marker
      expect(JSON.parse(claude.meta as string).nonGemini).toBe(true)

      // summary snapshot written
      const snap = db.prepare(`SELECT data FROM snapshots WHERE key = 'antigravity:summary'`).get() as {
        data: string
      }
      expect(JSON.parse(snap.data)).toMatchObject({ conversations: 1, steps: 42 })

      // incremental append picks up only the new record
      fs.appendFileSync(path.join(artifacts, 'usage.jsonl'), usageRecord(2, 'gemini-3.6-flash-tiered', { input: 999 }) + '\n')
      const r2 = antigravityAdapter.scan(settings, db)
      expect(r2.eventsAdded).toBe(1)
      expect((db.prepare("SELECT COUNT(*) c FROM usage_events WHERE provider='antigravity'").get() as { c: number }).c).toBe(3)

      expect(antigravityAdapter.status(settings).status).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('handles usage records with an unknown conversation gracefully', () => {
    const { root } = workspace()
    const artifacts = path.join(root, '.token-monitor', 'rpc-cache', 'v1', 'orphan')
    fs.mkdirSync(artifacts, { recursive: true })
    fs.writeFileSync(
      path.join(artifacts, 'usage.jsonl'),
      usageRecord(0, 'gemini-3.6-flash-tiered', {}, 'orphan') + '\n'
    )

    const db = openDb(path.join(root, 'usage.db'))
    try {
      const file = path.join(artifacts, 'usage.jsonl')
      const parser = createAntigravityUsageParser(file, new Map())
      parser.line(fs.readFileSync(file, 'utf8').trim())
      const events = parser.events()
      expect(events).toHaveLength(1)
      expect(events[0].project).toBeNull()
      expect(events[0].session_id).toBe('orphan')
    } finally {
      db.close()
    }
  })
})

// Minimal protobuf writer for Antigravity's per-conversation database rows.
const vint = (n: number): number[] => { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b) } while (n); return out }
const int = (field: number, n: number): number[] => [...vint(field * 8), ...vint(n)]
const bytes = (field: number, body: number[] | string): number[] => { const b = typeof body === 'string' ? [...Buffer.from(body)] : body; return [...vint(field * 8 + 2), ...vint(b.length), ...b] }

describe('Antigravity 2.x conversation databases', () => {
  function seedConversation(root: string, id: string, gens: Array<{ steps: number[]; input: number; thinking: number; response: number; cache: number; model: string }>, stepSeconds: number[]): void {
    fs.mkdirSync(path.join(root, 'conversations'), { recursive: true })
    const db = new Database(path.join(root, 'conversations', id + '.db'))
    db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0); CREATE TABLE steps (idx integer PRIMARY KEY, metadata blob)')
    stepSeconds.forEach((s, i) => db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(i, Uint8Array.from(bytes(1, [...int(1, s), ...int(2, 500_000_000)]))))
    gens.forEach((g, i) => {
      const usage = [...int(1, 1528), ...int(2, g.input), ...int(3, g.thinking + g.response), ...(g.cache ? int(5, g.cache) : []), ...int(9, g.thinking), ...int(10, g.response)]
      const chat = [...bytes(4, usage), ...bytes(19, g.model), ...bytes(20, [...bytes(1, 'used_claude'), ...bytes(2, String(g.model.startsWith('claude')))]), ...bytes(21, g.model.toUpperCase())]
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(i, Uint8Array.from([...bytes(1, chat), ...bytes(2, g.steps.flatMap(vint))]))
    })
    db.close()
  }

  it('reads per-call tokens, step timestamps and models, then scans incrementally', () => {
    const { root, dbPath, settings } = workspace()
    seedConversation(root, 'cascade-1', [
      { steps: [1, 2], input: 21566, thinking: 159, response: 246, cache: 59532, model: 'gemini-4-hydrogen' },
      { steps: [3], input: 900, thinking: 0, response: 100, cache: 0, model: 'claude-opus-4-6-thinking' }
    ], [1794774272, 1794774276, 1794774277, 1794774300])
    const db = openDb(dbPath)
    try {
      const first = antigravityAdapter.scan(settings, db)
      expect(first.errors).toEqual([]); expect(first.eventsAdded).toBe(2)
      const rows = db.prepare("SELECT * FROM usage_events WHERE provider = 'antigravity' ORDER BY ts").all() as any[]
      expect(rows.map(r => [r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.reasoning_tokens])).toEqual([
        ['gemini-4-hydrogen', 21566, 405, 59532, 159], ['claude-opus-4-6-thinking', 900, 100, 0, 0]
      ])
      expect(rows[0].ts).toBe(1794774276_500); expect(rows[0].session_id).toBe('cascade-1')
      expect(JSON.parse(rows[1].meta)).toMatchObject({ claude: true })
      expect(antigravityAdapter.scan(settings, db).eventsAdded).toBe(0)
      // A newer call appended to the same conversation is picked up alone.
      const conv = new Database(path.join(root, 'conversations', 'cascade-1.db'))
      conv.prepare('INSERT INTO gen_metadata (idx, data) VALUES (2, ?)').run(Uint8Array.from([...bytes(1, [...bytes(4, [...int(2, 10), ...int(3, 5)]), ...bytes(19, 'gemini-3.8-flash')]), ...bytes(2, vint(3))]))
      conv.close()
      const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(root, 'conversations', 'cascade-1.db'), later, later)
      expect(antigravityAdapter.scan(settings, db).eventsAdded).toBe(1)
      expect((db.prepare("SELECT COUNT(*) n FROM usage_events WHERE provider = 'antigravity'").get() as any).n).toBe(3)
    } finally { db.close() }
  })
})
