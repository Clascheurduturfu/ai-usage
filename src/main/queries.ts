import {
  AnalyticsDTO,
  BlockInfo,
  CodexLimitInfo,
  OverviewDTO,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  ProviderDetailDTO,
  ProviderId,
  ProviderSeriesPoint,
  ProviderSummary,
  SeriesPoint,
  SessionRow,
  Settings
} from '../shared/types'
import type { HistoryDTO, HistoryFilter, UsageFilter } from '../shared/types'
import { computeBlocks, BlockEvent } from './blocks'
import { DB } from './db'
import { ADAPTERS } from './providers'
import { estimateCost, priceFor, type TokenMix } from './pricing'
import type { ScannerStatusSnapshot } from './scanner'

const DAY = 86_400_000
const TOKENS_SQL = '(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)'

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function rangeStart(now: number, days: number): number {
  const date = new Date(startOfLocalDay(now))
  date.setDate(date.getDate() - days + 1)
  return date.getTime()
}


function costMix(group: { i: number | null; o: number | null; cr: number | null; cw: number | null; cw1h?: number; long_context?: number; price_multiplier?: number }): TokenMix {
  return { input: n(group.i), output: n(group.o), cacheRead: n(group.cr), cacheWrite: n(group.cw), cacheWrite1h: n(group.cw1h), longContext: group.long_context === 1, priceMultiplier: group.price_multiplier ?? 1 }
}
function subagentTokens(group: unknown): number { return n((group as { subagentTokens?: number }).subagentTokens) }
function addSessionModel(row: SessionRow, model: string | null): void {
  if (!model) return
  row.models = [...new Set([...(row.models ?? (row.model === '—' || row.model === 'Unknown model' ? [] : [row.model])), model])].sort()
  row.model = row.models.length > 1 ? 'Mixed · ' + row.models.length + ' models' : row.models[0]
}

function addModelUsage(row: SessionRow, model: string | null, usage: MixedCost, agents: number): void {
  const name = model ?? 'Unknown model'
  const breakdown = row.modelBreakdown ??= []
  const entry = breakdown.find(item => item.model === name)
  if (entry) {
    entry.tokens += usage.tokens
    entry.cost += usage.cost
    entry.requests += usage.requests
    entry.subagentTokens += agents
    entry.unpriced = entry.unpriced || usage.unpriced
  } else {
    breakdown.push({ model: name, tokens: usage.tokens, cost: usage.cost, requests: usage.requests, subagentTokens: agents, unpriced: usage.unpriced })
  }
  breakdown.sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
}

interface MixedCost {
  tokens: number
  cost: number
  requests: number
  unpriced: boolean
}

interface GroupRow {
  model: string | null
  kind: string
  i: number | null
  o: number | null
  cr: number | null
  cw: number | null
  real: number | null
  cnt: number | null
}

/**
 * Cost of grouped usage rows: provider-recorded real cost wins when present,
 * otherwise API-equivalent estimate; unpriced models are flagged, not guessed.
 */
function costOfGroups(rows: GroupRow[], overrides: Settings['pricingOverrides']): MixedCost {
  let tokens = 0
  let cost = 0
  let requests = 0
  let unpriced = false
  for (const r of rows) {
    requests += n(r.cnt)
    if (r.kind === 'request') continue
    tokens += n(r.i) + n(r.o) + n(r.cr) + n(r.cw)
    const real = n(r.real)
    if (r.real !== null) {
      cost += real
    } else {
      const est = estimateCost(r.model, costMix(r), overrides)
      if (est === null) unpriced = true
      else cost += est
    }
  }
  return { tokens, cost, requests, unpriced }
}

function sumRange(
  db: DB,
  provider: ProviderId,
  from: number,
  to: number,
  overrides: Settings['pricingOverrides']
): MixedCost {
  const rows = db
    .prepare(
      `SELECT model, kind,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens, COUNT(*) cnt
       FROM usage_events WHERE provider = ? AND ts >= ? AND ts < ?
       GROUP BY model, kind, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)`
    )
    .all(provider, from, to) as unknown as GroupRow[]
  return costOfGroups(rows, overrides)
}

