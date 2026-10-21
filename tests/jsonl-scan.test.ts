import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, getFileIndex } from '../src/main/db'
import { readCompleteLines, scanJsonlFile } from '../src/main/providers/jsonl'
import { createClaudeParser } from '../src/main/providers/claude'
import type { ProviderId } from '../src/shared/types'

const tmpDirs: string[] = []

function tmpWorkspace(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-test-'))
  const dbPath = path.join(dir, 'usage.db')
  tmpDirs.push(dir)
  return { dir, dbPath }
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

function assistantLine(uuid: string, ts: string, tokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    cwd: 'C:\\proj',
    sessionId: 'sess-1',
    message: {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: tokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: []
    }
  })
}

describe('readCompleteLines', () => {
  it('returns only fully terminated lines', () => {
    const { dir } = tmpWorkspace()
    const file = path.join(dir, 'a.jsonl')
    fs.writeFileSync(file, 'line1\nline2\npartial-without-newline')
    const r = readCompleteLines(file, 0)
    expect(r.lines).toEqual(['line1', 'line2'])
    expect(r.bytes).toBe('line1\nline2\n'.length)
  })

  it('reads from an offset', () => {
    const { dir } = tmpWorkspace()
    const file = path.join(dir, 'a.jsonl')
    fs.writeFileSync(file, 'hello world\nsecond\n')
    const r = readCompleteLines(file, 'hello world\n'.length)
    expect(r.lines).toEqual(['second'])
  })
})

describe('incremental JSONL scanning', () => {
  it('parses new files, appends incrementally, and handles partial writes', () => {
    const { dir, dbPath } = tmpWorkspace()
    const db = openDb(dbPath)
    try {
      const file = path.join(dir, 'sess.jsonl')
      const scan = (p: ProviderId = 'claude'): ReturnType<typeof scanJsonlFile> =>
        scanJsonlFile(db, p, file, (prior) => createClaudeParser(file, prior as never))

      // First scan: two complete lines
      fs.writeFileSync(
        file,
        assistantLine('u1', '2026-09-19T10:00:00Z', 10) + '\n' + assistantLine('u2', '2026-09-19T10:01:00Z', 20) + '\n'
      )
      const r1 = scan()
      expect(r1.skipped).toBe(false)
      expect(r1.added).toBe(2)

      const idx = getFileIndex(db, file.replaceAll('\\', '/'))
      expect(idx?.event_count).toBe(2)
      expect(idx?.byte_offset).toBe(fs.statSync(file).size)

      // Re-scan without changes -> skipped
      expect(scan().skipped).toBe(true)

      // Append a complete line + the first half of another line (writer mid-line).
      // The partial is a clean slice of a valid serialized line so that
      // completing it later yields valid JSON, exactly like a real writer.
      const fullU4 = assistantLine('u4', '2026-09-19T10:03:00Z', 40)
      const cut = 37
      fs.appendFileSync(file, assistantLine('u3', '2026-09-19T10:02:00Z', 30) + '\n')
      fs.appendFileSync(file, fullU4.slice(0, cut))

      const r2 = scan()
      expect(r2.added).toBe(1)
      const idx2 = getFileIndex(db, file.replaceAll('\\', '/'))
      expect(idx2?.event_count).toBe(3)
      // partial line not consumed
      expect(idx2?.byte_offset).toBeLessThan(fs.statSync(file).size)

      // Complete the partial line -> picked up
      fs.appendFileSync(file, fullU4.slice(cut) + '\n')
      const r3 = scan()
      expect(r3.added).toBe(1)
      const total = db.prepare('SELECT COUNT(*) c FROM usage_events').get() as { c: number }
      expect(total.c).toBe(4)
    } finally {
      db.close()
    }
  })

  it('re-indexes a file that shrank (rotated/rewritten)', () => {
    const { dir, dbPath } = tmpWorkspace()
    const db = openDb(dbPath)
    try {
      const file = path.join(dir, 'sess.jsonl')
      fs.writeFileSync(
        file,
        assistantLine('u1', '2026-09-19T10:00:00Z', 10) +
          '\n' +
          assistantLine('u2', '2026-09-19T10:01:00Z', 20) +
          '\n' +
          assistantLine('u3', '2026-09-19T10:02:00Z', 30) +
          '\n'
      )
      scanJsonlFile(db, 'claude', file, (prior) => createClaudeParser(file, prior as never))
      expect((db.prepare('SELECT COUNT(*) c FROM usage_events').get() as { c: number }).c).toBe(3)

      // File replaced by a shorter one -> full reparse, no duplicates
      fs.writeFileSync(file, assistantLine('v1', '2026-09-20T10:00:00Z', 5) + '\n')
      const r = scanJsonlFile(db, 'claude', file, (prior) => createClaudeParser(file, prior as never))
      expect(r.reindexed).toBe(true)
      const rows = db.prepare('SELECT id FROM usage_events ORDER BY id').all() as Array<{ id: string }>
      expect(rows).toEqual([{ id: 'claude:v1' }])
    } finally {
      db.close()
    }
  })
})
