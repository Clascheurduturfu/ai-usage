import { ArrowRight, FolderOpen, Plug, RefreshCw, Settings2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ManagerSnapshot } from '../../../shared/manager'
import { useApp } from '../App'
import { api } from '../lib/ipc'
import { PROVIDER_COLORS, fmtCount, relTime } from '../lib/format'
import { Btn, Panel } from '../components/ui'
import { AgentConnectionDetails } from '../components/AgentConnectionDetails'
import { Surfaces } from '../components/Surfaces'

export default function ProvidersPage(): React.ReactElement {
  const { overview, now, busy, openProvider, navigate, runAction } = useApp()
  const [manager, setManager] = useState<ManagerSnapshot | null>(null)
  useEffect(() => { let active = true; const load = (): void => { void api().getManager().then(value => { if (active) setManager(value) }).catch(() => undefined) }; load(); const off = api().onManagerUpdated(load); return () => { active = false; off() } }, [])
  return <div className="page">
    <div className="page-heading"><div><div className="eyebrow">EVERYTHING IN ONE PLACE</div><h1>Connected tools<span className="brand-dot">.</span></h1><p>AI Usage reads each tool’s own logs, no setup needed. One card covers a tool’s CLI, desktop app and editor extension: they share one settings folder and one usage log.</p></div><Btn disabled={!!busy || overview?.scan.scanning} onClick={() => void runAction('scan', () => api().fullRescan(), 'Local usage refreshed.')}><RefreshCw size={14} className={busy === 'scan' ? 'animate-spin' : ''} />Scan tools</Btn></div>
    {!!overview?.scan.errors.length && <Panel className="p-5"><h2 className="flex items-center gap-2"><TriangleAlert size={16} />Scan warnings</h2><div className="mt-3 flex flex-col gap-2 text-[11px] muted break-all">{overview.scan.errors.map((e, i) => <p key={i}>{e}</p>)}</div></Panel>}
    <div className="provider-grid">{overview?.providers.map((p) => <Panel className="provider-card" key={p.id}>
      <div className="provider-card-head"><Plug size={18} style={{ color: PROVIDER_COLORS[p.id] }} /><h2>{p.name}</h2><span className={`state-pill ${p.detected ? 'state-ready' : 'state-unknown'}`}><span />{p.status === 'error' ? 'Check source' : p.detected ? 'Detected' : 'No usage yet'}</span></div>
      <Surfaces surfaces={p.surfaces} />
      <p>{p.status === 'ok' ? `${fmtCount(p.eventCount)} indexed events · last activity ${relTime(p.lastActivity, now)}` : p.note || 'Run this tool once, then scan again. If its data is stored elsewhere, choose a custom source folder in Settings.'}</p>
      <div className="provider-path">{p.dataPath}</div><div className="provider-card-actions"><Btn onClick={() => openProvider(p.id)}>View usage<ArrowRight size={13} /></Btn><Btn disabled={!!busy} onClick={() => void runAction('folder', async () => { const error = await api().openPath(p.dataPath); if (error) throw new Error(error) })} title="Open source folder"><FolderOpen size={13} />Open folder</Btn><button className="icon-btn" aria-label={`Configure ${p.name} source`} onClick={() => navigate({ kind: 'settings' })}><Settings2 size={15} /></button></div>
      {p.id === 'antigravity' && manager?.antigravity && <AgentConnectionDetails name={p.name} status={manager.antigravity} sharedNames={manager.mcp.map(s => s.name)} busy={!!busy} reload={() => void runAction('reload-antigravity', async () => { await api().refreshAntigravity(); setManager(await api().getManager()) })} />}
    </Panel>)}</div><p className="privacy-note">“Detected” describes local usage logs. Live subscription quotas use the tool’s existing sign-in and have their own connection status on Overview. Missing token counts are kept as activity-only data.</p>
  </div>
}
