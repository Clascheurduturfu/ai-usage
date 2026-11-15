import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, randomUUID } from 'node:crypto'
import type { ManagerConfig, SharingStatus } from '../../shared/manager'
import { atomicWrite, ManagerStore, normalizeSkillFolders, readText, validateName, validatePathComponent, validateUrl, Vault } from './storage'
import { portableMcp, mcpSource } from './mcp-preparation'
import { validateWorkspaceAccount } from '../../shared/workspace-account'
import { composeEndpoints, legacyLibrary, partitionEndpoints, type EndpointLibrary } from './endpoint-library'

type Envelope = { schema: 1; revision: string; parent?: string; salt: string; iv: string; tag: string; data: string }
type Bundle = { config: ManagerConfig; endpointLibrary?: EndpointLibrary; mcp: Record<string, any>; instructions: string; skills: Record<string, string>; credentials: Record<string, string> }
export function mapMcpPaths(value: any, home: string, pool: string, portable: boolean): any {
  if (typeof value === 'string') {
    if (portable) return value.split(pool).join('${AIU_POOL}').split(pool.replaceAll('\\', '/')).join('${AIU_POOL}').split(home).join('${AIU_HOME}').split(home.replaceAll('\\', '/')).join('${AIU_HOME}')
    for (const [marker, root] of [['${AIU_POOL}', pool], ['${AIU_HOME}', home]]) {
      if (value.startsWith(marker)) return path.join(root, ...value.slice(marker.length).split(/[/\\]+/).filter(Boolean))
    }
    return value
  }
  if (Array.isArray(value)) return value.map(v => mapMcpPaths(v, home, pool, portable))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapMcpPaths(v, home, pool, portable)]))
  return value
}
export function encryptBundle(bundle: Bundle, password: string, revision: string, parent?: string): Envelope {
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(JSON.stringify({ schema: 1, revision, parent: parent ?? null })))
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final()]); key.fill(0)
  return { schema: 1, revision, parent, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}
