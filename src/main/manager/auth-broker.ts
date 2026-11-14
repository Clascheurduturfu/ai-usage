import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { FrameReader } from './frame-reader'
import fs from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LocalRuntime, type LocalSession } from './local-runtime'
import { McpMetricsStore, compactNames, compactToolList, parseRelayName, searchTools } from './mcp-metrics'
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { isPublicMcp } from '../../shared/mcp-auth'
import { APP_VERSION } from '../../shared/version'
import { z } from 'zod'
import { ManagerStore, Vault, type NativeCall } from './storage'
import type { McpDeviceStatus } from '../../shared/manager'

// Prompts and completions are request/response only, so one upstream session can
// serve several clients. Anything else (resources subscriptions, logging levels)
// gets its own connection.
const POOLABLE_CAPABILITIES = new Set(['tools', 'prompts', 'completions'])
const TRANSIENT_REFRESH = /HTTP 5\d\d|network/, TRANSIENT_GRACE_MS = 15 * 60_000
// An upstream session that expired (404) or dropped is reopened once per request.
const sessionLost = (error: unknown): boolean => (error instanceof StreamableHTTPError && error.code === 404) || /Connection closed|Not connected/i.test((error as Error)?.message ?? '')
export function ipcPath(pool: string): string {
  const id = createHash('sha256').update(path.resolve(pool).toLowerCase()).digest('hex').slice(0, 20)
  return process.platform === 'win32' ? `\\\\.\\pipe\\ai-usage-${id}` : path.join(pool, `manager-${id}.sock`)
}
export class McpAuthBroker {
  readonly token = randomUUID()
  readonly status: Record<string, string> = {}
  readonly probes: Record<string, McpDeviceStatus> = {}
  private statusRevisions = new Map<string, string | undefined>()
  private server?: net.Server
  private callback?: http.Server
  private callbacks = new Map<string, { provider: OAuthClientProvider; url: URL; name: string; timer: NodeJS.Timeout }>()
  private clients = new Set<Client>()
  private sockets = new Set<net.Socket>()
  private sessions = new Map<net.Socket, { name: string; tools?: number; kind?: 'local' | 'workspace' | 'remote' }>()
  private closingTransports = new Set<Promise<void>>()
  private publicClients = new Map<string, { client: Client; transport: StreamableHTTPClientTransport; sockets: Set<net.Socket>; active: number; lastUsed: number }>()
  private publicStarting = new Map<string, Promise<void>>()
  private isolatedPublic = new Set<string>()
  private publicTimer = setInterval(() => { for (const [name, entry] of this.publicClients) if (!entry.active && Date.now() - entry.lastUsed > 10 * 60_000) { this.publicClients.delete(name); this.clients.delete(entry.client); void entry.client.close() } }, 30_000).unref()
  private locks = new Map<string, Promise<unknown>>()
  private refreshFailures = new Map<string, { text: string; since: number }>()
  private recordRefreshFailure(name: string, text: string): void { const previous = this.refreshFailures.get(name); this.refreshFailures.set(name, { text, since: previous?.text === text ? previous.since : Date.now() }) }
  constructor(private store: ManagerStore, private vault: Vault, private native: NativeCall, private notify: () => void, private resolveLocal: (name: string, spec: any) => Promise<any>, readonly localRuntime: LocalRuntime, readonly metrics?: McpMetricsStore) {}
  running(): Record<string, McpDeviceStatus> {
    const counts = new Map<string, { clients: number; tools?: number }>()
    for (const session of this.sessions.values()) { const entry = counts.get(session.name) ?? { clients: 0 }; entry.clients++; entry.tools = session.tools ?? entry.tools; counts.set(session.name, entry) }
    // Running means a process is alive now; Connected means clients are attached and a
    // process starts on the next call (remote servers and per-call gws never keep one).
    return Object.fromEntries([...counts].map(([name, entry]) => {
      const workers = this.localRuntime.supervisor.status.workers.filter(w => w.name === name).length
      const clients = `${entry.clients} client${entry.clients === 1 ? '' : 's'}`
      return [name, { state: workers ? 'Running' : 'Connected', detail: workers ? `${clients} · ${workers} process${workers === 1 ? '' : 'es'} running` : `${clients} connected`, tools: entry.tools, clients: entry.clients, workers, canPrepare: false }]
    }))
  }
  setStatus(name: string, value: string): void {
    this.status[name] = value
    this.statusRevisions.set(name, this.vault.revision(this.store.config.mcpAuth?.[name]?.secretRef))
  }
  resetStatus(): void { for (const name of Object.keys(this.status)) delete this.status[name]; for (const name of Object.keys(this.probes)) delete this.probes[name]; this.statusRevisions.clear() }
  async check(name: string): Promise<McpDeviceStatus> {
    const spec = (await this.store.mcpRaw())[name]
    if (!spec?.url || spec.command) throw new Error('This connection check requires a remote HTTP MCP')
    return this.serialize(name, async () => {
      const client = new Client({ name: 'AI Usage connection check', version: APP_VERSION }, { capabilities: {} })
      const appAuth = this.store.config.mcpAuth?.[name]?.enabled, headerAuth = Object.keys(spec.headers ?? {}).some(k => k.toLowerCase() === 'authorization')
      const transport = new StreamableHTTPClientTransport(new URL(spec.url), { ...(appAuth && !isPublicMcp(spec.url) && !headerAuth ? { authProvider: this.provider(name) } : {}), requestInit: { headers: spec.headers ?? {} }, fetch: this.remoteFetch(name) })
      try {
        await client.connect(transport)
        const capabilities = client.getServerCapabilities(), listed = capabilities?.tools ? (await client.listTools()).tools : [], count = listed.length
        if (capabilities?.tools) this.metrics?.recordTools(name, listed)
        this.probes[name] = { state: 'Connection verified', detail: `${count} tools listed. The temporary check has finished; coding clients launch their own sessions.`, tools: count, checkedAt: Date.now(), canPrepare: false }
        if (appAuth && !isPublicMcp(spec.url) && !headerAuth) this.setStatus(name, 'Signed in')
      } catch (error) {
        this.probes[name] = { state: 'Connection failed', detail: this.vault.redact((error as Error).message).slice(0, 600), checkedAt: Date.now(), canPrepare: false }
      } finally { await client.close().catch(() => undefined); this.notify() }
      return this.probes[name]
    })
  }
  async currentStatus(name: string): Promise<string> {
    const saved = await this.savedStatus(name), ref = this.store.config.mcpAuth?.[name]?.secretRef
    if (this.statusRevisions.get(name) !== this.vault.revision(ref)) { delete this.status[name]; this.statusRevisions.delete(name) }
    if (saved === 'Public server · no sign-in needed' || saved === 'Uses configured authorization header' || saved === 'Saved sign-in unavailable; sign in again') return saved
    if (saved === 'Sign-in required' && ['Signed in', 'Saved sign-in'].includes(this.status[name])) return saved
    return this.status[name] ?? saved
  }
  private failure(name: string, error: unknown): string {
    const detail = this.vault.redact(error instanceof Error ? error.message : String(error)).slice(0, 600)
    this.setStatus(name, `Sign-in failed: ${detail}`); this.notify(); return detail
  }
  async savedStatus(name: string): Promise<string> {
    const spec = (await this.store.mcpRaw())[name]
    if (isPublicMcp(spec?.url)) return 'Public server · no sign-in needed'
    if (Object.keys(spec?.headers ?? {}).some(k => k.toLowerCase() === 'authorization')) return 'Uses configured authorization header'
    const ref = this.store.config.mcpAuth?.[name]?.secretRef
    if (!ref || !this.vault.refs().includes(ref)) return 'Sign-in required'
    try { const saved = JSON.parse(await this.vault.get(ref)); return saved.tokens?.access_token || saved.tokens?.refresh_token ? 'Saved sign-in' : 'Sign-in required' } catch { return 'Saved sign-in unavailable; sign in again' }
  }
  private serialize<T>(name: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(name) ?? Promise.resolve()).catch(() => undefined).then(task)
    this.locks.set(name, run); return run
  }
  private remoteFetch(name: string): typeof fetch {
    return async (input, init) => {
      const body = init?.body, refreshing = body instanceof URLSearchParams && body.get('grant_type') === 'refresh_token'
      let response: Response
      try { response = await fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) }) }
      catch (error) { if (refreshing) this.recordRefreshFailure(name, 'Token refresh failed: network error'); throw error }
      if (refreshing) {
        if (response.ok) this.refreshFailures.delete(name)
        else {
          const result = await response.clone().json().catch(() => ({})) as { error?: unknown }
          const code = typeof result.error === 'string' && /^[a-z_]{1,60}$/.test(result.error) ? ` (${result.error})` : ''
          this.recordRefreshFailure(name, `Token refresh failed: HTTP ${response.status}${code}`)
        }
      }
      return response
    }
  }
  private provider(name: string, interactive = false, state = randomUUID()): OAuthClientProvider {
    const ref = this.store.config.mcpAuth?.[name]?.secretRef
    if (!ref) throw new Error('Enable Authenticate in app for this MCP first')
    const readSaved = async (): Promise<any> => this.vault.refs().includes(ref) ? JSON.parse(await this.vault.get(ref) || '{}') : {}
    // A copied OAuth client can share one rotating grant across devices. An
    // explicit reconnect registers a separate client; keep the saved grant
    // intact until the replacement authorization succeeds.
    let pending: any = interactive ? { client: undefined, tokens: undefined, verifier: undefined } : {}
    const read = async (): Promise<any> => ({ ...await readSaved(), ...pending })
    const update = async (patch: any): Promise<void> => { pending = { ...pending, ...patch } }
    const commitTokens = (tokens: any): Promise<void> => this.serialize('vault-' + name, async () => {
      await this.vault.set(ref, JSON.stringify({ ...await readSaved(), ...pending, tokens, tokensUpdatedAt: Date.now() }))
      pending = {}
    })
    return {
      redirectUrl: 'http://127.0.0.1:43819/callback',
      clientMetadata: { client_name: 'AI Usage', redirect_uris: ['http://127.0.0.1:43819/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      state: () => state,
      clientInformation: async () => (await read()).client,
      saveClientInformation: client => update({ client }),
      tokens: async () => (await read()).tokens,
      // SDK retries may invalidate a rejected grant and register a new client.
      // Commit that registration/token pair only after authorization succeeds;
      // a failed check or cancelled browser flow must not erase the saved sign-in.
      saveTokens: async tokens => { await commitTokens(tokens); await this.store.save(); this.refreshFailures.delete(name); this.setStatus(name, 'Signed in'); this.notify() },
      saveCodeVerifier: verifier => update({ verifier }),
      codeVerifier: async () => { const v = (await read()).verifier; if (!v) throw new Error('Login expired; sign in again'); return v },
      discoveryState: async () => (await read()).discovery,
      saveDiscoveryState: discovery => update({ discovery }),
      invalidateCredentials: async scope => { const patch: any = {}; for (const key of scope === 'all' ? ['client', 'tokens', 'verifier', 'discovery'] : [scope === 'client' ? 'client' : scope]) patch[key] = undefined; await update(patch) },
      redirectToAuthorization: async url => {
        if (!interactive) {
          const recorded = this.refreshFailures.get(name), failure = recorded?.text
          // A provider outage is not a revoked grant: keep the sign-in and say so. Some
          // providers answer a dead upstream grant with 5xx too, so escalate if it persists.
          if (recorded && failure && TRANSIENT_REFRESH.test(failure) && Date.now() - recorded.since < TRANSIENT_GRACE_MS) { this.setStatus(name, `${failure} · Sign-in kept, retry shortly`); this.notify(); throw new Error(`${failure}. The provider's token service is temporarily unavailable; your ${name} sign-in is kept. Retry in a moment.`) }
          this.setStatus(name, failure ? `${failure} · Reconnect required` : await this.savedStatus(name) === 'Sign-in required' ? 'Sign-in required' : 'Reconnect required'); this.notify()
          throw new Error(failure ? `${failure}. Reconnect ${name} in AI Usage → Shared library → MCP.` : `Sign in to ${name} in AI Usage → Shared library → MCP`)
        }
        this.setStatus(name, 'Waiting for browser sign-in'); this.notify(); await this.native('open-url', url.toString())
      }
    }
  }
  async signIn(name: string): Promise<void> {
    const server = (await this.store.mcpRaw())[name]
    if (!server?.url || server.command) throw new Error('In-app OAuth applies to remote HTTP MCP servers')
    if (isPublicMcp(server.url)) { this.setStatus(name, 'Public server · no sign-in needed'); this.notify(); return }
    if (Object.keys(server.headers ?? {}).some(k => k.toLowerCase() === 'authorization')) { this.setStatus(name, 'Uses configured authorization header'); this.notify(); return }
    if ([...this.callbacks.values()].some(v => v.name === name)) throw new Error('A sign-in is already pending for this MCP')
    if (!this.callback) {
      const callback = http.createServer((req, res) => { void this.finish(req, res) })
      await new Promise<void>((resolve, reject) => { callback.once('error', reject); callback.listen(43819, '127.0.0.1', resolve) })
      this.callback = callback
    }
    const state = randomUUID(), provider = this.provider(name, true, state), url = new URL(server.url)
    const timer = setTimeout(() => { this.callbacks.delete(state); this.setStatus(name, 'Sign-in expired'); this.notify(); this.closeCallback() }, 10 * 60_000)
    this.callbacks.set(state, { provider, url, name, timer })
    try {
      // The transport sends initialize first and follows the server's 401 challenge,
      // including resource_metadata and scope, instead of guessing an OAuth issuer.
      const client = new Client({ name: 'AI Usage', version: APP_VERSION }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit: { headers: server.headers ?? {} }, fetch: this.remoteFetch(name) })
      try { await this.serialize(name, () => client.connect(transport)); this.setStatus(name, (await provider.tokens())?.access_token ? 'Signed in' : 'No sign-in required') }
      catch (e) { if (!(e instanceof UnauthorizedError && this.status[name] === 'Waiting for browser sign-in')) throw e; return }
      finally { await client.close().catch(() => undefined) }
      clearTimeout(timer); this.callbacks.delete(state); this.notify(); this.closeCallback()
    } catch (e) { clearTimeout(timer); this.callbacks.delete(state); this.failure(name, e); this.closeCallback(); throw e }
  }
  private closeCallback(): void { if (!this.callbacks.size) { this.callback?.close(); this.callback = undefined } }
  private async finish(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:43819'), state = url.searchParams.get('state') ?? '', pending = this.callbacks.get(state)
    if (url.pathname !== '/callback' || !pending) { res.writeHead(400); res.end('Unknown or expired sign-in'); return }
    this.callbacks.delete(state); clearTimeout(pending.timer)
    try {
      const code = url.searchParams.get('code'); if (!code || url.searchParams.has('error')) throw new Error('Provider declined sign-in')
      const result = await this.serialize(pending.name, () => auth(pending.provider, { serverUrl: pending.url, authorizationCode: code }))
      if (result !== 'AUTHORIZED') throw new Error('Authorization was not completed')
      this.setStatus(pending.name, 'Signed in'); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Signed in. You can close this tab and return to AI Usage.')
    } catch (e) { this.failure(pending.name, e); res.writeHead(400); res.end('Sign-in failed. Return to AI Usage for the error details.') }
    finally { this.notify(); this.closeCallback() }
  }
  private async publicClient(name: string, url: string, socket: net.Socket): Promise<{ client: Client; transport: StreamableHTTPClientTransport } | undefined> {
    if (this.isolatedPublic.has(name)) return undefined
    if (!this.publicClients.has(name)) {
      let opening = this.publicStarting.get(name)
      if (!opening) {
        opening = (async () => {
          const client = new Client({ name: 'AI Usage', version: APP_VERSION }, { capabilities: {} }), transport = new StreamableHTTPClientTransport(new URL(url))
          try {
            await client.connect(transport)
            if (Object.keys(client.getServerCapabilities() ?? {}).some(key => !POOLABLE_CAPABILITIES.has(key))) { this.isolatedPublic.add(name); await client.close().catch(() => undefined); return }
            const entry = { client, transport, sockets: new Set<net.Socket>(), active: 0, lastUsed: Date.now() }
            this.publicClients.set(name, entry); this.clients.add(client)
            client.onclose = () => { if (this.publicClients.get(name) !== entry) return; this.publicClients.delete(name); for (const s of entry.sockets) s.destroy() }
          } catch (error) { await client.close().catch(() => undefined); throw error }
        })()
        this.publicStarting.set(name, opening)
      }
      try { await opening } finally { this.publicStarting.delete(name) }
    }
    const entry = this.publicClients.get(name)
    if (!entry) return undefined
    entry.sockets.add(socket); entry.lastUsed = Date.now()
    return entry
  }
  async start(dispatch: (method: string, params: any) => Promise<any>): Promise<void> {
    const address = ipcPath(this.store.pool)
    if (process.platform !== 'win32' && await fs.lstat(address).then(() => true, () => false)) {
      const active = await new Promise<boolean>(resolve => { const s = net.createConnection(address); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', e => resolve((e as NodeJS.ErrnoException).code !== 'ECONNREFUSED')) })
      if (active) throw new Error('Another AI Usage manager owns the local socket')
      await fs.unlink(address)
    }
    this.server = net.createServer(socket => {
      if (this.sockets.size >= 128) { socket.destroy(); return }
      socket.on('error', () => undefined)
      this.sockets.add(socket)
      let client: Client | undefined, transport: StreamableHTTPClientTransport | undefined, local: LocalSession | undefined, serverName: string | undefined, shared = false
      const sessionId = randomUUID()
      const controllers = new Map<string, AbortController>(), queuedIds = new Set<string>(), cancelledIds = new Set<string>()
      let queued = 0
      let connectionQueue: Promise<unknown> = Promise.resolve()
      const lines = new FrameReader(socket)
      const write = (value: any): void => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n') }
      // Every response to the client passes here: internal compact-mode requests are
      // answered privately, tool lists are measured, and tool calls are counted.
      let compact = false, toolCache: any[] | undefined
      const internal = new Map<string, { resolve(value: any): void }>(), listIds = new Set<string>(), callIds = new Map<string, string>()
      const reply = (value: any): void => {
        const key = value && value.id !== undefined && value.id !== null && !value.method ? String(value.id) : undefined
        if (key && internal.has(key)) { const pending = internal.get(key)!; internal.delete(key); pending.resolve(value); return }
        if (value?.method === 'notifications/tools/list_changed') toolCache = undefined
        if (key && listIds.delete(key) && Array.isArray(value.result?.tools) && !value.result.nextCursor && serverName) this.metrics?.recordTools(serverName, value.result.tools)
        if (key && callIds.has(key)) { const tool = callIds.get(key)!; callIds.delete(key); if (serverName) this.metrics?.recordCall(serverName, tool, !value.error && !value.result?.isError) }
        write(value)
      }
      let remoteLost = false
      // Opens (or reopens) this client's upstream session. A failed or dropped upstream
      // never closes the client's socket: the next request reconnects, and errors are
      // returned as JSON-RPC errors instead of a bare "Connection closed".
      const openRemote = async (spec: any): Promise<void> => {
        if (!spec?.url || spec.command || !this.store.config.mcpAuth?.[serverName!]?.enabled) throw new Error('MCP configuration changed; restart this client')
        if (shared) { const entry = this.publicClients.get(serverName!); entry?.sockets.delete(socket); shared = false }
        else if (client) { this.clients.delete(client); const old = client; client = undefined; await old.close().catch(() => undefined) }
        if (isPublicMcp(spec.url) && !Object.keys(spec.headers ?? {}).length) {
          const connection = await this.publicClient(serverName!, spec.url, socket)
          if (connection) { client = connection.client; transport = connection.transport; shared = true; remoteLost = false; return }
        }
        const next = new Client({ name: 'AI Usage', version: APP_VERSION }, { capabilities: {} })
        const headerAuth = Object.keys(spec.headers ?? {}).some(k => k.toLowerCase() === 'authorization')
        const nextTransport = new StreamableHTTPClientTransport(new URL(spec.url), { ...(!isPublicMcp(spec.url) && !headerAuth ? { authProvider: this.provider(serverName!) } : {}), requestInit: { headers: spec.headers ?? {} }, fetch: this.remoteFetch(serverName!) })
        try { await next.connect(nextTransport) } catch (error) { await next.close().catch(() => undefined); remoteLost = true; throw error }
        next.onclose = () => { this.clients.delete(next); if (client === next) remoteLost = true }
        next.fallbackNotificationHandler = async notification => { reply(notification) }
        this.clients.add(next); client = next; transport = nextTransport; remoteLost = false
      }
      const internalRequest = async (request: { method: string; params?: any }): Promise<any> => {
        if (local) {
          const id = 'aiu-internal-' + randomUUID()
          const response = new Promise<any>(resolve => internal.set(id, { resolve }))
          try { await local.send({ jsonrpc: '2.0', id, ...request }) } catch (error) { internal.delete(id); throw error }
          const value = await response
          if (value.error) throw new Error(value.error.message)
          return value.result
        }
        if (remoteLost || (shared && !this.publicClients.has(serverName!))) await openRemote((await this.store.mcpRaw())[serverName!])
        if (!client) throw new Error('Initialize the MCP first')
        return client.request({ method: request.method, params: request.params }, z.unknown(), { timeout: 180_000 })
      }
      const fullTools = async (): Promise<any[]> => {
        if (toolCache) return toolCache
        const all: any[] = []; let cursor: string | undefined
        for (let page = 0; page < 50; page++) {
          const result = await internalRequest({ method: 'tools/list', params: cursor ? { cursor } : {} })
          all.push(...(Array.isArray(result?.tools) ? result.tools : [])); cursor = result?.nextCursor
          if (!cursor) break
        }
        this.metrics?.recordTools(serverName!, all)
        return toolCache = all
      }
      lines.on('line', line => {
        if (line.length > 16 * 1024 * 1024) { socket.destroy(); return }
        let frame: any; try { frame = JSON.parse(line) } catch { socket.destroy(); return }
        if (frame.token !== this.token) { socket.destroy(); return }
        if (typeof frame.server === 'string') { const relay = parseRelayName(frame.server); frame.server = relay.name; if (relay.compact) compact = true }
        const run = async (): Promise<void> => {
          try {
            if (cancelledIds.delete(String(frame.message?.id))) throw new Error('MCP request cancelled')
            if ((frame.workspace || frame.server) && this.localRuntime.supervisor.paused(frame.workspace ? 'google-workspace' : frame.server)) throw new Error('MCP paused on this device; Resume in AI Usage')
            if (frame.workspace) {
              const result = await dispatch('workspace:rpc', { ...frame.message, aiuSession: sessionId })
              if (frame.message?.method === 'initialize' && result?.result) { this.sessions.set(socket, { name: 'google-workspace', tools: 3, kind: 'workspace' }); this.notify() }
              if (result) reply(result); return
            }
            if (!frame.server) { const result = await dispatch(frame.method, frame.params); reply({ id: frame.id, result }); return }
            let msg = frame.message
            if (!msg || msg.jsonrpc !== '2.0') throw new Error('Invalid MCP message')
            if (!serverName) serverName = frame.server
            if (serverName !== frame.server) throw new Error('Cannot change the MCP during a session')
            if (compact && (local || client || remoteLost) && msg.id !== undefined) {
              const names = compactNames(serverName!)
              if (msg.method === 'tools/list') { reply({ jsonrpc: '2.0', id: msg.id, result: compactToolList(serverName!, await fullTools()) }); return }
              if (msg.method === 'tools/call' && msg.params?.name === names.search) {
                const found = searchTools(await fullTools(), String(msg.params?.arguments?.query ?? ''), Number(msg.params?.arguments?.limit ?? 6))
                const text = found.length ? JSON.stringify(found.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))) : `No ${serverName} tool matches. Try other keywords or an exact name from the list in ${names.search}.`
                reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }); return
              }
              if (msg.method === 'tools/call' && msg.params?.name === names.call) {
                const args = msg.params?.arguments ?? {}
                if (typeof args.name !== 'string' || !args.name) throw new Error(`Pass the exact tool name found with ${names.search}`)
                msg = { ...msg, params: { ...msg.params, name: args.name, arguments: args.arguments && typeof args.arguments === 'object' ? args.arguments : {} } }
              }
            }
            if (msg.method === 'tools/list' && msg.id !== undefined && !msg.params?.cursor) listIds.add(String(msg.id))
            if (msg.method === 'tools/call' && msg.id !== undefined) callIds.set(String(msg.id), String(msg.params?.name ?? ''))
            // Local MCPs keep their complete protocol, including server requests and
            // notifications. One process per client preserves browser/session isolation.
            if (local) { await local.send(msg); return }
            if (typeof msg.method !== 'string') throw new Error('Invalid MCP request')
            if (msg.method === 'notifications/cancelled') { const id = String(msg.params?.requestId); controllers.get(id)?.abort(); if (queuedIds.has(id)) cancelledIds.add(id); return }
            if (msg.method === 'initialize') {
              const spec = (await this.store.mcpRaw())[serverName!]
              if (spec?.command) {
                if (client) throw new Error('This MCP is already initialized')
                const resolved = await this.resolveLocal(serverName!, spec)
                if (!resolved?.command || resolved.args?.includes('--workspace')) throw new Error('Prepare this local server first')
                local = this.localRuntime.session(serverName!, resolved, reply, frame.clientPid)
                await local.send(msg); if (!socket.destroyed) this.sessions.set(socket, { name: serverName!, kind: 'local' }); this.notify(); return
              }
              if (!this.store.config.mcpAuth?.[serverName!]?.enabled) throw new Error(`${serverName} is not set to connect through AI Usage on this device. Enable it in AI Usage → Shared library → MCP, then restart this client.`)
              if (!spec?.url || spec.command) throw new Error('This relay requires a remote HTTP MCP')
              if (client) throw new Error('This MCP is already initialized')
              await openRemote(spec)
              // openRemote assigns these; control-flow narrowing cannot see closure writes.
              const opened = client as Client | undefined, openedTransport = transport as StreamableHTTPClientTransport | undefined
              if (!opened || !openedTransport) throw new Error('Remote MCP did not open')
              if (socket.destroyed) { if (!shared) await opened.close(); return }
              this.sessions.set(socket, { name: serverName!, kind: 'remote' }); this.notify()
              const remote = opened.getServerCapabilities() ?? {}, capabilities = Object.fromEntries(Object.entries(remote).filter(([key]) => ['tools', 'resources', 'prompts', 'logging', 'completions'].includes(key)))
              reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: openedTransport.protocolVersion ?? msg.params.protocolVersion, capabilities, serverInfo: opened.getServerVersion() ?? { name: serverName, version: '1' } } }); return
            }
            if (!client && !remoteLost) throw new Error('Initialize the MCP first')
            if (msg.method === 'notifications/initialized') return
            if (msg.id === undefined) { if (!shared && client && !remoteLost) await client.notification({ method: msg.method, params: msg.params }).catch(() => undefined); return }
            const controller = new AbortController(); controllers.set(String(msg.id), controller)
            const send = async (): Promise<unknown> => {
              if (remoteLost || (shared && !this.publicClients.has(serverName!))) await openRemote((await this.store.mcpRaw())[serverName!])
              const pooled = shared ? this.publicClients.get(serverName!) : undefined
              if (pooled) { pooled.active++; pooled.lastUsed = Date.now() }
              try { return await client!.request({ method: msg.method, params: msg.params }, z.unknown(), { timeout: 180_000, signal: controller.signal }) }
              finally { if (pooled) { pooled.active--; pooled.lastUsed = Date.now() } }
            }
            try {
              let result: unknown
              try { result = await send() }
              catch (error) { if (controller.signal.aborted || !sessionLost(error)) throw error; remoteLost = true; result = await send() }
              reply({ jsonrpc: '2.0', id: msg.id, result })
            }
            finally { controllers.delete(String(msg.id)) }
          } catch (e) {
            const error = e as any
            if (frame.server || frame.workspace) { if (frame.message?.id !== undefined) reply({ jsonrpc: '2.0', id: frame.message.id, error: { code: typeof error.code === 'number' ? error.code : -32000, message: this.vault.redact(error.message) } }) }
            else reply({ id: frame.id, error: this.vault.redact(error.message) })
          }
        }
        // Sessions own their execution queues; unrelated clients never share a tool lock.
        if (!frame.message?.method || frame.message?.method.startsWith('notifications/')) void run()
        else if (local || (!frame.server && !frame.workspace)) void run()
        else {
          const bytes = Buffer.byteLength(line)
          if (queued >= 16 || this.localRuntime.queued >= 64 || this.localRuntime.queuedBytes + bytes > 16 * 1024 * 1024) { if (frame.message?.id !== undefined) reply({ jsonrpc: '2.0', id: frame.message.id, error: { code: -32000, message: 'MCP queue is full; wait or Stop this MCP' } }); return }
          queuedIds.add(String(frame.message?.id))
          queued++; this.localRuntime.queued++; this.localRuntime.queuedBytes += bytes
          const next = connectionQueue.catch(() => undefined).then(async () => { queuedIds.delete(String(frame.message?.id)); queued--; this.localRuntime.queued--; this.localRuntime.queuedBytes -= bytes; if (!socket.destroyed) await run() })
          connectionQueue = next
        }
      })
      socket.once('close', () => {
        void dispatch('workspace:disconnect', sessionId).catch(() => undefined)
        for (const controller of controllers.values()) controller.abort()
        lines.close(); this.sockets.delete(socket); this.sessions.delete(socket); this.notify()
        if (local) {
          const closing = local.close(); this.closingTransports.add(closing)
          void closing.finally(() => this.closingTransports.delete(closing))
        }
        if (client) { if (shared) { const entry = this.publicClients.get(serverName!); entry?.sockets.delete(socket); if (entry) entry.lastUsed = Date.now() } else { this.clients.delete(client); void client.close() } }
      })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(ipcPath(this.store.pool), resolve) })
    if (process.platform !== 'win32') await fs.chmod(address, 0o600)
  }
  stopSessions(name: string): void { for (const [server, entry] of this.publicClients) if (name === '*' || server === name) { this.publicClients.delete(server); void entry.client.close() }; for (const [socket, session] of this.sessions) if ((name === '*' || session.name === name) && session.kind === 'remote') socket.destroy() }
  async close(): Promise<void> {
    clearInterval(this.publicTimer)
    for (const pending of this.callbacks.values()) clearTimeout(pending.timer)
    this.callbacks.clear(); this.closeCallback()
    for (const socket of this.sockets) socket.destroy()
    await Promise.allSettled([...this.clients].map(client => client.close()).concat([...this.localRuntime.sessions].map(session => session.close())))
    await Promise.allSettled([...this.closingTransports])
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()))
  }
}
