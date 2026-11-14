import { APP_VERSION } from '../../../shared/version'
// Development-only sample data. Never imported into a production build.
import type { AiuApi } from '../../../shared/api'
import type { UpdateStatus } from '../../../shared/update'
import type { OverviewDTO, ProviderDetailDTO, QuotaSnapshotDTO, SessionRow, Settings, UsageFilter } from '../../../shared/types'
import { PROVIDER_IDS, PROVIDER_NAMES } from '../../../shared/types'
import { demoManagerApi } from './demo-manager'
const now = Date.now()
const scenario = new URLSearchParams(location.search).get('demo')
const empty = scenario === 'empty'
const dayKey = (ts: number): string => new Date(ts).toLocaleDateString('en-CA')
const sessions: SessionRow[] = empty ? [] : Array.from({ length: 85 }, (_, i) => ({
  provider: PROVIDER_IDS[i % 5], id: `sample-session-${i}`, project: `C:/Projects/${['Example Dashboard', 'Example API', 'Example CLI', 'Example Notes', 'Example Site'][i % 5]}`,
  model: ['claude-sonnet-4-5', 'gpt-5', 'gemini-2.5-pro', 'glm-4.5', 'mistral-large'][i % 5],
  startedAt: now - i * 7 * 3_600_000 - 1_000_000, lastAt: now - i * 7 * 3_600_000,
  tokens: i % 5 === 2 ? 0 : 80_000 + (i * 71_791) % 700_000, cost: i % 5 === 2 ? 0 : 2.1 + (i * 13) % 40, requests: 10 + i * 3
}))
let settings: Settings = { pinnedQuotas: ['codex', 'antigravity', 'openrouter'], theme: 'dark', launchAtLogin: false, startMinimized: false,
  claudePlan: 'max5', claude5hLimit: 160000, claudeWeeklyLimit: null, openrouterByokMonthlyAllowance: 300,
  ntfyServer: 'https://ntfy.sh', ntfyTopic: '', ntfyToken: '', paths: {}, pricingOverrides: {} }
