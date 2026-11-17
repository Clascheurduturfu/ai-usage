import { APP_VERSION } from '../../shared/version'
import fs from 'node:fs'
import path from 'node:path'
import { ManagerStore, Vault, atomicWrite, normalizeSkillFolders, readText, validateName, validateUrl, type NativeCall } from './storage'
import { SyncEngine } from './sync'
import { Sharing } from './sharing'
import { AgentLauncher } from './launch'
import { LibraryInstaller } from './install'
import { McpAuthBroker, ipcPath } from './auth-broker'
import { McpPreparation } from './mcp-preparation'
import { NativeSupervisor } from './native-supervisor'
import { LocalRuntime } from './local-runtime'
import { McpMetricsStore } from './mcp-metrics'
import { WorkspaceAdapter } from './workspace'
import { EndpointEngine, redact } from '../../../proxies/endpoints'
import { ProxySupervisor } from '../../../proxies/server'
import type { EndpointRecord, ProxyRecord, AgentProfile, AgentId, ManagerSnapshot, SyncResult } from '../../shared/manager'
import { extractAntigravityAccessToken, extractAntigravityRefreshToken, findAntigravityClientSecret, stateDbPath } from '../antigravity-quota'

export class ManagerService {
  readonly store: ManagerStore
  readonly vault: Vault
  readonly engine: EndpointEngine
  readonly proxies: ProxySupervisor
  readonly sync: SyncEngine
  readonly sharing: Sharing
  readonly launch: AgentLauncher
  readonly installer: LibraryInstaller
  readonly auth: McpAuthBroker
  readonly preparation: McpPreparation
  readonly workspace: WorkspaceAdapter
  readonly supervisor: NativeSupervisor
  readonly localRuntime: LocalRuntime
  readonly metrics: McpMetricsStore
  private runtimeTimer?: NodeJS.Timeout
  private logs: string[] = []
  private lastSync?: SyncResult
  private watcher?: fs.FSWatcher
  private timer?: NodeJS.Timeout
  private shareTimer?: NodeJS.Timeout
  private queue: Promise<unknown> = Promise.resolve()
  private suppressWatchUntil = 0
  private conflictNotice = ''
  constructor(pool: string, data: string, private home: string, private native: NativeCall, private notify: () => void) {
    this.store = new ManagerStore(pool, data); this.vault = new Vault(path.join(data, 'vault.json'), native)
    this.engine = new EndpointEngine(this.vault, home)
    this.proxies = new ProxySupervisor(this.vault, this.engine, () => this.store.config.endpoints, notify, message => this.log(message))
    this.sync = new SyncEngine(this.store, home); this.sharing = new Sharing(this.store, this.vault, home)
    this.launch = new AgentLauncher(this.store, this.vault, this.proxies, native, home)
    this.installer = new LibraryInstaller(this.store)
    this.supervisor = new NativeSupervisor(data, native, notify, pool)
    this.localRuntime = new LocalRuntime(this.supervisor, notify)
    this.metrics = new McpMetricsStore(data)
    this.auth = new McpAuthBroker(this.store, this.vault, native, notify, (name, spec) => this.preparation.resolve(name, spec), this.localRuntime, this.metrics)
    this.preparation = new McpPreparation(this.store, home, this.supervisor)
    this.preparation.onTools = (name, tools) => this.metrics.recordTools(name, tools)
    this.workspace = new WorkspaceAdapter(this.store, this.vault, () => this.preparation.workspaceRunner(), native, notify, (method, params) => this.dispatch(method, params), this.supervisor)
  }
  log(message: string): void { this.logs.push(`${new Date().toISOString()} ${this.vault.redact(redact(message))}`); this.logs = this.logs.slice(-100) }
  async start(): Promise<void> {
    await this.store.load(); await this.vault.load(); await this.sharing.load(); await this.metrics.load()
    await this.auth.start((method, params) => this.dispatch(method, params))
    await this.supervisor.start()
    this.runtimeTimer = setInterval(() => { void this.supervisor.refresh().then(() => { for (const name of this.supervisor.status.paused) this.auth.stopSessions(name) }).catch(e => this.log(e.message)) }, 5000)
    this.runtimeTimer.unref()
    // Only the manager that owns the socket may publish its relay token.
    if (!process.env.AIU_PROFILE && !process.env.AIU_HOME) await atomicWrite(path.join(this.store.pool, 'manager-runtime.json'), JSON.stringify({ relay: this.supervisor.executable(), node: process.execPath, sync: path.join(path.dirname(process.argv[1]), 'sync.mjs'), cli: path.join(path.dirname(process.argv[1]), 'manager.mjs'), pipe: ipcPath(this.store.pool), token: this.auth.token, app: process.env.AIU_HOST_EXE, version: APP_VERSION }, null, 2))
    this.lastSync = JSON.parse(await readText(path.join(this.store.data, 'last-sync.json')) ?? 'null') ?? undefined
    this.conflictNotice = this.lastSync?.conflicts.slice().sort().join('|') ?? ''
    for (const proxy of this.store.config.proxies.filter(p => p.autostart)) await this.proxies.start(proxy).catch(e => this.log(e.message))
    this.watcher = fs.watch(this.store.pool, { recursive: true }, (_event, file) => {
      const name = String(file ?? '')
      if (Date.now() < this.suppressWatchUntil) return
      if (!(name === 'mcp.json' || name === 'AGENTS.md' || name.startsWith('skills' + path.sep))) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => { void this.dispatch('library:changed', null).catch(e => { this.log(e.message); void this.native('notify', 'Agent sync failed. Open AI Usage for details.').catch(() => undefined) }); this.notify() }, 1500)
    })
    this.shareTimer = setInterval(() => {
      if (this.sharing.status().enabled && this.sharing.status().unlocked) void this.dispatch('sharing:auto', {}).catch(e => { if (!e.message.includes('No shared bundle')) this.log(e.message) })
    }, 60_000)
    if (this.store.config.autoSync) {
      try { await this.recordSync(await this.sync.sync()) }
      catch (error) { this.log(`Startup sync: ${(error as Error).message}`); this.notify() }
    }
  }
  private async snapshot(): Promise<ManagerSnapshot> {
    const mcp = (await this.store.mcp()).map(s => ({ ...s, env: s.env ? Object.fromEntries(Object.keys(s.env).map(k => [k, '[saved]'])) : undefined, headers: s.headers ? Object.fromEntries(Object.keys(s.headers).map(k => [k, '[saved]'])) : undefined }))
    const appliedProfiles: Record<string, string> = {}
    for (const id of ['claude', 'codex', 'claude-desktop']) { const backup = JSON.parse(await readText(path.join(this.store.data, 'endpoint-defaults', id + '.json')) ?? 'null'); if (backup && !backup.pending) appliedProfiles[id] = backup.profileId ?? 'legacy' }
    const auth = Object.fromEntries(await Promise.all(mcp.filter(s => s.transport === 'http').map(async s => [s.name, await this.auth.currentStatus(s.name)])))
    const running = this.auth.running(), deviceMcp = await this.preparation.statuses()
    for (const [name, status] of Object.entries(running)) if (deviceMcp[name]) deviceMcp[name] = { ...status, canPrepare: deviceMcp[name].canPrepare }
    for (const name of this.supervisor.status.paused) { if (deviceMcp[name]) deviceMcp[name] = { ...deviceMcp[name], state: 'Paused', detail: 'Stopped on this device. Resume allows launch on next use.' } }
    return { runtime: { ...this.supervisor.status, sessions: this.localRuntime.status() }, config: this.store.config, agents: await this.sync.agents(), skills: await this.store.skills(), mcp, proxies: this.proxies.status(this.store.config.proxies), sharing: this.sharing.status(), lastSync: this.lastSync, secrets: this.vault.refs(), logs: this.logs, instructions: await readText(path.join(this.store.pool, 'AGENTS.md')) ?? '', auth, remoteMcp: { ...this.auth.probes, ...running }, appliedProfiles, instructionSource: path.join(this.store.pool, 'AGENTS.md'), deviceMcp, antigravity: await this.sync.antigravityStatus(), workspace: this.workspace.status(), install: { sandboxed: process.env.AIU_SANDBOXED_INSTALL === '1', path: process.env.AIU_HOST_EXE }, mcpMetrics: this.metrics.snapshot() }
  }
  dispatch(method: string, params: any): Promise<any> {
    // Serialize configuration changes and cloud imports so rotating credentials and backup state cannot race.
    const readOnly = ['manager:get', 'endpoint:test', 'endpoint:chat', 'migration:preview', 'skill:read', 'sharing:settings', 'sharing:exists', 'mcp:localLaunchGet', 'workspace:rpc', 'workspace:disconnect', 'mcp:pause', 'mcp:resume', 'mcp:runtimeRefresh'].includes(method)
    if (readOnly) return this.handle(method, params)
    this.pending++
    const task = this.queue.then(() => this.handle(method, params)).finally(() => { this.pending-- }); this.queue = task.catch(() => undefined); return task
  }
  private pending = 0
  /** Names queued library work an app update must not interrupt (sync, import, publish). */
  activity(): string | null { return this.pending ? 'the shared library change in progress' : null }
  private endpoint(id: string): EndpointRecord { const endpoint = this.store.config.endpoints.find(e => e.id === id); if (!endpoint) throw new Error('Endpoint not found'); return endpoint }
  private proxy(id: string): ProxyRecord { const proxy = this.store.config.proxies.find(p => p.id === id); if (!proxy) throw new Error('Proxy not found'); return proxy }
  private async changed(sync = false): Promise<void> { await this.store.save(); if (sync && this.store.config.autoSync) await this.recordSync(await this.sync.sync()); this.notify() }
  private async recordSync(result: SyncResult): Promise<SyncResult> {
    const previousBackup = this.lastSync?.backupId
    this.lastSync = { ...result, backupId: result.backupId ?? previousBackup }
    await atomicWrite(path.join(this.store.data, 'last-sync.json'), JSON.stringify(this.lastSync))
    const signature = result.conflicts.slice().sort().join('|')
    if (signature && signature !== this.conflictNotice) {
      this.log(`Sync conflict: ${result.conflicts.join(', ')}`)
      await this.native('notify', `Sync paused for ${result.conflicts.length} files (${result.conflicts.map(f => path.basename(f)).join(', ')}). Review Shared library → Sync. This is a local edit conflict, not an MCP sign-in error.`).catch(() => undefined)
    } else if (!signature && result.changed > 0 && this.store.config.syncNotifications !== false) await this.native('notify', `Agents synced: ${result.changed} configuration files updated.`).catch(() => undefined)
    this.conflictNotice = signature; this.notify(); return result
  }
  private async handle(method: string, p: any): Promise<any> {
    switch (method) {
      case 'mcp:pause': await this.localRuntime.stop(p); this.auth.stopSessions(p); return
      case 'mcp:resume': await this.supervisor.control('resume', p); return
      case 'mcp:runtimeRefresh': await this.supervisor.refresh(); for (const name of this.supervisor.status.paused) this.auth.stopSessions(name); return
      case 'manager:get': return this.snapshot()
      case 'agent:refreshAntigravity': await this.sync.antigravityStatus(true); this.notify(); return
      case 'library:changed': this.localRuntime.invalidate(); this.preparation.forget(); await this.changed(true); return
      case 'endpoint:save': {
        const e = p.endpoint as EndpointRecord; validateName(e.id); validateUrl(e.baseUrl)
        if (!e.name?.trim() || !['api-key', 'cline', 'antigravity'].includes(e.credentialKind) || !['openai-chat', 'openai-responses', 'anthropic'].includes(e.protocol) || !Array.isArray(e.models)) throw new Error('Invalid endpoint')
        delete e.draft
        const saved = this.store.config.endpoints.find(old => old.id === e.id)
        if (saved?.catalogId) e.catalogId = saved.catalogId
        if (p.secret !== undefined && p.secret !== '') { e.secretRef = 'endpoint-' + e.id; await this.vault.set(e.secretRef!, p.secret) }
        else if (p.secret === '') e.secretRef = undefined
        else if (!e.secretRef && saved?.secretRef) e.secretRef = saved.secretRef
        const index = this.store.config.endpoints.findIndex(old => old.id === e.id)
        if (index < 0) this.store.config.endpoints.push(e); else this.store.config.endpoints[index] = e
        this.engine.reset(e.id); await this.changed(); return
      }
      case 'endpoint:delete':
        if (this.store.config.proxies.some(proxy => proxy.routes.some(r => r.endpointId === p)) || this.store.config.profiles.some(profile => profile.endpointId === p)) throw new Error('Remove routes and profile references before deleting this endpoint')
        { const ref = this.endpoint(p).secretRef; this.store.config.endpoints = this.store.config.endpoints.filter(e => e.id !== p); await this.changed(); if (ref && !this.store.config.endpoints.some(e => e.secretRef === ref)) await this.vault.delete(ref); return }
      case 'endpoint:test': return this.engine.test(this.endpoint(p))
      case 'endpoint:chat': return this.engine.testChat(this.endpoint(p.id), p.model, p.prompt)
      case 'proxy:save': {
        const proxy = p.proxy as ProxyRecord; validateName(proxy.id)
        if (!Number.isInteger(proxy.port) || proxy.port < 1024 || proxy.port > 65535 || !proxy.name?.trim() || !Array.isArray(proxy.routes)) throw new Error('Use a name and an available port between 1024 and 65535')
        const aliases = new Set<string>()
        for (const route of proxy.routes) { if (!route.alias?.trim() || !route.model?.trim() || aliases.has(route.alias)) throw new Error('Routes need unique aliases and a model'); aliases.add(route.alias); this.endpoint(route.endpointId); for (const limit of [route.rpm, route.tpm]) if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw new Error('Rate limits must be positive') }
        if (this.store.config.proxies.some(old => old.id !== proxy.id && old.port === proxy.port)) throw new Error('Another saved proxy uses this port')
        if (proxy.authMode === 'none') proxy.clientSecretRef = ''
        else { proxy.authMode = 'key'; if (p.clientSecret !== undefined) { if (!p.clientSecret.length) throw new Error('Choose No key to disable authentication'); proxy.clientSecretRef = 'proxy-' + proxy.id; await this.vault.set(proxy.clientSecretRef, p.clientSecret) }; validateName(proxy.clientSecretRef ?? '') }
        await this.proxies.stop(proxy.id)
        const index = this.store.config.proxies.findIndex(old => old.id === proxy.id)
        if (index < 0) this.store.config.proxies.push(proxy); else this.store.config.proxies[index] = proxy
        await this.changed(); return
      }
      case 'proxy:delete':
        if (this.store.config.profiles.some(profile => profile.proxyId === p)) throw new Error('Remove profile references first')
        { const ref = this.proxy(p).clientSecretRef; await this.proxies.stop(p); this.store.config.proxies = this.store.config.proxies.filter(proxy => proxy.id !== p); await this.changed(); if (!this.store.config.proxies.some(proxy => proxy.clientSecretRef === ref)) await this.vault.delete(ref); return }
      case 'proxy:start': await this.proxies.start(this.proxy(p)); return
      case 'proxy:stop': await this.proxies.stop(p); return
      case 'profile:save': {
        const profile = p.profile as AgentProfile; validateName(profile.id)
        if (!(await this.sync.agents()).some(a => a.id === profile.agentId) || !profile.name?.trim() || !Array.isArray(profile.mcpNames) || !Array.isArray(profile.disabledSkills)) throw new Error('Invalid profile')
        const names = Object.keys(await this.store.mcpRaw()), skills = (await this.store.skills()).map(s => s.name)
        if (profile.mcpNames.some(n => !names.includes(n)) || profile.disabledSkills.some(n => !skills.includes(n))) throw new Error('Profile references an unknown server or skill')
        const index = this.store.config.profiles.findIndex(old => old.id === profile.id)
        if (index < 0) this.store.config.profiles.push(profile); else this.store.config.profiles[index] = profile
        if (p.activate) this.store.config.activeProfiles[profile.agentId] = profile.id
        await this.changed(!!p.activate || this.store.config.activeProfiles[profile.agentId] === profile.id); return
      }
      case 'profile:delete': {
        const profile = this.store.config.profiles.find(profile => profile.id === p)
        if (!profile) throw new Error('Profile not found')
        if (this.store.config.activeProfiles[profile.agentId] === p) delete this.store.config.activeProfiles[profile.agentId]
        this.store.config.profiles = this.store.config.profiles.filter(profile => profile.id !== p)
        await this.changed(true); return
      }
      case 'manager:autoSync': this.store.config.autoSync = !!p; await this.changed(); return
      case 'mcp:setEnabled': case 'mcp:setCompact': {
        const known = Object.keys(await this.store.mcpRaw())
        if (typeof p?.name !== 'string' || !known.includes(p.name)) throw new Error('Unknown library entry')
        const key = method === 'mcp:setEnabled' ? 'disabledMcp' : 'compactMcp'
        // Enabled toggles store the exception (disabled); compact stores the opt-in.
        const listed = method === 'mcp:setCompact' ? !!p.enabled : !p.enabled
        const values = new Set(this.store.config[key] ?? []); if (listed) values.add(p.name); else values.delete(p.name)
        this.store.config[key] = [...values].sort()
        await this.changed(); return this.recordSync(await this.sync.sync())
      }
      case 'skill:setEnabled': case 'skill:setManyEnabled': {
        const names = method === 'skill:setEnabled' ? (typeof p?.name === 'string' ? [p.name] : []) : (Array.isArray(p?.names) ? p.names.filter((n: unknown): n is string => typeof n === 'string') : [])
        const known = new Set((await this.store.skills()).map(s => s.name))
        if (!names.length || names.some((n: string) => !known.has(n))) throw new Error('Unknown library entry')
        const values = new Set(this.store.config.disabledSkills ?? [])
        for (const name of names) if (p.enabled) values.delete(name); else values.add(name)
        this.store.config.disabledSkills = [...values].sort()
        await this.changed(); return this.recordSync(await this.sync.sync())
      }
      case 'manager:contextBudget': { const value = Number(p); if (!Number.isFinite(value) || value < 1000 || value > 2_000_000) throw new Error('Choose a budget between 1,000 and 2,000,000 tokens'); this.store.config.contextBudget = Math.round(value); await this.changed(); return }
      case 'mcp:resetCalls': this.metrics.resetCalls(typeof p === 'string' ? p : undefined); this.notify(); return
      case 'manager:notifications': this.store.config.syncNotifications = !!p; await this.changed(); return
      case 'profile:activate': { const profile = this.store.config.profiles.find(profile => profile.id === p); if (!profile) throw new Error('Profile not found'); this.store.config.activeProfiles[profile.agentId] = p; await this.changed(); return this.recordSync(await this.sync.sync()) }
      case 'profile:standard': {
        const backup = path.join(this.store.data, 'endpoint-defaults', p + '.json')
        if (await readText(backup)) { const result = await this.launch.restore(p); if (!result.changed && !result.conflicts.length) throw new Error(result.warnings.join('; ') || 'Endpoint restoration did not finish'); if (result.conflicts.length) return this.recordSync(result) }
        delete this.store.config.activeProfiles[p as AgentId]; await this.changed(); return this.recordSync(await this.sync.sync())
      }
      case 'install:preview': return this.installer.preview(p.kind, p.source, p.selected)
      case 'install:confirm': { const result = await this.installer.install(p); await this.changed(true); return result }
      case 'mcp:preparePreview': return this.preparation.preview(p)
      case 'mcp:prepare': { this.suppressWatchUntil = Date.now() + 600_000; try { const result = await this.preparation.confirm(p); await this.recordSync(await this.sync.sync()); this.notify(); return result } finally { this.suppressWatchUntil = Date.now() + 1500 } }
      case 'mcp:check': {
        const spec = (await this.store.mcpRaw())[p]; const result = spec?.url && !spec.command ? await this.auth.check(p) : await this.preparation.probe(p)
        // Workspace: the connection check also verifies each Google account's sign-in and permissions.
        if (p === 'google-workspace' && result.state === 'Connection verified') {
          const accounts = (await this.workspace.checkAccounts()).filter(a => Object.hasOwn(this.store.config.workspaceAccounts ?? {}, a.account))
          const bad = accounts.filter(a => a.state !== 'Signed in')
          result.detail = result.detail.replace('Google consent was not checked.', accounts.length ? `Google accounts: ${accounts.map(a => `${a.account} ${a.state.toLowerCase()}`).join(', ')}.` : 'No Google account is connected yet.')
          if (bad.length) result.state = 'Needs sign-in'
        }
        this.notify(); return result
      }
      case 'mcp:awsProfile': await this.preparation.setAwsProfile(p.name, p.profile); await this.recordSync(await this.sync.sync()); return
      case 'mcp:localLaunch': await this.preparation.setOverride(p.name, p.launch); await this.recordSync(await this.sync.sync()); this.notify(); return
      case 'mcp:localLaunchGet': return this.preparation.localLaunch(p)
      case 'mcp:help': {
        const urls: Record<string, string> = { 'aws-mcp': 'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html', 'google-workspace': 'https://github.com/googleworkspace/cli', 'computer-use': 'https://github.com/domdomegg/computer-use-mcp', 'cua-driver': 'https://github.com/trycua/cua/tree/main/libs/cua-driver/rust', blender: 'https://projects.blender.org/lab/blender_mcp', 'playwright-cdp': 'https://github.com/microsoft/playwright-mcp#connect-to-existing-browser' }
        if (!urls[p]) throw new Error('No setup guide for this server'); await this.native('open-url', urls[p]); return
      }
      case 'mcp:auth': { const master = await this.store.mcpRaw(); if (!master[p.name]?.url || master[p.name].command) throw new Error('Only remote HTTP MCP servers use app OAuth'); this.store.config.mcpAuth ??= {}; this.store.config.mcpAuth[p.name] = { enabled: !!p.enabled, secretRef: this.store.config.mcpAuth[p.name]?.secretRef ?? `mcp-${p.name}-auth` }; await this.changed(); return this.recordSync(await this.sync.sync()) }
      case 'mcp:login': await this.auth.signIn(p); return
      case 'mcp:logout': { const ref = this.store.config.mcpAuth?.[p]?.secretRef; if (ref) await this.vault.delete(ref); this.auth.setStatus(p, 'Sign-in required'); await this.changed(); return }
      case 'manager:preview': return this.sync.preview()
      case 'manager:apply': return this.recordSync(typeof p === 'string' ? await this.sync.apply(p) : await this.sync.apply(p.id, false, { overwrite: p.overwrite, skip: p.skip }))
      case 'manager:adopt': {
        // Keeping the outside edits resolves the pause for those files; the status must say so.
        const preview = await this.sync.adopt(p), still = new Set(preview.changes.filter(c => c.conflict).map(c => c.path))
        if (this.lastSync) {
          const conflicts = this.lastSync.conflicts.filter(file => still.has(file))
          this.lastSync = { ...this.lastSync, conflicts, warnings: conflicts.length ? this.lastSync.warnings : [] }
          await atomicWrite(path.join(this.store.data, 'last-sync.json'), JSON.stringify(this.lastSync))
          this.conflictNotice = conflicts.slice().sort().join('|')
        }
        return preview
      }
      case 'manager:sync': return this.recordSync(await this.sync.sync())
      case 'manager:restore': return this.recordSync(await this.sync.restore(p))
      case 'mcp:save': {
        const server = p.server, oldName: string | undefined = p.oldName || undefined, warnings: string[] = []
        validateName(server.name)
        const master = await this.store.mcpRaw(), old = oldName ? master[oldName] : undefined
        if (oldName && !old) throw new Error(`${oldName} no longer exists. Reload the list and try again.`)
        if (oldName !== server.name && master[server.name]) throw new Error(`An MCP named ${server.name} already exists. Choose another name, or edit that server instead.`)
        const merge = (values: Record<string, string> = {}, previous: Record<string, string> = {}) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === '[saved]' ? previous[k] ?? '' : v]))
        // Fields this editor does not manage (cwd, timeout, client-specific flags) survive a save.
        const extras = Object.fromEntries(Object.entries(old ?? {}).filter(([key]) => !['command', 'args', 'env', 'url', 'headers', 'type', 'aiUsage', 'transport'].includes(key)))
        let entry: Record<string, unknown>
        if (server.transport === 'http') {
          validateUrl(server.url)
          const headers = merge(server.headers, old?.headers)
          entry = { ...extras, type: 'http', url: server.url, ...(Object.keys(headers).length ? { headers } : {}), ...(server.aiUsage ? { aiUsage: server.aiUsage } : {}) }
        } else {
          const args = server.args ?? []
          if (!server.command?.trim() || !Array.isArray(args) || args.some((a: unknown) => typeof a !== 'string')) throw new Error('Local servers need a command and text arguments')
          entry = { ...extras, command: server.command.trim(), args, env: merge(server.env, old?.env), ...(server.aiUsage ? { aiUsage: server.aiUsage } : {}) }
          if (old?.command && server.aiUsage?.source && (old.command !== entry.command || JSON.stringify(old.args) !== JSON.stringify(args))) warnings.push(`${server.name} is installed from a pinned recipe, so Prepare chooses its command on each device. Use "Edit local launch" for this device, or remove the recipe to manage the command yourself.`)
        }
        // A sign-in belongs to one remote URL; it is meaningless after switching to a local
        // command or another server, and would fail against the new one.
        const auth = this.store.config.mcpAuth?.[oldName ?? server.name]
        if (auth && (entry.command || (old?.url && old.url !== entry.url))) {
          delete this.store.config.mcpAuth![oldName ?? server.name]; await this.vault.delete(auth.secretRef).catch(() => undefined)
          if (!entry.command) warnings.push(`${server.name} points to a different server now. Turn on "Connect via AI Usage" and sign in again.`)
        }
        if (oldName && oldName !== server.name) {
          delete master[oldName]
          if (this.store.config.mcpAuth?.[oldName]) { this.store.config.mcpAuth[server.name] = this.store.config.mcpAuth[oldName]; delete this.store.config.mcpAuth[oldName] }
          for (const profile of this.store.config.profiles) profile.mcpNames = profile.mcpNames.map(name => name === oldName ? server.name : name)
          for (const key of ['disabledMcp', 'compactMcp'] as const) if (this.store.config[key]) this.store.config[key] = this.store.config[key]!.map(name => name === oldName ? server.name : name)
          this.metrics.rename(oldName, server.name)
          if (entry.command) await this.preparation.renameOverride(oldName, server.name, entry)
          if (this.supervisor.paused(oldName)) { await this.supervisor.control('resume', oldName); await this.localRuntime.stop(server.name) }
          this.auth.stopSessions(oldName)
        }
        master[server.name] = entry
        await this.store.save()
        this.suppressWatchUntil = Date.now() + 600_000
        try {
          await atomicWrite(path.join(this.store.pool, 'mcp.json'), JSON.stringify({ mcpServers: master }, null, 2) + '\n')
          this.preparation.forget(); this.localRuntime.invalidate()
          const sync = this.store.config.autoSync ? await this.recordSync(await this.sync.sync()) : undefined
          this.notify(); return { warnings, sync }
        } finally { this.suppressWatchUntil = Date.now() + 1500 }
      }
      case 'mcp:delete': { validateName(p); const master = await this.store.mcpRaw(); delete master[p]; const ref = this.store.config.mcpAuth?.[p]?.secretRef; if (this.store.config.mcpAuth) delete this.store.config.mcpAuth[p]; if (ref) await this.vault.delete(ref); for (const profile of this.store.config.profiles) profile.mcpNames = profile.mcpNames.filter(name => name !== p); for (const key of ['disabledMcp', 'compactMcp'] as const) if (this.store.config[key]) this.store.config[key] = this.store.config[key]!.filter(name => name !== p); this.metrics.forget(p); await this.store.save(); await atomicWrite(path.join(this.store.pool, 'mcp.json'), JSON.stringify({ mcpServers: master }, null, 2)); this.notify(); return }
      case 'instructions:save': if (typeof p !== 'string' || p.length > 2_000_000) throw new Error('Instructions are too large'); await atomicWrite(path.join(this.store.pool, 'AGENTS.md'), p); this.notify(); return
      case 'skill:read': return readText(await this.store.skillPath(p))
      case 'skill:save': if (typeof p.text !== 'string' || p.text.length > 2_000_000) throw new Error('Skill text is too large'); await atomicWrite(await this.store.skillPath(p.name), p.text); this.notify(); return
      case 'skill:delete': {
        if (typeof p !== 'string') throw new Error('Invalid skill name')
        this.suppressWatchUntil = Date.now() + 2500
        await this.store.deleteSkill(p)
        if (this.store.config.disabledSkills) this.store.config.disabledSkills = this.store.config.disabledSkills.filter(name => name !== p)
        for (const profile of this.store.config.profiles) profile.disabledSkills = profile.disabledSkills.filter(name => name !== p)
        if (this.store.config.skillFolders) this.store.config.skillFolders = this.store.config.skillFolders.map(folder => ({ ...folder, skills: folder.skills.filter(name => name !== p) }))
        await this.changed(true)
        return
      }
      case 'skillFolders:save': this.store.config.skillFolders = normalizeSkillFolders(p); await this.changed(); return
      case 'migration:preview': return { providers: 0, protectedKeys: 0, gateways: 0, routes: 0, profiles: 0, sources: [], alreadyImported: false }
      case 'migration:import': throw new Error('Add endpoints directly or import an encrypted shared library.')
      case 'sharing:configure': { const result = await this.sharing.configure(p.folder, p.passphrase); this.notify(); return result }
      case 'workspace:disconnect': this.workspace.closeSession(p); return
      case 'workspace:rpc': return this.workspace.rpc(p)
      case 'workspace:configureClient': await this.workspace.configureClient(p); return { saved: true }
      case 'workspace:clientFile': {
        if (typeof p !== 'string' || !path.isAbsolute(p) || fs.statSync(p).size > 128_000) throw new Error('Choose the Google Desktop OAuth client JSON file')
        let value: any; try { value = JSON.parse((await readText(p))!) } catch { throw new Error('The OAuth client file is not valid JSON') }
        await this.workspace.configureClient(value); return
      }
      case 'workspace:signIn': await this.workspace.signIn(p); return
      case 'workspace:signOut': await this.workspace.signOut(p); return
      case 'workspace:check': return this.workspace.checkAccounts()
      case 'workspace:finish': await this.workspace.finish(p); return
      case 'workspace:importAccount': { await this.workspace.importAccount(p.account, p.credential, p.projectId); this.notify(); return { account: p.account, saved: true } }
      case 'workspace:enable': {
        const master = await this.store.mcpRaw()
        await atomicWrite(path.join(this.store.data, 'workspace-before-gws.json'), JSON.stringify({ mcp: master, config: this.store.config }, null, 2))
        master['google-workspace'] = { command: '@device', args: [], aiUsage: { source: { kind: 'workspace-gws', version: '0.22.5' } } }
        await atomicWrite(path.join(this.store.pool, 'mcp.json'), JSON.stringify({ mcpServers: master }, null, 2))
        this.preparation.forget('google-workspace'); await this.changed(); return { enabled: true, next: 'Prepare google-workspace on this device, then sync agents' }
      }
      case 'sharing:settings': return this.sharing.settings()
      case 'sharing:exists': return this.sharing.fileExists(p?.folder)
      case 'sharing:auto': {
        // Cloud changes are announced, never imported over edits or published without a click.
        const result = await this.sharing.checkRemote(); this.notify(); return result
      }
      case 'sharing:unlock': { const result = await this.sharing.unlock(p.passphrase); this.notify(); return result }
      case 'sharing:publish': {
        if (p?.folder !== undefined) await this.sharing.useSettings(p.folder, p.passphrase, false)
        for (const endpoint of this.store.config.endpoints) {
          let auth: any
          if (endpoint.credentialKind === 'cline') {
            const text = await readText(path.join(this.home, '.cline/data/settings/providers.json'))
            auth = text ? JSON.parse(text).providers?.cline?.settings?.auth : null
          } else if (endpoint.credentialKind === 'antigravity') {
            const file = stateDbPath(), refreshToken = extractAntigravityRefreshToken(file)
            if (refreshToken) auth = { accessToken: extractAntigravityAccessToken(file), refreshToken, clientSecret: findAntigravityClientSecret(), clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com' }
          }
          if (auth) { endpoint.secretRef = `account-${endpoint.id}`; await this.vault.set(endpoint.secretRef, JSON.stringify(auth)); this.engine.reset(endpoint.id) }
        }
        await this.store.save(); const result = await this.sharing.publish(); this.notify(); return result
      }
      case 'sharing:import': {
        if (p?.folder !== undefined) await this.sharing.useSettings(p.folder, p.passphrase, true)
        this.preparation.forget()
        this.suppressWatchUntil = Date.now() + 5000
        try { const result = await this.sharing.import(true); this.auth.resetStatus(); this.workspace.resetStatus(); await this.recordSync(await this.sync.sync(true)); this.notify(); return result }
        finally { this.suppressWatchUntil = Date.now() + 1500 }
      }
      case 'agent:launch': return this.launch.launch(p)
      case 'agent:default': { const result = await this.launch.applyDefault(p); if (result.changed) { const profile = this.store.config.profiles.find(profile => profile.id === p)!; this.store.config.activeProfiles[profile.agentId] = p; await this.changed(); await this.recordSync(await this.sync.sync()); const file = path.join(this.store.data, 'endpoint-defaults', profile.agentId + '.json'), saved = JSON.parse(await readText(file) ?? 'null'); if (saved?.kind === 'file') { saved.after = await readText(saved.file); await atomicWrite(file, JSON.stringify(saved)) } }; this.notify(); return result }
      case 'agent:restore': return this.launch.restore(p)
      default: throw new Error('Unknown manager operation')
    }
  }
  async close(): Promise<void> { this.watcher?.close(); if (this.timer) clearTimeout(this.timer); if (this.shareTimer) clearInterval(this.shareTimer); this.workspace.close(); if (this.runtimeTimer) clearInterval(this.runtimeTimer); await this.auth.close(); await this.supervisor.close(); await this.metrics.flush(); await this.queue; await this.proxies.stopAll(); this.sharing.clear(); this.vault.clear() }
}
