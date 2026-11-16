// Shared contracts between the Electron main process and the React renderer.

export type ProviderId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'zcode'
  | 'antigravity'
  | 'copilot'
  | 'mistral'

export const PROVIDER_IDS: ProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'zcode',
  'antigravity',
  'copilot',
  'mistral'
]

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  antigravity: 'Antigravity',
  copilot: 'GitHub Copilot',
  mistral: 'Mistral Vibe'
}

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cached-input (read) tokens */
  cacheRead: number
  /** USD per 1M cache-write tokens */
  cacheWrite: number
}

export interface PriceCatalogEntry {
  label: string
  matchSource: string
  price: ModelPrice | null
  sourceUrl?: string
  note?: string
  verifiedAt?: string
}

export interface Settings {
  /** Subscription cards to show on the home screen, in display order. */
  pinnedQuotas: QuotaCardId[]
  theme: 'dark' | 'light' | 'system'
  launchAtLogin: boolean
  startMinimized: boolean
  claudePlan: 'pro' | 'max5' | 'max20' | 'custom'
  /** community-estimate token limit per 5-hour block */
  claude5hLimit: number
  /** optional weekly token limit estimate */
  claudeWeeklyLimit: number | null
  /** Monthly USD allowance (Mistral-sub credits routed through OpenRouter BYOK). */
  openrouterByokMonthlyAllowance: number
  /** ntfy publish target for the Android companion app (empty = disabled). */
  ntfyServer: string
  ntfyTopic: string
  ntfyToken: string
  /** exact-model-id -> price overrides (USD per 1M tokens) */
  pricingOverrides: Record<string, Partial<ModelPrice>>
  /** override root data directories per provider */
  paths: Partial<Record<ProviderId, string>>
}

export type QuotaCardId = 'codex' | 'antigravity' | 'openrouter' | 'claude'

export interface UsageFilter {
  days: 1 | 7 | 30 | 90
  provider?: ProviderId
}

export interface HistoryFilter extends UsageFilter {
  search?: string
  offset?: number
  limit?: number
  sort?: 'recent' | 'tokens' | 'cost'
}

export interface HistoryDTO {
  sessions: SessionRow[]
  total: number
}

export interface AppMeta {
  version: string
  platform: string
  userDataPath: string
  appDbPath: string
  managerError?: string
}

export interface ScanStatus {
  lastScanAt: number
  scanning: boolean
  filesScanned: number
  eventsIndexed: number
  errors: string[]
}

export type ProviderStatus = 'ok' | 'no-data' | 'error'

export interface ProviderSummary {
  id: ProviderId
  name: string
  status: ProviderStatus
  detected?: boolean
  dataPath: string
  eventCount: number
  lastActivity: number | null
  tokensToday: number
  costToday: number
  requestsToday: number
  unpricedToday: boolean
  tokens30d: number
  cost30d: number
  requests30d: number
  unpriced30d: boolean
  sessions30d: number
  firstSeen: number | null
  note?: string
}

export interface SeriesPoint {
  /** local date, YYYY-MM-DD */
  date: string
  tokens: Partial<Record<ProviderId, number>>
  total: number
  cost: number
}

export interface BlockInfo {
  start: number
  end: number
  tokens: number
  cost: number
  active: boolean
  sessions: number
  percent: number
}

export interface CodexLimitInfo {
  usedPercent: number
  windowMinutes: number
  resetsAt: number
  planType: string
  observedAt: number
  sessionCount: number
}

export interface SessionModelUsage {
  model: string
  tokens: number
  cost: number
  requests: number
  subagentTokens: number
  unpriced?: boolean
}

export interface SessionRow {
  provider: ProviderId
  id: string
  project: string
  model: string
  models?: string[]
  modelBreakdown?: SessionModelUsage[]
  subagentTokens?: number
  startedAt: number
  lastAt: number
  tokens: number
  cost: number
  /** Some token events have no matching price. */
  unpriced?: boolean
  requests: number
}

export interface OverviewDTO {
  providers: ProviderSummary[]
  today: { tokens: number; cost: number; requests: number; unpriced: boolean }
  series30d: SeriesPoint[]
  claude: { activeBlock: BlockInfo | null; blocks: BlockInfo[]; weeklyTokens: number } | null
  codex: { limit: CodexLimitInfo | null; tokens7d: number } | null
  recentSessions: SessionRow[]
  scan: ScanStatus
}