const stamp = scenario === 'stale' ? now - 4 * 3_600_000 : now
let quota: QuotaSnapshotDTO = {
  chatgpt: empty ? null : { availableCredits: 120, totalEarnedCredits: 300, immediateResetEligible: false, planType: 'Plus', fetchedAt: stamp,
    primaryWindow: { usedPercent: 26, windowSeconds: 18000, resetAt: now + 8_700_000 }, secondaryWindow: { usedPercent: scenario === 'low' ? 96 : 39, windowSeconds: 604800, resetAt: now + 223_000_000 } },
  antigravity: empty ? null : { plan: 'Google AI Pro', availablePromptCredits: 300, monthlyPromptCredits: 500, fetchedAt: stamp, buckets: [
    { id: 'g5', group: 'Gemini', window: '5h', label: 'Gemini 5h', remainingFraction: .9, resetTime: now + 12_600_000, description: null },
    { id: 'gw', group: 'Gemini', window: 'weekly', label: 'Gemini weekly', remainingFraction: .67, resetTime: now + 254_000_000, description: null },
    { id: 'c5', group: 'Claude & GPT', window: '5h', label: 'Claude 5h', remainingFraction: .86, resetTime: now + 11_000_000, description: null },
    { id: 'cw', group: 'Claude & GPT', window: 'weekly', label: 'Claude weekly', remainingFraction: .42, resetTime: now + 301_000_000, description: null }
  ] }, mistral: empty ? null : { planType: 'pro', planName: 'Pro', fetchedAt: stamp },
  openrouter: empty ? null : { usageDaily: 3.82, usageWeekly: 21.75, usageMonthly: 48.6, byokUsageDaily: 4.2, byokUsageMonthly: 86.4, totalCredits: 25, totalUsage: 8, limit: null, isFreeTier: false, fetchedAt: stamp }
}
function selected(filter: UsageFilter): SessionRow[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - filter.days + 1)
  return sessions.filter((s) => s.lastAt >= start.getTime() && (!filter.provider || s.provider === filter.provider))
}
function series(filter: UsageFilter) {
  const rows = selected(filter)
  return Array.from({ length: filter.days }, (_, i) => {
    const date = new Date(now); date.setDate(date.getDate() - filter.days + 1 + i)
    const key = dayKey(date.getTime()), daily = rows.filter((s) => dayKey(s.lastAt) === key)
    return { date: key, total: daily.reduce((sum, s) => sum + s.tokens, 0), cost: daily.reduce((sum, s) => sum + s.cost, 0),
      tokens: Object.fromEntries(PROVIDER_IDS.map((id) => [id, daily.filter((s) => s.provider === id).reduce((sum, s) => sum + s.tokens, 0)])) }
  })
}
function overview(): OverviewDTO {
  const today = selected({ days: 1 })
  return { providers: PROVIDER_IDS.map((id) => {
    const rows = sessions.filter((s) => s.provider === id), daily = today.filter((s) => s.provider === id)
    return { id, name: PROVIDER_NAMES[id], status: rows.length ? 'ok' : 'no-data', dataPath: `C:/Sample-data/${id}`, eventCount: rows.length * 40,
      lastActivity: rows[0]?.lastAt ?? null, firstSeen: rows.at(-1)?.lastAt ?? null, tokensToday: daily.reduce((n, s) => n + s.tokens, 0), costToday: daily.reduce((n, s) => n + s.cost, 0), requestsToday: daily.reduce((n, s) => n + s.requests, 0), unpricedToday: false,
      tokens30d: rows.reduce((n, s) => n + s.tokens, 0), cost30d: rows.reduce((n, s) => n + s.cost, 0), requests30d: rows.reduce((n, s) => n + s.requests, 0), unpriced30d: false, sessions30d: rows.length }
  }), today: { tokens: today.reduce((n, s) => n + s.tokens, 0), cost: today.reduce((n, s) => n + s.cost, 0), requests: today.reduce((n, s) => n + s.requests, 0), unpriced: false },
    series30d: series({ days: 30 }), claude: { activeBlock: null, blocks: [], weeklyTokens: 0 }, codex: null, recentSessions: sessions.slice(0, 12),
    scan: { lastScanAt: now, scanning: false, filesScanned: 302, eventsIndexed: 1280, errors: [] } }
}
/** A simulated GitHub update: nothing is downloaded or installed in the preview. */
function demoUpdateApi(): Partial<AiuApi> {
  const listeners = new Set<() => void>()
  let status: UpdateStatus = { channel: 'stable', autoCheck: true, installed: APP_VERSION, repository: 'sample/repo', releasesUrl: 'https://github.com', state: 'idle', installKind: 'installer' }
  const set = (patch: Partial<UpdateStatus>): UpdateStatus => { status = { ...status, ...patch }; listeners.forEach(cb => cb()); return structuredClone(status) }
  const next = (): UpdateStatus['available'] => status.channel === 'preview'
    ? { version: '1.0.0-rc.3', name: 'AI Usage 1.0.0 RC 3', notes: 'Sample preview notes.\n- Command palette\n- In-app updates', url: 'https://github.com', prerelease: true, publishedAt: new Date().toISOString(), size: 48_200_000 }
    : undefined
  return {
    onUpdateStatus: cb => { listeners.add(cb); return () => listeners.delete(cb) },
    updateStatus: async () => structuredClone(status),
    setUpdateChannel: async channel => set({ channel, state: 'idle', available: undefined, progress: undefined, message: undefined }),
    setUpdateAutoCheck: async autoCheck => set({ autoCheck }),
    checkForUpdates: async () => { set({ state: 'checking' }); await new Promise(r => setTimeout(r, 600)); const available = next(); return set({ state: available ? 'available' : 'up-to-date', available, checkedAt: Date.now() }) },
    downloadUpdate: async () => {
      const total = status.available?.size ?? 1
      for (let received = 0; received <= total; received += total / 8) { set({ state: 'downloading', progress: { received, total } }); await new Promise(r => setTimeout(r, 120)) }
      return set({ state: 'ready', progress: { received: total, total }, message: 'Verified. Install closes AI Usage, updates it and opens it again.' })
    },
    installUpdate: async () => set({ state: 'ready', message: 'Preview mode: nothing was installed.' }),
    openReleases: async () => undefined
  }
}

