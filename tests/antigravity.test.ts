import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
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
