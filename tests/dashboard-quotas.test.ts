import { describe, expect, it } from 'vitest'
import { makeQuotaCards, quotaState } from '../src/renderer/src/lib/quotas'
import type { OverviewDTO, QuotaSnapshotDTO, Settings } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/main/settings'
const now = 1_800_000_000_000
const overview = { claude: null, scan: { lastScanAt: now } } as OverviewDTO
const blank: QuotaSnapshotDTO = { chatgpt: null, antigravity: null, mistral: null, openrouter: null }
const settings: Settings = { ...DEFAULT_SETTINGS }
function snapshot(): QuotaSnapshotDTO {
  return { ...blank, chatgpt: { availableCredits: 0, totalEarnedCredits: 0, immediateResetEligible: false, planType: 'Plus', fetchedAt: now,
    primaryWindow: { usedPercent: 30, windowSeconds: 18000, resetAt: now + 3600000 }, secondaryWindow: { usedPercent: 95, windowSeconds: 604800, resetAt: now + 86400000 } } }
}
describe('quota availability and freshness', () => {
  it('uses the tightest independent window and flags low capacity', () => {
    const card = makeQuotaCards(snapshot(), settings, overview)[0]
    expect(card.windows.map((w) => w.remaining)).toEqual([70, 5])
    expect(quotaState(card, now)).toBe('low')
  })
  it('does not manufacture an allowance balance from missing spend', () => {
    const q = { ...blank, openrouter: { byokUsageMonthly: null, fetchedAt: now } } as QuotaSnapshotDTO
    const card = makeQuotaCards(q, settings, overview)[2]
    expect(card.remainingUsd).toBeUndefined()
    expect(quotaState(card, now)).toBe('unknown')
  })
  it('keeps genuine zero spend distinct from unknown spend', () => {
    const q = { ...blank, openrouter: { byokUsageMonthly: 0, fetchedAt: now } } as QuotaSnapshotDTO
    const card = makeQuotaCards(q, settings, overview)[2]
    expect(card.remainingUsd).toBe(300)
    expect(quotaState(card, now)).toBe('ready')
  })
  it('flags old data and elapsed resets instead of silently refilling capacity', () => {
    const q = snapshot(); q.chatgpt!.fetchedAt = now - 46 * 60000
    expect(quotaState(makeQuotaCards(q, settings, overview)[0], now)).toBe('stale')
    q.chatgpt!.fetchedAt = now; q.chatgpt!.primaryWindow!.resetAt = now - 1000
    expect(quotaState(makeQuotaCards(q, settings, overview)[0], now)).toBe('stale')
  })
  it('treats a provider error as unavailable even with previous windows', () => {
    const q = snapshot(); q.chatgpt!.error = 'HTTP 401'
    expect(quotaState(makeQuotaCards(q, settings, overview)[0], now)).toBe('unknown')
  })
  it('clamps over-limit values without assuming unknown reset times', () => {
    const q = snapshot(); q.chatgpt!.primaryWindow!.usedPercent = 120; q.chatgpt!.primaryWindow!.resetAt = 0
    const card = makeQuotaCards(q, settings, overview)[0]
    expect(card.windows[0]).toMatchObject({ remaining: 0, resetAt: null })
  })
  it('identifies a local Codex snapshot as a fallback when no live snapshot exists', () => {
    const local = { ...overview, codex: { tokens7d: 0, limit: { usedPercent: 35, windowMinutes: 10080, resetsAt: now + 100000, planType: 'Plus', observedAt: now, sessionCount: 1 } } }
    const card = makeQuotaCards(blank, settings, local)[0]
    expect(card.subtitle).toBe('Last observed in Codex logs')
    expect(card.windows[0].remaining).toBe(65)
    expect(quotaState(card, now)).toBe('ready')
  })
})
describe('tray quota lines', () => {
  it('formats pinned cards from the same data as the Overview', async () => {
    const { trayQuotaLine } = await import('../src/shared/quotas')
    const cards = makeQuotaCards(snapshot(), settings, overview)
    expect(trayQuotaLine(cards.find(c => c.id === 'codex')!, now)).toBe('ChatGPT / Codex: 70% (5h) · 5% (week)')
    expect(trayQuotaLine(cards.find(c => c.id === 'antigravity')!, now)).toBe('Antigravity: not connected')
    const failed = makeQuotaCards({ ...snapshot(), chatgpt: { ...snapshot().chatgpt!, error: 'HTTP 401' } }, settings, overview)
    expect(trayQuotaLine(failed[0], now)).toContain('· last known')
    expect(trayQuotaLine(cards.find(c => c.id === 'claude')!, now)).toBe('Claude Code: ~100% of 5-hour estimate')
  })
})
