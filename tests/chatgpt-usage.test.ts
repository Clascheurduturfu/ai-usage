import { describe, expect, it } from 'vitest'
import { parseCodexUsageWindows } from '../src/main/quota'

const LIVE_SAMPLE = {
  user_id: 'user-abc',
  account_id: '5dbd7e13-75ee-48c8-b169-55f698cc4dff',
  email: 'support@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 18000,
      reset_after_seconds: 18000,
      reset_at: 1790519003
    },
    secondary_window: {
      used_percent: 7,
      limit_window_seconds: 604800,
      reset_after_seconds: 548503,
      reset_at: 1791049505
    }
  },
  code_review_rate_limit: null
}

describe('ChatGPT live usage parser', () => {
  it('extracts both windows with ms timestamps, plan and email', () => {
    const parsed = parseCodexUsageWindows(LIVE_SAMPLE)
    expect(parsed.planType).toBe('plus')
    expect(parsed.email).toBe('support@example.com')
    expect(parsed.primaryWindow).toEqual({
      usedPercent: 0,
      windowSeconds: 18000,
      resetAt: 1790519003 * 1000
    })
    expect(parsed.secondaryWindow).toEqual({
      usedPercent: 7,
      windowSeconds: 604800,
      resetAt: 1791049505 * 1000
    })
  })

  it('tolerates missing windows and empty payloads', () => {
    const parsed = parseCodexUsageWindows({})
    expect(parsed.planType).toBeNull()
    expect(parsed.email).toBeNull()
    expect(parsed.primaryWindow).toBeNull()
    expect(parsed.secondaryWindow).toBeNull()

    const partial = parseCodexUsageWindows({
      rate_limit: { primary_window: { used_percent: 42 } }
    })
    expect(partial.primaryWindow?.usedPercent).toBe(42)
    expect(partial.primaryWindow?.resetAt).toBe(0)
    expect(partial.secondaryWindow).toBeNull()
  })
})
