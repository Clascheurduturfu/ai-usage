import { APP_DISPLAY_VERSION, displayVersion } from '../../shared/version'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Activity, ArrowUpRight, RefreshCw, Sparkles } from 'lucide-react'
import type { AppMeta, OverviewDTO, QuotaSnapshotDTO, Settings } from '../../shared/types'
import { makeQuotaCards } from '../../shared/quotas'
import { api } from './lib/ipc'
import './popover.css'

function resetLabel(at: number | null | undefined, now: number): string {
  if (!at || !Number.isFinite(at)) return 'Reset time unavailable'
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return 'Reset due · refresh'
  if (minutes >= 1440) return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
  return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
type Window = { id: string; label: string; remaining: number; resetAt?: number | null }
function Card({ name, plan, windows, fetchedAt, error, color, now, hint }: { name: string; plan?: string; windows: Window[]; fetchedAt?: number; error?: string; color: string; now: number; hint: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const ordered = name === 'Antigravity' ? [...windows].sort((a, b) => a.remaining - b.remaining) : windows
  const visible = name === 'Antigravity' && !expanded ? ordered.slice(0, 2) : ordered
  const stale = !!fetchedAt && (now - fetchedAt > 45 * 60_000 || windows.some(w => w.resetAt && w.resetAt <= now))
  const tightest = windows.length ? Math.min(...windows.map(w => w.remaining)) : null
  return <section className="popover-card" style={{ '--quota-color': color } as React.CSSProperties}>
    <div className="popover-card-heading"><span className="popover-provider-dot" /><h2>{name}</h2><span className="popover-plan">{plan ?? 'Not connected'}</span></div>
    <div className="popover-capacity"><strong>{tightest === null ? '—' : `${Math.round(tightest)}%`}</strong><span>{tightest === null ? 'Waiting for account data' : error ? 'Last known remaining' : stale ? 'Last known · refresh needed' : 'remaining in tightest window'}</span></div>
    {visible.map(w => <div className="popover-window" key={w.id}><div><span>{w.label}</span><b>{Math.round(w.remaining)}%</b></div><div className="popover-track"><i style={{ width: `${w.remaining}%` }} /></div><small>{resetLabel(w.resetAt, now)}</small></div>)}
    {name === 'Antigravity' && ordered.length > 2 && <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer limits' : `Show ${ordered.length - 2} more limits`}</button>}
    {error && <p className="popover-error">{error}</p>}
    {!windows.length && !error && <p className="popover-hint">{hint}</p>}
  </section>
}
export default function QuotaPopover(): React.ReactElement {
  const [quota, setQuota] = useState<QuotaSnapshotDTO | null>(null), [meta, setMeta] = useState<AppMeta | null>(null), [settings, setSettings] = useState<Settings | null>(null), [overview, setOverview] = useState<OverviewDTO | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now)
  const [phase, setPhase] = useState<'entering' | 'open' | 'closing'>('entering')
  const cardRef = useRef<HTMLElement>(null)
  const closingRef = useRef(false)
  const generation = useMemo(() => {
    const raw = Number(new URLSearchParams(location.search).get('gen') ?? '0')
    return Number.isFinite(raw) ? raw : 0
  }, [])
  const load = useCallback(async () => { setQuota(await api().getQuota()); setMeta(await api().meta()); setSettings(await api().getSettings()); setOverview(await api().getOverview()) }, [])
  useEffect(() => {
    document.documentElement.dataset.popover = '1'
    document.documentElement.dataset.theme = 'system'
    void api().getSettings().then(s => { document.documentElement.dataset.theme = s.theme }).catch(() => undefined)
    void load().catch(e => setError(String(e)))
    const unsubscribe = api().onDataUpdated(() => { void load().catch(e => setError(String(e))) })
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') void invoke('hide_popover').catch(() => undefined) }
    window.addEventListener('keydown', onKey)

    let cancelled = false
    let raf1 = 0
    let raf2 = 0
    let unlistenClose: (() => void) | undefined
    const runExit = async (): Promise<void> => {
      if (closingRef.current) return
      closingRef.current = true
      setPhase('closing')
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const el = cardRef.current
      if (el) {
        const animations = el.getAnimations()
        if (animations.length > 0) {
          await Promise.race([
            Promise.allSettled(animations.map(a => a.finished)),
            new Promise<void>(resolve => setTimeout(resolve, 200))
          ])
        }
      }
      await invoke('finish_close_popover', { generation }).catch(() => undefined)
    }

    void listen<number>('popover:closing', event => {
      if (event.payload !== generation && event.payload !== undefined) return
      void runExit()
    }).then(fn => { if (cancelled) fn(); else unlistenClose = fn }).catch(() => undefined)

    void invoke('show_popover', { generation }).catch(() => undefined).then(() => {
      if (cancelled || closingRef.current) return
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          if (!cancelled && !closingRef.current) setPhase('open')
        })
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      unlistenClose?.()
      unsubscribe()
      clearInterval(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [generation, load])
  const refresh = async (): Promise<void> => { if (busy) return; setBusy(true); setError(''); try { setQuota(await api().refreshQuota()) } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  // Same cards and pinned order as the Overview and the tray menu.
  const cards = settings && overview ? makeQuotaCards(quota, settings, overview) : []
  const pinned = settings ? settings.pinnedQuotas.map(id => cards.find(card => card.id === id)).filter(card => !!card) : []
  const colors: Record<string, string> = { codex: '#88dab8', antigravity: '#8ea7ff', openrouter: '#f0b86e', claude: '#e98a6b' }
  const fetched = pinned.map(card => card.fetchedAt).filter((v): v is number => !!v)
  return <div className="popover-stage" onMouseDown={e => { if (e.target === e.currentTarget) void invoke('hide_popover').catch(() => undefined) }}>
    <main ref={cardRef} className="quota-popover" data-phase={phase}><header><div className="popover-brand"><Activity size={20} /><div><h1>AI Usage</h1><small>Your capacity, at a glance</small></div></div><span className="popover-version">v{meta?.version ? displayVersion(meta.version) : APP_DISPLAY_VERSION}</span></header>
      <div className="popover-scroll"><div className="popover-section-label"><Sparkles size={12} /> AVAILABLE NOW</div>
        {pinned.map(card => <Card key={card.id} name={card.name} plan={card.plan} windows={card.windows} fetchedAt={card.fetchedAt ?? undefined} error={card.error} color={colors[card.id]} now={now} hint={card.detail} />)}
        {settings && !pinned.length && <p className="popover-hint">No pinned quotas. Pin them on the Overview.</p>}
        {error && <p className="popover-error" role="alert">{error}</p>}
        {meta?.managerError && <p className="popover-error">Shared library needs attention. Open the dashboard for details.</p>}
      </div><footer><div><button className="popover-refresh" onClick={() => void refresh()} disabled={busy}><RefreshCw size={13} className={busy ? 'popover-spin' : ''} />{busy ? 'Refreshing…' : 'Refresh'}</button><small>{fetched.length ? `Updated ${new Date(Math.min(...fetched)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Account data stays on this Mac'}</small></div><button className="popover-open" onClick={() => void invoke('open_dashboard')}>Dashboard<ArrowUpRight size={14} /></button></footer>
    </main>
  </div>
}
