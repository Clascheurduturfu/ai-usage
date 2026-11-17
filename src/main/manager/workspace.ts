import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ManagerStore, Vault, validateName, type NativeCall } from './storage'
import type { WorkspaceStatus } from '../../shared/manager'
import { APP_VERSION } from '../../shared/version'
import type { NativeSupervisor } from './native-supervisor'
import { validateWorkspaceAccount } from '../../shared/workspace-account'

const services = ['drive', 'gmail', 'calendar', 'sheets', 'docs', 'people', 'slides', 'forms', 'tasks', 'chat', 'meet', 'classroom']
type Credential = { type: 'authorized_user'; client_id: string; client_secret: string; refresh_token: string; token?: string; expiry?: string; token_uri?: string; scopes?: string[]; signedInAt?: number }
type Runner = { command: string; args: string[]; env?: Record<string, string> }
const scopes = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/contacts.readonly']

const scopeLabels: Record<string, string> = {
  'https://www.googleapis.com/auth/gmail.modify': 'Gmail (read and organize)', 'https://www.googleapis.com/auth/gmail.send': 'Gmail (send)',
  'https://www.googleapis.com/auth/calendar': 'Calendar', 'https://www.googleapis.com/auth/drive': 'Drive', 'https://www.googleapis.com/auth/documents': 'Docs',
  'https://www.googleapis.com/auth/spreadsheets': 'Sheets', 'https://www.googleapis.com/auth/contacts.readonly': 'Contacts'
}
const TESTING_HINT = 'If your Google Cloud OAuth app is still in Testing, Google ends its sign-ins after 7 days; publishing the app to Production stops that.'
/** A failed token refresh, with Google's reason (invalid_grant means the sign-in was revoked or expired). */
class RefreshError extends Error { constructor(message: string, readonly status: number, readonly reason?: string) { super(message) } }

/** Turn a failed gws run into a message that says what Google refused and what to do. */
export function describeGwsError(error: unknown, account?: string): string {
  const e = error as { message?: string; stdout?: string; stderr?: string }
  const out = String(e?.stdout ?? ''), err = String(e?.stderr ?? '')
  let api: { code?: number; message?: string; reason?: string; status?: string } | undefined
  try { api = JSON.parse(out.slice(out.indexOf('{')))?.error } catch { /* not a JSON error */ }
  const who = account ? `the ${account} account` : 'this account'
  if (api?.code) {
    const said = String(api.message ?? api.status ?? 'no details').slice(0, 500)
    if (api.code === 401) return `Google rejected ${who}'s sign-in (HTTP 401): ${said} Reconnect it in AI Usage → Shared library → MCP → google-workspace.`
    if (api.code === 403 && /scope|insufficient|permission/i.test(`${said} ${api.reason ?? ''}`)) return `${who.charAt(0).toUpperCase() + who.slice(1)} did not grant the permission this call needs (HTTP 403): ${said} Reconnect it and allow every permission on Google's consent screen.`
    return `Google refused the request (HTTP ${api.code}${api.reason ? `, ${api.reason}` : ''}): ${said}`
  }
  const text = (err.split(/\r?\n/).find(line => /^error/i.test(line.trim())) ?? (err.trim() || out.trim())).trim()
  return text ? `gws: ${text.slice(0, 1500)}` : `${e?.message ?? 'gws failed'}. gws printed nothing; run the AI Usage connection check for google-workspace.`
}

