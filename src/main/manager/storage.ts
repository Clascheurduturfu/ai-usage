import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ManagerConfig, McpRecord, SkillInfo } from '../../shared/manager'
import { parse as parseYaml } from 'yaml'
import { composeEndpoints, legacyLibrary, partitionEndpoints, type EndpointLibrary } from './endpoint-library'

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
export async function atomicWrite(file: string, text: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}
export function validateName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new Error('Use a simple name with letters, numbers, dots, underscores or hyphens')
}
/** A portable filename is different from an MCP/credential identifier. */
export function validatePathComponent(name: string): void {
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name, 'utf8') > 255 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error(`Unsafe or non-portable skill path component: ${JSON.stringify(name)}`)
}
export function validateUrl(url: string): void {
  const value = new URL(url)
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.hash || value.search) throw new Error('Use an HTTP(S) base URL without credentials or query parameters')
}
export type NativeCall = (method: string, value: string) => Promise<string>

export class Vault {
  private values: Record<string, string> = {}
  private cached = new Map<string, string>()
  constructor(private file: string, private native: NativeCall) {}
  async load(): Promise<void> { this.values = JSON.parse(await readText(this.file) ?? '{}') }
  refs(): string[] { return Object.keys(this.values) }
  revision(id?: string): string | undefined { return id && this.values[id] ? hash(this.values[id]) : undefined }
  async set(id: string, secret: string): Promise<void> {
    validateName(id)
    if (secret.length > 128_000) throw new Error('Credential is too large')
    this.values[id] = await this.native('protect', secret)
    await atomicWrite(this.file, JSON.stringify(this.values, null, 2))
    this.cached.set(id, secret)
  }
  async get(id?: string): Promise<string> {
    if (!id) return ''
    if (this.cached.has(id)) return this.cached.get(id)!
    if (!this.values[id]) throw new Error(`Saved credential ${id} is unavailable`)
    const value = await this.native('unprotect', this.values[id])
    this.cached.set(id, value)
    return value
  }
  async export(): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all(this.refs().map(async (id) => [id, await this.get(id)])))
  }
  async delete(id?: string): Promise<void> {
    if (!id) return
    delete this.values[id]; this.cached.delete(id)
    await atomicWrite(this.file, JSON.stringify(this.values, null, 2))
  }
  protectedSnapshot(): Record<string, string> { return { ...this.values } }
  async restoreProtected(values: Record<string, string>): Promise<void> { await atomicWrite(this.file, JSON.stringify(values, null, 2)); this.values = { ...values }; this.clear() }
  redact(message: string): string {
    for (const secret of this.cached.values()) if (secret.length) message = message.split(secret).join('[redacted]')
    return message
  }
  clear(): void { this.cached.clear() }
}

