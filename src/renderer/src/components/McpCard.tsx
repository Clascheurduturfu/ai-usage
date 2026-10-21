import { MoreHorizontal, Network, Globe } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ManagerSnapshot, McpRecord } from '../../../shared/manager'
import { isPublicMcp } from '../../../shared/mcp-auth'
import { api } from '../lib/ipc'
import { hasSetupHelp, mcpStatus, type McpPrimary } from '../lib/mcp-status'
import { Btn, Panel } from './ui'
import { WorkspaceAccounts } from './WorkspaceAccounts'

type Action = (work: () => Promise<unknown>, success?: string) => Promise<void>
const PRIMARY_LABEL: Record<McpPrimary, string> = { check: 'Check', signIn: 'Sign in', reconnect: 'Reconnect', resume: 'Resume', prepare: 'Prepare', manage: 'Connect via AI Usage', help: 'Setup help' }

export function McpCard({ server: s, data, act, busy, edit, prepare, localLaunch, help }: {
  server: McpRecord; data: ManagerSnapshot; act: Action; busy: boolean; edit(server: McpRecord): void
  prepare(names: string[]): void; localLaunch(name: string): void; help(name: string): void
}): React.ReactElement {
  const [menu, setMenu] = useState(false), [confirmRemove, setConfirmRemove] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) { setConfirmRemove(false); return }
    const close = (e: MouseEvent | KeyboardEvent): void => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false) }
    window.addEventListener('mousedown', close); window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [menu])
  const remote = s.transport === 'http', publicServer = isPublicMcp(s.url)
  const status = mcpStatus(s, data), paused = !!data.runtime?.paused.includes(s.name)
  const managed = !!data.config.mcpAuth?.[s.name]?.enabled
  const ref = data.config.mcpAuth?.[s.name]?.secretRef, credentialSaved = !!ref && data.secrets.includes(ref)
  const sessions = data.runtime?.sessions.filter(session => session.name === s.name) ?? []
  const setManaged = (enabled: boolean): Promise<void> => act(async () => { const result = await api().setMcpAuth(s.name, enabled); if (result.conflicts.length) throw new Error('Review sync conflicts in Shared library → Sync.') }, enabled ? `${s.name} now connects through AI Usage. Restart open coding clients to pick it up.` : `${s.name} now connects directly. Restart open coding clients to pick it up.`)
  const check = (): Promise<void> => act(async () => { const result = await api().checkMcp(s.name); if (result.state === 'Connection failed') throw new Error(result.detail) }, `${s.name}: connection works`)
  const run = (primary: McpPrimary): void => {
    if (primary === 'check') void check()
    else if (primary === 'signIn' || primary === 'reconnect') void act(() => api().loginMcp(s.name))
    else if (primary === 'resume') void act(() => api().resumeMcp(s.name), `${s.name} resumed`)
    else if (primary === 'prepare') prepare([s.name])
    else if (primary === 'manage') void setManaged(true)
    else help(s.name)
  }
  const item = (label: string, onClick: () => void, danger = false): React.ReactElement => <button role="menuitem" className={danger ? 'danger' : ''} disabled={busy} onClick={() => { onClick(); if (!danger) setMenu(false) }}>{label}</button>
  const source = remote ? s.url : s.aiUsage?.source ? `${s.aiUsage.source.package ?? s.aiUsage.source.kind} ${s.aiUsage.source.version}` : `${s.command} ${(s.args ?? []).join(' ')}`
  return <Panel className="mcp-card">
    <div className="mcp-row">
      <span className={`mcp-dot tone-${status.tone}`} aria-hidden="true" />
      <div className="mcp-title">
        <h3>{remote ? <Globe size={14} /> : <Network size={14} />}{s.name}</h3>
        <p title={source}>{source}</p>
      </div>
      <span className={`mcp-pill tone-${status.tone}`} role="status">{status.label}</span>
      <div className="mcp-actions">
        {status.primary && <Btn variant={status.tone === 'error' || status.tone === 'warn' || status.primary === 'manage' ? 'primary' : 'default'} disabled={busy} onClick={() => run(status.primary!)}>{PRIMARY_LABEL[status.primary]}</Btn>}
        <div className="mcp-menu" ref={menuRef}>
          <button className="icon-btn" aria-label={`More actions for ${s.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(open => !open)}><MoreHorizontal size={16} /></button>
          {menu && <div className="mcp-menu-list" role="menu">
            {remote && managed && !publicServer && status.primary !== 'signIn' && status.primary !== 'reconnect' && item(credentialSaved ? 'Reconnect (new sign-in)' : 'Sign in', () => void act(() => api().loginMcp(s.name)))}
            {remote && managed && !publicServer && credentialSaved && item('Sign out on this device', () => void act(() => api().logoutMcp(s.name), 'Sign-in removed from this device'))}
            {remote && (managed ? item('Let clients connect directly', () => void setManaged(false)) : null)}
            {status.primary !== 'check' && !paused && item('Check connection', () => void check())}
            {!remote && item('Edit local launch', () => localLaunch(s.name))}
            {!remote && data.deviceMcp?.[s.name]?.canPrepare && status.primary !== 'prepare' && item('Reinstall on this device', () => prepare([s.name]))}
            {!remote && hasSetupHelp(s.name) && status.primary !== 'help' && item('Setup help', () => help(s.name))}
            {!!data.runtime && (remote ? managed : true) && !paused && item(remote ? 'Disconnect and stop' : 'Stop on this device', () => void act(() => api().stopMcp(s.name), `${s.name} stopped on this device`))}
            {item('Edit configuration', () => edit(s))}
            {confirmRemove ? item(`Confirm: remove ${s.name} everywhere`, () => { setMenu(false); void act(() => api().deleteMcp(s.name), `${s.name} removed`) }, true) : item('Remove…', () => setConfirmRemove(true), true)}
          </div>}
        </div>
      </div>
    </div>
    <p className="mcp-detail">{status.detail}</p>
    {!remote && sessions.length > 0 && <details className="mcp-sessions"><summary>{sessions.length} client session{sessions.length === 1 ? '' : 's'}</summary>{sessions.map((session, index) => <p key={index}>Client PID {session.clientPid ?? 'unknown'} · {session.workerId ? 'process running' : 'idle'} · {session.active} active · {session.pending} queued · last used {new Date(session.lastActivity).toLocaleTimeString()}</p>)}</details>}
    {s.name === 'google-workspace' && <WorkspaceAccounts status={data.workspace} act={act} busy={busy} />}
  </Panel>
}
