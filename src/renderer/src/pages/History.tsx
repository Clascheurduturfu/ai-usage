import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ChevronLeft, ChevronRight, History, Search, X } from 'lucide-react'
import type { HistoryDTO, HistoryFilter, ProviderId, SessionRow } from '../../../shared/types'
import { PROVIDER_IDS, PROVIDER_NAMES } from '../../../shared/types'
import { useApp } from '../App'
import { api } from '../lib/ipc'
import { PROVIDER_COLORS, fmtCount, fmtDateTime, fmtTokens, fmtUsd, projectLabel } from '../lib/format'
import { Btn, EmptyState, LoadingRows, Panel, Table } from '../components/ui'
import { SessionModels } from '../components/SessionModels'

function csvCell(value: string | number): string {
  const text = String(value)
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`
}
export default function HistoryPage(): React.ReactElement {
  const { version, openProvider, runAction, busy } = useApp()
  const [filter, setFilter] = useState<HistoryFilter>({ days: 30, sort: 'recent', offset: 0, limit: 25 })
  // The command palette hands over a query once.
  const [search, setSearch] = useState(() => { try { return sessionStorage.getItem('aiu:history-search') ?? '' } catch { return '' } })
  useEffect(() => { try { sessionStorage.removeItem('aiu:history-search') } catch { /* optional hand-off */ } }, [])
  const [data, setData] = useState<HistoryDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => f.search === search ? f : { ...f, search, offset: 0 }), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api().getHistory(filter).then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((e) => { if (!cancelled) setError(String(e)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [filter, version])
  const change = (patch: Partial<HistoryFilter>): void => setFilter((f) => ({ ...f, ...patch, offset: 0 }))
  const exportRows = async (): Promise<void> => {
    const rows: SessionRow[] = []
    let total = Infinity
    for (let offset = 0; offset < total; offset += 100) {
      const result = await api().getHistory({ ...filter, offset, limit: 100 })
      total = result.total; rows.push(...result.sessions)
      if (!result.sessions.length) break
    }
    const lines = [['Tool', 'Project', 'Model', 'Last activity', 'Tokens', 'Main tokens', 'Subagent tokens', 'Estimated / recorded USD', 'Cost complete', 'Requests', 'Session ID'],
      ...rows.map((r) => [PROVIDER_NAMES[r.provider], r.project, r.models?.join(' + ') ?? r.model, new Date(r.lastAt).toISOString(), r.tokens, r.tokens - (r.subagentTokens ?? 0), r.subagentTokens ?? 0, r.cost, r.unpriced ? 'No' : 'Yes', r.requests, r.id])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `ai-usage-${filter.days}d.csv`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const offset = filter.offset ?? 0
  return <div className="page">
    <div className="page-heading"><div><div className="eyebrow">THE DETAILS, WHEN YOU NEED THEM</div><h1>Usage history<span className="brand-dot">.</span></h1><p>Find a session, project or model across all your tools.</p></div><Btn disabled={!!busy || loading || !data?.total} onClick={() => void runAction('export', exportRows, 'Filtered usage exported to CSV.')}><ArrowDownToLine size={14} />Export CSV</Btn></div>
    <div className="filter-bar"><div className="search-field"><Search size={16} /><input aria-label="Search usage" ref={searchRef} placeholder="Search projects, models or sessions…" value={search} onChange={(e) => setSearch(e.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</div>
      <select aria-label="Filter by tool" value={filter.provider ?? ''} onChange={(e) => change({ provider: e.target.value ? e.target.value as ProviderId : undefined })}><option value="">All tools</option>{PROVIDER_IDS.map((id) => <option key={id} value={id}>{PROVIDER_NAMES[id]}</option>)}</select>
      <select aria-label="History period" value={filter.days} onChange={(e) => change({ days: Number(e.target.value) as HistoryFilter['days'] })}>{[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d === 1 ? 'Today' : `Last ${d} days`}</option>)}</select>
      <select aria-label="Sort sessions" value={filter.sort} onChange={(e) => change({ sort: e.target.value as HistoryFilter['sort'] })}><option value="recent">Most recent</option><option value="tokens">Most tokens</option><option value="cost">Highest est. cost</option></select>
    </div>
    <Panel className="table-panel"><div className="table-meta"><strong>{data ? `${fmtCount(data.total)} sessions` : 'Loading sessions…'}</strong><span>Totals cover the selected period</span></div>
      {error ? <EmptyState title="Couldn’t load usage" hint={error} /> : loading ? <LoadingRows rows={8} /> : !data?.total ? <EmptyState icon={<History size={22} />} title="No matching sessions" hint="Try another search, a longer time period or a different tool." /> : <Table rows={data.sessions} columns={[
        { key: 'project', label: 'Project / model', render: (r: SessionRow) => <div className="max-w-[300px]"><strong className="block truncate font-medium" title={r.project}>{projectLabel(r.project)}</strong><SessionModels session={r} className="text-[10px] mt-1" /></div> },
        { key: 'provider', label: 'Tool', render: (r: SessionRow) => <button className="text-btn" onClick={() => openProvider(r.provider)}><span className="provider-dot" style={{ background: PROVIDER_COLORS[r.provider] }} />{PROVIDER_NAMES[r.provider]}</button> },
        { key: 'last', label: 'Last active', render: (r: SessionRow) => <span className="muted whitespace-nowrap">{fmtDateTime(r.lastAt)}</span> },
        { key: 'tokens', label: 'Tokens', align: 'right', render: (r: SessionRow) => r.tokens ? <div>{fmtTokens(r.tokens)}{!!r.subagentTokens && <span className="block text-[10px] muted mt-1">{fmtTokens(r.tokens - r.subagentTokens)} main · {fmtTokens(r.subagentTokens)} agents</span>}</div> : <span className="muted" title="This tool does not record token counts">—</span> },
        { key: 'cost', label: 'Est. / recorded cost', align: 'right', render: (r: SessionRow) => r.unpriced ? <span title="Some model prices are missing" style={{ color: 'var(--warn)' }}>{r.cost ? `${fmtUsd(r.cost)}+` : 'Unknown'}</span> : r.tokens ? fmtUsd(r.cost) : '—' },
        { key: 'requests', label: 'Requests', align: 'right', render: (r: SessionRow) => fmtCount(r.requests) }
      ]} />}
      {data && data.total > 0 && <div className="pagination"><span>{offset + 1}–{Math.min(offset + 25, data.total)} of {fmtCount(data.total)}</span><div><Btn disabled={loading || !offset} onClick={() => setFilter((f) => ({ ...f, offset: Math.max(0, offset - 25) }))}><ChevronLeft size={13} />Previous</Btn><Btn disabled={loading || offset + 25 >= data.total} onClick={() => setFilter((f) => ({ ...f, offset: offset + 25 }))}>Next<ChevronRight size={13} /></Btn></div></div>}
    </Panel><p className="privacy-note">Costs combine provider-recorded amounts with API-equivalent estimates where available. They are not your subscription bill. A dash means the tool has no token/cost data; unknown prices may leave estimates incomplete.</p>
  </div>
}
