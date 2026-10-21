import type { BlockInfo } from '../shared/types'

export interface BlockEvent {
  ts: number
  tokens: number
  cost: number
  sessionId: string | null
}

export const FIVE_HOURS = 5 * 60 * 60 * 1000

/**
 * Claude-style rolling 5-hour usage blocks: a block starts at the first event
 * and spans 5 hours; any event landing inside the span joins the block; the
 * first event after the span starts a new block. Mirrors the billing behavior
 * community tools use for Claude Pro/Max plans.
 */
export function computeBlocks(
  events: BlockEvent[],
  now: number,
  limitTokens: number,
  windowMs: number = FIVE_HOURS
): BlockInfo[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const blocks: BlockInfo[] = []
  let current: { start: number; events: BlockEvent[] } | null = null

  for (const e of sorted) {
    if (!current || e.ts - current.start >= windowMs) {
      if (current) blocks.push(finalize(current))
      current = { start: e.ts, events: [e] }
    } else {
      current.events.push(e)
    }
  }
  if (current) blocks.push(finalize(current))

  function finalize(b: { start: number; events: BlockEvent[] }): BlockInfo {
    const tokens = b.events.reduce((s, e) => s + e.tokens, 0)
    const cost = b.events.reduce((s, e) => s + e.cost, 0)
    const sessions = new Set(b.events.map((e) => e.sessionId).filter((x): x is string => !!x)).size
    const end = b.start + windowMs
    return {
      start: b.start,
      end,
      tokens,
      cost,
      active: end > now,
      sessions,
      percent: limitTokens > 0 ? Math.min(100, (tokens / limitTokens) * 100) : 0
    }
  }

  return blocks.reverse() // most recent first
}