/**
 * Aggregate events into a per-day series with cost (real or estimated).
 * Aggregation happens in SQL (GROUP BY day, provider, model) so the JS side
 * handles a few dozen groups instead of tens of thousands of raw rows.
 */
function buildSeries(db: DB, from: number, now: number, overrides: Settings['pricingOverrides'], provider?: ProviderId): SeriesPoint[] {
  const buckets = new Map<string, { tokens: Partial<Record<ProviderId, number>>; total: number; cost: number }>()
  for (const date = new Date(from); date.getTime() <= now; date.setDate(date.getDate() + 1)) {
    buckets.set(dayKey(date.getTime()), { tokens: {}, total: 0, cost: 0 })
  }

  const groups = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, provider, model, kind,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens
       FROM usage_events WHERE ts >= ? AND ts <= ? ${provider ? 'AND provider = ?' : ''}
       GROUP BY d, provider, model, kind, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)`
    )
    .all(...(provider ? [from, now, provider] : [from, now])) as unknown as Array<{
    d: string
    provider: string
    model: string | null
    kind: string
    i: number
    o: number
    cr: number
    cw: number
    real: number | null
  }>

  for (const g of groups) {
    const b = buckets.get(g.d)
    if (!b) continue
    if (g.kind === 'request') continue
    const p = g.provider as ProviderId
    const tok = g.i + g.o + g.cr + g.cw
    b.tokens[p] = (b.tokens[p] ?? 0) + tok
    b.total += tok
    if (g.real != null) {
      b.cost += g.real
    } else {
      const est = estimateCost(g.model, costMix(g), overrides)
      if (est !== null) b.cost += est
    }
  }
  return [...buckets.entries()].map(([date, b]) => ({ date, tokens: b.tokens, total: b.total, cost: b.cost }))
}

// Provider status walks directories; cache it briefly so frequent overview
// recomputes (live rescans) don't hit the disk every time.
const statusCache = new Map<string, { at: number; info: ReturnType<(typeof ADAPTERS)[ProviderId]['status']> }>()
const STATUS_TTL_MS = 15_000

function cachedStatus(id: ProviderId, settings: Settings): ReturnType<(typeof ADAPTERS)[ProviderId]['status']> {
  const key = `${id}:${settings.paths[id] ?? ''}`
  const hit = statusCache.get(key)
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.info
  const info = ADAPTERS[id].status(settings)
  statusCache.set(key, { at: Date.now(), info })
  return info
}

function providerSummary(db: DB, id: ProviderId, settings: Settings, now: number): ProviderSummary {
  const st = cachedStatus(id, settings)
  const todayStart = startOfLocalDay(now)
  const d30 = rangeStart(now, 30)

  const today = sumRange(db, id, todayStart, Infinity, settings.pricingOverrides)
  const m30 = sumRange(db, id, d30, Infinity, settings.pricingOverrides)

  const counts = db
    .prepare(
      `SELECT COUNT(*) cnt, MIN(ts) first_ts, MAX(ts) last_ts,
              COUNT(DISTINCT session_id) sessions
       FROM usage_events WHERE provider = ?`
    )
    .get(id) as unknown as { cnt: number; first_ts: number | null; last_ts: number | null; sessions: number | null }
  const sessions30d = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) c FROM usage_events WHERE provider = ? AND ts >= ? AND session_id IS NOT NULL`
      )
      .get(id, d30) as unknown as { c: number }
  ).c

  const status = st.status === 'ok' && n(counts.cnt) === 0 ? 'no-data' : st.status

  return {
    id,
    name: PROVIDER_NAMES[id],
    status,
    detected: st.status === 'ok',
    dataPath: st.path,
    eventCount: n(counts.cnt),
    lastActivity: counts.last_ts ?? null,
    tokensToday: today.tokens,
    costToday: today.cost,
    requestsToday: today.requests,
    unpricedToday: today.unpriced,
    tokens30d: m30.tokens,
    cost30d: m30.cost,
    requests30d: m30.requests,
    unpriced30d: m30.unpriced,
    sessions30d,
    firstSeen: counts.first_ts ?? null,
    note: st.note
  }
}