export interface ProviderSeriesPoint {
  date: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  requests: number
}

export interface ProviderDetailDTO {
  id: ProviderId
  summary: ProviderSummary
  series90d: ProviderSeriesPoint[]
  models: { model: string; tokens: number; cost: number; requests: number; share: number; lastUsed: number }[]
  projects: { project: string; tokens: number; cost: number; requests: number; sessions: number; share: number; lastUsed: number }[]
  sessions: SessionRow[]
  tools: { name: string; count: number; lastUsed: number }[]
  /** Claude only: 5-hour rolling blocks */
  blocks: BlockInfo[]
  /** Claude only: Claude Code's own daily activity stats */
  activityHistory: { date: string; messages: number; sessions: number; toolCalls: number }[]
  /** Codex only: latest observed rate-limit snapshot */
  limit: CodexLimitInfo | null
  /** provider-specific breakdowns (e.g. ZCode: upstream providers, request status) */
  breakdowns: { key: string; label: string; value: number }[]
  notes: string[]
}

export interface AnalyticsDTO {
  tools: { provider: ProviderId; name: string; count: number; lastUsed: number }[]
  models: { provider: ProviderId; model: string; tokens: number; cost: number; requests: number }[]
  projects: { provider: ProviderId; project: string; tokens: number; cost: number; requests: number }[]
  series90d: SeriesPoint[]
}

/** One of the ChatGPT/Codex usage windows (5-hour or weekly). */
export interface ChatGptWindowDTO {
  usedPercent: number
  windowSeconds: number
  /** epoch ms */
  resetAt: number
}

/** Live ChatGPT/Codex plan usage (fetched with the local Codex CLI credentials). */
export interface ChatGptQuotaDTO {
  availableCredits: number | null
  totalEarnedCredits: number
  immediateResetEligible: boolean
  planType: string
  /** account the current ~/.codex/auth.json token belongs to */
  email?: string | null
  /** 5-hour window (live) */
  primaryWindow?: ChatGptWindowDTO | null
  /** weekly window (live) */
  secondaryWindow?: ChatGptWindowDTO | null
  fetchedAt: number
  error?: string
}

/** Antigravity (Google AI) subscription quota from Google's own internal APIs. */
export interface AntigravityQuotaDTO {
  plan: string
  availablePromptCredits: number | null
  monthlyPromptCredits: number | null
  buckets: Array<{
    id: string
    /** quota group, e.g. "Gemini Models" or "Claude and GPT models" */
    group: string
    label: string
    window: string
    remainingFraction: number
    resetTime: number | null
    description: string | null
  }>
  fetchedAt: number
  error?: string
}

/** Mistral Vibe plan info (via /api/vibe/whoami when an API key is configured). */
export interface MistralPlanDTO {
  planType: string
  planName: string
  fetchedAt: number
  error?: string
}

/** OpenRouter usage & credits (key read from ZCode's own config). */
export interface OpenRouterQuotaDTO {
  /** key usage today, USD */
  usageDaily: number | null
  usageWeekly: number | null
  usageMonthly: number | null
  /** spend billed to your own provider keys routed through OpenRouter */
  byokUsageDaily: number | null
  byokUsageMonthly: number | null
  /** prepaid credits (null when the key isn't credit-based) */
  totalCredits: number | null
  totalUsage: number | null
  /** spending cap set on the key, null = unlimited */
  limit: number | null
  isFreeTier: boolean | null
  fetchedAt: number
  error?: string
}

export interface QuotaSnapshotDTO {
  chatgpt: ChatGptQuotaDTO | null
  mistral: MistralPlanDTO | null
  antigravity: AntigravityQuotaDTO | null
  openrouter: OpenRouterQuotaDTO | null
  /** Live Claude subscription limits; absent when not fetched yet. */
  claude?: ClaudeQuotaDTO | null
}
export interface ClaudeQuotaDTO {
  fetchedAt: number
  plan?: string
  windows: Array<{ id: string; label: string; usedPercent: number; resetAt: number | null }>
  error?: string
}
