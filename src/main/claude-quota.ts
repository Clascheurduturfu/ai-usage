import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClaudeQuotaDTO } from '../shared/types'

/**
 * Live Claude subscription limits, the same numbers Claude Code's /usage screen shows.
 * Reads Claude Code's own CLI sign-in (~/.claude/.credentials.json, or the macOS Keychain item
 * "Claude Code-credentials") and calls GET api.anthropic.com/api/oauth/usage. Read-only.
 *
 * The token is never refreshed here. Anthropic rotates the refresh token on use, so refreshing
 * from AI Usage would sign Claude Code out. An expired token just means "use Claude Code once".
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const exec = promisify(execFile)
interface OAuth { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string }
type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined

const WINDOWS: Array<[key: string, id: string, label: string]> = [
  ['five_hour', 'five_hour', '5-hour window'], ['seven_day', 'seven_day', 'Weekly window'],
  ['seven_day_opus', 'seven_day_opus', 'Weekly · Opus'], ['seven_day_sonnet', 'seven_day_sonnet', 'Weekly · Sonnet']
]

function configDir(): string { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') }

export async function readClaudeOAuth(): Promise<OAuth | null> {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(configDir(), '.credentials.json'), 'utf8'))
    if (file?.claudeAiOauth?.accessToken) return file.claudeAiOauth
  } catch { /* not a CLI sign-in on this path */ }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 })
      const item = JSON.parse(stdout.trim())
      if (item?.claudeAiOauth?.accessToken) return item.claudeAiOauth
    } catch { /* no item, locked keychain or access refused */ }
  }
  return null
}

/** "default_claude_max_5x" / subscriptionType "max" → "Max 5x". */
export function claudePlanName(oauth: Pick<OAuth, 'subscriptionType' | 'rateLimitTier'>): string | undefined {
  const tier = oauth.rateLimitTier?.match(/max_(\d+)x/i)?.[1]
  const type = oauth.subscriptionType?.toLowerCase()
  if (type === 'max' || tier) return `Max${tier ? ` ${tier}x` : ''}`
  if (type) return type.charAt(0).toUpperCase() + type.slice(1)
  return undefined
}

export function parseClaudeUsage(payload: Record<string, Window>): ClaudeQuotaDTO['windows'] {
  return WINDOWS.flatMap(([key, id, label]) => {
    const w = payload?.[key]
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return []
    const reset = w.resets_at ? Date.parse(w.resets_at) : Number.NaN
    return [{ id, label, usedPercent: Math.max(0, Math.min(100, w.utilization)), resetAt: Number.isFinite(reset) ? reset : null }]
  })
}

export async function fetchClaudeQuota(): Promise<ClaudeQuotaDTO> {
  const base: ClaudeQuotaDTO = { fetchedAt: Date.now(), windows: [] }
  const oauth = await readClaudeOAuth()
  if (!oauth?.accessToken) return { ...base, error: 'No Claude Code CLI sign-in on this device. Run `claude` in a terminal and sign in with /login to show your live limits.' }
  const plan = claudePlanName(oauth)
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now() + 30_000) return { ...base, plan, error: 'Claude Code’s sign-in expired. It renews the next time you use Claude Code; then refresh.' }
  try {
    const res = await fetch(USAGE_URL, { signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'ai-usage' } })
    if (res.status === 401) return { ...base, plan, error: 'Anthropic refused the Claude Code sign-in. Use Claude Code once to renew it, then refresh.' }
    if (!res.ok) return { ...base, plan, error: `Claude usage: HTTP ${res.status}` }
    const windows = parseClaudeUsage(await res.json() as Record<string, Window>)
    return { ...base, plan, windows, error: windows.length ? undefined : 'Anthropic returned no usage windows for this account.' }
  } catch (error) { return { ...base, plan, error: `Claude usage: ${(error as Error).message}` } }
}