function sessionRows(db: DB, id: ProviderId, from: number, overrides: Settings['pricingOverrides'], limit: number): SessionRow[] {
  const groups = db
    .prepare(
      `SELECT session_id, model, MIN(ts) started, MAX(ts) last, COUNT(*) requests,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens
       FROM usage_events WHERE provider = ? AND ts >= ? AND session_id IS NOT NULL
       GROUP BY session_id, model, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)
       ORDER BY last DESC`
    )
    .all(id, from) as unknown as Array<{
    session_id: string
    model: string | null
    started: number
    last: number
    requests: number
    i: number | null
    o: number | null
    cr: number | null
    cw: number | null
    real: number | null
  }>

  const bySession = new Map<string, SessionRow & { _real: number }>()
  for (const g of groups) {
    const tokens = n(g.i) + n(g.o) + n(g.cr) + n(g.cw)
    const real = n(g.real)
    let cost = 0
    let unpriced = false
    if (g.real !== null) {
      cost = real
    } else {
      const est = estimateCost(g.model, costMix(g), overrides)
      if (est !== null) cost = est
      else unpriced = true
    }
    const existing = bySession.get(g.session_id)
    if (existing) {
      existing.tokens += tokens
      existing.cost += cost
      existing.unpriced = existing.unpriced || unpriced
      existing.requests += n(g.requests)
      existing.lastAt = Math.max(existing.lastAt, g.last)
      existing.startedAt = Math.min(existing.startedAt, g.started)
      addSessionModel(existing, g.model)
      existing.subagentTokens = (existing.subagentTokens ?? 0) + subagentTokens(g)
    } else {
      bySession.set(g.session_id, {
        provider: id,
        id: g.session_id,
        project: '',
        model: g.model ?? '—',
        models: g.model ? [g.model] : [], subagentTokens: subagentTokens(g),
        startedAt: g.started,
        lastAt: g.last,
        tokens,
        cost,
        unpriced,
        requests: n(g.requests),
        _real: real
      })
    }
    addModelUsage(bySession.get(g.session_id)!, g.model, { tokens, cost, requests: n(g.requests), unpriced }, subagentTokens(g))
  }

  // Attach project per session
  const rows = [...bySession.values()]
  const projectStmt = db.prepare(
    `SELECT project FROM usage_events WHERE provider = ? AND session_id = ? AND project IS NOT NULL ORDER BY ts DESC LIMIT 1`
  )
  for (const r of rows) {
    const p = projectStmt.get(id, r.id) as unknown as { project: string } | undefined
    ;(r as unknown as { project: string }).project = p?.project ?? '—'
    delete (r as unknown as { _real?: number })._real
  }
  rows.sort((a, b) => b.lastAt - a.lastAt)
  return rows.slice(0, limit)
}

function claudeBlocks(db: DB, settings: Settings, now: number, days = 30): BlockInfo[] {
  const from = rangeStart(now, days)
  const rows = db
    .prepare(
      `SELECT ts, model, session_id, input_tokens i, output_tokens o,
              cache_read_tokens cr, cache_write_tokens cw,
              json_extract(meta, '$.cacheWrite1h') cw1h,
              json_extract(meta, '$.longContext') long_context,
              json_extract(meta, '$.priceMultiplier') price_multiplier
       FROM usage_events WHERE provider = 'claude' AND ts >= ?`
    )
    .all(from) as unknown as Array<{
    ts: number
    model: string | null
    session_id: string | null
    i: number
    o: number
    cr: number
    cw: number
  }>
  const events: BlockEvent[] = rows.map((r) => {
    const tokens = n(r.i) + n(r.o) + n(r.cr) + n(r.cw)
    const cost = estimateCost(
      r.model,
      costMix(r),
      settings.pricingOverrides
    )
    return { ts: r.ts, tokens, cost: cost ?? 0, sessionId: r.session_id }
  })
  return computeBlocks(events, now, settings.claude5hLimit)
}