export class ManagerStore {
  config!: ManagerConfig
  private endpointLibrary?: EndpointLibrary
  endpointSnapshot(): EndpointLibrary { return partitionEndpoints(this.config.endpoints, this.endpointLibrary) }
  adoptEndpoints(library: EndpointLibrary): void { this.config.endpoints = composeEndpoints(library); this.endpointLibrary = structuredClone(library) }
  constructor(readonly pool: string, readonly data: string) {}
  async load(): Promise<void> {
    await fs.mkdir(this.pool, { recursive: true })
    const existing = await readText(path.join(this.pool, 'manager.json'))
    this.config = existing ? JSON.parse(existing) : {
      schema: 2, revision: randomUUID(), autoSync: false,
      endpoints: [], proxies: [], profiles: [], activeProfiles: {}
    }
    if (![1, 2].includes(this.config.schema)) throw new Error('Unsupported manager configuration version')
    const savedLibrary = await readText(path.join(this.pool, 'endpoints.custom.json'))
    if (existing && this.config.schema === 1) {
      await atomicWrite(path.join(this.data, 'endpoint-migrations', 'manager-v1-before.json'), existing)
      this.adoptEndpoints(legacyLibrary(this.config.endpoints)); this.config.schema = 2; await this.save()
    } else this.adoptEndpoints(savedLibrary ? JSON.parse(savedLibrary) : { schema: 1, custom: [], overrides: {}, hidden: [] })
    const pendingFile = path.join(this.data, 'pending-library-additions.json'), pending = JSON.parse(await readText(pendingFile) ?? '[]')
    if (pending.length) { const names = new Set(Object.keys(await this.mcpRaw())); for (const name of pending) if (names.has(name)) for (const profile of this.config.profiles) if (!profile.mcpNames.includes(name)) profile.mcpNames.push(name); await this.save(); await atomicWrite(pendingFile, '[]') }
    if (!existing) await this.save()
  }
  async save(): Promise<void> {
    this.config.schema = 2
    this.config.revision = randomUUID()
    const library = this.endpointSnapshot(), file = path.join(this.pool, 'endpoints.custom.json'), previous = await readText(file)
    await atomicWrite(file, JSON.stringify(library, null, 2) + '\n')
    try { const { endpoints: _derived, ...stored } = this.config; await atomicWrite(path.join(this.pool, 'manager.json'), JSON.stringify({ ...stored, schema: 2 }, null, 2) + '\n'); this.endpointLibrary = library }
    catch (error) { if (previous === null) await fs.rm(file, { force: true }); else await atomicWrite(file, previous); throw error }
  }
  async mcpRaw(): Promise<Record<string, any>> {
    const text = await readText(path.join(this.pool, 'mcp.json'))
    const value = JSON.parse(text ?? '{"mcpServers":{}}')
    if (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)) throw new Error('The MCP registry must contain mcpServers')
    return value.mcpServers
  }
  async mcp(): Promise<McpRecord[]> {
    return Object.entries(await this.mcpRaw()).map(([name, s]) => ({ name, transport: s.command ? 'stdio' : 'http', command: s.command,
      args: s.args, url: s.url, env: s.env, headers: s.headers, aiUsage: s.aiUsage }))
  }
  /** Active skills, read by every client that scans the shared folder. */
  get skillRoot(): string { return path.join(this.pool, 'skills') }
  /** Globally disabled skills live beside the shared folder, where no client looks. */
  get parkedSkillRoot(): string { return path.join(this.pool, 'skills-disabled') }
  async skills(): Promise<SkillInfo[]> {
    const result: SkillInfo[] = [], seen = new Set<string>()
    for (const root of [this.skillRoot, this.parkedSkillRoot]) await this.readSkills(root, result, seen)
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }
  private async readSkills(root: string, result: SkillInfo[], seen: Set<string>): Promise<void> {
    let dirs: import('node:fs').Dirent[]
    try { dirs = await fs.readdir(root, { withFileTypes: true }) } catch { return }
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith('.') || seen.has(dir.name)) continue
      seen.add(dir.name)
      const file = path.join(root, dir.name, 'SKILL.md')
      const text = await readText(file)
      if (text === null) continue
      try {
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        const meta = match ? parseYaml(match[1]) : null
        result.push({ name: dir.name, description: String(meta?.description ?? '').trim(), path: file,
          valid: !!meta?.name && !!meta?.description, issue: meta?.name && meta?.description ? undefined : 'Missing name or description' })
      } catch { result.push({ name: dir.name, description: '', path: file, valid: false, issue: 'Invalid YAML frontmatter' }) }
    }
  }
  async skillPath(name: string): Promise<string> {
    validatePathComponent(name)
    const parked = path.join(this.parkedSkillRoot, name)
    const root = !await exists(path.join(this.skillRoot, name)) && await exists(parked) ? this.parkedSkillRoot : this.skillRoot
    const file = path.join(root, name, 'SKILL.md')
    const realRoot = await fs.realpath(root)
    const realParent = await fs.realpath(path.dirname(file))
    if (!realParent.startsWith(realRoot + path.sep)) throw new Error('Skill is outside the managed library')
    return file
  }
  /**
   * Moves skill folders so the shared folder holds exactly the enabled skills.
   * Linked folders and names present in both places are left alone and reported.
   */
  async placeSkills(disabled: readonly string[]): Promise<string[]> {
    const warnings: string[] = [], off = new Set(disabled)
    const move = async (name: string, from: string, to: string): Promise<void> => {
      const source = path.join(from, name), target = path.join(to, name)
      const stat = await fs.lstat(source).catch(() => null)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return
      if (await exists(target)) { warnings.push(`Skill ${name} exists in both ${path.basename(from)} and ${path.basename(to)}; remove one copy`); return }
      await fs.mkdir(to, { recursive: true })
      try { await fs.rename(source, target) } catch (error) { warnings.push(`Skill ${name} could not be moved: ${(error as Error).message}`) }
    }
    const names = async (root: string): Promise<string[]> => (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name)
    for (const name of await names(this.skillRoot)) if (off.has(name)) await move(name, this.skillRoot, this.parkedSkillRoot)
    for (const name of await names(this.parkedSkillRoot)) if (!off.has(name)) await move(name, this.parkedSkillRoot, this.skillRoot)
    return warnings
  }
}

const exists = (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false)
