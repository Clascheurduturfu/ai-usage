import { describe, expect, it } from 'vitest'
import { estimateCost, priceFor } from '../src/main/pricing'
import type { Settings } from '../src/shared/types'

const overrides: Settings['pricingOverrides'] = {}

describe('pricing catalog', () => {
  it('matches Claude Sonnet 4.5 family', () => {
    const p = priceFor('claude-sonnet-4-5-20251001', overrides)
    expect(p).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
  })

  it('matches the Claude 5 generation (opus-5, sonnet-5)', () => {
    expect(priceFor('claude-opus-5', overrides)?.input).toBe(5)
    expect(priceFor('claude-opus-5', overrides)?.output).toBe(25)
    expect(priceFor('claude-sonnet-5', overrides)?.input).toBe(3)
  })

  it('matches Claude Opus 4.5+ vs older Opus 4', () => {
    expect(priceFor('claude-opus-4-6', overrides)?.input).toBe(5)
    expect(priceFor('claude-opus-4-20250514', overrides)?.input).toBe(15)
  })

  it('distinguishes GLM 5.3 flash from GLM 5.3', () => {
    expect(priceFor('glm-5.3-flash', overrides)?.input).toBe(0.11)
    expect(priceFor('z-ai/glm-5.3', overrides)?.input).toBe(0.55)
  })

  it('matches Codex models', () => {
    expect(priceFor('gpt-5.2-codex', overrides)).toEqual({
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 1.75
    })
  })

  it('returns null for unknown models', () => {
    expect(priceFor('totally-unknown-model', overrides)).toBeNull()
    expect(priceFor(null, overrides)).toBeNull()
  })

  it('free-tier models are priced at zero (known, not unpriced)', () => {
    expect(priceFor('muse-spark-1.3-contributor-free', overrides)?.input).toBe(0)
  })

  it('exact-model overrides win over the catalog', () => {
    const p = priceFor('my-custom-model', { 'my-custom-model': { input: 2, output: 4 } })
    expect(p?.input).toBe(2)
    expect(p?.output).toBe(4)
    expect(p?.cacheRead).toBeCloseTo(0.2, 6) // defaults to 10% of input
    expect(p?.cacheWrite).toBe(2) // defaults to input
  })
})

describe('estimateCost', () => {
  it('computes per-component cost', () => {
    const cost = estimateCost(
      'claude-sonnet-4-5',
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      {}
    )
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 4)
  })

  it('returns null when the model is unpriced', () => {
    expect(estimateCost('mystery-model', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, {})).toBeNull()
  })

  it('scales for small volumes', () => {
    const cost = estimateCost('glm-5.3', { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }, {})
    // 1000 tokens at $0.55/M in and $2.10/M out
    expect(cost).toBeCloseTo(0.00055 + 0.0021, 8)
  })
})