function codexLimit(db: DB): CodexLimitInfo | null {
  const rows = db
    .prepare(`SELECT key, data FROM snapshots WHERE provider = 'codex' AND key LIKE 'codex:limit:%'`)
    .all() as unknown as Array<{ key: string; data: string }>
  let latest: CodexLimitInfo | null = null
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.data) as CodexLimitInfo
      if (!latest || parsed.observedAt > latest.observedAt) latest = parsed
    } catch {
      /* ignore */
    }
  }
  if (latest) latest = { ...latest, sessionCount: rows.length }
  return latest
}

const PROVIDER_NOTES: Record<ProviderId, string[]> = {
  claude: [
    'Costs are API-equivalent estimates from token counts and public list prices (editable in Settings).',
    'Usage includes subagent (sidechain) activity.'
  ],
  codex: [
    'Token counts are per-turn deltas parsed from Codex session rollouts.',
    'The weekly limit card comes from rate-limit snapshots recorded in those logs by Codex itself.'
  ],
  gemini: ['Gemini CLI does not record token counts locally, so activity is counted as user messages (requests).'],
  opencode: ['Costs are OpenCode’s own recorded per-session costs.'],
  zcode: [
    'Per-request ledger from ZCode’s local database.',
    'Costs are estimates; durations and statuses are recorded by ZCode.'
  ],
  antigravity: [
    'Token usage comes from the Antigravity Token Monitor extension’s exported artifacts (per model call, with cache read/write shares).',
    'Costs are API-equivalent estimates from the price catalog; quota windows are live from Google.'
  ],
  copilot: [
    'Activity comes from the Copilot Chat session store in VS Code (turns per session/agent).',
    'Copilot premium-request balances live on GitHub and are not readable from local data.'
  ],
  mistral: [
    'Activity comes from Mistral Vibe’s local session logs (~/.vibe/logs/session).',
    'Plan info (when an API key is configured) is fetched read-only from Mistral’s /api/vibe/whoami.'
  ]
}

// Frequent scan bursts shouldn't recompute the full overview DTO more than
// once every few seconds; the result is memoized briefly.
const overviewCache = new WeakMap<DB, { at: number; key: string; dto: OverviewDTO }>()
const OVERVIEW_CACHE_MS = 3_000

export function getOverview(db: DB, settings: Settings, scan: ScannerStatusSnapshot, now = Date.now()): OverviewDTO {
  const key = JSON.stringify([settings.paths, settings.pricingOverrides, settings.claude5hLimit, settings.claudeWeeklyLimit, scan.lastScanAt])
  const cached = overviewCache.get(db)
  if (cached && cached.key === key && now >= cached.at && now - cached.at < OVERVIEW_CACHE_MS) {
    return { ...cached.dto, scan }
  }
  const dto = computeOverview(db, settings, scan, now)
  overviewCache.set(db, { at: now, key, dto })
  return dto
}