export function decryptBundle(envelope: Envelope, password: string): Bundle {
  if (envelope.schema !== 1 || envelope.data.length > 100 * 1024 * 1024) throw new Error('Unsupported or oversized shared bundle')
  const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(Buffer.from(JSON.stringify({ schema: 1, revision: envelope.revision, parent: envelope.parent ?? null })))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString())
  } catch { throw new Error('Incorrect sharing password, or the encrypted file is damaged. No changes were imported or published.') }
  finally { key.fill(0) }
}
export class Sharing {
  private password = ''
  private state: SharingStatus = { folder: '', enabled: false, unlocked: false, pending: 0 }
  private localRevision = ''
  constructor(private store: ManagerStore, private vault: Vault, private home = os.homedir()) {}
  private file(): string { return path.join(this.normalizeFolder(this.state.folder), 'ai-usage-shared.encrypted.json') }
  private stateFile(): string { return path.join(this.store.data, 'sharing.json') }
  /** Tolerate a shared FILE path pasted where the folder belongs. */
  private normalizeFolder(folder: string): string {
    const trimmed = folder.replace(/[\\/]+$/, '')
    return trimmed.toLowerCase().endsWith('ai-usage-shared.encrypted.json') ? path.dirname(trimmed) : trimmed
  }
  async load(): Promise<void> {
    const saved = JSON.parse(await readText(this.stateFile()) ?? '{}')
    this.state = { ...this.state, ...saved, unlocked: false, pending: 0 }
    this.state.folder = this.normalizeFolder(this.state.folder)
    if (this.state.enabled && this.vault.refs().includes('sharing-passphrase')) {
      try { this.password = await this.vault.get('sharing-passphrase'); this.state.unlocked = true }
      catch { this.password = ''; this.state.error = 'Saved sharing password is unavailable on this device. Enter it again.' }
    }
    this.localRevision = saved.localRevision ?? this.store.config.revision
  }
  status(): SharingStatus { return { ...this.state } }
  async fileExists(folder = this.state.folder): Promise<boolean> {
    folder = this.normalizeFolder(folder)
    if (!folder || !path.isAbsolute(folder)) return false
    return fs.stat(path.join(folder, 'ai-usage-shared.encrypted.json')).then(s => s.isFile(), e => { if (e.code === 'ENOENT') return false; throw e })
  }
  settings(): { folder: string; passphrase: string } { return { folder: this.state.folder, passphrase: this.password } }
  async checkRemote(): Promise<SharingStatus> {
    if (!this.state.enabled) return this.status()
    const text = await readText(this.file())
    this.state.pending = text && JSON.parse(text).revision !== this.state.revision ? 1 : 0
    return this.status()
  }
  hasLocalChanges(): boolean { return this.localRevision !== this.store.config.revision }
  async configure(folder: string, password: string): Promise<SharingStatus> {
    if (password.length < 12) throw new Error('Use a shared passphrase with at least 12 characters')
    folder = this.normalizeFolder(folder)
    if (!path.isAbsolute(folder)) throw new Error('Select an absolute shared folder')
    await fs.mkdir(folder, { recursive: true })
    const sameFolder = folder === this.state.folder
    this.state = { folder, enabled: true, unlocked: true, pending: 0, revision: sameFolder ? this.state.revision : undefined }; this.password = password
    await this.vault.set('sharing-passphrase', password)
    await atomicWrite(this.stateFile(), JSON.stringify({ folder, enabled: true, revision: this.state.revision, localRevision: this.localRevision }))
    return this.status()
  }
  async useSettings(folder: string, password: string, importing: boolean): Promise<void> {
    if (password.length < 12) throw new Error('Use a shared passphrase with at least 12 characters')
    folder = this.normalizeFolder(folder)
    if (!path.isAbsolute(folder)) throw new Error('Select an absolute shared folder')
    const existing = await readText(path.join(folder, 'ai-usage-shared.encrypted.json'))
    if (importing && !existing) throw new Error('No shared bundle exists yet')
    // Verify an existing bundle before saving a new password or replacing it.
    if (existing) decryptBundle(JSON.parse(existing), password)
    await this.configure(folder, password)
  }
  async unlock(password: string): Promise<SharingStatus> {
    if (password.length < 12) throw new Error('Use a shared passphrase with at least 12 characters')
    const envelope = await readText(this.file())
    if (envelope) decryptBundle(JSON.parse(envelope), password)
    this.password = password; this.state.unlocked = true
    await this.vault.set('sharing-passphrase', password); return this.status()
  }
  private require(): void { if (!this.state.enabled || !this.password) throw new Error('Select a shared folder and enter its password') }
  async publish(): Promise<SharingStatus> {
    this.require()
    const oldText = await readText(this.file()), old: Envelope | null = oldText ? JSON.parse(oldText) : null
    if (old) decryptBundle(old, this.password)
    const skills: Record<string, string> = {}
    let size = 0
    // Disabled skills are parked outside the shared folder; they are still part of the library.
    let root = this.store.skillRoot
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name) || entry.isSymbolicLink()) continue
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          const bytes = await fs.readFile(full); size += bytes.length
          if (size > 64 * 1024 * 1024 || bytes.length > 8 * 1024 * 1024) throw new Error('Shared skills exceed the 64 MiB bundle or 8 MiB file limit')
          skills[path.relative(root, full).split(path.sep).join('/')] = bytes.toString('base64')
        }
      }
    }
    for (const base of [this.store.skillRoot, this.store.parkedSkillRoot]) { root = base; if (await fs.stat(base).then(s => s.isDirectory(), () => false)) await walk(base) }
    // MCP OAuth grants rotate on every refresh, so a copied grant breaks whichever
    // device refreshes second. They stay on the device that signed in; only the
    // "connect through AI Usage" setting travels.
    const refs = new Set([...this.store.config.endpoints.map(e => e.secretRef), ...this.store.config.proxies.map(p => p.clientSecretRef), this.store.config.workspaceOAuth?.secretRef, ...Object.values(this.store.config.workspaceAccounts ?? {}).map(v => v.secretRef)].filter((ref): ref is string => !!ref))
    // A vault can lose device-scoped credentials over time. Publish survives by
    // omitting them and stripping the dangling references instead of failing.
    const credentials: Record<string, string> = {}, skipped: string[] = []
    for (const ref of refs) { try { credentials[ref] = await this.vault.get(ref) } catch { skipped.push(ref) } }
    const config = structuredClone(this.store.config)
    config.schema = 2
    config.endpoints = config.endpoints.map(e => e.secretRef && skipped.includes(e.secretRef) ? { ...e, secretRef: undefined } : e)
    config.proxies = config.proxies.map(p => p.clientSecretRef && skipped.includes(p.clientSecretRef) ? { ...p, clientSecretRef: undefined, authMode: 'none' as const } : p)
    for (const [account, spec] of Object.entries(config.workspaceAccounts ?? {})) if (skipped.includes(spec.secretRef)) delete config.workspaceAccounts![account]
    if (config.workspaceOAuth && skipped.includes(config.workspaceOAuth.secretRef)) delete config.workspaceOAuth
    const library = structuredClone(this.store.endpointSnapshot())
    library.custom = (library.custom ?? []).map(e => e.secretRef && skipped.includes(e.secretRef) ? { ...e, secretRef: undefined } : e)
    for (const patch of Object.values(library.overrides ?? {})) if (patch?.secretRef && skipped.includes(patch.secretRef)) delete patch.secretRef
    const bundle: Bundle = { config, endpointLibrary: library, mcp: mapMcpPaths(portableMcp(await this.store.mcpRaw()), this.home, this.store.pool, true), instructions: await readText(path.join(this.store.pool, 'AGENTS.md')) ?? '', skills, credentials }
    const revision = randomUUID(), envelope = encryptBundle(bundle, this.password, revision, old?.revision)
    // Recheck immediately before the atomic replace to detect cloud-client updates during collection.
    if (oldText) await atomicWrite(path.join(this.store.data, 'shared-publications', randomUUID() + '.encrypted.json'), oldText)
    if (await readText(this.file()) !== oldText) throw new Error('Shared bundle changed during publication. Check the latest file and retry Publish.')
    await atomicWrite(this.file(), JSON.stringify(envelope))
    this.state.revision = revision; this.state.pending = 0
    if (skipped.length) this.state.error = `Published, but skipped ${skipped.length} unavailable credential${skipped.length === 1 ? '' : 's'} (${skipped.join(', ')}). Those arrive without their key; enter the key on the importing device.`
    else delete this.state.error
    this.localRevision = this.store.config.revision
    await atomicWrite(this.stateFile(), JSON.stringify({ ...this.state, localRevision: this.localRevision, unlocked: undefined, pending: undefined }))
    return this.status()
  }
  async import(resolveConflict = false): Promise<SharingStatus> {
    this.require()
    const text = await readText(this.file())
    if (!text) throw new Error('No shared bundle exists yet')
    const envelope: Envelope = JSON.parse(text)
    if (envelope.revision === this.state.revision && !resolveConflict) return this.status()
    if (this.localRevision !== this.store.config.revision && !resolveConflict) { this.state.pending = 1; this.state.error = 'Local and shared settings changed; review before replacing local settings'; return this.status() }
    const bundle = decryptBundle(envelope, this.password)
    if (![1, 2].includes(bundle.config.schema)) throw new Error('This shared library requires a newer AI Usage version')
    if (!Array.isArray(bundle.config.endpoints) || !Array.isArray(bundle.config.profiles) || !Array.isArray(bundle.config.proxies) || typeof bundle.skills !== 'object') throw new Error('Invalid shared bundle')
    const incomingLibrary = bundle.endpointLibrary ?? (bundle.config.schema === 2 ? partitionEndpoints(bundle.config.endpoints) : legacyLibrary(bundle.config.endpoints))
    bundle.config.endpoints = composeEndpoints(incomingLibrary); bundle.config.schema = 2
    let totalSize = 0
    for (const relative of Object.keys(bundle.skills)) {
      if (relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Unsafe skill path in shared bundle')
      for (const part of relative.split('/')) validatePathComponent(part)
      const size = Buffer.from(bundle.skills[relative], 'base64').length; totalSize += size
      if (size > 8 * 1024 * 1024 || totalSize > 64 * 1024 * 1024) throw new Error('Shared skills exceed the import size limit')
    }
    for (const [ref, value] of Object.entries(bundle.credentials)) { validateName(ref); if (typeof value !== 'string' || value.length > 128_000) throw new Error('Invalid shared credential') }
    for (const endpoint of bundle.config.endpoints) { validateName(endpoint.id); if (endpoint.baseUrl) validateUrl(endpoint.baseUrl); if (!['api-key', 'cline', 'antigravity'].includes(endpoint.credentialKind) || !['openai-chat', 'openai-responses', 'anthropic'].includes(endpoint.protocol) || !Array.isArray(endpoint.models)) throw new Error('Invalid shared endpoint') }
    for (const proxy of bundle.config.proxies) { validateName(proxy.id); if (proxy.authMode !== 'none') { if (!proxy.clientSecretRef) throw new Error('Invalid shared listener'); validateName(proxy.clientSecretRef) }; if (!Number.isInteger(proxy.port) || proxy.port < 1024 || proxy.port > 65535 || !Array.isArray(proxy.routes)) throw new Error('Invalid shared listener') }
    for (const [name, value] of Object.entries(bundle.config.mcpAuth ?? {})) { validateName(name); validateName(value.secretRef); if (typeof value.enabled !== 'boolean') throw new Error('Invalid MCP auth setting') }
    for (const [name, value] of Object.entries(bundle.config.workspaceAccounts ?? {})) { validateWorkspaceAccount(name); validateName(value.secretRef); if (typeof bundle.credentials[value.secretRef] !== 'string') throw new Error('Missing shared Workspace credential') }
    if (bundle.config.workspaceOAuth) { validateName(bundle.config.workspaceOAuth.secretRef); if (!/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(bundle.config.workspaceOAuth.projectId) || typeof bundle.credentials[bundle.config.workspaceOAuth.secretRef] !== 'string') throw new Error('Invalid shared Google OAuth project') }
    for (const profile of bundle.config.profiles) { validateName(profile.id); if (!Array.isArray(profile.mcpNames) || !Array.isArray(profile.disabledSkills)) throw new Error('Invalid shared profile') }
    if (bundle.config.skillFolders !== undefined) bundle.config.skillFolders = normalizeSkillFolders(bundle.config.skillFolders)
    const skillRoot = path.join(this.store.pool, 'skills')
    await fs.mkdir(skillRoot, { recursive: true })
    if ((await fs.lstat(skillRoot)).isSymbolicLink()) throw new Error('A linked master skill directory prevents safe import')
    for (const relative of Object.keys(bundle.skills)) {
      let candidate = path.join(skillRoot, relative)
      while (candidate !== skillRoot) { if ((await fs.lstat(candidate).catch(() => null))?.isSymbolicLink()) throw new Error('A local skill link prevents safe import'); candidate = path.dirname(candidate) }
    }
    // Import writes one folder: bring parked skills back first; the next sync parks them again.
    for (const warning of await this.store.placeSkills([])) throw new Error(warning)
    const backup = path.join(this.store.data, 'shared-imports', randomUUID())
    await fs.mkdir(backup, { recursive: true })
    for (const name of ['manager.json', 'endpoints.custom.json', 'mcp.json', 'AGENTS.md']) { const value = await readText(path.join(this.store.pool, name)); if (value !== null) await atomicWrite(path.join(backup, name), value) }
    await fs.cp(path.join(this.store.pool, 'skills'), path.join(backup, 'skills'), { recursive: true, dereference: false })
    const oldConfig = structuredClone(this.store.config), oldVault = this.vault.protectedSnapshot(), oldLibrary = this.store.endpointSnapshot()
    const localMaster = await this.store.mcpRaw(), importedMaster = mapMcpPaths(bundle.mcp, this.home, this.store.pool, false)
    // MCP sign-ins are per device (see publish). Older bundles may still carry
    // grants: never import them, and keep every local sign-in and its reference,
    // including servers the publishing device never set to authenticate in app.
    const preserved = new Set<string>()
    const readCredential = async (ref: string): Promise<any> => {
      try { return JSON.parse(await this.vault.get(ref)) } catch { return null }
    }
    const portableRefs = new Set([...bundle.config.endpoints.map(e => e.secretRef), ...bundle.config.proxies.map(p => p.clientSecretRef), bundle.config.workspaceOAuth?.secretRef, ...Object.values(bundle.config.workspaceAccounts ?? {}).map(v => v.secretRef)])
    for (const ref of Object.values(bundle.config.mcpAuth ?? {}).map(v => v.secretRef)) if (!portableRefs.has(ref)) preserved.add(ref)
    const mcpAuth: NonNullable<ManagerConfig['mcpAuth']> = {}
    for (const name of Object.keys(importedMaster)) {
      const incoming = bundle.config.mcpAuth?.[name], previous = oldConfig.mcpAuth?.[name]
      if (!incoming && !previous) continue
      mcpAuth[name] = { enabled: incoming?.enabled ?? previous!.enabled, secretRef: previous?.secretRef ?? `mcp-${name}-auth` }
      preserved.add(mcpAuth[name].secretRef)
    }
    bundle.config.mcpAuth = mcpAuth
    for (const [account, incoming] of Object.entries(bundle.config.workspaceAccounts ?? {})) {
      const previous = oldConfig.workspaceAccounts?.[account]
      if (!previous || previous.email !== incoming.email || previous.projectId !== incoming.projectId) continue
      const local = await readCredential(previous.secretRef), remote = JSON.parse(bundle.credentials[incoming.secretRef])
      if (local?.refresh_token && !(Number(remote.signedInAt) > Number(local.signedInAt ?? 0))) {
        bundle.config.workspaceAccounts![account] = previous; preserved.add(previous.secretRef)
      }
    }
    for (const [name, spec] of Object.entries(importedMaster) as Array<[string, any]>) {
      const incoming = mcpSource(name, spec), local = localMaster[name], previous = local && mcpSource(name, local)
      if (incoming && previous && JSON.stringify(incoming) === JSON.stringify(previous) && local.command !== '@device') importedMaster[name] = { ...spec, command: local.command, args: local.args, env: { ...spec.env, ...Object.fromEntries(Object.entries(local.env ?? {}).filter(([key]) => ['AWS_PROFILE', 'BLENDER_PATH'].includes(key))) } }
    }
    await atomicWrite(path.join(backup, 'vault.protected.json'), JSON.stringify(oldVault))
    // Preserve local listener ports and auto-start preferences on an existing machine.
    bundle.config.proxies = bundle.config.proxies.map(p => {
      const local = this.store.config.proxies.find(old => old.id === p.id)
      return { ...p, port: local?.port ?? p.port, autostart: local?.autostart ?? false }
    })
    const writes: Array<{ file: string; before: Buffer | null }> = []
    const replace = async (file: string, value: string | Buffer): Promise<void> => {
      const before = await fs.readFile(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
      writes.push({ file, before }); await atomicWrite(file, value)
    }
    try {
      for (const [id, value] of Object.entries(bundle.credentials)) if (!preserved.has(id)) await this.vault.set(id, value)
      for (const [relative, encoded] of Object.entries(bundle.skills)) await replace(path.join(skillRoot, relative), Buffer.from(encoded, 'base64'))
      await replace(path.join(this.store.pool, 'mcp.json'), JSON.stringify({ mcpServers: importedMaster }, null, 2))
      await replace(path.join(this.store.pool, 'AGENTS.md'), bundle.instructions)
      await replace(path.join(this.store.pool, 'manager.json'), JSON.stringify(bundle.config, null, 2))
      this.store.config = bundle.config; this.store.adoptEndpoints(incomingLibrary); await this.store.save()
    } catch (error) {
      for (const change of writes.reverse()) { if (change.before === null) await fs.rm(change.file, { force: true }); else await atomicWrite(change.file, change.before) }
      this.store.config = oldConfig; this.store.adoptEndpoints(oldLibrary); await atomicWrite(path.join(this.store.pool, 'endpoints.custom.json'), JSON.stringify(oldLibrary, null, 2)); await this.vault.restoreProtected(oldVault)
      throw error
    }
    this.localRevision = this.store.config.revision; this.state.revision = envelope.revision; this.state.pending = 0; delete this.state.error
    await atomicWrite(this.stateFile(), JSON.stringify({ ...this.state, localRevision: this.localRevision, unlocked: undefined, pending: undefined }))
    return this.status()
  }
  clear(): void { this.password = ''; this.state.unlocked = false }
}
