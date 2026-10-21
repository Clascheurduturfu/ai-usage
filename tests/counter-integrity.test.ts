import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, upsertEvents } from '../src/main/db'
import { createClaudeParser } from '../src/main/providers/claude'
import { createCodexParser } from '../src/main/providers/codex'
import { createAntigravityUsageParser } from '../src/main/providers/antigravity'
import { scanJsonlFile } from '../src/main/providers/jsonl'
import { getHistory, getProviderDetail } from '../src/main/queries'
import { DEFAULT_SETTINGS } from '../src/main/settings'
import { estimateCost } from '../src/main/pricing'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-counter-')); roots.push(root); return { root, file: path.join(root, 'session.jsonl'), db: openDb(path.join(root, 'usage.db')) } }
const time = '2026-10-16T12:00:00Z'
function claude(uuid: string, id: string, output = 9, sidechain = false, model = 'claude-haiku-5-5') {
  return JSON.stringify({ type: 'assistant', uuid, sessionId: 'session', timestamp: time, isSidechain: sidechain, cwd: '/example', message: { id, model, usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 120000, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 } }, content: [{ type: 'tool_use', id: id + '-tool', name: 'fixture' }] } })
}
describe('usage counter integrity', () => {
  it('reindexes old UUID events once and merges partial message usage across later scans', () => {
    const { db, file } = fixture()
    try {
      fs.writeFileSync(file, claude('block-a', 'api-1', 5) + '\n' + claude('block-b', 'api-1', 9) + '\n')
      const old = () => { const p = createClaudeParser(file, null); return { ...p, line(s: string) { const record = JSON.parse(s); delete record.message.id; p.line(JSON.stringify(record)) } } }
      scanJsonlFile(db, 'claude', file, old)
      expect(db.prepare('SELECT COUNT(*) count FROM usage_events').get()).toEqual({ count: 2 })
      const scan = () => scanJsonlFile(db, 'claude', file, prior => createClaudeParser(file, prior as never), 2)
      expect(scan().reindexed).toBe(true)
      expect(db.prepare('SELECT COUNT(*) count, SUM(output_tokens) output FROM usage_events').get()).toEqual({ count: 1, output: 9 })
      expect(db.prepare('SELECT COUNT(*) count FROM tool_events').get()).toEqual({ count: 1 })
      expect(scan().skipped).toBe(true)
      fs.appendFileSync(file, claude('block-c', 'api-1', 3) + '\n' + claude('block-d', 'api-2', 4) + '\n')
      scan()
      expect(db.prepare('SELECT COUNT(*) count, SUM(output_tokens) output FROM usage_events').get()).toEqual({ count: 2, output: 13 })
    } finally { db.close() }
  })
  it('keeps copied histories deduplicated and labels mixed-model/agent totals in both session views', () => {
    const { db, file, root } = fixture()
    try {
      const parser = createClaudeParser(file, null)
      parser.line(claude('a', 'api-1', 9)); parser.line(claude('b', 'api-1', 9)); parser.line(claude('c', 'api-2', 4, true, 'claude-opus-5-5'))
      upsertEvents(db, parser.events()); upsertEvents(db, parser.events())
      const settings = { ...DEFAULT_SETTINGS, paths: { claude: root } }, now = Date.parse(time) + 1000
      const history = getHistory(db, settings, { days: 90, provider: 'claude', sort: 'recent', search: 'haiku' }, now)
      const detail = getProviderDetail(db, 'claude', settings, now)
      expect(history.total).toBe(1)
      for (const row of [history.sessions[0], detail.sessions[0]]) {
        expect(row.model).toBe('Mixed · 2 models'); expect(row.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
        expect(row.requests).toBe(2); expect(row.tokens).toBe(240217); expect(row.subagentTokens).toBe(120106)
        expect(row.cost).toBeCloseTo(0.0310115, 7)
        expect(row.modelBreakdown).toEqual([
          { model: 'claude-haiku-5-5', tokens: 120111, requests: 1, cost: expect.any(Number), subagentTokens: 0, unpriced: false },
          { model: 'claude-opus-5-5', tokens: 120106, requests: 1, cost: expect.any(Number), subagentTokens: 120106, unpriced: false }
        ])
        expect(row.modelBreakdown!.reduce((sum, model) => sum + model.tokens, 0)).toBe(row.tokens)
        expect(row.modelBreakdown!.reduce((sum, model) => sum + model.cost, 0)).toBeCloseTo(row.cost, 9)
      }
      expect(detail.models.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(history.sessions[0].cost, 9)
    } finally { db.close() }
  })
  it('uses Codex cumulative deltas, skips repeated snapshots and excludes cached subsets from fresh input', () => {
    const file = '/fixture/codex.jsonl', parser = createCodexParser(file, null)
    parser.line(JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }))
    const frame = (input: number, cached: number, output: number, percent: number) => JSON.stringify({ timestamp: time, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }, rate_limits: { primary: { used_percent: percent } } } })
    parser.line(frame(100, 40, 10, 1)); parser.line(frame(100, 40, 10, 2))
    const next = createCodexParser(file, parser.state() as never); next.line(frame(250, 100, 30, 3))
    const rows = [...parser.events(), ...next.events()]
    expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.id)).size).toBe(2)
    expect(rows.reduce((sum, row) => sum + row.input_tokens + row.cache_read_tokens + row.output_tokens, 0)).toBe(280)
    expect(rows[1].input_tokens).toBe(90); expect(rows[1].cache_read_tokens).toBe(60)
    expect((parser.snapshots().at(-1)?.data as any).usedPercent).toBe(2)
  })
  it('preserves Antigravity call identities and safely distinguishes records without sequence numbers', () => {
    const { db, file } = fixture()
    try {
      const parser = createAntigravityUsageParser(file, new Map())
      const frame = (sequence: number | undefined, outputTokens: number) => JSON.stringify({ recordType: 'usage', sessionId: 'session', sequence, inputTokens: 10, outputTokens, raw: { chatModel: { chatStartMetadata: { createdAt: time } } } })
      parser.line(frame(1, 3)); parser.line(frame(1, 4)); parser.line(frame(undefined, 5)); parser.line(frame(undefined, 6)); parser.line(frame(undefined, 6))
      upsertEvents(db, parser.events())
      expect(db.prepare('SELECT COUNT(*) count, SUM(output_tokens) output FROM usage_events').get()).toEqual({ count: 3, output: 15 })
    } finally { db.close() }
  })
  it('applies Haiku 5.5 tiers per request, 1h writes and exact user overrides', () => {
    const mix = { input: 0, output: 1000, cacheRead: 100000, cacheWrite: 1000, cacheWrite1h: 1000 }
    expect(estimateCost('claude-haiku-5-5', mix, {})).toBeCloseTo(0.0017, 9)
    expect(estimateCost('claude-haiku-5-5', { ...mix, longContext: true }, {})).toBeCloseTo(0.0085, 9)
    expect(estimateCost('claude-haiku-5-5', { ...mix, longContext: true }, { 'claude-haiku-5-5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })).toBeCloseTo(0.306, 9)
  })
  it('includes separately reported Antigravity reasoning once and respects already-inclusive output', () => {
    const parser = createAntigravityUsageParser('/fixture/session/usage.jsonl', new Map())
    for (const [sequence, totalTokens] of [[1, 17], [2, 13]]) parser.line(JSON.stringify({ recordType: 'usage', sequence, inputTokens: 10, outputTokens: 3, reasoningTokens: 4, totalTokens }))
    expect(parser.events().map(row => row.output_tokens)).toEqual([7, 3])
    expect(parser.events().map(row => row.reasoning_tokens)).toEqual([4, 4])
  })
  it('reindexes large UTF-8 transcripts across chunk boundaries and retains an incomplete trailing record', () => {
    const { file, db } = fixture()
    try {
      const record = JSON.parse(claude('one', 'api-one'))
      record.message.content = [{ type: 'text', text: 'é'.repeat(280000) }]
      const tail = claude('two', 'api-two')
      fs.writeFileSync(file, JSON.stringify(record) + '\n' + tail.slice(0, -1))
      const scan = () => scanJsonlFile(db, 'claude', file, prior => createClaudeParser(file, prior as never), 2)
      scan(); expect(db.prepare('SELECT COUNT(*) count FROM usage_events').get()).toEqual({ count: 1 })
      fs.appendFileSync(file, '}\n'); scan()
      expect(db.prepare('SELECT COUNT(*) count FROM usage_events').get()).toEqual({ count: 2 })
    } finally { db.close() }
  })
})
