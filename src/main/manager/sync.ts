import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseJson, modify, applyEdits } from 'jsonc-parser'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { COMPACT_SUFFIX, LAZY_TOOL_AGENTS, type AgentId, type AgentInfo, type AgentProfile, type AntigravityStatus, type SyncPreview, type SyncResult } from '../../shared/manager'
import { ManagerStore, atomicWrite, hash, readText, validatePathComponent } from './storage'
import { renderCodexToml, renderGeminiServers } from './vendor/renderers'
import { McpPreparation } from './mcp-preparation'
import { AntigravityClient } from './antigravity-client'

const definitions: Array<[AgentId, string, string, AgentInfo['skillControl']]> = [
  ['claude', 'Claude Code', '.claude.json', 'native'], ['claude-desktop', 'Claude Desktop', 'AppData/Roaming/Claude/claude_desktop_config.json', 'none'],
  ['codex', 'Codex', '.codex/config.toml', 'native'], ['gemini', 'Gemini CLI', '.gemini/settings.json', 'native'],
  ['antigravity', 'Antigravity', '.gemini/config/mcp_config.json', 'native'], ['cursor', 'Cursor', '.cursor/mcp.json', 'shared'],
  ['cline', 'Cline', '.cline/data/settings/cline_mcp_settings.json', 'shared'], ['opencode', 'OpenCode', '.config/opencode/opencode.json', 'native'],
  ['zcode', 'ZCode', '.zcode/cli/config.json', 'shared'], ['copilot', 'Copilot CLI', '.copilot/mcp-config.json', 'shared']
]
const instructions: Partial<Record<AgentId, string>> = { claude: '.claude/CLAUDE.md', codex: '.codex/AGENTS.md', gemini: '.gemini/GEMINI.md', antigravity: '.gemini/GEMINI.md', opencode: '.config/opencode/AGENTS.md', zcode: '.zcode/AGENTS.md' }
type FileChange = { file: string; before: string | null; after: string | null; target: string; encoding?: 'base64'; unmanagedConflict?: boolean; beforeMode?: number; afterMode?: number }
type Ledger = { hashes: Record<string, string>; names: string[]; baselines?: Record<string, string> }
const stable = (v: any): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)
async function contents(file: FileChange): Promise<string | null> { if (!file.encoding) return readText(file.file); try { return (await fs.readFile(file.file)).toString('base64') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e } }
async function writeChange(file: FileChange, value: string | null, mode?: number): Promise<void> { if (value === null) await fs.rm(file.file, { force: true }); else { await atomicWrite(file.file, file.encoding ? Buffer.from(value, 'base64') : value); if (mode !== undefined) await fs.chmod(file.file, mode) } }
export class SyncEngine {
  private previews = new Map<string, { dto: SyncPreview; files: FileChange[] }>()
  readonly antigravity: AntigravityClient
  constructor(private store: ManagerStore, private home: string) { this.antigravity = new AntigravityClient(home) }
  private async complete(result: SyncResult): Promise<SyncResult> {
    const client = await this.antigravityStatus(!result.warnings.some(w => w.startsWith('Antigravity: cannot parse') || w.startsWith('Antigravity: invalid MCP server map')))
    if (client && client.state !== 'Loaded') result.warnings.push(`Antigravity: ${client.detail}`)
    return result
  }
  async antigravityStatus(refresh = false): Promise<AntigravityStatus | undefined> {
    const live = await this.antigravity.inspect(refresh)
    if (!live) return undefined
    const raw = await this.store.mcpRaw(), names = Object.keys(raw)
    const profile = this.store.config.profiles.find(p => p.id === this.store.config.activeProfiles.antigravity)
    const off = new Set(this.store.config.disabledMcp ?? [])
    const selected = names.filter(name => !off.has(name) && (!profile || profile.mcpNames.includes(name)))
    const configured = parseJson(await readText(path.join(this.home, '.gemini/config/mcp_config.json')) ?? '{}')?.mcpServers ?? {}
    const device = await new McpPreparation(this.store, this.home).statuses()
    const reported = new Map(live.servers.map(server => [server.name, server]))
    const servers = selected.map(name => {
      if (device[name]?.state === 'Needs setup') return { name, state: 'Needs setup', tools: 0, detail: device[name].detail }
      if (!configured[name]) return { name, state: 'Not synced', tools: 0, detail: 'Missing from Antigravity configuration. Check Sync warnings and selected profile.' }
      if (configured[name].disabled) return { name, state: 'Disabled', tools: 0, detail: 'Disabled in Antigravity. Sync agents to enable selected shared servers.' }
      return reported.get(name) ?? { name, state: 'Not loaded', tools: 0, detail: 'Configured but not reported by the client. Reload Antigravity, or start a fresh chat.' }
    })
    const excluded = names.filter(name => !selected.includes(name)).map(name => off.has(name) ? { name, state: 'Disabled', tools: 0, detail: 'Disabled for every agent in AI Usage → Shared library.' } : { name, state: 'Not selected', tools: 0, detail: 'Excluded by the active Antigravity profile. Use the standard shared profile to include it.' })
    return { ...live, expected: selected.length, libraryCount: names.length, servers: [...servers, ...excluded, ...live.servers.filter(server => !names.includes(server.name))] }
  }
  async agents(): Promise<AgentInfo[]> {
    const supported = definitions
    return Promise.all(supported.map(async ([id, name, relative, skillControl]) => {
      const configPath = path.join(this.home, process.platform === 'darwin' && id === 'claude-desktop' ? 'Library/Application Support/Claude/claude_desktop_config.json' : relative)
      const nativeApp = id === 'antigravity' && (await Promise.all((process.platform === 'darwin' ? [...['Antigravity.app', 'Antigravity IDE.app'].flatMap(name => [path.join('/Applications', name), path.join(this.home, 'Applications', name)]), path.join(this.home, '.gemini/antigravity'), path.join(this.home, '.gemini/antigravity-cli')] : [path.join(this.home, 'AppData/Local/Programs/Antigravity'), path.join(this.home, '.gemini/antigravity')]).map(file => fs.access(file).then(() => true, () => false)))).some(Boolean)
      const installed = !!await readText(configPath) || nativeApp || await fs.access(path.dirname(configPath)).then(() => true, () => false)
      return { id, name, configPath, installed, skillControl, restartRequired: true, endpointSupport: ['claude', 'codex', 'opencode', 'claude-desktop'].includes(id),
        note: id === 'antigravity' ? 'Shared skills are copied to the native global skills folder. Restart after sync.' : skillControl === 'shared' ? 'Reads the shared skill library. Individual exclusions are not guaranteed by this client.' : skillControl === 'none' ? 'Skills are managed by the client separately.' : undefined }
    }))
  }
  private ledgerPath(): string { return path.join(this.store.data, 'sync-ledger.json') }
  private async baseline(file: string, ledger: Ledger): Promise<string | undefined> {
    if (ledger.baselines?.[file] !== undefined) return ledger.baselines[file]
    // Older ledgers recorded only hashes. Recover their exact managed bytes from
    // local backups; do not silently adopt a file without a matching baseline.
    for (const name of await fs.readdir(path.join(this.store.data, 'backups')).catch(() => [])) {
      try { const entries = JSON.parse(await readText(path.join(this.store.data, 'backups', name)) ?? '[]'); const found = entries.find((v: any) => v.file === file && hash(v.after) === ledger.hashes[file]); if (found) return found.after } catch { /* unrelated backup */ }
    }
    return undefined
  }
  private async owned(text: string, file: string, managed: Set<string>): Promise<string> {
    if (!/\.(json|toml)$/.test(file)) return text
    const doc: any = file.endsWith('.toml') ? parseToml(text) : parseJson(text)
    const skills = new Set((await this.store.skills()).map(s => s.name))
    const select = (v: any, keys: Set<string>): any => Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => keys.has(k)))
    let mcp = select(doc.mcp_servers ?? doc.mcp?.servers ?? doc.mcp ?? doc.mcpServers, managed)
    if (file === path.join(this.home, '.gemini/config/mcp_config.json')) mcp = Object.fromEntries(Object.entries(mcp).map(([name, value]) => {
      // Antigravity drops empty argument lists and owns its UI enable/disable toggle.
      // Preserve that toggle without treating its normalization as a launch edit.
      const { disabled: _disabled, ...launch } = value as Record<string, any>
      if (launch.command) launch.args ??= []
      return [name, launch]
    }))
    const root = path.join(this.store.pool, 'skills') + path.sep
    return stable({ mcp,
      skillOverrides: select(doc.skillOverrides, skills), disabled: (doc.skills?.disabled ?? []).filter((n: string) => skills.has(n)).sort(),
      skillConfig: (doc.skills?.config ?? []).filter((v: any) => String(v.path ?? '').startsWith(root)), permission: select(doc.permission?.skill, skills) })
  }
  private async materializeSkills(disabled: string[], ledger: Ledger, files: FileChange[], warnings: string[], relative = '.gemini/config/skills', client = 'Antigravity'): Promise<void> {
    // A skill may still sit in the disabled folder until apply moves it: map each from its own root.
    let sourceRoot = this.store.skillRoot
    const targetRoot = path.join(this.home, relative), wanted = new Set<string>()
    if ((await fs.lstat(targetRoot).catch(() => null))?.isSymbolicLink()) { warnings.push(`${client}: global skill directory is linked; kept its existing link unchanged`); return }
    let total = 0
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name) || entry.isSymbolicLink()) continue
        validatePathComponent(entry.name)
        const source = path.join(directory, entry.name), target = path.join(targetRoot, path.relative(sourceRoot, source))
        let parent = target, linked = false
        while (parent !== targetRoot) { if ((await fs.lstat(parent).catch(() => null))?.isSymbolicLink()) { linked = true; break }; parent = path.dirname(parent) }
        if (linked) { warnings.push(`${client}: preserved linked skill path ${target}`); continue }
        if (entry.isDirectory()) await walk(source)
        else if (entry.isFile()) {
          const bytes = await fs.readFile(source); total += bytes.length
          if (bytes.length > 8 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error(`${client} skill sync exceeds 64 MiB or 8 MiB per file`)
          const change: FileChange = { file: target, before: null, after: bytes.toString('base64'), encoding: 'base64', target: `${client} skills` }
          change.before = await contents(change); wanted.add(target)
          if (process.platform === 'darwin' && /\.(sh|command)$/.test(entry.name)) {
            const targetStat = await fs.stat(target).catch(() => null)
            change.beforeMode = targetStat ? targetStat.mode & 0o777 : undefined
            if (change.before === null) change.beforeMode = undefined
            change.afterMode = (change.beforeMode ?? 0o600) | 0o100
          }
          if (change.before !== change.after || (change.afterMode !== undefined && change.beforeMode !== change.afterMode)) { change.unmanagedConflict = change.before !== null && change.before !== change.after && !ledger.hashes[target]; files.push(change) }
          else if (!ledger.hashes[target]) { /* Equal native files stay unmanaged until a reviewed edit. */ }
        }
      }
    }
    for (const skill of (await this.store.skills()).filter(s => s.valid && !disabled.includes(s.name))) { sourceRoot = path.dirname(path.dirname(skill.path)); await walk(path.dirname(skill.path)) }
    for (const file of Object.keys(ledger.hashes).filter(file => file.startsWith(targetRoot + path.sep) && !wanted.has(file))) {
      const change: FileChange = { file, before: null, after: null, encoding: 'base64', target: `${client} skills` }; change.before = await contents(change)
      if (change.before !== null) files.push(change)
    }
  }
  private async antigravityInstructions(profile: AgentProfile | undefined, files: FileChange[], warnings: string[]): Promise<void> {
    const primary = path.join(this.home, '.gemini/config/GEMINI.md'), legacy = path.join(this.home, '.gemini/GEMINI.md')
    const target = await readText(primary) !== null ? primary : legacy
    const marker = /\n?<!-- AI Usage shared instructions -->[\s\S]*?<!-- \/AI Usage shared instructions -->\n?/g
    const other = target === primary ? legacy : primary
    const targets = profile && !profile.instructions ? [primary, legacy] : [target, ...((await readText(other))?.includes('<!-- AI Usage shared instructions -->') ? [other] : [])]
    for (const file of targets) {
      if (files.some(change => change.file === file)) continue;
      const current = await readText(file) ?? ''
      let after: string
      if (profile && !profile.instructions) after = current.replace(marker, '')
      else {
        const source = path.join(this.store.pool, 'AGENTS.md'), text = await readText(source)
        if (text === null) { warnings.push('Antigravity: no shared AGENTS.md exists yet; existing instructions were kept'); return }
        if (await fs.realpath(file).catch(() => file) === await fs.realpath(source).catch(() => source)) return
        const block = `<!-- AI Usage shared instructions -->\n${text.trimEnd()}\n<!-- /AI Usage shared instructions -->`
        after = current.includes('<!-- AI Usage shared instructions -->') ? current.replace(marker, '\n' + block + '\n') : current.trimEnd() + (current.trim() ? '\n\n' : '') + block + '\n'
      }
      if (after !== current) files.push({ file, before: await readText(file), after, target: 'Antigravity instructions' })
    }
  }
  async preview(): Promise<SyncPreview> {
    const raw = await this.store.mcpRaw(), names = Object.keys(raw), master: Record<string, any> = {}, setupWarnings: string[] = []
    const preparation = new McpPreparation(this.store, this.home)
    const disabledMcp = new Set(this.store.config.disabledMcp ?? []), compactMcp = new Set(this.store.config.compactMcp ?? [])
    for (const [name, spec] of Object.entries(raw)) {
      if (disabledMcp.has(name)) continue
      try { const resolved = await preparation.resolve(name, spec); if (resolved) master[name] = resolved; else setupWarnings.push(`${name}: needs local setup; omitted from client launch configuration until prepared`) }
      catch { setupWarnings.push(`${name}: invalid local launch or installation metadata; omitted until reviewed`) }
    }
    const runtime = JSON.parse(await readText(path.join(this.store.pool, 'manager-runtime.json')) ?? '{}')
    for (const name of Object.keys(master)) if (master[name].command || this.store.config.mcpAuth?.[name]?.enabled) {
      if (!runtime.node || !runtime.cli) throw new Error('Open the updated AI Usage app before syncing app-authenticated MCP servers')
      const workspace = master[name].args?.includes('--workspace')
      master[name] = runtime.relay ? { command: runtime.relay, args: workspace ? ['--workspace'] : ['--relay', name] } : { command: runtime.node, args: workspace ? [runtime.cli, '--workspace'] : [runtime.cli, '--relay', name] }
    }
    const ledger: Ledger = JSON.parse(await readText(this.ledgerPath()) ?? '{"hashes":{},"names":[]}')
    const managed = new Set([...ledger.names, ...names])
    const files: FileChange[] = [], warnings: string[] = [...setupWarnings]
    const agents = await this.agents()
    const add = async (file: string, after: string, target: string): Promise<void> => {
      if (files.some(f => f.file === file)) return
      const before = await readText(file)
      if (before !== after) files.push({ file, before, after, target })
    }
    for (const agent of agents.filter(a => a.installed)) {
      const profile = this.store.config.profiles.find(p => p.id === this.store.config.activeProfiles[agent.id])
      // Globally disabled skills are off for every agent, on top of the profile's own exclusions.
      const skillsOff = [...new Set([...(this.store.config.disabledSkills ?? []), ...(profile?.disabledSkills ?? [])])]
      // Global disables are enforced by moving the folder; only profile exclusions need client support.
      const profileOff = (profile?.disabledSkills ?? []).filter(name => !(this.store.config.disabledSkills ?? []).includes(name))
      // Skills and rules remain usable even when the client's MCP JSON needs repair.
      // Claude Code reads ~/.claude/skills, not the shared folder: give it its own copy.
      if (agent.id === 'claude') await this.materializeSkills(skillsOff, ledger, files, warnings, '.claude/skills', 'Claude Code')
      if (agent.id === 'antigravity') {
        await this.materializeSkills(skillsOff, ledger, files, warnings)
        if (process.platform === 'darwin' && await fs.access(path.join(this.home, '.gemini/antigravity-cli')).then(() => true, () => false)) await this.materializeSkills(skillsOff, ledger, files, warnings, '.gemini/antigravity-cli/skills')
        await this.antigravityInstructions(profile, files, warnings)
      }
      const selected = profile ? new Set(profile.mcpNames) : new Set(names)
      // Compact relays replace a large tool list with search + call for clients that load every schema eagerly.
      const compactFor = (name: string, s: any): any => compactMcp.has(name) && !LAZY_TOOL_AGENTS.includes(agent.id) && Array.isArray(s.args) && s.args.includes('--relay') ? { ...s, args: s.args.map((a: string) => a === name ? name + COMPACT_SUFFIX : a) } : s
      const entries = Object.entries(master).filter(([n, s]) => selected.has(n) && (agent.id !== 'claude-desktop' || s.command)).map(([n, s]) => [n, compactFor(n, s)] as [string, any])
      const text = (await readText(agent.configPath))?.replace(/^\uFEFF/, '') ?? null
      const errors: import('jsonc-parser').ParseError[] = []
      let doc: any
      try { doc = agent.id === 'codex' ? parseToml(text ?? '') : parseJson(text ?? '{}', errors, { allowTrailingComma: true }) }
      catch { errors.push({ error: 1, offset: 0, length: 0 }) }
      if (errors.length || !doc || typeof doc !== 'object' || Array.isArray(doc)) { warnings.push(`${agent.name}: cannot parse ${agent.configPath}; kept this client's files unchanged`); continue }
      const section = agent.id === 'codex' ? 'mcp_servers' : agent.id === 'opencode' ? 'mcp' : 'mcpServers'
      const old = agent.id === 'zcode' ? doc.mcp?.servers ?? {} : doc[section] ?? {}
      if (!old || typeof old !== 'object' || Array.isArray(old)) { warnings.push(`${agent.name}: invalid MCP server map in ${agent.configPath}; kept it unchanged`); continue }
      const servers: Record<string, any> = Object.fromEntries(Object.entries(old).filter(([n]) => !managed.has(n) || (agent.id === 'codex' && n === 'node_repl')))
      for (const [name, s] of entries) {
        const local = !!s.command
        const base: any = local ? { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) } : { url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
        if (agent.id === 'codex') servers[name] = local ? { ...base, startup_timeout_sec: 120, tool_timeout_sec: 120 } : { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) }
        else if (agent.id === 'opencode') servers[name] = local ? { type: 'local', command: [s.command, ...(s.args ?? [])], ...(s.env ? { environment: s.env } : {}) } : { type: 'remote', ...base }
        else if (agent.id === 'antigravity') {
          // The selected managed profile is authoritative. A previous failed
          // setup must not leave its now-selected servers disabled forever.
          servers[name] = { ...(local ? base : { serverUrl: s.url, ...(s.headers ? { headers: s.headers } : {}) }), disabled: false }
          if (local && !servers[name].args.length) delete servers[name].args
        }
        else if (agent.id === 'cline') servers[name] = { ...base, ...(local ? {} : { type: 'streamableHttp' }), disabled: false, autoApprove: old[name]?.autoApprove ?? [] }
        else if (agent.id === 'copilot') servers[name] = { type: local ? 'local' : 'http', ...base, tools: old[name]?.tools ?? ['*'] }
        else servers[name] = { ...base, ...(agent.id === 'claude' && !local ? { type: 'http' } : {}) }
      }
      // ZCode's empty-list fallback reads the raw master. Explicit disabled entries
      // prevent it from trying foreign commands or excluded servers on this device.
      if (agent.id === 'zcode') for (const name of names.filter(n => !entries.some(([ready]) => ready === n))) servers[name] = { command: process.execPath, args: ['--version'], enabled: false, disabled: true }
      const resolved = entries.map(([name, s]) => ({ ...s, name, transport: s.command ? 'stdio' as const : 'http' as const, connectTimeout: 120_000, timeout: 120_000 }))
      if (agent.id === 'gemini') Object.assign(servers, renderGeminiServers(resolved).mcpServers)
      if (agent.id === 'codex') Object.assign(servers, (parseToml(renderCodexToml(resolved).content) as any).mcp_servers ?? {})
      if (agent.id === 'claude') {
        const settingsFile = path.join(this.home, '.claude/settings.json'), settingsText = await readText(settingsFile) ?? '{}', settings = parseJson(settingsText)
        const overrides = { ...(settings.skillOverrides ?? {}) }
        for (const skill of await this.store.skills()) { if (skillsOff.includes(skill.name)) overrides[skill.name] = 'off'; else if (overrides[skill.name] === 'off') delete overrides[skill.name] }
        await add(settingsFile, applyEdits(settingsText, modify(settingsText, ['skillOverrides'], overrides, { formattingOptions: { insertSpaces: true, tabSize: 2 } })).trimEnd() + '\n', 'Claude Code skills')
      }
      let after: string
      if (agent.id === 'codex') {
        doc[section] = servers
        if (profile || skillsOff.length || doc.skills?.config) {
          const root = path.join(this.store.pool, 'skills') + path.sep
          doc.skills ??= {}
          doc.skills.config = [...(doc.skills.config ?? []).filter((s: any) => !String(s.path ?? '').startsWith(root)), ...profileOff.map(name => ({ path: path.join(root, name, 'SKILL.md'), enabled: false }))]
        }
        after = stringifyToml(doc) + '\n'
      } else {
        after = applyEdits(text ?? '{}', modify(text ?? '{}', agent.id === 'zcode' ? ['mcp', 'servers'] : [section], servers, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
        if (agent.id === 'gemini' && (profile || skillsOff.length || doc.skills?.disabled)) { const shared = new Set((await this.store.skills()).map(s => s.name)); after = applyEdits(after, modify(after, ['skills', 'disabled'], [...(doc.skills?.disabled ?? []).filter((name: string) => !shared.has(name)), ...skillsOff], { formattingOptions: { insertSpaces: true, tabSize: 2 } })) }
        if (agent.id === 'opencode' && (profile || skillsOff.length || doc.permission?.skill)) {
          const permission = { ...(doc.permission?.skill ?? {}) }
          for (const skill of await this.store.skills()) { if (skillsOff.includes(skill.name)) permission[skill.name] = 'deny'; else if (permission[skill.name] === 'deny') delete permission[skill.name] }
          after = applyEdits(after, modify(after, ['permission', 'skill'], permission, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
        }
        after = after.trimEnd() + '\n'
      }
      await add(agent.configPath, after, agent.name)
      if (agent.id === 'zcode' && profile && !Object.keys(servers).length && names.length) throw new Error('ZCode falls back to the master when its MCP list is empty; an empty MCP profile cannot be enforced')
      if (profileOff.length && agent.skillControl !== 'native') warnings.push(`${agent.name}: this profile's skill exclusions are not enforced; this client reads the whole shared skill folder`)
      if (agent.id === 'claude-desktop' && entries.length < selected.size) warnings.push('Claude Desktop: remote MCP servers require client-managed connectors; only stdio entries are generated')
      const relative = agent.id === 'antigravity' ? undefined : instructions[agent.id]
      if (relative && (!profile || profile.instructions)) {
        const source = path.join(this.store.pool, 'AGENTS.md'), target = path.join(this.home, relative)
        const realTarget = await fs.realpath(target).catch(() => target), realSource = await fs.realpath(source).catch(() => source)
        const sourceText = await readText(source)
        if (sourceText === null) { warnings.push(`${agent.name}: no shared AGENTS.md exists yet; existing instructions were kept`) }
        else if (realTarget !== realSource) {
          await add(target, sourceText, `${agent.name} instructions`)
        }
      }
    }
    const changes = await Promise.all(files.map(async f => {
      let conflict = !!f.unmanagedConflict || (!!ledger.hashes[f.file] && ledger.hashes[f.file] !== hash(f.before ?? ''))
      if (conflict && !f.encoding && !f.unmanagedConflict) { const baseline = await this.baseline(f.file, ledger); if (baseline !== undefined) try { conflict = await this.owned(baseline, f.file, managed) !== await this.owned(f.before ?? '', f.file, managed) } catch { /* retain conflict */ } }
      return { target: f.target, path: f.file, beforeHash: hash(f.before ?? ''), afterHash: hash(f.after ?? ''), changed: true, conflict, summary: f.encoding ? 'Copy or remove managed skill assets; preserve native skills' : 'Update managed entries; preserve unrelated settings' }
    }))
    const dto: SyncPreview = { id: randomUUID(), createdAt: Date.now(), warnings, changes }
    this.previews.clear(); this.previews.set(dto.id, { dto, files }); return dto
  }
  async apply(id: string, replaceInstructions = false): Promise<SyncResult> {
    const preview = this.previews.get(id)
    if (!preview || Date.now() - preview.dto.createdAt > 600_000) throw new Error('Preview expired; preview again')
    const conflicts = preview.dto.changes.filter(c => c.conflict && !(replaceInstructions && c.target.endsWith(' instructions'))).map(c => c.path)
    for (const file of preview.files) if (await contents(file) !== file.before || (file.beforeMode !== undefined && ((await fs.stat(file.file)).mode & 0o777) !== file.beforeMode)) conflicts.push(file.file)
    if (conflicts.length) return { changed: 0, conflicts: [...new Set(conflicts)], warnings: ['Files changed outside the manager. Review and adopt their current state before retrying.'] }
    // Globally disabled skills leave the shared folder, so clients that scan it stop seeing them.
    preview.dto.warnings.push(...await this.store.placeSkills(this.store.config.disabledSkills ?? []))
    if (!preview.files.length) { this.previews.delete(id); return this.complete({ changed: 0, conflicts: [], warnings: preview.dto.warnings }) }
    const backupId = randomUUID(), backupPath = path.join(this.store.data, 'backups', backupId + '.json')
    await atomicWrite(backupPath, JSON.stringify(preview.files))
    const applied: FileChange[] = []
    try { for (const file of preview.files) { applied.push(file); await writeChange(file, file.after, file.afterMode) } }
    catch (error) { for (const file of applied.reverse()) await writeChange(file, file.before, file.beforeMode); throw error }
    const ledger: Ledger = JSON.parse(await readText(this.ledgerPath()) ?? '{"hashes":{},"names":[]}')
    ledger.baselines ??= {}
    for (const file of preview.files) { if (file.after === null) { delete ledger.hashes[file.file]; delete ledger.baselines[file.file] } else { ledger.hashes[file.file] = hash(file.after); ledger.baselines[file.file] = file.after } }
    ledger.names = Object.keys(await this.store.mcpRaw()); await atomicWrite(this.ledgerPath(), JSON.stringify(ledger))
    this.previews.delete(id)
    return this.complete({ changed: preview.files.length, conflicts: [], backupId, warnings: preview.dto.warnings })
  }
  async sync(replaceInstructions = false): Promise<SyncResult> {
    if (!replaceInstructions) return this.apply((await this.preview()).id)
    // A manual Import explicitly restores instructions. An unrelated MCP conflict
    // must not block that restore; preserve native instruction text and back it up.
    const instructions = await this.preview(), saved = this.previews.get(instructions.id)!
    saved.files = saved.files.filter(f => f.target.endsWith(' instructions'))
    saved.dto.changes = saved.dto.changes.filter(c => c.target.endsWith(' instructions'))
    const restored = await this.apply(instructions.id, true)
    if (restored.conflicts.length) return restored
    const remaining = await this.apply((await this.preview()).id)
    let backupId = remaining.backupId ?? restored.backupId
    if (remaining.backupId && restored.backupId) {
      const directory = path.join(this.store.data, 'backups')
      const first = JSON.parse((await readText(path.join(directory, restored.backupId + '.json')))!)
      const second = JSON.parse((await readText(path.join(directory, remaining.backupId + '.json')))!)
      backupId = randomUUID(); await atomicWrite(path.join(directory, backupId + '.json'), JSON.stringify([...first, ...second]))
    }
    return { ...remaining, changed: restored.changed + remaining.changed, backupId, warnings: [...new Set([...restored.warnings, ...remaining.warnings])] }
  }
  async adopt(id: string): Promise<SyncPreview> {
    const preview = this.previews.get(id)
    if (!preview || Date.now() - preview.dto.createdAt > 600_000) throw new Error('Preview expired; preview again')
    const ledger: Ledger = JSON.parse(await readText(this.ledgerPath()) ?? '{"hashes":{},"names":[]}')
    ledger.baselines ??= {}
    for (const change of preview.files.filter(f => preview.dto.changes.some(c => c.path === f.file && c.conflict))) { const text = await contents(change) ?? ''; ledger.hashes[change.file] = hash(text); ledger.baselines[change.file] = text }
    await atomicWrite(this.ledgerPath(), JSON.stringify(ledger)); return this.preview()
  }
  async restore(id: string): Promise<SyncResult> {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid backup ID')
    const files: FileChange[] = JSON.parse(await readText(path.join(this.store.data, 'backups', id + '.json')) ?? 'null')
    if (!files) throw new Error('Backup not found')
    const conflicts: string[] = []
    for (const file of files) if (await contents(file) !== file.after || (file.afterMode !== undefined && ((await fs.stat(file.file)).mode & 0o777) !== file.afterMode)) conflicts.push(file.file)
    if (conflicts.length) return { changed: 0, conflicts, warnings: ['Restore refused because files have newer edits'] }
    const restored: FileChange[] = []
    try { for (const file of files) { restored.push(file); await writeChange(file, file.before, file.beforeMode) } }
    catch (error) { for (const file of restored.reverse()) await writeChange(file, file.after, file.afterMode); throw error }
    const ledger: Ledger = JSON.parse(await readText(this.ledgerPath()) ?? '{"hashes":{},"names":[]}')
    for (const file of files) { delete ledger.hashes[file.file]; if (ledger.baselines) delete ledger.baselines[file.file] }
    await atomicWrite(this.ledgerPath(), JSON.stringify(ledger))
    return this.complete({ changed: files.length, conflicts: [], warnings: [] })
  }
}