export function installDemo(): void {
  document.documentElement.dataset.demo = 'true'
  const demo: Partial<AiuApi> = {
    meta: async () => ({ version: `${APP_VERSION} · preview`, platform: 'sample data', userDataPath: 'Sample data only', appDbPath: 'Sample data only' }),
    getSettings: async () => structuredClone(settings), setSettings: async (patch) => { settings = { ...settings, ...patch }; return structuredClone(settings) },
    getOverview: async () => overview(), getQuota: async () => structuredClone(quota),
    refreshQuota: async () => {
      if (scenario === 'error') throw new Error('Sample connection failure. Try again later.')
      quota = { ...quota, chatgpt: quota.chatgpt ? { ...quota.chatgpt, fetchedAt: Date.now() } : null, antigravity: quota.antigravity ? { ...quota.antigravity, fetchedAt: Date.now() } : null, openrouter: quota.openrouter ? { ...quota.openrouter, fetchedAt: Date.now() } : null }
      return structuredClone(quota)
    },
    getHistory: async (filter) => {
      const search = filter.search?.toLowerCase() ?? ''
      const rows = selected(filter).filter((s) => `${s.project} ${s.model} ${s.id} ${PROVIDER_NAMES[s.provider]}`.toLowerCase().includes(search))
      rows.sort((a, b) => filter.sort === 'tokens' ? b.tokens - a.tokens : filter.sort === 'cost' ? b.cost - a.cost : b.lastAt - a.lastAt)
      return { total: rows.length, sessions: rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 25)) }
    },
    getAnalytics: async (filter = { days: 90 }) => {
      const rows = selected(filter)
      return { series90d: series(filter), tools: rows.slice(0, 8).map((s, i) => ({ provider: s.provider, name: ['Read', 'Edit', 'Bash', 'Search'][i % 4], count: 300 - i * 29, lastUsed: s.lastAt })),
        models: rows.slice(0, 8).filter((s) => s.tokens).map((s) => ({ provider: s.provider, model: s.model, tokens: s.tokens, cost: s.cost, requests: s.requests })),
        projects: rows.slice(0, 8).map((s) => ({ provider: s.provider, project: s.project, tokens: s.tokens, cost: s.cost, requests: s.requests })) }
    },
    getProvider: async (id): Promise<ProviderDetailDTO> => ({ id, summary: overview().providers.find((p) => p.id === id)!,
      series90d: series({ days: 90, provider: id }).map((s) => ({ date: s.date, input: s.total * .6, output: s.total * .2, cacheRead: s.total * .2, cacheWrite: 0, total: s.total, cost: s.cost, requests: 20 })),
      models: selected({ days: 90, provider: id }).slice(0, 3).map((s) => ({ model: s.model, tokens: s.tokens, cost: s.cost, requests: s.requests, share: 33, lastUsed: s.lastAt })), projects: [],
      sessions: selected({ days: 90, provider: id }), tools: [{ name: 'Read', count: 40, lastUsed: now }], blocks: [], activityHistory: [], limit: null, breakdowns: [], notes: ['Development preview using fictional data.'] }),
    getPriceCatalog: async () => [{ label: 'Sample model', matchSource: 'Sample', price: { input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 } }],
    fullRescan: async () => overview().scan, reindex: async () => overview().scan, pickFolder: async () => 'C:/Sample-custom-folder', openPath: async () => '', onDataUpdated: () => () => undefined,
    ...demoManagerApi(),
    ...demoUpdateApi()
  }
  ;(window as unknown as { aiu: AiuApi }).aiu = demo as AiuApi
}