function computeOverview(db: DB, settings: Settings, scan: ScannerStatusSnapshot, now: number): OverviewDTO {
  const todayStart = startOfLocalDay(now)
  const from30 = rangeStart(now, 30)
  const from7 = now - 7 * DAY

  const providers = PROVIDER_IDS.map((id) => providerSummary(db, id, settings, now))

  const todayTotals = providers.reduce(
    (acc, p) => ({
      tokens: acc.tokens + p.tokensToday,
      cost: acc.cost + p.costToday,
      requests: acc.requests + p.requestsToday,
      unpriced: acc.unpriced || p.unpricedToday
    }),
    { tokens: 0, cost: 0, requests: 0, unpriced: false }
  )

  const series30d = buildSeries(db, from30, now, settings.pricingOverrides)

  // Claude 5h blocks
  const blocks = claudeBlocks(db, settings, now)
  const activeBlock = blocks.find((b) => b.active) ?? null
  const claudeWeekly = (
    db
      .prepare(`SELECT SUM(${TOKENS_SQL}) t FROM usage_events WHERE provider = 'claude' AND ts >= ?`)
      .get(from7) as unknown as { t: number | null }
  ).t
  const claude7dEvents = db
    .prepare(`SELECT COUNT(*) c FROM usage_events WHERE provider = 'claude' AND ts >= ?`)
    .get(from7) as unknown as { c: number }

  // Codex weekly window
  const codex7d = sumRange(db, 'codex', from7, Infinity, settings.pricingOverrides)

  // Recent sessions across providers
  const recent = providers
    .filter((p) => p.status === 'ok')
    .flatMap((p) => sessionRows(db, p.id, from30, settings.pricingOverrides, 3))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 12)

  return {
    providers,
    today: todayTotals,
    series30d,
    claude:
      providers.find((p) => p.id === 'claude')?.status === 'ok'
        ? {
            activeBlock,
            blocks: blocks.slice(0, 10),
            weeklyTokens: n(claudeWeekly)
          }
        : null,
    codex:
      providers.find((p) => p.id === 'codex')?.status === 'ok'
        ? { limit: codexLimit(db), tokens7d: codex7d.tokens }
        : null,
    recentSessions: recent,
    scan: {
      lastScanAt: scan.lastScanAt,
      scanning: scan.scanning,
      filesScanned: scan.filesScanned,
      eventsIndexed: scan.eventsIndexed,
      errors: scan.errors
    }
  }
}

