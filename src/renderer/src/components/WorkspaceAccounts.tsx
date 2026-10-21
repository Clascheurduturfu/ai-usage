import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { WorkspaceStatus } from '../../../shared/manager'
import { validateWorkspaceAccount } from '../../../shared/workspace-account'
import { api } from '../lib/ipc'
import { Btn, Field } from './ui'

export function WorkspaceAccounts({ status, act, busy }: { status?: WorkspaceStatus; busy: boolean; act(work: () => Promise<unknown>, success?: string): Promise<void> }): React.ReactElement {
  const [adding, setAdding] = useState(false), [account, setAccount] = useState(''), [error, setError] = useState('')
  const accounts = status?.accounts ?? []
  const connect = (): void => {
    const name = account.trim()
    try {
      validateWorkspaceAccount(name)
      if (accounts.some(a => a.account === name)) throw new Error('That account name already exists. Reconnect it below or choose another name.')
      setError('')
      void act(async () => { await api().signInWorkspace(name); setAccount(''); setAdding(false) })
    } catch (e) { setError((e as Error).message) }
  }
  return <div className="manager-workspace">
    <div className="workspace-heading"><div><strong>Official gws · Google accounts</strong><p className="muted">Each account has its own name and sign-in. All saved accounts travel with encrypted Sharing.</p></div><Btn disabled={busy || !status?.oauthConfigured} onClick={() => setAdding(true)}><Plus size={14} />Add account</Btn></div>
    {!status?.oauthConfigured && <p className="muted">Import your Google OAuth project below to enable sign-in.</p>}
    {adding && <form className="workspace-add" onSubmit={e => { e.preventDefault(); connect() }}>
      <Field label="Account name" hint="Used by agents to choose the account, for example work or personal."><input autoFocus value={account} maxLength={48} placeholder="work" onChange={e => { setAccount(e.target.value); setError('') }} autoComplete="off" /></Field>
      <Btn disabled={busy || !account.trim() || !status?.oauthConfigured} onClick={connect}>Continue with Google</Btn><Btn disabled={busy} aria-label="Cancel adding account" onClick={() => { setAdding(false); setError('') }}><X size={14} /></Btn>
      {error && <p role="alert" className="workspace-form-error">{error}</p>}
    </form>}
    {accounts.map(a => <div className="workspace-account" key={a.account}>
      <div><strong>{a.account === 'gmail' ? 'Gmail' : a.account === 'work' ? 'Work' : a.account}</strong><small>{a.email ? `${a.email} · ` : ''}{a.state}{a.detail ? ` · ${a.detail}` : ''}</small><small>Account name: {a.account}</small></div>
      <div className="manager-actions"><Btn disabled={busy || !status?.oauthConfigured || a.state === 'Waiting for browser sign-in'} onClick={() => void act(() => api().signInWorkspace(a.account))}>{a.email ? 'Reconnect' : a.state === 'Waiting for browser sign-in' ? 'Waiting for Google…' : 'Sign in'}</Btn>
        {<Btn disabled={busy} aria-label={`Remove ${a.account} sign-in`} onClick={() => void act(() => api().signOutWorkspace(a.account), `${a.account} sign-in removed`)}>{a.state === 'Waiting for browser sign-in' ? 'Cancel' : 'Sign out'}</Btn>}</div>
    </div>)}
    <details><summary>Google project settings{status?.projectId ? ` · ${status.projectId}` : ''}</summary><div className="workspace-project"><p className="muted">Import the Desktop OAuth client JSON from your Google Cloud project. Your shared project settings can be reused on this device.</p><Btn disabled={busy} onClick={() => void act(async () => { const file = await api().pickJsonFile(); if (file) await api().importWorkspaceClientFile(file) }, 'Google OAuth client imported')}>{status?.oauthConfigured ? 'Replace OAuth client' : 'Import OAuth client'}</Btn></div></details>
  </div>
}
