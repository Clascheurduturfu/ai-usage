import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as yaml } from 'yaml'
import type { InstallPreview } from '../../shared/manager'
import { atomicWrite, ManagerStore, readText, validateName } from './storage'

const exec = promisify(execFile)
type Ticket = { preview: InstallPreview; files: Record<string, string>; packageName?: string; bin?: string; created: number }
export class LibraryInstaller {
  private tickets = new Map<string, Ticket>()
  constructor(private store: ManagerStore) {}
  async preview(kind: 'skill' | 'mcp', source: string, selected?: string): Promise<InstallPreview> {
    const url = new URL(source)
    if (kind === 'mcp' && url.hostname !== 'github.com') {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) MCP URL')
      const preview: InstallPreview = { id: randomUUID(), kind, source, name: url.hostname.replace(/[^a-z0-9._-]/gi, '-'), description: 'Remote MCP server. Sign in through the app after installation if required.', files: [] }
      this.tickets.set(preview.id, { preview, files: {}, created: Date.now() }); return preview
    }
    if (url.hostname !== 'github.com') throw new Error('Use a GitHub repository, tree or SKILL.md link')
    const [owner, repo, mode, refPart, ...tail] = url.pathname.split('/').filter(Boolean)
    if (!owner || !repo) throw new Error('A repository URL is required')
    const get = async (route: string): Promise<any> => {
      const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${route}`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
      return response.json()
    }
    const ref = mode === 'blob' || mode === 'tree' ? refPart : (await get('')).default_branch
    const tree = await get(`git/trees/${encodeURIComponent(ref)}?recursive=1`)
    if (tree.truncated) throw new Error('Repository is too large; use a specific skill repository')
    const blobs = tree.tree.filter((v: any) => v.type === 'blob' && v.mode !== '120000')
    const download = async (file: string): Promise<string> => {
      const value = await get(`contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`)
      if (value.encoding !== 'base64' || value.size > 8 * 1024 * 1024) throw new Error(`Unsupported or oversized file: ${file}`)
      return Buffer.from(value.content, 'base64').toString('base64')
    }
    let files: Record<string, string> = {}, name: string, description: string, packageName: string | undefined, bin: string | undefined, args: string[] | undefined
    const choices = blobs.filter((v: any) => /(^|\/)SKILL\.md$/.test(v.path) && !v.path.includes('node_modules/')).map((v: any) => v.path)
    if (kind === 'skill') {
      const linked = tail.join('/'), chosen = selected ?? (mode === 'blob' ? linked : mode === 'tree' ? `${linked}/SKILL.md` : choices.length === 1 ? choices[0] : undefined)
      if (!chosen) return { id: '', kind, source, name: '', description: 'Choose a skill from this repository', files: [], choices }
      if (!choices.includes(chosen)) throw new Error('The selected path does not contain SKILL.md')
      const root = path.posix.dirname(chosen), prefix = root === '.' ? '' : root + '/'
      const entries = blobs.filter((v: any) => v.path.startsWith(prefix) && !v.path.slice(prefix.length).split('/').some((part: string) => part.startsWith('.') || ['node_modules', '__pycache__'].includes(part)))
      if (entries.length > 250 || entries.reduce((n: number, v: any) => n + (v.size ?? 0), 0) > 64 * 1024 * 1024) throw new Error('Skill exceeds 250 files or 64 MiB')
      for (const entry of entries) files[entry.path.slice(prefix.length)] = await download(entry.path)
      const text = Buffer.from(files['SKILL.md'], 'base64').toString('utf8'), match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/), meta = match ? yaml(match[1]) : null
      if (!meta?.name || !meta?.description) throw new Error('SKILL.md needs YAML name and description')
      name = meta.name; description = String(meta.description)
    } else {
      const manifest = JSON.parse(Buffer.from(await download('package.json'), 'base64').toString('utf8'))
      packageName = manifest.name
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(packageName!) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('Repository needs a published npm package and version')
      name = repo.replace(/\.git$/, ''); description = manifest.description ?? packageName
      bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0] as string
      if (!bin || bin.includes('..') || path.isAbsolute(bin)) throw new Error('Package has no usable MCP executable')
      packageName += '@' + manifest.version; args = name === 'rea' ? ['mcp'] : []
    }
    validateName(name)
    const preview: InstallPreview = { id: randomUUID(), kind, source, name, description, files: Object.keys(files), ...(packageName ? { command: 'npm install ' + packageName, args } : {}) }
    this.tickets.set(preview.id, { preview, files, packageName, bin, created: Date.now() }); return preview
  }
  async install(id: string): Promise<{ name: string }> {
    const ticket = this.tickets.get(id)
    if (!ticket || Date.now() - ticket.created > 15 * 60_000) throw new Error('Installation preview expired')
    const { preview } = ticket
    if (preview.kind === 'skill') {
      const root = path.join(this.store.skillRoot, preview.name)
      if (await readText(path.join(root, 'SKILL.md')) !== null || await readText(path.join(this.store.parkedSkillRoot, preview.name, 'SKILL.md')) !== null) throw new Error('This skill already exists; remove or rename it before installing')
      await fs.mkdir(root, { recursive: true })
      const realParent = await fs.realpath(path.dirname(root)), realRoot = await fs.realpath(root)
      if (path.dirname(realRoot) !== realParent) throw new Error('Cannot install into a linked directory')
      for (const [relative, value] of Object.entries(ticket.files)) {
        if (relative.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Unsafe skill path')
        const target = path.join(root, ...relative.split('/'))
        if (!target.startsWith(root + path.sep)) throw new Error('Unsafe skill path')
        const parent = path.dirname(target); await fs.mkdir(parent, { recursive: true })
        if (!(await fs.realpath(parent)).startsWith(realRoot)) throw new Error('Linked skill asset directory')
        const stat = await fs.lstat(target).catch(() => null); if (stat?.isSymbolicLink()) throw new Error('Linked skill asset')
        await atomicWrite(target, Buffer.from(value, 'base64'))
      }
    } else {
      const master = await this.store.mcpRaw(); if (master[preview.name]) throw new Error('This MCP name already exists')
      if (ticket.packageName) {
        const root = path.join(this.store.pool, 'mcp', preview.name)
        const npm = path.join(path.dirname(process.argv[1]), 'npm/bin/npm-cli.js')
        const environment = { ...process.env }
        if (process.platform === 'darwin') {
          const bin = path.join(this.store.data, 'runtime-bin'); await fs.mkdir(bin, { recursive: true })
          const node = path.join(bin, 'node'), existing = await fs.lstat(node).catch(() => null)
          if (existing && !existing.isSymbolicLink()) throw new Error('Unexpected file in the private Node runtime folder')
          if (existing) await fs.unlink(node)
          await fs.symlink(process.execPath, node)
          environment.PATH = bin + path.delimiter + (environment.PATH ?? '')
        } else {
          const bin = path.join(this.store.data, 'runtime-bin'); await fs.mkdir(bin, { recursive: true })
          const node = path.join(bin, 'node.exe'); if (!await fs.access(node).then(() => true, () => false)) await fs.copyFile(process.execPath, node)
          environment.PATH = bin + path.delimiter + (environment.PATH ?? '')
        }
        await exec(process.execPath, [npm, 'install', '--prefix', root, '--no-audit', '--no-fund', ticket.packageName], { env: environment, windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
        const packageId = ticket.packageName.slice(0, ticket.packageName.lastIndexOf('@'))
        master[preview.name] = { command: process.execPath, args: [path.join(root, 'node_modules', packageId, ticket.bin!), ...(preview.args ?? [])], aiUsage: { source: { kind: 'npm', package: packageId, version: ticket.packageName.slice(ticket.packageName.lastIndexOf('@') + 1), args: preview.args ?? [] } } }
        await fs.appendFile(path.join(this.store.pool, 'INSTALLED_TOOLS.md'), `\n- ${ticket.packageName}: installed by AI Usage in ${root}; MCP executable ${ticket.bin}.\n`)
      } else master[preview.name] = { type: 'http', url: preview.source }
      for (const profile of this.store.config.profiles) if (!profile.mcpNames.includes(preview.name)) profile.mcpNames.push(preview.name)
      await this.store.save(); await atomicWrite(path.join(this.store.pool, 'mcp.json'), JSON.stringify({ mcpServers: master }, null, 2) + '\n')
    }
    this.tickets.delete(id); return { name: preview.name }
  }
}