export function getProviderDetail(
  db: DB,
  id: ProviderId,
  settings: Settings,
  now = Date.now()
): ProviderDetailDTO {
  const summary = providerSummary(db, id, settings, now)
  const from90 = rangeStart(now, 90)
  const from30 = rangeStart(now, 30)
  const overrides = settings.pricingOverrides

  // 90-day per-day token mix series (aggregated in SQL: day x model x kind
  // groups instead of every raw event row)
  const groups = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, model, kind,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens, COUNT(*) cnt
       FROM usage_events WHERE provider = ? AND ts >= ?
       GROUP BY d, model, kind, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)`
    )
    .all(id, from90) as unknown as Array<{
    d: string
    model: string | null
    kind: string
    i: number
    o: number
    cr: number
    cw: number
    real: number | null
    cnt: number
  }>
  const buckets = new Map<string, ProviderSeriesPoint>()
  for (const date = new Date(from90); date.getTime() <= now; date.setDate(date.getDate() + 1)) {
    const key = dayKey(date.getTime())
    buckets.set(key, { date: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 })
  }
  for (const g of groups) {
    const b = buckets.get(g.d)
    if (!b) continue
    b.requests += g.cnt
    if (g.kind === 'request') continue
    b.input += g.i
    b.output += g.o
    b.cacheRead += g.cr
    b.cacheWrite += g.cw
    b.total += g.i + g.o + g.cr + g.cw
    if (g.real != null) b.cost += g.real
    else {
      const est = estimateCost(g.model, costMix(g), overrides)
      if (est !== null) b.cost += est
    }
  }
  const series90d = [...buckets.values()]

  // Models (90d)
  const modelRows = db
    .prepare(
      `SELECT model, kind, COUNT(*) cnt, MAX(ts) last_ts,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens
       FROM usage_events WHERE provider = ? AND ts >= ? AND model IS NOT NULL
       GROUP BY model, kind, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)`
    )
    .all(id, from90) as unknown as Array<GroupRow & { last_ts: number }>
  const modelMap = new Map<string, ProviderDetailDTO['models'][number]>()
  for (const group of modelRows) {
    const value = costOfGroups([group], overrides)
    const name = group.model as string
    const row = modelMap.get(name) ?? { model: name, tokens: 0, cost: 0, requests: 0, share: 0, lastUsed: 0 }
    row.tokens += value.tokens; row.cost += value.cost; row.requests += value.requests
    row.lastUsed = Math.max(row.lastUsed, group.last_ts)
    modelMap.set(name, row)
  }
  const models = [...modelMap.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
  const modelTotal = models.reduce((s, m) => s + m.tokens, 0)
  for (const m of models) m.share = modelTotal > 0 ? (m.tokens / modelTotal) * 100 : 0

  // Projects (90d)
  const projectGroups = db
    .prepare(
      `SELECT project, session_id, model, COUNT(*) cnt, MAX(ts) last_ts,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens
       FROM usage_events WHERE provider = ? AND ts >= ? AND project IS NOT NULL
       GROUP BY project, session_id, model, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)`
    )
    .all(id, from90) as unknown as Array<{
    project: string
    session_id: string | null
    model: string | null
    cnt: number
    last_ts: number
    i: number | null
    o: number | null
    cr: number | null
    cw: number | null
    real: number | null
  }>
  const byProject = new Map<string, { project: string; tokens: number; cost: number; requests: number; sessions: Set<string>; lastUsed: number }>()
  for (const g of projectGroups) {
    const tokens = n(g.i) + n(g.o) + n(g.cr) + n(g.cw)
    const real = n(g.real)
    let cost = real
    if (g.real === null) {
      const est = estimateCost(g.model, costMix(g), overrides)
      cost = est ?? 0
    }
    const entry = byProject.get(g.project) ?? { project: g.project, tokens: 0, cost: 0, requests: 0, sessions: new Set<string>(), lastUsed: 0 }
    entry.tokens += tokens
    entry.cost += cost
    entry.requests += n(g.cnt)
    if (g.session_id) entry.sessions.add(g.session_id)
    entry.lastUsed = Math.max(entry.lastUsed, g.last_ts)
    byProject.set(g.project, entry)
  }
  const projectTotal = [...byProject.values()].reduce((s, p) => s + p.tokens, 0)
  const projects = [...byProject.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 25)
    .map((p) => ({
      project: p.project,
      tokens: p.tokens,
      cost: p.cost,
      requests: p.requests,
      sessions: p.sessions.size,
      share: projectTotal > 0 ? (p.tokens / projectTotal) * 100 : 0,
      lastUsed: p.lastUsed
    }))

  const sessions = sessionRows(db, id, from90, overrides, 40)

  // Tools (90d)
  const toolRows = db
    .prepare(
      `SELECT name, COUNT(*) cnt, MAX(ts) last_ts FROM tool_events
       WHERE provider = ? AND ts >= ? GROUP BY name ORDER BY cnt DESC LIMIT 30`
    )
    .all(id, from90) as unknown as Array<{ name: string; cnt: number; last_ts: number }>
  const tools = toolRows.map((t) => ({ name: t.name, count: n(t.cnt), lastUsed: n(t.last_ts) }))

  // Claude extras
  let blocks: BlockInfo[] = []
  let activityHistory: ProviderDetailDTO['activityHistory'] = []
  if (id === 'claude') {
    blocks = claudeBlocks(db, settings, now)
    const snap = db
      .prepare(`SELECT data FROM snapshots WHERE key = 'claude:activity'`)
      .get() as unknown as { data: string } | undefined
    if (snap) {
      try {
        const parsed = JSON.parse(snap.data) as {
          days: Array<{ date: string; messages: number; sessions: number; toolCalls: number }>
        }
        activityHistory = parsed.days.slice(-180)
      } catch {
        /* ignore */
      }
    }
  }

  // ZCode breakdowns
  const breakdowns: ProviderDetailDTO['breakdowns'] = []
  if (id === 'zcode') {
    const upstream = db
      .prepare(
        `SELECT json_extract(meta, '$.upstream') k, SUM(${TOKENS_SQL}) v
         FROM usage_events WHERE provider = 'zcode' AND ts >= ? AND json_extract(meta, '$.upstream') IS NOT NULL
         GROUP BY k ORDER BY v DESC`
      )
      .all(from30) as unknown as Array<{ k: string; v: number }>
    for (const u of upstream) {
      breakdowns.push({ key: `upstream:${u.k}`, label: `Upstream · ${u.k}`, value: n(u.v) })
    }
    const status = db
      .prepare(
        `SELECT json_extract(meta, '$.status') k, COUNT(*) v
         FROM usage_events WHERE provider = 'zcode' AND ts >= ?
         GROUP BY k ORDER BY v DESC`
      )
      .all(from30) as unknown as Array<{ k: string; v: number }>
    for (const s of status) {
      breakdowns.push({ key: `status:${s.k}`, label: `Requests · ${s.k}`, value: n(s.v) })
    }
    const ttft = db
      .prepare(
        `SELECT AVG(json_extract(meta, '$.ttftMs')) v FROM usage_events
         WHERE provider = 'zcode' AND ts >= ? AND json_extract(meta, '$.ttftMs') > 0`
      )
      .get(now - 7 * DAY) as unknown as { v: number | null }
    if (ttft?.v != null) {
      breakdowns.push({ key: 'ttft', label: 'Avg time-to-first-token (7d)', value: Math.round(n(ttft.v)) })
    }
  }

  // Antigravity breakdowns: conversation/step totals from the summary snapshot
  if (id === 'antigravity') {
    const snap = db
      .prepare(`SELECT data FROM snapshots WHERE key = 'antigravity:summary'`)
      .get() as unknown as { data: string } | undefined
    if (snap) {
      try {
        const parsed = JSON.parse(snap.data) as { conversations?: number; steps?: number }
        if (parsed.steps != null) breakdowns.push({ key: 'steps', label: 'Agent steps (all time)', value: n(parsed.steps) })
        if (parsed.conversations != null) breakdowns.push({ key: 'convs', label: 'Conversations (all time)', value: n(parsed.conversations) })
      } catch {
        /* ignore */
      }
    }
  }

  return {
    id,
    summary,
    series90d,
    models,
    projects,
    sessions,
    tools,
    blocks,
    activityHistory,
    limit: id === 'codex' ? codexLimit(db) : null,
    breakdowns,
    notes: PROVIDER_NOTES[id]
  }
}

export function getAnalytics(db: DB, settings: Settings, now = Date.now(), filter: UsageFilter = { days: 90 }): AnalyticsDTO {
  const from90 = rangeStart(now, filter.days)
  const where = `ts >= ? AND ts <= ? ${filter.provider ? 'AND provider = ?' : ''}`
  const params = filter.provider ? [from90, now, filter.provider] : [from90, now]
  const overrides = settings.pricingOverrides

  const tools = (
    db
      .prepare(
        `SELECT provider, name, COUNT(*) cnt, MAX(ts) last_ts FROM tool_events
         WHERE ${where} GROUP BY provider, name ORDER BY cnt DESC LIMIT 30`
      )
      .all(...params) as unknown as Array<{ provider: ProviderId; name: string; cnt: number; last_ts: number }>
  ).map((t) => ({ provider: t.provider, name: t.name, count: n(t.cnt), lastUsed: n(t.last_ts) }))

  const modelGroups = db
    .prepare(
      `SELECT provider, model, COUNT(*) cnt,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens
       FROM usage_events WHERE ${where} AND model IS NOT NULL AND kind = 'tokens'
       GROUP BY provider, model, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)`
    )
    .all(...params) as unknown as Array<{
    provider: ProviderId
    model: string
    cnt: number
    i: number | null
    o: number | null
    cr: number | null
    cw: number | null
    real: number | null
  }>
  const byModel = new Map<string, AnalyticsDTO['models'][number]>()
  for (const group of modelGroups) {
    const key = `${group.provider}:${group.model}`
    const value = costOfGroups([{ ...group, kind: 'tokens' }], overrides)
    const row = byModel.get(key) ?? { provider: group.provider, model: group.model, tokens: 0, cost: 0, requests: 0 }
    row.tokens += value.tokens; row.cost += value.cost; row.requests += value.requests
    byModel.set(key, row)
  }
  const models = [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 20)

  const projectGroups = db
    .prepare(
      `SELECT provider, project, model, kind, COUNT(*) cnt,
              SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw, SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens
       FROM usage_events WHERE ${where} AND project IS NOT NULL
       GROUP BY provider, project, model, kind, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)`
    )
    .all(...params) as unknown as Array<GroupRow & { provider: ProviderId; project: string }>
  const byProject = new Map<string, AnalyticsDTO['projects'][number]>()
  for (const group of projectGroups) {
    const key = `${group.provider}:${group.project}`
    const value = costOfGroups([group], overrides)
    const row = byProject.get(key) ?? { provider: group.provider, project: group.project, tokens: 0, cost: 0, requests: 0 }
    row.tokens += value.tokens
    row.cost += value.cost
    row.requests += value.requests
    byProject.set(key, row)
  }
  const projects = [...byProject.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests).slice(0, 20)

  const series90d = buildSeries(db, from90, now, overrides, filter.provider)

  return { tools, models, projects, series90d }
}

export function getHistory(db: DB, settings: Settings, filter: HistoryFilter, now = Date.now()): HistoryDTO {
  const from = rangeStart(now, filter.days)
  const groups = db.prepare(`
    SELECT provider, session_id, model, kind, MAX(project) project,
           MIN(ts) started, MAX(ts) last, COUNT(*) cnt,
           SUM(input_tokens) i, SUM(output_tokens) o,
           SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw, SUM(cost_usd) real,
              SUM(COALESCE(json_extract(meta, '$.cacheWrite1h'), 0)) cw1h,
              MAX(COALESCE(json_extract(meta, '$.longContext'), 0)) long_context,
              MAX(COALESCE(json_extract(meta, '$.priceMultiplier'), 1)) price_multiplier,
              SUM(CASE WHEN json_extract(meta, '$.sidechain') = 1 THEN ${TOKENS_SQL} ELSE 0 END) subagentTokens
    FROM usage_events WHERE ts >= ? AND ts <= ? AND session_id IS NOT NULL
    ${filter.provider ? 'AND provider = ?' : ''}
    GROUP BY provider, session_id, model, kind, (cost_usd IS NOT NULL), COALESCE(json_extract(meta, '$.longContext'), 0), COALESCE(json_extract(meta, '$.priceMultiplier'), 1)
  `).all(...(filter.provider ? [from, now, filter.provider] : [from, now])) as Array<GroupRow & {
    provider: ProviderId; session_id: string; project: string | null; started: number; last: number
  }>
  const sessions = new Map<string, SessionRow>()
  for (const group of groups) {
    const key = `${group.provider}:${group.session_id}`
    const cost = costOfGroups([group], settings.pricingOverrides)
    const row = sessions.get(key)
    if (row) {
      row.tokens += cost.tokens
      addSessionModel(row, group.model)
      row.subagentTokens = (row.subagentTokens ?? 0) + subagentTokens(group)
      row.cost += cost.cost
      row.unpriced = row.unpriced || cost.unpriced
      row.requests += cost.requests
      row.startedAt = Math.min(row.startedAt, group.started)
      if (group.last >= row.lastAt) {
        row.project = group.project ?? row.project
      }
      row.lastAt = Math.max(row.lastAt, group.last)
    } else {
      sessions.set(key, { provider: group.provider, id: group.session_id, project: group.project ?? 'Unknown project',
        model: group.model ?? 'Unknown model', models: group.model ? [group.model] : [], subagentTokens: subagentTokens(group), startedAt: group.started, lastAt: group.last,
        tokens: cost.tokens, cost: cost.cost, unpriced: cost.unpriced, requests: cost.requests })
    }
    addModelUsage(sessions.get(key)!, group.model, cost, subagentTokens(group))
  }
  const search = filter.search?.trim().toLowerCase() ?? ''
  const rows = [...sessions.values()].filter((r) => !search || `${r.project} ${r.model} ${(r.models ?? []).join(' ')} ${r.id} ${PROVIDER_NAMES[r.provider]}`.toLowerCase().includes(search))
  rows.sort((a, b) => filter.sort === 'tokens' ? b.tokens - a.tokens || b.lastAt - a.lastAt
    : filter.sort === 'cost' ? b.cost - a.cost || b.lastAt - a.lastAt : b.lastAt - a.lastAt)
  const offset = Math.max(0, Math.floor(filter.offset ?? 0))
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 25)))
  return { total: rows.length, sessions: rows.slice(offset, offset + limit) }
}
