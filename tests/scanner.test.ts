import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Scanner } from '../src/main/scanner'
import { DEFAULT_SETTINGS } from '../src/main/settings'
import type { DB } from '../src/main/db'
const calls = vi.hoisted(() => [] as string[])
vi.mock('../src/main/providers', () => ({ ADAPTERS: Object.fromEntries(['claude', 'codex', 'gemini', 'opencode', 'zcode', 'antigravity', 'copilot', 'mistral'].map((id) => [id, {
  scan: () => { calls.push(id); return { filesScanned: 1, eventsAdded: 1, errors: [] } }, watchRoots: () => []
}])) }))
beforeEach(() => { calls.length = 0 })
describe('scan coordination', () => {
  it('coalesces full rescans and queues watch rescans without dropping them', async () => {
    const scanner = new Scanner({} as DB, () => DEFAULT_SETTINGS, () => undefined)
    const first = scanner.fullScan()
    expect(scanner.fullScan()).toBe(first)
    const pending = scanner.scanProvider('codex')
    await Promise.all([first, pending, scanner.whenIdle()])
    expect(calls).toHaveLength(9)
    expect(calls.at(-1)).toBe('codex')
    expect(scanner.status().scanning).toBe(false)
    scanner.close()
  })
  it('stops queued work after closing', async () => {
    const scanner = new Scanner({} as DB, () => DEFAULT_SETTINGS, () => undefined)
    const scan = scanner.fullScan(); scanner.close(); await scan
    expect(calls).toHaveLength(0)
  })
})
