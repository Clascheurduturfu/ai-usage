import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpenRouterQuotaDTO } from '../shared/types'

/**
 * OpenRouter usage & credits. The key is, in order: the one saved in AI Usage (Settings →
 * OpenRouter, kept in the encrypted vault), or the one ZCode stores in its own settings.
 * Both endpoints are OpenRouter's documented read-only APIs.
 */

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits'
const KEY_URL = 'https://openrouter.ai/api/v1/auth/key'
/** Vault id of the key saved in AI Usage. */
export const OPENROUTER_KEY_REF = 'openrouter-quota'

const isKey = (v: unknown): v is string => typeof v === 'string' && v.startsWith('sk-or-')

/**
 * The first OpenRouter key in ZCode's settings, without printing it. ZCode 2 keeps providers in
 * ~/.zcode/v2/provider_config.json (config.providerConfigRules.providerRules[].config.access.apiKey);
 * older versions used ~/.zcode/v2/config.json (provider[].options.apiKey).
 */
export function findOpenRouterKey(root = path.join(os.homedir(), '.zcode', 'v2')): { key: string; at: string } | null {
  const read = (file: string): any => { try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) } catch { return null } }
  const rules: any[] = read('provider_config.json')?.config?.providerConfigRules?.providerRules ?? []
  const ordered = [...rules].sort((a, b) => Number(b?.providerId === 'openrouter' || b?.templateId === 'openrouter') - Number(a?.providerId === 'openrouter' || a?.templateId === 'openrouter'))
  for (const rule of ordered) if (isKey(rule?.config?.access?.apiKey)) return { key: rule.config.access.apiKey, at: `provider_config.json · ${rule.providerName ?? rule.providerId}` }
  for (const [id, entry] of Object.entries<any>(read('config.json')?.provider ?? {})) if (isKey(entry?.options?.apiKey)) return { key: entry.options.apiKey, at: `config.json · ${id}` }
  return null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const EMPTY = { usageDaily: null, usageWeekly: null, usageMonthly: null, byokUsageDaily: null, byokUsageMonthly: null, totalCredits: null, totalUsage: null, limit: null, isFreeTier: null }

/** What OpenRouter said about a key it refused, in plain words. */
function refusal(status: number, source: OpenRouterQuotaDTO['keySource']): string {
  const where = source === 'ai-usage' ? 'Paste a current key in Settings → OpenRouter.' : 'Paste a current key in Settings → OpenRouter, or update it in ZCode.'
  if (status === 401 || status === 403) return `OpenRouter refused the key (HTTP ${status}): it was deleted, disabled or mistyped. ${where}`
  return `OpenRouter answered HTTP ${status}. Try refresh in a minute.`
}

/** Check a key before saving it: returns OpenRouter's label for it, or throws a readable error. */
export async function verifyOpenRouterKey(key: string): Promise<string> {
  if (!isKey(key)) throw new Error('That is not an OpenRouter API key. Keys start with “sk-or-”; create one at openrouter.ai/settings/keys.')
  const res = await fetch(KEY_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(refusal(res.status, 'ai-usage'))
  const data = ((await res.json()) as { data?: { label?: unknown } }).data
  return typeof data?.label === 'string' ? data.label : 'OpenRouter key'
}

export async function fetchOpenRouterQuota(saved?: () => Promise<string | undefined>): Promise<OpenRouterQuotaDTO> {
  const base = { fetchedAt: Date.now() }
  const own = await saved?.().catch(() => undefined)
  const zcode = own ? null : findOpenRouterKey()
  const key = own || zcode?.key, keySource: OpenRouterQuotaDTO['keySource'] = own ? 'ai-usage' : zcode ? 'zcode' : undefined
  if (!key) return { ...base, ...EMPTY, error: 'No OpenRouter key yet. Paste one in Settings → OpenRouter (or add it in ZCode), then refresh.' }

  try {
    const headers = { Authorization: `Bearer ${key}` }
    const [creditsRes, keyRes] = await Promise.all([
      fetch(CREDITS_URL, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null),
      fetch(KEY_URL, { headers, signal: AbortSignal.timeout(15_000) })
    ])
    if (!keyRes.ok) return { ...base, ...EMPTY, keySource, error: refusal(keyRes.status, keySource) }
    const keyInfo = ((await keyRes.json()) as {
      data?: { usage_daily?: unknown; usage_weekly?: unknown; usage_monthly?: unknown; byok_usage_daily?: unknown; byok_usage_monthly?: unknown; limit?: unknown; is_free_tier?: unknown }
    }).data
    // The credit balance is optional: some keys may not read it; spend still comes from the key itself.
    const credits = creditsRes?.ok ? ((await creditsRes.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } }).data : undefined

    return {
      ...base,
      keySource,
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
    return { ...base, ...EMPTY, keySource, error: `OpenRouter: ${(err as Error).message}` }
  }
}
