import { describe, expect, it } from 'vitest'
import { computeBlocks, FIVE_HOURS } from '../src/main/blocks'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function ev(ts: number, tokens: number, sessionId = 's1'): { ts: number; tokens: number; cost: number; sessionId: string } {
  return { ts, tokens, cost: tokens / 1e6, sessionId }
}

describe('computeBlocks (Claude 5-hour windows)', () => {
  it('groups events inside one 5-hour span', () => {
    const blocks = computeBlocks([ev(NOW - HOUR, 10), ev(NOW - 30 * 60_000, 20)], NOW, 100)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].tokens).toBe(30)
    expect(blocks[0].sessions).toBe(1)
    expect(blocks[0].active).toBe(true)
  })

  it('starts a new block at the 5-hour boundary', () => {
    const t0 = NOW - 6 * HOUR
    const blocks = computeBlocks([ev(t0, 10), ev(t0 + 4 * HOUR, 20), ev(t0 + 5 * HOUR, 40)], NOW, 100)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].tokens).toBe(40) // newest block first
    expect(blocks[1].tokens).toBe(30)
  })

  it('marks a block inactive once its window has passed', () => {
    const t0 = NOW - 10 * HOUR
    const blocks = computeBlocks([ev(t0, 5), ev(t0 + HOUR, 5)], NOW, 100)
    expect(blocks[0].active).toBe(false)
    expect(blocks[0].end).toBe(t0 + FIVE_HOURS)
  })

  it('computes percent against the limit and caps at 100', () => {
    const blocks = computeBlocks([ev(NOW - HOUR, 150)], NOW, 100)
    expect(blocks[0].percent).toBe(100)
    const half = computeBlocks([ev(NOW - HOUR, 50)], NOW, 100)
    expect(half[0].percent).toBe(50)
  })

  it('counts distinct sessions per block', () => {
    const blocks = computeBlocks(
      [ev(NOW - HOUR, 1, 'a'), ev(NOW - 2 * HOUR, 1, 'b'), ev(NOW - 3 * HOUR, 1, 'a')],
      NOW,
      100
    )
    expect(blocks[0].sessions).toBe(2)
  })

  it('returns blocks sorted newest-first', () => {
    const blocks = computeBlocks([ev(NOW - 8 * HOUR, 1), ev(NOW - HOUR, 2)], NOW, 100)
    expect(blocks[0].start).toBeGreaterThan(blocks[1].start)
  })
})
