import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpenRouterQuotaDTO } from '../shared/types'

/**
 * OpenRouter usage & credits for the GLM-5.3 traffic ZCode routes through it.
 * The API key is the one ZCode already stores in its own config
 * (~/.zcode/v2/config.json -> provider[].options.apiKey, "sk-or-…" format).
 * Both endpoints are OpenRouter's documented read-only APIs.
 */

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits'
const KEY_URL = 'https://openrouter.ai/api/v1/auth/key'

interface ZcodeProviderEntry {
  provider?: string
  options?: { apiKey?: string }
}

/** Extract the first OpenRouter key from ZCode's config without printing it. */
export function findOpenRouterKey(configPath?: string): { key: string; at: string } | null {
  const p = configPath ?? path.join(os.homedir(), '.zcode', 'v2', 'config.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { provider?: Record<string, ZcodeProviderEntry> }
    const providers = parsed.provider ?? {}
    for (const [id, entry] of Object.entries(providers)) {
      const key = entry?.options?.apiKey
      if (typeof key === 'string' && key.startsWith('sk-or-')) {
        return { key, at: `provider/${id}/options/apiKey` }
      }
    }
    return null
  } catch {
    return null
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function fetchOpenRouterQuota(): Promise<OpenRouterQuotaDTO | null> {
  const found = findOpenRouterKey()
  const base = { fetchedAt: Date.now() }
  if (!found) return null

  try {
    const headers = { Authorization: `Bearer ${found.key}` }
    const [creditsRes, keyRes] = await Promise.all([
      fetch(CREDITS_URL, { headers, signal: AbortSignal.timeout(15_000) }),
      fetch(KEY_URL, { headers, signal: AbortSignal.timeout(15_000) })
    ])
    if (!creditsRes.ok || !keyRes.ok) {
      return {
        ...base,
        usageDaily: null,
        usageWeekly: null,
        usageMonthly: null,
        byokUsageDaily: null,
        byokUsageMonthly: null,
        totalCredits: null,
        totalUsage: null,
        limit: null,
        isFreeTier: null,
        error: `HTTP ${creditsRes.status}/${keyRes.status}`
      }
    }
    const credits = ((await creditsRes.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } }).data
    const keyInfo = ((await keyRes.json()) as {
      data?: {
        usage?: unknown
        usage_daily?: unknown
        usage_weekly?: unknown
        usage_monthly?: unknown
        byok_usage_daily?: unknown
        byok_usage_monthly?: unknown
        limit?: unknown
        is_free_tier?: unknown
      }
    }).data

    return {
      ...base,
      usageDaily: num(keyInfo?.usage_daily) ?? 0,
      usageWeekly: num(keyInfo?.usage_weekly) ?? 0,
      usageMonthly: num(keyInfo?.usage_monthly) ?? 0,
      byokUsageDaily: num(keyInfo?.byok_usage_daily) ?? 0,
      byokUsageMonthly: num(keyInfo?.byok_usage_monthly) ?? 0,
      totalCredits: num(credits?.total_credits),
      totalUsage: num(credits?.total_usage),
      limit: num(keyInfo?.limit),
      isFreeTier: typeof keyInfo?.is_free_tier === 'boolean' ? keyInfo.is_free_tier : null,
      error: undefined
    }
  } catch (err) {
    return {
      ...base,
      usageDaily: null,
      usageWeekly: null,
      usageMonthly: null,
      byokUsageDaily: null,
      byokUsageMonthly: null,
      totalCredits: null,
      totalUsage: null,
      limit: null,
      isFreeTier: null,
      error: (err as Error).message
    }
  }
}
