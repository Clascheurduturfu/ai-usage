import { useEffect, useState } from 'react'
import { ArrowUpRight, Download, RefreshCw, Rocket } from 'lucide-react'
import type { UpdateChannel, UpdateStatus } from '../../../shared/update'
import { displayVersion } from '../../../shared/version'
import { api } from '../lib/ipc'
import { relTime } from '../lib/format'
import { Btn, Panel } from './ui'

const CHANNELS: Array<{ id: UpdateChannel; label: string; hint: string }> = [
  { id: 'stable', label: 'Stable', hint: 'Finished releases only.' },
  { id: 'preview', label: 'Preview', hint: 'The newest prerelease, plus any newer Stable. Earlier, and sometimes rougher.' }
]
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Stable/Preview channel, explicit check, verified download and an explicit install. */
export function UpdatesPanel(): React.ReactElement {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(() => {
    const load = (): void => { api().updateStatus().then(setStatus, e => setError(String(e?.message ?? e))) }
    load(); return api().onUpdateStatus(load)
  }, [])
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setWorking(true); setError(null)
    try { const next = await work(); if (next && typeof next === 'object' && 'state' in next) setStatus(next as UpdateStatus) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setWorking(false) }
  }
  if (!status) return <Panel className="settings-panel"><h2>Updates</h2><p className="muted">{error ?? 'Reading update settings…'}</p></Panel>
  const busy = working || ['checking', 'downloading', 'installing'].includes(status.state), a = status.available
  const pct = status.progress ? Math.round(status.progress.received / Math.max(1, status.progress.total) * 100) : 0
  const line = status.state === 'checking' ? 'Checking GitHub Releases…'
    : status.state === 'up-to-date' ? `You have the newest ${status.channel === 'preview' ? 'Preview or Stable' : 'Stable'} release.`
    : status.state === 'available' && a ? `${displayVersion(a.version)} is available.`
    : status.state === 'downloading' ? `Downloading… ${pct}%`
    : status.state === 'ready' ? 'Downloaded and verified.'
    : status.state === 'installing' ? 'Installing…'
    : status.state === 'error' ? 'The last check did not finish.' : 'Not checked yet.'
  return <Panel className="settings-panel update-panel">
    <div className="update-head"><div><h2>Updates</h2><p>Installed: <strong>v{displayVersion(status.installed)}</strong>{status.checkedAt ? <> · checked {relTime(status.checkedAt, Date.now())}</> : null}</p></div>
      <Btn onClick={() => void run(() => api().openReleases())} title={status.releasesUrl}><ArrowUpRight size={13} />Releases</Btn></div>
    <div className="update-channels" role="radiogroup" aria-label="Update channel">{CHANNELS.map(c => <button key={c.id} type="button" role="radio" aria-checked={status.channel === c.id} className={status.channel === c.id ? 'selected' : ''} disabled={busy}
      onClick={() => { if (status.channel !== c.id) void run(() => api().setUpdateChannel(c.id)) }}><strong>{c.label}</strong><small>{c.hint}</small></button>)}</div>
    <label className="setting-row"><div><strong>Check once a day at launch</strong><p>Only checks. Nothing downloads or installs until you choose to.</p></div><input type="checkbox" checked={status.autoCheck} disabled={busy} onChange={e => void run(() => api().setUpdateAutoCheck(e.target.checked))} /></label>
    <div className={`update-status state-${status.state}`} role="status" aria-live="polite">
      <div><strong>{line}</strong>{(status.message || error) && <p>{error ?? status.message}</p>}</div>
      {status.state === 'downloading' && <div className="update-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>}
      <div className="update-actions">
        {['idle', 'up-to-date', 'error', 'checking'].includes(status.state) && <Btn disabled={busy} onClick={() => void run(() => api().checkForUpdates())}><RefreshCw size={13} className={status.state === 'checking' ? 'spin' : ''} />Check for updates</Btn>}
        {status.state === 'available' && a && status.installKind !== 'manual' && <Btn variant="primary" disabled={busy} onClick={() => void run(() => api().downloadUpdate())}><Download size={13} />Download {mb(a.size)}</Btn>}
        {status.state === 'ready' && <Btn variant="primary" disabled={busy} onClick={() => void run(() => api().installUpdate())}><Rocket size={13} />{status.installKind === 'installer' ? 'Install and restart' : 'Open disk image'}</Btn>}
      </div>
    </div>
    {a && ['available', 'downloading', 'ready'].includes(status.state) && <details className="update-notes"><summary>{a.name}{a.prerelease ? ' · Preview' : ''}{a.publishedAt ? ` · ${new Date(a.publishedAt).toLocaleDateString()}` : ''}</summary><pre>{a.notes || 'No release notes.'}</pre></details>}
  </Panel>
}
