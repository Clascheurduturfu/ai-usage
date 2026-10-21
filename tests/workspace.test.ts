import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, upsertEvents } from '../src/main/db'
import type { DB, UpsertEvent } from '../src/main/db'
import { getAnalytics, getHistory } from '../src/main/queries'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../src/main/settings'
const now = new Date(2026, 9, 8, 15, 0).getTime()
let db: DB, dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-workspace-')); db = openDb(path.join(dir, 'usage.db')) })
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
function event(id: string, patch: Partial<UpsertEvent> = {}): UpsertEvent {
  return { id, provider: 'codex', ts: now - 1000, session_id: id, project: 'C:/Projects/ExampleDashboard', model: 'sample-priced', kind: 'tokens',
    input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 2, source_file: null, meta: null, ...patch }
}
describe('usage history', () => {
  it('merges multi-model sessions and filters before pagination', () => {
    upsertEvents(db, [event('a', { session_id: 'same' }), event('b', { session_id: 'same', model: 'other', input_tokens: 500 }), event('c'), event('d', { provider: 'claude', project: 'C:/Projects/ExampleApi' })])
    const result = getHistory(db, DEFAULT_SETTINGS, { days: 7, provider: 'codex', search: 'exampledashboard', limit: 1, sort: 'tokens' }, now)
    expect(result.total).toBe(2)
    expect(result.sessions[0]).toMatchObject({ id: 'same', tokens: 1700, cost: 4, requests: 2 })
    expect(getHistory(db, DEFAULT_SETTINGS, { days: 7, provider: 'codex', limit: 1, offset: 1 }, now).sessions).toHaveLength(1)
  })
  it('uses the selected calendar period and excludes future events', () => {
    upsertEvents(db, [event('today'), event('old', { ts: now - 40 * 86400000 }), event('future', { ts: now + 86400000 })])
    expect(getHistory(db, DEFAULT_SETTINGS, { days: 30 }, now).total).toBe(1)
    expect(getHistory(db, DEFAULT_SETTINGS, { days: 90 }, now).total).toBe(2)
  })
  it('keeps activity-only sessions searchable without guessed tokens', () => {
    upsertEvents(db, [event('activity', { provider: 'gemini', kind: 'request', input_tokens: 0, output_tokens: 0, cost_usd: null })])
    expect(getHistory(db, DEFAULT_SETTINGS, { days: 1, search: 'Gemini' }, now).sessions[0]).toMatchObject({ tokens: 0, cost: 0, requests: 1 })
  })
  it('keeps a recorded zero cost and adds estimates for unbilled events of the same model', () => {
    const settings = { ...DEFAULT_SETTINGS, pricingOverrides: { 'sample-priced': { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } } }
    upsertEvents(db, [event('free', { session_id: 'mixed', cost_usd: 0 }), event('estimated', { session_id: 'mixed', cost_usd: null }), event('paid', { session_id: 'mixed', cost_usd: 2 })])
    expect(getHistory(db, settings, { days: 1 }, now).sessions[0].cost).toBe(3)
    const analytics = getAnalytics(db, settings, now, { days: 1 })
    expect(analytics.models[0].cost).toBe(3)
    expect(analytics.projects[0].cost).toBe(3)
    expect(analytics.series90d[0].cost).toBe(3)
  })
  it('marks unknown model prices instead of implying a free request', () => {
    upsertEvents(db, [event('unknown', { model: 'not-in-the-catalog', cost_usd: null })])
    expect(getHistory(db, DEFAULT_SETTINGS, { days: 1 }, now).sessions[0]).toMatchObject({ cost: 0, unpriced: true })
  })
})
describe('filtered insights', () => {
  it('filters every ranking and chart by the same provider and time period', () => {
    upsertEvents(db, [event('today'), event('old', { ts: now - 40 * 86400000 }), event('other', { provider: 'claude' })])
    const result = getAnalytics(db, DEFAULT_SETTINGS, now, { days: 7, provider: 'codex' })
    expect(result.series90d).toHaveLength(7)
    expect(result.series90d.reduce((n, s) => n + s.total, 0)).toBe(1100)
    expect(result.projects[0]).toMatchObject({ provider: 'codex', tokens: 1100, cost: 2 })
    expect(result.models).toHaveLength(1)
  })
  it('includes activity-only projects without inventing costs', () => {
    upsertEvents(db, [event('activity', { provider: 'gemini', kind: 'request', input_tokens: 0, output_tokens: 0, cost_usd: null })])
    expect(getAnalytics(db, DEFAULT_SETTINGS, now, { days: 1 }).projects[0]).toMatchObject({ provider: 'gemini', tokens: 0, requests: 1, cost: 0 })
  })
})
describe('settings compatibility and validation', () => {
  it('loads new pinned-card defaults from an existing settings record', () => {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('settings', JSON.stringify({ theme: 'light' }))
    expect(getSettings(db)).toMatchObject({ theme: 'light', pinnedQuotas: ['codex', 'antigravity', 'openrouter'] })
  })
  it('normalizes empty custom paths back to auto-detection', () => {
    expect(saveSettings(db, { paths: { codex: '  ' } }).paths).toEqual({})
  })
  it('rejects invalid limits and prices without saving a partial patch', () => {
    expect(() => saveSettings(db, { openrouterByokMonthlyAllowance: -1 })).toThrow()
    expect(() => saveSettings(db, { pricingOverrides: { bad: { input: Infinity } } })).toThrow()
    expect(getSettings(db).openrouterByokMonthlyAllowance).toBe(300)
  })
})
