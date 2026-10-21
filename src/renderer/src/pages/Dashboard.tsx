import { useState } from 'react'
import { Activity, ArrowRight, ArrowUpRight, Check, ChevronRight, Clock3, Layers3, Pin, RefreshCw, SlidersHorizontal, Sparkles, TriangleAlert, Zap } from 'lucide-react'
import { useApp } from '../App'
import { api } from '../lib/ipc'
import { PROVIDER_COLORS, countdownTo, fmtCount, fmtDateTime, fmtTokens, fmtUsd, projectLabel, relTime } from '../lib/format'
import { makeQuotaCards, QUOTA_NAMES, quotaState } from '../lib/quotas'
import type { QuotaCard } from '../lib/quotas'
import type { QuotaCardId } from '../../../shared/types'
import { Btn, Panel, ProgressBar, Sparkline } from '../components/ui'
import { StackedProviderChart } from '../components/charts'

export function SubscriptionCard({ card }: { card: QuotaCard }): React.ReactElement {
  const { now, refreshQuotas, busy, openProvider, navigate } = useApp()
  const [expanded, setExpanded] = useState(false)
  const modelWindows = card.id === 'antigravity' ? [...card.windows].sort((a, b) => a.remaining - b.remaining) : card.windows
  const visibleWindows = card.id === 'antigravity' && !expanded ? modelWindows.slice(0, 2) : modelWindows
  const state = quotaState(card, now)
  const color = PROVIDER_COLORS[card.id === 'openrouter' ? 'zcode' : card.id]
  const lowest = card.windows.length ? Math.min(...card.windows.map((w) => w.remaining)) : null
  const stateLabel = { ready: card.estimated ? 'Estimated' : 'Available', low: 'Running low', stale: 'Needs refresh', unknown: 'Unavailable' }[state]
  return <article className={`quota-card quota-${state}`}>
    <div className="quota-card-top"><span className="quota-icon" style={{ color, background: `${color}16` }}>{card.id === 'antigravity' ? <Sparkles size={21} /> : card.id === 'openrouter' ? <Layers3 size={21} /> : <Zap size={21} />}</span><span className={`state-pill state-${state}`}><span />{stateLabel}</span></div>
    <div className="quota-name">{card.name}</div><div className="quota-plan">{card.subtitle} <span>· {card.plan}</span></div>
    <div className="quota-headline">{state === 'unknown' ? <strong className="unknown-value">—</strong> : <><strong>{card.id === 'openrouter' && card.remainingUsd !== undefined ? fmtUsd(card.remainingUsd) : `${Math.round(lowest ?? 0)}%`}</strong><span>{state === 'stale' ? 'last known remaining' : card.id === 'openrouter' ? `remaining of ${fmtUsd(card.allowance ?? 0)} this month` : 'remaining in tightest window'}</span></>}</div>
    {state === 'unknown' ? <div className="quota-unavailable"><TriangleAlert size={16} /><p>{card.error ? 'Couldn’t fetch your current quota. Refresh or check the tool’s sign-in.' : card.detail}</p>{card.error && <details><summary>Connection details</summary><p>{card.error}</p></details>}<button className="text-btn" disabled={!!busy} onClick={() => void refreshQuotas()}>Try refresh <ArrowRight size={13} /></button></div> : <div className="quota-windows">
      {visibleWindows.map((w) => <div key={w.id} className="quota-window"><div><span title={w.label}>{w.label}</span><strong>{Math.round(w.remaining)}% left</strong></div><ProgressBar percent={w.remaining} color={state === 'stale' ? 'var(--faint)' : w.remaining <= 10 ? 'var(--bad)' : color} height={5} /><small><Clock3 size={11} />{w.resetAt ? w.resetAt <= now ? 'Reset passed · refresh to confirm' : `Resets in ${countdownTo(w.resetAt, now)}` : 'Reset time not provided'}{w.resetAt && w.resetAt > now && <span title={new Date(w.resetAt).toLocaleString()}>{fmtDateTime(w.resetAt)}</span>}</small></div>)}
    {card.id === 'antigravity' && modelWindows.length > 2 && <button className="text-btn" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer limits' : `Show ${modelWindows.length - 2} more limits`}</button>}
    </div>}
    <div className="quota-card-footer"><span title={card.detail}>{card.estimated ? 'Community limit estimate' : card.fetchedAt ? `Checked ${relTime(card.fetchedAt, now)}` : 'Waiting for connection'}</span><button aria-label={`View ${card.name} details`} onClick={() => card.id === 'openrouter' ? navigate({ kind: 'settings' }) : openProvider(card.id)}><ArrowRight size={16} /></button></div>
  </article>
}
export default function Dashboard(): React.ReactElement {
  const { overview, settings, quota, now, busy, runAction, refreshQuotas, openProvider, navigate } = useApp()
  const [customize, setCustomize] = useState(false)
  const [chartMode, setChartMode] = useState<'tokens' | 'cost'>('tokens')
  if (!overview || !settings) return <div className="page"><div className="skeleton h-20" /><div className="quota-grid mt-6">{[0, 1, 2].map((n) => <div key={n} className="skeleton h-80" />)}</div></div>
  const cards = makeQuotaCards(quota, settings, overview)
  const pinned = settings.pinnedQuotas.map((id) => cards.find((c) => c.id === id)!).filter(Boolean)
  const low = pinned.filter((c) => quotaState(c, now) === 'low')
  const needsRefresh = pinned.filter((c) => ['unknown', 'stale'].includes(quotaState(c, now))).length
  const liveCards = pinned.filter((c) => !c.estimated && quotaState(c, now) === 'ready')
  const resets = pinned.filter((c) => quotaState(c, now) !== 'unknown').flatMap((c) => c.windows.filter((w) => w.resetAt && w.resetAt > now).map((w) => ({ ...w, name: c.name }))).sort((a, b) => a.resetAt! - b.resetAt!)
  const active = overview.providers.filter((p) => p.tokensToday || p.requestsToday).sort((a, b) => b.tokensToday - a.tokensToday)
  const last7 = overview.series30d.slice(-7)
  const togglePin = (id: QuotaCardId): void => {
    const next = settings.pinnedQuotas.includes(id) ? settings.pinnedQuotas.filter((p) => p !== id) : [...settings.pinnedQuotas, id]
    void runAction('pin', () => api().setSettings({ pinnedQuotas: next }))
  }
  return <div className="page dashboard-page">
    <div className="page-heading"><div><div className="eyebrow">{new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div><h1>Your AI, at a glance<span className="brand-dot">.</span></h1><p>Know what’s left. Keep your flow.</p></div><Btn variant="primary" disabled={!!busy} onClick={() => void refreshQuotas()}><RefreshCw size={15} className={busy === 'quotas' ? 'animate-spin' : ''} />{busy === 'quotas' ? 'Refreshing…' : 'Refresh quotas'}</Btn></div>
    <div className={`capacity-banner ${low.length ? 'capacity-low' : ''}`}><span className="capacity-icon">{low.length ? <TriangleAlert size={20} /> : needsRefresh || !liveCards.length ? <Clock3 size={20} /> : <Check size={20} />}</span><div><strong>{low.length ? `${low.map((c) => c.name).join(' & ')} ${low.length === 1 ? 'is' : 'are'} running low` : needsRefresh ? 'A few quotas need a fresh look' : liveCards.length ? 'You have room to keep going' : 'Connect your plans to see what’s available'}</strong><p>{low.length ? '10% or less in a usage window. Check the reset times below.' : needsRefresh ? `${needsRefresh} ${needsRefresh === 1 ? 'card is' : 'cards are'} unavailable or out of date. Refresh to check current capacity.` : liveCards.length ? 'Your connected plans have more than 10% remaining in every reported window.' : 'Your local tools provide the sign-ins. No extra account needed.'}</p></div>{resets[0] && <div className="next-reset"><Clock3 size={14} /><span>Next reset<strong>{countdownTo(resets[0].resetAt!, now)}</strong><small>{resets[0].name}</small></span></div>}</div>
    <section><div className="section-heading"><div><h2>Your subscriptions <span>{pinned.length.toString().padStart(2, '0')}</span></h2><p>Remaining capacity across your plans</p></div><button className={`text-btn customize-btn ${customize ? 'selected' : ''}`} aria-expanded={customize} onClick={() => setCustomize((v) => !v)}><SlidersHorizontal size={14} />Customize</button></div>
      {customize && <div className="customize-panel"><span>Show on overview</span>{cards.map((c) => <button disabled={!!busy} key={c.id} aria-pressed={settings.pinnedQuotas.includes(c.id)} className={`pin-option ${settings.pinnedQuotas.includes(c.id) ? 'selected' : ''}`} onClick={() => togglePin(c.id)}><Pin size={13} />{QUOTA_NAMES[c.id]}{settings.pinnedQuotas.includes(c.id) && <Check size={13} />}</button>)}</div>}
      {pinned.length ? <div className="quota-grid">{pinned.map((card) => <SubscriptionCard key={card.id} card={card} />)}</div> : <Panel className="empty-panel"><Pin size={22} /><h3>Make this space yours</h3><p>Use Customize to pin the subscriptions you want to keep an eye on.</p><Btn onClick={() => setCustomize(true)}>Choose subscriptions</Btn></Panel>}
      <div className="section-footnote"><Clock3 size={12} />Live quotas refresh every 30 minutes. Remaining percentages are separate limits, not a combined balance.</div>
    </section>
    <div className="today-strip"><div className="today-intro"><Activity size={19} /><span>Your day so far<small>From local tool logs</small></span></div><div><strong>{fmtTokens(overview.today.tokens)}</strong><span>tokens processed</span></div><div><strong>{fmtCount(overview.today.requests)}</strong><span>recorded requests</span></div><div><strong>{active.length}</strong><span>active tools</span></div><div><strong>{fmtUsd(overview.today.cost)}{overview.today.unpriced ? '+' : ''}</strong><span>API-equivalent estimate</span></div></div>
    <div className="overview-bottom-grid"><Panel className="trend-panel"><div className="section-heading"><div><h2>Usage this week</h2><p>A little context for your capacity</p></div><div className="segmented">{(['tokens', 'cost'] as const).map((m) => <button key={m} aria-pressed={chartMode === m} className={chartMode === m ? 'selected' : ''} onClick={() => setChartMode(m)}>{m === 'tokens' ? 'Tokens' : 'Est. cost'}</button>)}</div></div><StackedProviderChart data={last7} mode={chartMode} height={190} /><button className="text-btn" onClick={() => navigate({ kind: 'analytics' })}>Explore insights <ArrowRight size={13} /></button></Panel>
      <Panel className="active-tools-panel"><div className="section-heading"><div><h2>In your rotation</h2><p>Tools used today</p></div><button className="icon-btn" aria-label="View connected tools" onClick={() => navigate({ kind: 'providers' })}><ArrowUpRight size={16} /></button></div>{active.length ? active.slice(0, 5).map((p) => <button key={p.id} className="tool-activity-row" onClick={() => openProvider(p.id)}><span className="provider-dot" style={{ background: PROVIDER_COLORS[p.id] }} /><div><strong>{p.name}</strong><small>{fmtCount(p.requestsToday)} requests today</small></div><Sparkline data={last7.map((s) => s.tokens[p.id] ?? 0)} color={PROVIDER_COLORS[p.id]} width={66} height={22} /><span>{p.tokensToday ? fmtTokens(p.tokensToday) : 'Activity only'}</span><ChevronRight size={13} /></button>) : <div className="small-empty"><Activity size={24} /><p>No activity recorded today.</p><button className="text-btn" disabled={!!busy} onClick={() => void runAction('scan', () => api().fullRescan(), 'Local usage refreshed.')}>Scan local tools <RefreshCw size={12} /></button></div>}</Panel></div>
    <Panel className="recent-panel"><div className="section-heading"><div><h2>Recently active</h2><p>Pick up where you left off</p></div><button className="text-btn" onClick={() => navigate({ kind: 'history' })}>All usage <ArrowRight size={13} /></button></div>{overview.recentSessions.slice(0, 4).map((s) => <button key={`${s.provider}:${s.id}`} className="recent-row" onClick={() => openProvider(s.provider)}><span className="session-icon"><Activity size={15} /></span><div><strong title={s.project}>{projectLabel(s.project)}</strong><small>{s.model} · {s.provider}</small></div><span>{relTime(s.lastAt, now)}</span><ChevronRight size={14} /></button>)}{!overview.recentSessions.length && <p className="muted py-5">Your sessions will appear after a local scan. Open Connected tools to check data sources.</p>}</Panel>
  </div>
}
