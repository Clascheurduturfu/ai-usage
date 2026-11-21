import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AntigravityQuotaDTO, ChatGptQuotaDTO, ClaudeQuotaDTO, ChatGptWindowDTO, MistralPlanDTO, OpenRouterQuotaDTO, QuotaSnapshotDTO } from '../shared/types'
import type { DB } from './db'
import { kvGet, kvSet } from './db'
import { carryOverBuckets, fetchAntigravityQuota, verifiedAntigravityClientSecret } from './antigravity-quota'
import { fetchOpenRouterQuota } from './openrouter-quota'
import { fetchClaudeQuota } from './claude-quota'
import { mistralRoot, readMistralWhoamiCache } from './providers/mistral'
import { getSettings } from './settings'

/**
 * Live account quota lookups, using credentials that already exist locally:
 * - ChatGPT/Codex: ~/.codex/auth.json OAuth tokens (the same ones Codex Switcher
 *   uses) against chatgpt.com/backend-api/wham/rate-limit-reset-credits.
 * - Mistral Vibe: the API key vibe stores in ~/.vibe/.env, against
 *   /api/vibe/whoami (plan info; Mistral exposes no public usage endpoint).
 * Quota reads do not invoke models or spend inference tokens.
 */

const CHATGPT_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const AUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const MISTRAL_WHOAMI_URL = 'https://api.mistral.ai/api/vibe/whoami'

interface CodexAuth {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

function codexAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json')
}

function readCodexAuth(): CodexAuth | null {
  try {
    return JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8')) as CodexAuth
  } catch {
    return null
  }
}

/** Atomic write-back so a concurrent Codex process never reads a partial file. */
function writeCodexAuth(auth: CodexAuth, expected: CodexAuth): void {
  const p = codexAuthPath()
  const tmp = `${p}.${randomUUID()}.aiu-tmp`
  const current = readCodexAuth()
  if (JSON.stringify(current?.tokens) !== JSON.stringify(expected.tokens) || current?.auth_mode !== expected.auth_mode) throw new Error('Codex sign-in changed during refresh; refresh again to use its current session')
  try { fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, p) }
  finally { fs.rmSync(tmp, { force: true }) }
}

