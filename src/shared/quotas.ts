import type { BlockInfo, OverviewDTO, QuotaCardId, QuotaSnapshotDTO, Settings } from './types'

export interface QuotaWindow { id: string; label: string; remaining: number; resetAt: number | null }
export interface QuotaCard {
  id: QuotaCardId; name: string; subtitle: string; plan: string; windows: QuotaWindow[]
  fetchedAt: number | null; error?: string; estimated?: boolean; detail: string
  remainingUsd?: number; allowance?: number
}
export const QUOTA_NAMES: Record<QuotaCardId, string> = { codex: 'ChatGPT / Codex', antigravity: 'Antigravity', openrouter: 'OpenRouter', claude: 'Claude Code' }
const clamp = (n: number): number => Math.max(0, Math.min(100, n))
/** "12 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}
export function quotaState(card: QuotaCard, now: number): 'unknown' | 'stale' | 'low' | 'ready' {
  if (card.error || !card.windows.length) return 'unknown'
  if ((!card.estimated && (!card.fetchedAt || now - card.fetchedAt > 45 * 60_000)) || card.windows.some((w) => w.resetAt !== null && w.resetAt <= now)) return 'stale'
  return card.windows.some((w) => w.remaining <= 10) ? 'low' : 'ready'
}
export function makeQuotaCards(quota: QuotaSnapshotDTO | null, settings: Settings, overview: OverviewDTO): QuotaCard[] {
  const cg = quota?.chatgpt, ag = quota?.antigravity, or = quota?.openrouter
  const logged = !cg ? overview.codex?.limit : null
  const codexWindows: QuotaWindow[] = []
  for (const [key, label] of [['primaryWindow', '5-hour window'], ['secondaryWindow', 'Weekly window']] as const) {
    const window = cg?.[key]
    if (window && Number.isFinite(window.usedPercent)) codexWindows.push({ id: key, label, remaining: clamp(100 - window.usedPercent), resetAt: window.resetAt || null })
  }
  if (logged && Number.isFinite(logged.usedPercent)) {
    codexWindows.push({ id: 'logged-window', label: logged.windowMinutes >= 10080 ? 'Weekly window · from logs' : `${Math.round(logged.windowMinutes / 60)}-hour window · from logs`, remaining: clamp(100 - logged.usedPercent), resetAt: logged.resetsAt || null })
  }
  const allowance = settings.openrouterByokMonthlyAllowance
  const validSpend = or?.byokUsageMonthly != null && Number.isFinite(or.byokUsageMonthly)
  const block = overview.claude?.activeBlock
  return [
    { id: 'codex', name: QUOTA_NAMES.codex, subtitle: logged ? 'Last observed in Codex logs' : 'ChatGPT subscription', plan: cg?.planType || logged?.planType || 'Not connected', windows: codexWindows, fetchedAt: cg?.fetchedAt ?? logged?.observedAt ?? null, error: cg?.error,
      detail: cg ? cg.availableCredits != null ? `${cg.availableCredits.toLocaleString()} credits available` : 'Credit balance unavailable; quota windows are fetched separately.' : 'Sign in to Codex, then refresh your quotas.' },
    { id: 'antigravity', name: QUOTA_NAMES.antigravity, subtitle: 'Google AI subscription', plan: ag?.plan || 'Not connected',
      windows: (ag?.buckets ?? []).filter((b) => Number.isFinite(b.remainingFraction)).map((b) => ({ id: b.id, label: (b.window ? `${b.group} · ${b.window === '5h' ? '5 hours' : b.window === 'weekly' ? 'Weekly' : b.window}` : b.label || b.group) + (b.observedAt ? ` · as of ${ago(b.observedAt)}` : ''), remaining: clamp(b.remainingFraction * 100), resetAt: b.resetTime })),
      fetchedAt: ag?.fetchedAt ?? null, error: ag?.error, detail: ag?.availablePromptCredits != null ? `${ag.availablePromptCredits.toLocaleString()} prompt credits available`
        : !ag?.buckets.length ? 'Sign in to Antigravity to connect your plan.'
        : ag.source === 'google' ? `Antigravity is closed, so these limits come from Google directly.${ag.buckets.some(b => b.observedAt) ? ' Limits only Antigravity reports show their last value.' : ' Open Antigravity once to also see the limits only it reports, such as Gemini 4 Argon.'}`
        : 'Quota limits reported by Antigravity.' },
    { id: 'openrouter', name: QUOTA_NAMES.openrouter, subtitle: 'Monthly BYOK allowance', plan: 'Monthly allowance', windows: validSpend && allowance > 0 ? [{ id: 'allowance', label: 'Monthly allowance', remaining: clamp((allowance - or!.byokUsageMonthly!) / allowance * 100), resetAt: null }] : [],
      fetchedAt: or?.fetchedAt ?? null, error: or?.error, remainingUsd: validSpend ? Math.max(0, allowance - or!.byokUsageMonthly!) : undefined, allowance,
      detail: allowance <= 0 ? 'Set a monthly allowance in Settings.' : or ? 'Allowance configured by you. Provider spend is fetched live.' : 'Add an OpenRouter key in ZCode, then refresh.' },
    claudeCard(quota?.claude ?? null, settings, block, overview.scan.lastScanAt || null)
  ]
}

const PLAN_NAMES: Record<Settings['claudePlan'], string> = { custom: 'Custom limit', pro: 'Pro', max5: 'Max 5x', max20: 'Max 20x' }
/** Live limits from Anthropic when Claude Code's CLI sign-in is available; otherwise the local token estimate. */
function claudeCard(live: QuotaSnapshotDTO['claude'], settings: Settings, block: BlockInfo | null | undefined, scannedAt: number | null): QuotaCard {
  if (live?.windows.length) return { id: 'claude', name: QUOTA_NAMES.claude, subtitle: 'Claude subscription', plan: live.plan ?? PLAN_NAMES[settings.claudePlan],
    windows: live.windows.map(w => ({ id: w.id, label: w.label, remaining: clamp(100 - w.usedPercent), resetAt: w.resetAt })), fetchedAt: live.fetchedAt, error: live.error,
    detail: 'Live limits from Anthropic, the same as Claude Code’s /usage. Includes every device and claude.ai.' }
  const why = live?.error ? ` Live limits: ${live.error}` : ''
  return { id: 'claude', name: QUOTA_NAMES.claude, subtitle: 'Local estimate', plan: live?.plan ?? PLAN_NAMES[settings.claudePlan],
    // No active block means no Claude use on this device in the last five hours: the
    // estimate is a full window, not "unavailable". Other devices' use is not visible here.
    windows: settings.claude5hLimit > 0 ? [{ id: 'block', label: '5-hour token estimate', remaining: block ? clamp(100 - block.percent) : 100, resetAt: block?.end ?? null }] : [], fetchedAt: scannedAt, estimated: true,
    detail: (settings.claude5hLimit <= 0 ? 'Set your Claude plan limit in Settings to estimate the 5-hour window.' : block ? 'Estimated from Claude Code tokens on this device and your plan limit. Use on other devices and claude.ai is not included.' : 'No Claude Code use on this device in the last 5 hours. Use on other devices and claude.ai is not included.') + why }
}

const short = (label: string): string => /5-hour|5 hours/i.test(label) ? '5h' : /week/i.test(label) ? 'week' : label
/** One tray menu line per pinned card, from the same data as the Overview. */
export function trayQuotaLine(card: QuotaCard, now: number): string {
  const state = quotaState(card, now)
  if (!card.windows.length) return `${card.name}: ${card.error ? 'unavailable' : card.plan === 'Not connected' ? 'not connected' : 'no data yet'}`
  let value: string
  if (card.id === 'openrouter' && card.remainingUsd !== undefined) value = `$${card.remainingUsd.toFixed(2)} left this month`
  else if (card.id === 'claude' && card.estimated) value = `~${Math.round(card.windows[0].remaining)}% of 5-hour estimate`
  else if (card.windows.length > 2) value = `${Math.round(Math.min(...card.windows.map(w => w.remaining)))}% at tightest limit`
  else value = card.windows.map(w => `${Math.round(w.remaining)}% (${short(w.label)})`).join(' · ')
  return `${card.name}: ${value}${card.error ? ' · last known' : state === 'stale' ? ' · needs refresh' : ''}`
}