/** Official gws 0.22.5 uses the app adapter for MCP and account selection. Keep credentials and selection in AI Usage. */
export class WorkspaceAdapter {
  private requests = new Map<string, AbortController>()
  private refreshing = new Map<string, Promise<string>>()
  private states: Record<string, { state: string; detail?: string }> = {}
  private pending = new Map<string, { account: string; verifier: string; redirect: string; client: { client_id: string; client_secret: string }; server: http.Server; timer: NodeJS.Timeout }>()
  constructor(private store: ManagerStore, private vault: Vault, private runner: () => Promise<Runner>, private native: NativeCall, private notify: () => void, private dispatch: (method: string, params: any) => Promise<any>, private supervisor: NativeSupervisor) {}
  status(): WorkspaceStatus {
    const aliases = [...new Set([...Object.keys(this.store.config.workspaceAccounts ?? {}), ...Object.keys(this.states)])]
    return { oauthConfigured: !!this.store.config.workspaceOAuth && this.vault.refs().includes(this.store.config.workspaceOAuth.secretRef), projectId: this.store.config.workspaceOAuth?.projectId,
      accounts: aliases.map(account => {
        const saved = this.store.config.workspaceAccounts?.[account], available = !!saved && this.vault.refs().includes(saved.secretRef)
        return { account, email: saved?.email, ...(this.states[account] ?? { state: available ? 'Saved sign-in' : 'Sign-in required' }), ...(!available && saved ? { state: 'Saved sign-in unavailable', detail: 'Import your shared sign-ins or reconnect this account.' } : {}) }
      }) }
  }
  resetStatus(): void { this.close(); this.states = {} }
  async configureClient(value: any): Promise<void> {
    const client = value?.installed
    if (!client || ![client.client_id, client.client_secret, client.project_id].every(v => typeof v === 'string' && v.length > 0) || client.token_uri !== 'https://oauth2.googleapis.com/token' || !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(client.project_id)) throw new Error('Import the Google Cloud Desktop OAuth client JSON')
    await this.vault.set('workspace-oauth-client', JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret }))
    this.store.config.workspaceOAuth = { secretRef: 'workspace-oauth-client', projectId: client.project_id }; await this.store.save(); this.notify()
  }
  async signIn(account: string): Promise<void> {
    validateWorkspaceAccount(account)
    if ([...this.pending.values()].some(p => p.account === account)) throw new Error('Sign-in is already waiting in your browser')
    const ref = this.store.config.workspaceOAuth?.secretRef
    if (!ref) throw new Error('Import the Google Cloud OAuth client in Workspace project settings first')
    const client = JSON.parse(await this.vault.get(ref)), state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state || !this.pending.has(state)) { res.writeHead(400); res.end('Unknown or expired Google sign-in'); return }
      void this.dispatch('workspace:finish', { state, code: url.searchParams.get('code'), error: url.searchParams.get('error') }).then(() => { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Google account connected. Return to AI Usage.') }, () => { res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Google sign-in failed. Return to AI Usage for details.') })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const redirect = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/callback`
    const timer = setTimeout(() => { this.pending.delete(state); server.close(); this.states[account] = { state: 'Sign-in expired' }; this.notify() }, 10 * 60_000)
    this.pending.set(state, { account, verifier, redirect, client, server, timer })
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent select_account', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(this.store.config.workspaceAccounts?.[account]?.email ? { login_hint: this.store.config.workspaceAccounts[account].email! } : {}) }).toString()
    this.states[account] = { state: 'Waiting for browser sign-in' }; this.notify()
    try { await this.native('open-url', url.toString()) } catch { clearTimeout(timer); this.pending.delete(state); server.close(); this.states[account] = { state: 'Sign-in failed', detail: 'Could not open the browser. Retry Sign in.' }; this.notify(); throw new Error('Could not open Google sign-in') }
  }
  async finish(input: any): Promise<void> {
    const p = this.pending.get(input.state); if (!p) throw new Error('Google sign-in expired')
    this.pending.delete(input.state); clearTimeout(p.timer)
    try {
      if (input.error || !input.code) throw new Error('Google sign-in was declined')
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, client_id: p.client.client_id, client_secret: p.client.client_secret, redirect_uri: p.redirect, code_verifier: p.verifier }), signal: AbortSignal.timeout(20_000) })
      const result = await response.json() as any
      if (!response.ok || typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string') throw new Error(`Google authorization failed (HTTP ${response.status}); offline access was not granted`)
      await this.importAccount(p.account, { type: 'authorized_user', ...p.client, refresh_token: result.refresh_token, token: result.access_token, expiry: new Date(Date.now() + (Number(result.expires_in) || 3600) * 1000).toISOString(), scopes: String(result.scope ?? scopes.join(' ')).split(' ') }, this.store.config.workspaceOAuth?.projectId)
    } catch (error) { this.states[p.account] = { state: 'Sign-in failed', detail: (error as Error).message }; throw error }
    finally { p.server.close(); this.notify() }
  }
  async signOut(account: string): Promise<void> {
    validateWorkspaceAccount(account)
    for (const [state, p] of this.pending) if (p.account === account) { clearTimeout(p.timer); p.server.close(); this.pending.delete(state) }
    await this.vault.delete(this.store.config.workspaceAccounts?.[account]?.secretRef); delete this.store.config.workspaceAccounts?.[account]; delete this.states[account]; await this.store.save(); this.notify()
  }
  closeSession(session: string): void { for (const [id, controller] of this.requests) if (id.startsWith(session + ':')) controller.abort() }
  close(): void { for (const controller of this.requests.values()) controller.abort(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.server.close() }; this.pending.clear() }
  async importAccount(account: string, value: unknown, projectId?: string): Promise<void> {
    validateWorkspaceAccount(account)
    if (projectId !== undefined && !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(projectId)) throw new Error('Use a valid Google Cloud project ID')
    const c = value as Credential
    if (!c || c.type !== 'authorized_user' || ![c.client_id, c.client_secret, c.refresh_token].every(v => typeof v === 'string' && v.length > 0) || (c.token_uri && c.token_uri !== 'https://oauth2.googleapis.com/token')) throw new Error('Select a Google authorized_user credential file')
    const ref = `workspace-${account}`; validateName(ref)
    const credential: Credential = { type: 'authorized_user', client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, token_uri: 'https://oauth2.googleapis.com/token', signedInAt: Date.now(), ...(typeof c.token === 'string' ? { token: c.token } : {}), ...(typeof c.expiry === 'string' ? { expiry: c.expiry } : {}), ...(Array.isArray(c.scopes) ? { scopes: c.scopes } : {}) }
    const before = this.vault.protectedSnapshot(), oldAccounts = structuredClone(this.store.config.workspaceAccounts)
    try {
      await this.vault.set(ref, JSON.stringify(credential))
      this.store.config.workspaceAccounts ??= {}; this.store.config.workspaceAccounts[account] = { secretRef: ref, ...(projectId ? { projectId } : {}) }
      const token = await this.token(account), response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }), identity = await response.json() as any
      if (!response.ok || typeof identity.emailAddress !== 'string') throw new Error(`${account}: could not verify Google account identity (HTTP ${response.status})`)
      const duplicate = Object.entries(this.store.config.workspaceAccounts).find(([name, value]) => name !== account && value.email?.toLowerCase() === identity.emailAddress.toLowerCase())
      if (duplicate) throw new Error(`This Google account is already connected as ${duplicate[0]}. Choose a different Google account.`)
      this.store.config.workspaceAccounts[account].email = identity.emailAddress; await this.store.save(); this.states[account] = { state: 'Signed in' }; this.notify()
    } catch (error) { this.store.config.workspaceAccounts = oldAccounts; await this.vault.restoreProtected(before); throw error }
  }
  private async token(account: string, force = false): Promise<string> {
    validateWorkspaceAccount(account)
    if (!Object.hasOwn(this.store.config.workspaceAccounts ?? {}, account)) throw new Error(`Unknown account ${account}. Import its Google credentials in AI Usage first.`)
    const existing = this.refreshing.get(account); if (existing) return existing
    const operation = this.refresh(account, force); this.refreshing.set(account, operation)
    try { return await operation } finally { if (this.refreshing.get(account) === operation) this.refreshing.delete(account) }
  }
  private async refresh(account: string, force = false): Promise<string> {
    const ref = this.store.config.workspaceAccounts![account].secretRef
    const c: Credential = JSON.parse(await this.vault.get(ref))
    if (!force && c.token && Date.parse(c.expiry ?? '') > Date.now() + 120_000) return c.token
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token }), signal: AbortSignal.timeout(15_000) })
    const result = await response.json() as any
    if (!response.ok || typeof result.access_token !== 'string') {
      const reason = typeof result.error === 'string' ? result.error : undefined
      const why = reason === 'invalid_grant' ? `Google no longer accepts this sign-in (it was revoked or expired). ${TESTING_HINT}` : `Google token refresh failed (HTTP ${response.status}${reason ? `, ${reason}` : ''}).`
      this.states[account] = { state: 'Needs reconnect', detail: why }; this.notify()
      throw new RefreshError(`${account}: ${why} Reconnect this account in AI Usage.`, response.status, reason)
    }
    c.token = result.access_token; c.expiry = new Date(Date.now() + (Number(result.expires_in) || 3600) * 1000).toISOString()
    if (typeof result.refresh_token === 'string') c.refresh_token = result.refresh_token
    await this.vault.set(ref, JSON.stringify(c)); this.states[account] = { state: 'Signed in' }; this.notify(); return c.token!
  }
  /**
   * Verify every saved account: the refresh token is still accepted (a forced refresh), and the
   * granted permissions cover what the gws tools need. Updates the per-account state the app shows.
   */
  async checkAccounts(): Promise<WorkspaceStatus['accounts']> {
    for (const account of Object.keys(this.store.config.workspaceAccounts ?? {})) {
      const saved = this.store.config.workspaceAccounts![account]
      if (!this.vault.refs().includes(saved.secretRef)) continue
      try {
        const token = await this.token(account, true)
        const response = await fetch('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', body: new URLSearchParams({ access_token: token }), signal: AbortSignal.timeout(15_000) })
        const info = await response.json() as any
        if (!response.ok) throw new Error(`Google could not describe the renewed token (HTTP ${response.status})`)
        const granted = new Set(String(info.scope ?? '').split(' ')), missing = scopes.filter(scope => !granted.has(scope))
        const c: Credential = JSON.parse(await this.vault.get(saved.secretRef))
        const age = c.signedInAt ? Math.floor((Date.now() - c.signedInAt) / 86_400_000) : undefined
        const since = age === undefined ? '' : age === 0 ? ' · signed in today' : ` · signed in ${age} day${age === 1 ? '' : 's'} ago`
        this.states[account] = missing.length
          ? { state: 'Missing permissions', detail: `Not granted: ${missing.map(s => scopeLabels[s] ?? s).join(', ')}. Calls that need them fail with HTTP 403. Reconnect and allow every permission${since}.` }
          : { state: 'Signed in', detail: `Checked just now: the sign-in renews and all ${scopes.length} permissions are granted${since}.` }
      } catch (error) {
        if (!(error instanceof RefreshError)) this.states[account] = { state: 'Check failed', detail: (error as Error).message.slice(0, 300) }
      }
    }
    this.notify(); return this.status().accounts
  }
  private tools(): any[] {
    const account = { type: 'string', description: 'Required account name from workspace_accounts (for example personal or work). Never infer or switch a global default.' }
    const route = { service: { type: 'string', enum: services }, resource: { type: 'string', description: 'Resource path such as files, users.messages, or spreadsheets.values' }, method: { type: 'string', description: 'API method such as list, get, create, or update' } }
    return [
      { name: 'workspace_accounts', description: 'List configured Google account aliases. Credentials are never returned.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'workspace_schema', description: 'Inspect a Google API method before calling it. No account action is performed.', inputSchema: { type: 'object', properties: route, required: ['service', 'resource', 'method'], additionalProperties: false } },
      { name: 'workspace_call', description: 'Call a Google Workspace API through official gws. Always choose the intended account explicitly. Inspect workspace_schema for params and body first.', inputSchema: { type: 'object', properties: { account, ...route, params: { type: 'object' }, body: { type: 'object' }, uploadPath: { type: 'string', description: 'Absolute local file path when this method supports multipart upload' }, outputPath: { type: 'string', description: 'Absolute local output path, required for binary downloads' } }, required: ['account', 'service', 'resource', 'method'], additionalProperties: false } }
    ]
  }
  private async execute(name: string, input: any, signal?: AbortSignal): Promise<string> {
    if (name === 'workspace_accounts') return JSON.stringify({ accounts: this.status().accounts.filter(a => Object.hasOwn(this.store.config.workspaceAccounts ?? {}, a.account)) })
    if (!['workspace_schema', 'workspace_call'].includes(name)) throw new Error('Unknown Workspace tool')
    if (!input || !services.includes(input.service) || typeof input.resource !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/.test(input.resource) || typeof input.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(input.method)) throw new Error('Use a supported service and a valid resource/method from workspace_schema')
    const runner = await this.runner()
    const args = name === 'workspace_schema' ? ['schema', `${input.service}.${input.resource}.${input.method}`] : [input.service, ...input.resource.split('.'), input.method]
    if (name === 'workspace_call') {
      if (input.params?.alt === 'media' && !input.outputPath) throw new Error('Binary downloads require an absolute outputPath')
      if (input.uploadPath !== undefined) { if (typeof input.uploadPath !== 'string' || !path.isAbsolute(input.uploadPath) || !(await fs.stat(input.uploadPath)).isFile()) throw new Error('uploadPath must name an existing absolute local file'); args.push('--upload', input.uploadPath) }
      if (input.outputPath !== undefined) { if (typeof input.outputPath !== 'string' || !path.isAbsolute(input.outputPath)) throw new Error('outputPath must be absolute'); args.push('--output', input.outputPath) }
    }
    if (name === 'workspace_call') for (const [key, flag] of [['params', '--params'], ['body', '--json']]) {
      if (input[key] !== undefined) { if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) throw new Error(`${key} must be an object`); const value = JSON.stringify(input[key]); if (value.length > 1_000_000) throw new Error('Workspace request is too large'); args.push(flag, value) }
    }
    const token = name === 'workspace_call' ? await this.token(input.account) : ''
    const env = { ...process.env, ...runner.env, GOOGLE_WORKSPACE_CLI_TOKEN: token, GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: '', GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_WORKSPACE_PROJECT_ID: name === 'workspace_call' ? this.store.config.workspaceAccounts?.[input.account]?.projectId ?? '' : '' }
    try { const result = await this.supervisor.run('google-workspace', { command: runner.command, args: [...runner.args, ...args], env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string')) }, signal); if (name === 'workspace_call' && input.outputPath) return JSON.stringify({ savedTo: input.outputPath, bytes: (await fs.stat(input.outputPath)).size }); return result.stdout }
    catch (error) { const message = describeGwsError(error, name === 'workspace_call' ? input.account : undefined); throw new Error((token ? message.split(token).join('[redacted]') : message).replace(/(?:access_token|refresh_token|client_secret)["\s:=]+[^\s",}]+/gi, '[redacted]').slice(0, 3000)) }
  }
  async rpc(message: any): Promise<any> {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('Invalid Workspace MCP message')
    if (message.method === 'notifications/cancelled') { this.requests.get(`${message.aiuSession ?? 'direct'}:${message.params?.requestId}`)?.abort(); return null }
    if (message.id === undefined) return null
    const reply = (result: any): any => ({ jsonrpc: '2.0', id: message.id, result })
    if (message.method === 'initialize') return reply({ protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'AI Usage Workspace (gws adapter)', version: APP_VERSION }, instructions: 'Every Workspace action requires an explicit account from workspace_accounts. Use workspace_schema, then workspace_call.' })
    if (message.method === 'ping') return reply({})
    if (message.method === 'tools/list') return reply({ tools: this.tools() })
    if (message.method === 'tools/call') {
      const id = `${message.aiuSession ?? 'direct'}:${message.id}`, controller = new AbortController(); this.requests.set(id, controller)
      try { return reply({ content: [{ type: 'text', text: await this.execute(message.params?.name, message.params?.arguments ?? {}, controller.signal) }] }) }
      catch (error) { return reply({ isError: true, content: [{ type: 'text', text: (error as Error).message }] }) }
      finally { this.requests.delete(id) }
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported Workspace MCP method' } }
  }
}