async function refreshCodexTokens(auth: CodexAuth): Promise<CodexAuth> {
  const refresh_token = auth.tokens?.refresh_token
  if (!refresh_token) throw new Error('no refresh token in ~/.codex/auth.json')
  const res = await fetch(AUTH_TOKEN_URL, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token
    })
  })
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`)
  const data = (await res.json()) as {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  if (!data.access_token || !data.refresh_token) throw new Error('token refresh returned incomplete tokens')
  return {
    ...auth,
    tokens: {
      ...auth.tokens,
      id_token: data.id_token ?? auth.tokens?.id_token,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      account_id: data.account_id ?? auth.tokens?.account_id
    },
    last_refresh: new Date().toISOString()
  }
}

async function chatgptFetch(url: string, accessToken: string, accountId: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'ai-usage-for-windows'
  }
  if (accountId) headers['chatgpt-account-id'] = accountId
  return fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
}

interface CreditsPayload {
  credits?: unknown[]
  available_count?: number
  total_earned_count?: number
  immediate_reset_purchase_eligible?: boolean
}

interface UsageWindowPayload {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
  window_minutes?: number
  resets_at?: number
}

export interface UsagePayload {
  email?: string
  plan_type?: string
  rate_limit?: {
    primary_window?: UsageWindowPayload | null
    secondary_window?: UsageWindowPayload | null
    primary?: UsageWindowPayload | null
    secondary?: UsageWindowPayload | null
  }
  rate_limits?: UsagePayload
}

/** Parse the live /codex/usage payload into window DTOs (exported for tests). */
export function parseCodexUsageWindows(payload: UsagePayload): {
  email: string | null
  planType: string | null
  primaryWindow: ChatGptWindowDTO | null
  secondaryWindow: ChatGptWindowDTO | null
} {
  const toWindow = (w: UsageWindowPayload | null | undefined): ChatGptWindowDTO | null =>
    w && typeof w.used_percent === 'number' && Number.isFinite(w.used_percent)
      ? {
          usedPercent: w.used_percent,
          windowSeconds: num(w.limit_window_seconds) || num(w.window_minutes) * 60,
          resetAt: typeof (w.reset_at ?? w.resets_at) === 'number' ? num(w.reset_at ?? w.resets_at) * 1000 : typeof w.reset_after_seconds === 'number' ? Date.now() + w.reset_after_seconds * 1000 : 0
        }
      : null
  const limits = payload.rate_limits ?? payload
  return {
    email: typeof payload.email === 'string' ? payload.email : null,
    planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
    primaryWindow: toWindow(limits.rate_limit?.primary_window ?? limits.rate_limit?.primary),
    secondaryWindow: toWindow(limits.rate_limit?.secondary_window ?? limits.rate_limit?.secondary)
  }
}

export async function fetchChatGptQuota(db: DB): Promise<ChatGptQuotaDTO | null> {
  const auth = readCodexAuth()
  if (!auth?.tokens?.access_token) return null

  const base = {
    immediateResetEligible: false,
    planType: latestCodexPlanType(db),
    email: null as string | null,
    primaryWindow: null as ChatGptWindowDTO | null,
    secondaryWindow: null as ChatGptWindowDTO | null,
    fetchedAt: Date.now()
  }

  try {
    const call = async (token: string, account: string | undefined, url: string): Promise<Response> =>
      chatgptFetch(url, token, account)

    let accessToken = auth.tokens.access_token
    let accountId = auth.tokens.account_id
    const read = () => Promise.allSettled([call(accessToken, accountId, CHATGPT_USAGE_URL), call(accessToken, accountId, CHATGPT_CREDITS_URL)])
    let results = await read()
    if (results.some(r => r.status === 'fulfilled' && r.value.status === 401)) {
      // Access token expired: refresh it exactly like Codex CLI does and persist
      // the rotated tokens back to auth.json (Codex re-reads this file itself).
      const current = readCodexAuth()
      const changed = current?.tokens?.access_token && JSON.stringify(current.tokens) !== JSON.stringify(auth.tokens)
      const refreshed = changed ? current! : await refreshCodexTokens(auth)
      if (!changed) writeCodexAuth(refreshed, auth)
      accessToken = refreshed.tokens!.access_token!
      accountId = refreshed.tokens!.account_id
      results = await read()
    }

    // Live usage windows for the CURRENT account (5h + weekly) — independent of
    // any session log, so multi-account setups can't mix numbers up.
    let usage: UsagePayload | null = null
    let usageError: string | undefined
    const [usageResult, creditsResult] = results
    try {
      if (usageResult.status === 'rejected') throw usageResult.reason
      if (!usageResult.value.ok) throw new Error(`HTTP ${usageResult.value.status}`)
      usage = await usageResult.value.json() as UsagePayload
    } catch (error) { usageError = `Codex usage windows: ${(error as Error).message}` }
    const live = parseCodexUsageWindows(usage ?? {})
    if (!usageError && !live.primaryWindow && !live.secondaryWindow) usageError = 'Codex usage returned no quota windows for this account'
    let credits: CreditsPayload | null = null
    try { if (creditsResult.status === 'fulfilled' && creditsResult.value.ok) credits = await creditsResult.value.json() as CreditsPayload } catch { /* credit balance does not gate usage windows */ }
    const dto: ChatGptQuotaDTO = {
      ...base,
      availableCredits: credits ? num(credits.available_count) : null,
      totalEarnedCredits: credits ? num(credits.total_earned_count) : 0,
      immediateResetEligible: credits?.immediate_reset_purchase_eligible === true,
      planType: live.planType ?? base.planType,
      email: live.email,
      primaryWindow: live.primaryWindow,
      secondaryWindow: live.secondaryWindow,
      error: usageError
    }
    kvSet(db, 'quota:chatgpt', dto)
    return dto
  } catch (err) {
    const dto: ChatGptQuotaDTO = {
      ...base,
      availableCredits: null,
      totalEarnedCredits: 0,
      error: (err as Error).message
    }
    kvSet(db, 'quota:chatgpt', dto)
    return dto
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** The plan type Codex itself reported in its most recent rate-limit snapshot. */
function latestCodexPlanType(db: DB): string {
  try {
    const rows = db
      .prepare(`SELECT data FROM snapshots WHERE provider = 'codex' AND key LIKE 'codex:limit:%'`)
      .all() as unknown as Array<{ data: string }>
    let latest: { planType: string; observedAt: number } | null = null
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.data) as { planType: string; observedAt: number }
        if (!latest || parsed.observedAt > latest.observedAt) latest = parsed
      } catch {
        /* ignore */
      }
    }
    return latest?.planType ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Join a path fragment onto a possibly-UNC root (//wsl.localhost/…).
 * path.posix.join would collapse the leading double slash — concatenate instead.
 */
function uncJoin(root: string, name: string): string {
  const r = root.replaceAll('\\', '/')
  return r.endsWith('/') ? r + name : `${r}/${name}`
}

/** Read the API key vibe persists in its own env file (`<vibe root>/.env`). */
function readMistralApiKey(root: string): string | null {
  try {
    const envPath = uncJoin(root, '.env')
    const text = fs.readFileSync(envPath, 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?MISTRAL_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/i.exec(line)
      if (m) return m[1]
    }
    return null
  } catch {
    return null
  }
}

export async function fetchMistralPlan(root: string, db: DB): Promise<MistralPlanDTO | null> {
  const key = readMistralApiKey(root)
  try {
    if (key) {
      const res = await fetch(MISTRAL_WHOAMI_URL, {
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'ai-usage-for-windows' }
      })
      if (res.ok) {
        const data = (await res.json()) as { plan_type?: string; plan_name?: string }
        const dto: MistralPlanDTO = {
          planType: data.plan_type ?? 'unknown',
          planName: data.plan_name ?? 'unknown',
          fetchedAt: Date.now()
        }
        kvSet(db, 'quota:mistral', dto)
        return dto
      }
    }
    // No API key (or live call failed): fall back to the plan info vibe caches
    // in whoami_cache.json — still accurate for the account signed into vibe.
    const cached = readMistralWhoamiCache(root)
    if (cached) {
      const dto: MistralPlanDTO = {
        planType: cached.planType,
        planName: cached.planName,
        fetchedAt: Date.now()
      }
      kvSet(db, 'quota:mistral', dto)
      return dto
    }
    return null
  } catch (err) {
    const dto: MistralPlanDTO = {
      planType: 'unknown',
      planName: 'unknown',
      fetchedAt: Date.now(),
      error: (err as Error).message
    }
    kvSet(db, 'quota:mistral', dto)
    return dto
  }
}

export function getQuotaSnapshot(db: DB): QuotaSnapshotDTO {
  return {
    chatgpt: kvGet<ChatGptQuotaDTO>(db, 'quota:chatgpt') ?? null,
    mistral: kvGet<MistralPlanDTO>(db, 'quota:mistral') ?? null,
    antigravity: kvGet<AntigravityQuotaDTO>(db, 'quota:antigravity') ?? null,
    openrouter: kvGet<OpenRouterQuotaDTO>(db, 'quota:openrouter') ?? null,
    claude: kvGet<ClaudeQuotaDTO>(db, 'quota:claude') ?? null
  }
}

const REFRESH_INTERVAL_MS = 30 * 60 * 1000

export interface NtfyPublishSettings {
  server: string
  topic: string
  token: string
}

/**
 * Compact snapshot published to ntfy for the Android companion app.
 * Kept minimal — it rides inside an ntfy message body.
 */
export function buildSyncSnapshot(
  quota: QuotaSnapshotDTO,
  appVersion: string
): Record<string, unknown> {
  const cg = quota.chatgpt
  const ag = quota.antigravity
  const or = quota.openrouter
  const win = (w: { usedPercent: number; windowSeconds: number; resetAt: number } | null | undefined, id: string, label: string) =>
    w ? { id, label, leftPct: Math.max(0, 100 - w.usedPercent), resetAtMs: w.resetAt } : null

  return {
    v: 1,
    updatedAt: Date.now(),
    appVersion,
    cards: [
      cg
        ? {
            id: 'chatgpt',
            title: 'ChatGPT · Codex',
            plan: cg.planType,
            email: cg.email,
            credits: { available: cg.availableCredits, earned: cg.totalEarnedCredits },
            windows: [win(cg.secondaryWindow, 'weekly', 'Weekly'), win(cg.primaryWindow, '5h', '5-hour')].filter(
              (x): x is NonNullable<typeof x> => x !== null
            )
          }
        : null,
      ag && !ag.error
        ? {
            id: 'antigravity',
            title: 'Antigravity',
            plan: ag.plan,
            groups: Object.entries(
              ag.buckets.reduce<Record<string, Array<{ id: string; label: string; leftPct: number; resetAtMs: number }>>>(
                (acc, b) => {
                  ;(acc[b.group] ??= []).push({
                    id: b.id,
                    label: b.window === 'weekly' ? 'Weekly' : b.window === '5h' ? '5-hour' : b.label || 'Quota',
                    leftPct: Math.round(b.remainingFraction * 100),
                    resetAtMs: b.resetTime ?? 0
                  })
                  return acc
                },
                {}
              )
            ).map(([name, windows]) => ({ name, windows }))
          }
        : null,
      or
        ? {
            id: 'openrouter',
            title: 'OpenRouter · GLM 5.3',
            byokMonthUsd: or.byokUsageMonthly ?? 0,
            allowanceUsd: 0, // filled by the caller (from settings)
            leftUsd: 0,
            leftPct: 0,
            byokTodayUsd: or.byokUsageDaily ?? 0
          }
        : null
    ].filter((x): x is NonNullable<typeof x> => x !== null)
  }
}

/** Publish the snapshot to ntfy (JSON publishing format). Errors are swallowed. */
async function publishToNtfy(cfg: NtfyPublishSettings, snapshot: Record<string, unknown>): Promise<void> {
  if (!cfg.topic) return
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
    await fetch(cfg.server.replace(/\/+$/, ''), {
      signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: cfg.topic,
        title: 'AI Usage update',
        message: JSON.stringify(snapshot),
        tags: ['bar_chart']
      })
    })
  } catch {
    /* publishing is best-effort */
  }
}

export function startQuotaService(
  db: DB,
  appVersion: string,
  onChanged: () => void,
  /** The OpenRouter key saved in AI Usage's vault, if any. */
  openRouterKey?: () => Promise<string | undefined>
): { refresh(): Promise<void>; stop(): void } {
  let timer: NodeJS.Timeout | null = null
  let inFlight: Promise<void> | null = null

  const refreshNow = async (): Promise<void> => {
    try {
      const update = async (work: () => Promise<unknown>): Promise<void> => { try { await work() } finally { onChanged() } }
      await Promise.allSettled([
        update(() => fetchChatGptQuota(db)),
        ...(process.platform === 'darwin' ? [] : [update(() => fetchMistralPlan(mistralRoot(getSettings(db)), db))]),
        update(async () => {
          const storedSecret = kvGet<string>(db, 'antigravity:clientSecret')
          const agy = await fetchAntigravityQuota(storedSecret)
          const verified = verifiedAntigravityClientSecret()
          if (verified && verified !== storedSecret) kvSet(db, 'antigravity:clientSecret', verified)
          if (agy) kvSet(db, 'quota:antigravity', carryOverBuckets(kvGet<AntigravityQuotaDTO>(db, 'quota:antigravity'), agy))
        }),
        update(async () => {
          // Keep the last good spend when a refresh fails, marked with the new error (same as Claude below).
          const or = await fetchOpenRouterQuota(openRouterKey), previous = kvGet<OpenRouterQuotaDTO>(db, 'quota:openrouter')
          kvSet(db, 'quota:openrouter', or.error && or.keySource && previous?.byokUsageMonthly != null && previous.keySource === or.keySource ? { ...previous, error: or.error } : or)
        }),
        update(async () => {
          // Keep the last good windows when a refresh fails, marked with the new error.
          const claude = await fetchClaudeQuota(), previous = kvGet<ClaudeQuotaDTO>(db, 'quota:claude')
          kvSet(db, 'quota:claude', claude.error && previous?.windows.length ? { ...previous, plan: claude.plan ?? previous.plan, error: claude.error } : claude)
        })
      ])

      // Publish the sync snapshot for the Android companion (if configured)
      const settings = getSettings(db)
      if (settings.ntfyTopic) {
        const snapshot = buildSyncSnapshot(getQuotaSnapshot(db), appVersion)
        // fill the OpenRouter allowance from settings
        for (const card of (snapshot.cards as Array<Record<string, unknown>>) ?? []) {
          if (card['id'] === 'openrouter') {
            const allowance = Math.max(0, settings.openrouterByokMonthlyAllowance)
            const byok = Number(card['byokMonthUsd'] ?? 0)
            card['allowanceUsd'] = allowance
            card['leftUsd'] = Math.round(Math.max(0, allowance - byok) * 100) / 100
            card['leftPct'] = allowance > 0 ? Math.round(Math.max(0, ((allowance - byok) / allowance) * 100)) : 0
          }
        }
        await publishToNtfy(
          { server: settings.ntfyServer, topic: settings.ntfyTopic, token: settings.ntfyToken },
          snapshot
        )
      }
      onChanged()
    } catch {
      /* fetchers already record their own errors */
    }
  }

  const refresh = (): Promise<void> => {
    if (!inFlight) inFlight = refreshNow().finally(() => { inFlight = null })
    return inFlight
  }

  void refresh()
  timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS)

  return {
    refresh,
    stop(): void {
      if (timer) clearInterval(timer)
    }
  }
}
