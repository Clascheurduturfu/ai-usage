import { APP_DISPLAY_VERSION, displayVersion } from '../../shared/version'
import { createContext, useCallback, useContext, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Activity, ArrowUpRight, BarChart3, Check, ChevronRight, CircleHelp, History, LayoutDashboard, Moon, Plug, Search, Settings as SettingsIcon, ShieldCheck, Sun, X } from 'lucide-react'
import type { AppMeta, OverviewDTO, ProviderId, QuotaSnapshotDTO, Settings } from '../../shared/types'
import { PROVIDER_IDS, PROVIDER_NAMES } from '../../shared/types'
import { api } from './lib/ipc'
import { PROVIDER_COLORS, relTime } from './lib/format'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const ProviderPage = lazy(() => import('./pages/ProviderPage'))
const AnalyticsPage = lazy(() => import('./pages/Analytics'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const HistoryPage = lazy(() => import('./pages/History'))
const ProvidersPage = lazy(() => import('./pages/Providers'))
const ManagerPage = lazy(() => import('./pages/ManagerV3'))

export type Page = { kind: 'dashboard' | 'analytics' | 'settings' | 'history' | 'providers' | 'endpoints' | 'proxies' | 'agents' | 'shared' } | { kind: 'provider'; id: ProviderId }
interface AppCtx {
  meta: AppMeta | null; settings: Settings | null; overview: OverviewDTO | null; quota: QuotaSnapshotDTO | null
  version: number; now: number; error: string | null; busy: string | null
  refresh: () => Promise<void>; refreshQuotas: () => Promise<void>
  runAction: (name: string, fn: () => Promise<unknown>, message?: string) => Promise<void>
  openProvider: (id: ProviderId) => void; navigate: (page: Page) => void
}
const Ctx = createContext<AppCtx | null>(null)
export function useApp(): AppCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp outside provider')
  return ctx
}
function initialPage(): Page {
  const p = new URLSearchParams(window.location.search).get('page')
  if (p && ['analytics', 'settings', 'history', 'providers'].includes(p)) return { kind: p as 'analytics' | 'settings' | 'history' | 'providers' }
  if (PROVIDER_IDS.includes(p as ProviderId)) return { kind: 'provider', id: p as ProviderId }
  try { const saved = JSON.parse(localStorage.getItem('aiu:last-page') ?? 'null'); if (saved && ['dashboard', 'analytics', 'settings', 'history', 'providers', 'endpoints', 'proxies', 'agents', 'shared'].includes(saved.kind)) return saved } catch { /* invalid saved navigation */ }
  return { kind: 'dashboard' }
}
const NAV = [
  { kind: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { kind: 'history', label: 'Usage history', icon: History },
  { kind: 'analytics', label: 'Insights', icon: BarChart3 },
  { kind: 'providers', label: 'Connected tools', icon: Plug },
  { kind: 'endpoints', label: 'Endpoints', icon: Plug },
  { kind: 'agents', label: 'Agent profiles', icon: ShieldCheck },
  { kind: 'shared', label: 'Shared library', icon: SettingsIcon }
] as const
export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>(initialPage)
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [overview, setOverview] = useState<OverviewDTO | null>(null)
  const [quota, setQuota] = useState<QuotaSnapshotDTO | null>(null)
  const [version, setVersion] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const refreshTask = useRef<Promise<void> | null>(null)
  const actionBusy = useRef(false)
  const mainRef = useRef<HTMLElement>(null)
  const refresh = useCallback((): Promise<void> => {
    if (refreshTask.current) return refreshTask.current
    refreshTask.current = Promise.all([api().getSettings(), api().getOverview(), api().getQuota(), api().meta()])
      .then(([s, o, q, m]) => { setSettings(s); setOverview(o); setQuota(q); setMeta(m); setVersion((v) => v + 1) })
      .finally(() => { refreshTask.current = null })
    return refreshTask.current
  }, [])
  const runAction = useCallback(async (name: string, fn: () => Promise<unknown>, message?: string): Promise<void> => {
    if (actionBusy.current) return
    actionBusy.current = true; setBusy(name); setError(null)
    try { await fn(); await refresh(); if (message) setToast(message) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { actionBusy.current = false; setBusy(null) }
  }, [refresh])
  const refreshQuotas = useCallback(() => runAction('quotas', async () => {
    await api().refreshQuota()
  }, 'Quota refresh finished. Check each card for its connection status.'), [runAction])
  const navigate = useCallback((p: Page) => setPage(p), [])
  const openProvider = useCallback((id: ProviderId) => setPage({ kind: 'provider', id }), [])
  useEffect(() => {
    void api().meta().then(setMeta).catch((e) => setError(String(e)))
    void refresh().catch((e) => setError(String(e)))
    return api().onDataUpdated(() => { void refresh().catch((e) => setError(String(e))) })
  }, [refresh])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  useEffect(() => { if (settings) document.documentElement.dataset.theme = settings.theme }, [settings])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => { mainRef.current?.scrollTo(0, 0) }, [page])
  useEffect(() => { localStorage.setItem('aiu:last-page', JSON.stringify(page)) }, [page])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPage({ kind: 'history' }) }
      if (e.key === 'Escape') setHelp(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const active = overview?.providers.filter((p) => p.detected || p.eventCount > 0 || (p.id === 'antigravity' && quota?.antigravity && !quota.antigravity.error) || (p.id === 'codex' && quota?.chatgpt && !quota.chatgpt.error)) ?? []
  const title = page.kind === 'provider' ? PROVIDER_NAMES[page.id] : NAV.find((n) => n.kind === page.kind)?.label ?? 'Settings'
  const dark = settings?.theme === 'dark' || (settings?.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  return <Ctx.Provider value={{ meta, settings, overview, quota, version, now, error, busy, refresh, refreshQuotas, runAction, openProvider, navigate }}>
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate({ kind: 'dashboard' })} aria-label="AI Usage home">
          <span className="brand-mark"><Activity size={23} strokeWidth={2.2} /></span>
          <span><strong>AI Usage<span className="brand-dot">.</span></strong><small>Your personal control room</small></span>
        </button>
        <button className="search-shortcut" onClick={() => navigate({ kind: 'history' })}><Search size={15} /><span>Find usage…</span><kbd>Ctrl K</kbd></button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">{NAV.map(({ kind, label, icon: Icon }) => <button key={kind} className={`nav-item ${page.kind === kind ? 'active' : ''}`} aria-current={page.kind === kind ? 'page' : undefined} onClick={() => navigate({ kind })}>
          <Icon size={17} /><span>{label}</span>{kind === 'providers' && <span className="nav-count">{active.length}</span>}
        </button>)}</nav>
        <div className="nav-label tools-label">YOUR TOOLS <span>{active.length}</span></div>
        <nav aria-label="Tool details" className="tool-nav">{active.map((p) => <button key={p.id} className={`nav-item ${page.kind === 'provider' && page.id === p.id ? 'active' : ''}`} onClick={() => openProvider(p.id)}>
          <span className="provider-dot" style={{ background: PROVIDER_COLORS[p.id] }} /><span>{p.name}</span><ChevronRight size={12} />
        </button>)}{!active.length && <p className="sidebar-hint">Your detected tools will appear here.</p>}</nav>
        <div className="sidebar-bottom">
          <div className="local-notice"><ShieldCheck size={16} /><div><strong>On your machine</strong><small>Local usage. No telemetry.</small></div></div>
          <button className={`nav-item ${page.kind === 'settings' ? 'active' : ''}`} onClick={() => navigate({ kind: 'settings' })}><SettingsIcon size={17} /><span>Settings</span></button>
          <div className="sidebar-footer"><span>v{meta?.version ? displayVersion(meta.version) : APP_DISPLAY_VERSION}</span><button className="icon-btn" title={dark ? 'Switch to light theme' : 'Switch to dark theme'} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} disabled={!!busy || !settings} onClick={() => void runAction('theme', () => api().setSettings({ theme: dark ? 'light' : 'dark' }))}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button></div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="breadcrumb">Workspace<ChevronRight size={13} /><strong>{title}</strong></div><div className="topbar-actions"><span className="watching"><span className="live-dot" />{overview?.scan.scanning ? 'Indexing usage' : 'Monitoring locally'}</span><button className="icon-btn" aria-label="How AI Usage works" onClick={() => setHelp((v) => !v)}><CircleHelp size={18} /></button></div></header>
        {help && <div className="help-banner"><ShieldCheck size={19} /><div><strong>A little clarity</strong><p>Usage history is read from local tool logs. Subscription quotas are fetched from your providers using existing tool sign-ins. Cost estimates are API equivalents, not your subscription bill. Android sync uploads a quota snapshot only when you enable it.</p><small>Ctrl K opens usage search · close the window to keep monitoring in the tray.</small></div><button className="icon-btn" aria-label="Close help" onClick={() => setHelp(false)}><X size={17} /></button></div>}
        {error && <div className="error-banner" role="alert"><span>{error}</span><button className="text-btn" onClick={() => void runAction('retry', () => refresh())}>Retry</button><button className="icon-btn" aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}
        {meta?.managerError && <div className="error-banner" role="alert"><span>Shared library: {meta.managerError}. Quotas remain available. Startup log: {meta.userDataPath}/broker-startup.log</span></div>}
        <main ref={mainRef} className="main-content" id="main-content">
          <Suspense fallback={<div className="page muted">Opening dashboard…</div>}>
          {page.kind === 'dashboard' && <Dashboard />}{page.kind === 'history' && <HistoryPage />}
          {page.kind === 'provider' && <ProviderPage key={page.id} id={page.id} />}{page.kind === 'analytics' && <AnalyticsPage />}
          {page.kind === 'providers' && <ProvidersPage />}{page.kind === 'settings' && <SettingsPage />}
          {['endpoints', 'proxies', 'agents', 'shared'].includes(page.kind) && <ManagerPage key={page.kind} section={page.kind as 'endpoints' | 'proxies' | 'agents' | 'shared'} />}
          </Suspense>
        </main>
        <footer className="statusbar"><span><span className="live-dot" />{overview?.scan.lastScanAt ? `Local index updated ${relTime(overview.scan.lastScanAt, now)}` : 'Preparing local index…'}</span><button onClick={() => navigate({ kind: 'providers' })}>{overview?.scan.errors.length ? `${overview.scan.errors.length} scan warnings` : `${active.length} tools detected`}<ArrowUpRight size={12} /></button></footer>
      </div>
      {toast && <div className="toast" role="status"><Check size={16} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  </Ctx.Provider>
}
