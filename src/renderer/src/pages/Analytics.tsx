import { useEffect, useState } from 'react'
import { Activity, ArrowRight, BarChart3, Cpu, FolderOpen, Wrench } from 'lucide-react'
import type { AnalyticsDTO, ProviderId, UsageFilter } from '../../../shared/types'
import { PROVIDER_IDS, PROVIDER_NAMES } from '../../../shared/types'
import { useApp } from '../App'
import { api } from '../lib/ipc'
import { PROVIDER_COLORS, fmtCount, fmtTokens, fmtUsd, projectLabel } from '../lib/format'
import { BarList, Btn, EmptyState, Kpi, LoadingRows, Panel, SectionTitle, Table } from '../components/ui'
import { StackedProviderChart } from '../components/charts'
export default function AnalyticsPage(): React.ReactElement {
  const { version, navigate } = useApp()
  const [data, setData] = useState<AnalyticsDTO | null>(null)
  const [filter, setFilter] = useState<UsageFilter>({ days: 30 })
  const [mode, setMode] = useState<'tokens' | 'cost'>('tokens')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false; setLoading(true)
    void api().getAnalytics(filter).then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((e) => { if (!cancelled) setError(String(e)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [version, filter])
  const tokens = data?.series90d.reduce((sum, p) => sum + p.total, 0) ?? 0
  const cost = data?.series90d.reduce((sum, p) => sum + p.cost, 0) ?? 0
  const activeDays = data?.series90d.filter((p) => p.total > 0).length ?? 0
  return <div className="page">
    <div className="page-heading"><div><div className="eyebrow">A BETTER PICTURE OF YOUR HABITS</div><h1>Insights<span className="brand-dot">.</span></h1><p>See where your tokens go, and which tools earn their place.</p></div><Btn onClick={() => navigate({ kind: 'history' })}>View sessions<ArrowRight size={14} /></Btn></div>
    <div className="filter-bar"><select aria-label="Insights period" value={filter.days} onChange={(e) => setFilter((f) => ({ ...f, days: Number(e.target.value) as UsageFilter['days'] }))}>{[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d === 1 ? 'Today' : `Last ${d} days`}</option>)}</select><select aria-label="Insights tool" value={filter.provider ?? ''} onChange={(e) => setFilter((f) => ({ ...f, provider: e.target.value ? e.target.value as ProviderId : undefined }))}><option value="">All tools</option>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{PROVIDER_NAMES[id]}</option>)}</select><span className="privacy-note">Charts and rankings use the same filters.</span></div>
    {error ? <EmptyState title="Couldn’t load insights" hint={error} /> : loading ? <LoadingRows rows={8} /> : data && <>
      <div className="kpi-grid"><Kpi label="Tokens processed" value={fmtTokens(tokens)} icon={<Activity size={14} />} /><Kpi label="API-equivalent cost" value={fmtUsd(cost)} sub="Includes known prices only" icon={<BarChart3 size={14} />} /><Kpi label="Days with tokens" value={activeDays} sub={`of ${filter.days} selected days`} /><Kpi label="Daily token average" value={fmtTokens(tokens / filter.days)} sub="Across the selected period" /></div>
      <Panel className="p-5"><div className="section-heading"><div><h2>Daily usage</h2><p>{filter.days === 1 ? 'Today' : `Last ${filter.days} days`} · {filter.provider ? PROVIDER_NAMES[filter.provider] : 'all tools'}</p></div><div className="segmented">{(['tokens', 'cost'] as const).map((m) => <button key={m} className={mode === m ? 'selected' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'tokens' ? 'Tokens' : 'Est. cost'}</button>)}</div></div><StackedProviderChart data={data.series90d} mode={mode} height={235} /><div className="flex flex-wrap gap-4 mt-4">{PROVIDER_IDS.filter((id) => data.series90d.some((s) => (s.tokens[id] ?? 0) > 0)).map((id) => <span key={id} className="flex items-center gap-2 text-[10px] muted"><span className="provider-dot" style={{ background: PROVIDER_COLORS[id] }} />{PROVIDER_NAMES[id]}</span>)}</div></Panel>
      <div className="insight-grid"><Panel className="p-5"><SectionTitle title="Most-used tools" icon={<Wrench size={15} />} sub="Recorded tool calls" /><BarList items={data.tools.slice(0, 10).map((t) => ({ label: t.name, value: t.count, color: PROVIDER_COLORS[t.provider], sub: PROVIDER_NAMES[t.provider] }))} formatValue={fmtCount} empty="No tool calls recorded for this period." /></Panel><Panel className="p-5"><SectionTitle title="Top models" icon={<Cpu size={15} />} sub="Ranked by token usage" /><Table rows={data.models} columns={[
        { key: 'model', label: 'Model', render: (r: AnalyticsDTO['models'][number]) => <span title={r.model} className="block max-w-[240px] truncate">{r.model}<small className="muted block text-[9px] mt-1">{PROVIDER_NAMES[r.provider]}</small></span> },
        { key: 'tokens', label: 'Tokens', align: 'right', render: (r: AnalyticsDTO['models'][number]) => fmtTokens(r.tokens) },
        { key: 'cost', label: 'Est. / recorded USD', align: 'right', render: (r: AnalyticsDTO['models'][number]) => fmtUsd(r.cost) }
      ]} /></Panel></div>
      <Panel className="p-5"><SectionTitle title="Projects in focus" icon={<FolderOpen size={15} />} sub="Ranked by tokens, then recorded requests" /><Table rows={data.projects} columns={[
        { key: 'project', label: 'Project', render: (r: AnalyticsDTO['projects'][number]) => <span title={r.project} className="block max-w-[350px] truncate">{projectLabel(r.project)}</span> },
        { key: 'provider', label: 'Tool', render: (r: AnalyticsDTO['projects'][number]) => <span className="muted">{PROVIDER_NAMES[r.provider]}</span> },
        { key: 'tokens', label: 'Tokens', align: 'right', render: (r: AnalyticsDTO['projects'][number]) => r.tokens ? fmtTokens(r.tokens) : '—' },
        { key: 'cost', label: 'Est. / recorded USD', align: 'right', render: (r: AnalyticsDTO['projects'][number]) => r.tokens ? fmtUsd(r.cost) : '—' },
        { key: 'requests', label: 'Requests', align: 'right', render: (r: AnalyticsDTO['projects'][number]) => fmtCount(r.requests) }
      ]} /></Panel>
    </>}<p className="privacy-note">Activity-only providers do not contribute to the token chart. Cost estimates can be incomplete when model prices are unknown. Configure price overrides in Settings → Pricing.</p>
  </div>
}
