import { useEffect, useState } from 'react'
import { Activity, ArrowLeft, FolderOpen, RefreshCw } from 'lucide-react'
import type { ProviderDetailDTO, ProviderId } from '../../../shared/types'
import { useApp } from '../App'
import { MODEL_DIMENSION, PROVIDER_COLORS, REQUEST_UNIT, fmtCount, fmtTokens, fmtUsd, fmtDateTime, isRequestKind, projectLabel, relTime } from '../lib/format'
import { api } from '../lib/ipc'
import { BarList, Btn, EmptyState, Kpi, LoadingRows, Panel, SectionTitle, Table } from '../components/ui'
import { MessagesBarChart, ProviderMixChart, SimpleBarChart } from '../components/charts'
import { makeQuotaCards } from '../lib/quotas'
import { SubscriptionCard } from './Dashboard'
import { SessionModels } from '../components/SessionModels'
const TABS = ['Activity', 'Models & projects', 'Tool calls', 'Plan & quota'] as const
export default function ProviderPage({ id }: { id: ProviderId }): React.ReactElement {
  const { version, settings, overview, quota, now, busy, navigate, runAction } = useApp()
  const [detail, setDetail] = useState<ProviderDetailDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<typeof TABS[number]>('Activity')
  const [days, setDays] = useState(30)
  useEffect(() => {
    let cancelled = false
    void api().getProvider(id).then((d) => { if (!cancelled) { setDetail(d); setError(null) } }).catch((e) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [id, version])
  if (error) return <div className="page"><EmptyState title="Couldn’t load tool data" hint={error} /></div>
  if (!detail || !settings || !overview) return <div className="page"><LoadingRows rows={9} /></div>
  const s = detail.summary, color = PROVIDER_COLORS[id]
  const requestKind = isRequestKind(id) || (s.tokens30d === 0 && s.requests30d > 0)
  const unit = REQUEST_UNIT[id] ?? 'requests'
  const card = makeQuotaCards(quota, settings, overview).find((c) => c.id === id || (id === 'zcode' && c.id === 'openrouter'))
  return <div className="page">
    <button className="text-btn self-start" onClick={() => navigate({ kind: 'providers' })}><ArrowLeft size={13} />Connected tools</button>
    <div className="page-heading"><div><div className="eyebrow">YOUR TOOL, IN CONTEXT</div><h1 className="flex items-center gap-3"><span className="provider-dot" style={{ background: color, width: 10, height: 10, flexBasis: 10 }} />{s.name}</h1><p>Last activity {relTime(s.lastActivity, now)} · {fmtCount(s.eventCount)} indexed events</p></div><Btn disabled={!!busy} onClick={() => void runAction('folder', async () => { const error = await api().openPath(s.dataPath); if (error) throw new Error(error) })}><FolderOpen size={14} />Source folder</Btn></div>
    <div className="kpi-grid"><Kpi label={requestKind ? `${unit} today` : 'Tokens today'} value={requestKind ? fmtCount(s.requestsToday) : fmtTokens(s.tokensToday)} accent={color} icon={<Activity size={14} />} /><Kpi label={requestKind ? `${unit} · 30 days` : 'Tokens · 30 days'} value={requestKind ? fmtCount(s.requests30d) : fmtTokens(s.tokens30d)} /><Kpi label="Sessions · 30 days" value={fmtCount(s.sessions30d)} /><Kpi label="Est. / recorded cost · 30d" value={requestKind ? '—' : `${fmtUsd(s.cost30d)}${s.unpriced30d ? '+' : ''}`} sub={requestKind ? 'No token counts recorded' : s.unpriced30d ? 'Some models need price overrides' : 'API equivalent / provider records'} /></div>
    <nav className="settings-tabs detail-tabs" aria-label="Tool sections">{TABS.map((t) => <button key={t} className={tab === t ? 'selected' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{t}</button>)}</nav>
    {s.status !== 'ok' && <Panel className="empty-panel"><Activity size={24} /><h3>No local usage found yet</h3><p>{s.note || 'Run the tool, then scan your local usage. You can change its source folder in Settings → Data sources.'}</p><Btn disabled={!!busy} onClick={() => void runAction('scan', () => api().fullRescan(), 'Local usage refreshed.')}><RefreshCw size={14} />Scan tools</Btn></Panel>}
    {tab === 'Activity' && <>
      <Panel className="p-5"><div className="section-heading"><div><h2>{requestKind ? 'Daily activity' : 'Token mix & estimated cost'}</h2><p>{requestKind ? 'Recorded requests; token counts unavailable' : 'Input, output, cached input and cache writes'}</p></div><select aria-label="Tool chart period" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></div>{requestKind ? <SimpleBarChart data={detail.series90d.slice(-days).map((d) => ({ date: d.date, value: d.requests }))} color={color} /> : <ProviderMixChart data={detail.series90d.slice(-days)} />}</Panel>
      <Panel className="p-5"><SectionTitle title="Recent sessions" sub="Last 90 days · latest 40 · totals include cached input and subagents" right={<button className="text-btn" onClick={() => navigate({ kind: 'history' })}>Search all usage</button>} /><Table rows={detail.sessions} columns={[
        { key: 'project', label: 'Project', render: (r) => <span className="block max-w-[300px] truncate" title={r.project}>{projectLabel(r.project)}</span> },
        { key: 'model', label: 'Model', render: (r) => <SessionModels session={r} /> },
        { key: 'last', label: 'Last activity', render: (r) => fmtDateTime(r.lastAt) },
        { key: 'tokens', label: requestKind ? unit : 'Tokens', align: 'right', render: (r) => requestKind ? fmtCount(r.requests) : <div>{fmtTokens(r.tokens)}{!!r.subagentTokens && <span className="block text-[10px] muted mt-1">{fmtTokens(r.tokens - r.subagentTokens)} main · {fmtTokens(r.subagentTokens)} agents</span>}</div> },
        { key: 'cost', label: 'Est. / recorded USD', align: 'right', render: (r) => requestKind ? '—' : fmtUsd(r.cost) }
      ]} /></Panel>{!!detail.activityHistory.length && <Panel className="p-5"><SectionTitle title="Claude’s activity history" sub="Recorded messages, sessions and tool calls" /><MessagesBarChart data={detail.activityHistory.slice(-days)} /></Panel>}
    </>}
    {tab === 'Models & projects' && <>
      <Panel className="p-5"><SectionTitle title={MODEL_DIMENSION[id] ?? 'Models'} sub="Last 90 days" /><Table rows={detail.models} columns={[
        { key: 'model', label: MODEL_DIMENSION[id] ?? 'Model', render: (r) => r.model },
        { key: 'tokens', label: requestKind ? unit : 'Tokens', align: 'right', render: (r) => requestKind ? fmtCount(r.requests) : fmtTokens(r.tokens) },
        { key: 'cost', label: 'Est. / recorded USD', align: 'right', render: (r) => requestKind ? '—' : fmtUsd(r.cost) },
        { key: 'last', label: 'Last used', render: (r) => relTime(r.lastUsed, now) }
      ]} /></Panel><Panel className="p-5"><SectionTitle title="Projects" sub="Last 90 days" /><Table rows={detail.projects} columns={[
        { key: 'project', label: 'Project', render: (r) => <span title={r.project}>{projectLabel(r.project)}</span> },
        { key: 'tokens', label: requestKind ? unit : 'Tokens', align: 'right', render: (r) => requestKind ? fmtCount(r.requests) : fmtTokens(r.tokens) },
        { key: 'cost', label: 'Est. / recorded USD', align: 'right', render: (r) => requestKind ? '—' : fmtUsd(r.cost) },
        { key: 'sessions', label: 'Sessions', align: 'right', render: (r) => fmtCount(r.sessions) }
      ]} /></Panel>
    </>}
    {tab === 'Tool calls' && <><Panel className="p-5"><SectionTitle title="Tool calls" sub="Last 90 days · tools exposed by this provider’s logs" /><BarList items={detail.tools.map((t) => ({ label: t.name, value: t.count, color }))} formatValue={fmtCount} empty="No tool calls recorded for this tool." /></Panel>{!!detail.breakdowns.length && <Panel className="p-5"><SectionTitle title="Provider details" /><Table rows={detail.breakdowns} columns={[{ key: 'name', label: 'Metric', render: (r) => r.label }, { key: 'value', label: 'Value', align: 'right', render: (r) => fmtCount(r.value) }]} /></Panel>}</>}
    {tab === 'Plan & quota' && <>{id === 'mistral' && quota?.mistral && <Panel className="p-5"><SectionTitle title="Mistral Vibe plan" sub={`Checked ${relTime(quota.mistral.fetchedAt, now)}`} /><h2>{quota.mistral.planName || quota.mistral.planType}</h2>{quota.mistral.error && <p className="privacy-note mt-3">{quota.mistral.error}</p>}</Panel>}{card ? <div className="quota-grid"><SubscriptionCard card={card} /></div> : <Panel className="empty-panel"><h3>No live balance for this tool</h3><p>Its local logs provide activity, but a subscription quota is not available through this integration.</p></Panel>}{!!detail.blocks.length && <Panel className="p-5"><SectionTitle title="Claude usage windows" sub="Local token estimates · last 30 days" /><Table rows={detail.blocks} columns={[
      { key: 'start', label: 'Window started', render: (r) => fmtDateTime(r.start) }, { key: 'tokens', label: 'Tokens', align: 'right', render: (r) => fmtTokens(r.tokens) }, { key: 'cost', label: 'Est. cost', align: 'right', render: (r) => fmtUsd(r.cost) }, { key: 'status', label: 'Window', render: (r) => r.active ? 'Active' : 'Ended' }
    ]} /></Panel>}</>}
    <details className="privacy-note"><summary className="cursor-pointer">About this data source</summary><div className="mt-3 flex flex-col gap-2"><p className="break-all">{s.dataPath}</p>{detail.notes.map((note) => <p key={note}>{note}</p>)}</div></details>
  </div>
}
