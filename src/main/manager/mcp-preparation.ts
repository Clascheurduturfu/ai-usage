import { APP_VERSION } from '../../shared/version'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { NativeSupervisor, LaunchSpec } from './native-supervisor'
import { ManagerStore, atomicWrite, hash, readText, validateName } from './storage'
import type { McpDeviceStatus, McpSetupPreview, McpSource } from '../../shared/manager'

const exec = promisify(execFile)
const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)
const recipes: Record<string, McpSource> = {
  'google-workspace-gws': { kind: 'workspace-gws', version: '0.22.5' },
  blender: { kind: 'blender', version: '1.0.3', revision: '2cea8d566dde07fbac28a61d698909d69724e853' },
  'google-workspace': { kind: 'workspace-gws', version: '0.22.5' },
  playwright: { kind: 'npm', package: '@playwright/mcp', version: '0.0.83', args: ['--isolated'] },
  'playwright-cdp': { kind: 'npm', package: '@playwright/mcp', version: '0.0.83', args: ['--cdp-endpoint', 'http://127.0.0.1:9222'] },
  'computer-use': { kind: 'npm', package: 'computer-use-mcp', version: '1.8.0', args: [] },
  rea: { kind: 'npm', package: 'rea-agents', version: '6.4.0', args: ['mcp'] },
  'aws-mcp': { kind: 'aws', version: '1.7.0', args: ['https://aws-mcp.us-east-1.api.aws/mcp', '--metadata', 'INSTALL_SOURCE=aws-cli'] }
}

/** Recognize legacy definitions by their payload, not just a user supplied name. */
export function mcpSource(name: string, spec: any): McpSource | undefined {
  if (spec.aiUsage?.source) {
    const source = spec.aiUsage.source as McpSource
    if (source.kind === 'workspace' && source.version === '0.0.8') return structuredClone(recipes['google-workspace'])
    if (source.kind === 'npm' && /^(@[\w.-]+\/)?[\w.-]+$/.test(source.package ?? '') && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(source.version) && (!source.args || (Array.isArray(source.args) && source.args.every(a => typeof a === 'string')))) return source
    const known = Object.values(recipes).find(r => r.kind === source.kind && r.version === source.version && r.revision === source.revision)
    if (known) return { ...known, ...(source.kind === 'aws' && source.args?.every(a => typeof a === 'string') ? { args: source.args } : {}) }
    throw new Error(`${name}: unsupported installation source; review its definition`)
  }
  const launch = [spec.command, ...(spec.args ?? [])].join(' ').replaceAll('\\', '/')
  const recipe = recipes[name]
  if (!recipe) return undefined
  if ((name === 'blender' && /blender[-/]mcp|mcp\/blender/.test(launch)) ||
      (name === 'google-workspace' && /google-workspace.*dist\/index\.js/.test(launch)) ||
      (/^playwright/.test(name) && launch.includes('@playwright/mcp')) ||
      (name === 'computer-use' && launch.includes('computer-use-mcp')) ||
      (name === 'rea' && launch.includes('rea-agents')) ||
      (name === 'aws-mcp' && launch.includes('mcp-proxy-for-aws'))) {
    const source = structuredClone(recipe)
    if (name === 'playwright-cdp') { const i = spec.args?.indexOf('--cdp-endpoint'); if (i >= 0 && spec.args[i + 1]) source.args = ['--cdp-endpoint', spec.args[i + 1]] }
    if (name === 'aws-mcp') { const i = spec.args?.findIndex((a: string) => a.startsWith('https://')); if (i >= 0) source.args = spec.args.slice(i) }
    return source
  }
}

/** Shared recipes contain no resolved executable, platform payload or machine profile. */
export function portableMcp(master: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(master).map(([name, spec]) => {
    const source = mcpSource(name, spec)
    if (!source) return [name, spec]
    const env = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([key, value]) => key !== 'AWS_PROFILE' && key !== 'AWS_MCP_PROXY_PROFILES' && key !== 'BLENDER_PATH' && !/^(?:[A-Z]:[/\\]|\/Users\/|\/home\/)/i.test(String(value))))
    return [name, { command: '@device', args: [], ...(Object.keys(env).length ? { env } : {}), aiUsage: { source } }]
  }))
}

type Receipt = { fingerprint: string; command: string; args: string[]; env?: Record<string, string>; preparedAt: number; note?: string }
type Ticket = McpSetupPreview & { masterHash: string }

export class McpPreparation {
  private probes: Record<string, McpDeviceStatus> = {}
  private root: string
  constructor(private store: ManagerStore, private home = os.homedir(), private supervisor?: NativeSupervisor) { this.root = path.join(store.data, 'mcp-device') }
  forget(name?: string): void { if (name) delete this.probes[name]; else this.probes = {} }
  private receiptPath(name: string): string { validateName(name); return path.join(this.root, 'receipts', name + '.json') }
  private async command(command: string): Promise<string | undefined> {
    if (!command || command === '@device' || (process.platform !== 'win32' && /^[a-z]:[/\\]|^(cmd|powershell)(\.exe)?$/i.test(command))) return undefined
    if (path.isAbsolute(command)) return await exists(command) ? command : undefined
    const directories = [...(process.env.PATH ?? '').split(path.delimiter), path.join(this.home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
    for (const dir of directories.filter(Boolean)) for (const suffix of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
      const candidate = path.join(dir, command + suffix); if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate
    }
  }
  private async viable(spec: any): Promise<boolean> {
    if (!await this.command(spec.command)) return false
    for (const arg of spec.args ?? []) {
      if (process.platform === 'win32' && /^\/[cskdqau]$/i.test(arg)) continue
      if (process.platform !== 'win32' && /^[a-z]:[/\\]/i.test(arg)) return false
      if (path.isAbsolute(arg) && !arg.startsWith('//') && !await exists(arg)) return false
    }
    return true
  }
  private fingerprint(source: McpSource): string { return hash(JSON.stringify(source)) }
  private definitionHash(name: string, spec: any): string { return hash(JSON.stringify(mcpSource(name, spec) ?? spec)) }
  /** Carries a device launch override across a rename, re-bound to the new definition. */
  async renameOverride(from: string, to: string, spec: any): Promise<void> {
    validateName(from); validateName(to)
    const source = path.join(this.root, 'overrides', from + '.json'), saved = JSON.parse(await readText(source) ?? 'null')
    if (!saved) return
    await atomicWrite(path.join(this.root, 'overrides', to + '.json'), JSON.stringify({ ...saved, fingerprint: this.definitionHash(to, spec) }))
    await fs.rm(source, { force: true }); delete this.probes[from]
  }
  async setOverride(name: string, launch: { command: string; args: string[]; env?: Record<string, string> } | null): Promise<void> {
    validateName(name); const spec = (await this.store.mcpRaw())[name]
    if (!spec?.command) throw new Error('Only local MCP servers support a device launch override')
    const file = path.join(this.root, 'overrides', name + '.json')
    if (launch === null) { await fs.rm(file, { force: true }); delete this.probes[name]; return }
    if (!launch.command?.trim() || !Array.isArray(launch.args) || launch.args.some(a => typeof a !== 'string') || Object.values(launch.env ?? {}).some(v => typeof v !== 'string')) throw new Error('Use a command, string arguments and environment values')
    const previous = JSON.parse(await readText(file) ?? '{}')
    const resolved = await this.resolve(name, spec)
    const env = Object.fromEntries(Object.entries(launch.env ?? {}).map(([key, value]) => [key, value === '[saved]' ? previous.env?.[key] ?? resolved?.env?.[key] ?? spec.env?.[key] ?? '' : value]))
    await atomicWrite(file, JSON.stringify({ ...launch, env, fingerprint: this.definitionHash(name, spec) })); delete this.probes[name]
  }
  private async receipt(name: string, source: McpSource): Promise<Receipt | undefined> {
    const saved = JSON.parse(await readText(this.receiptPath(name)) ?? 'null') as Receipt | null
    if (saved?.fingerprint === this.fingerprint(source) && await this.viable(saved)) return saved
  }
  async localLaunch(name: string): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
    validateName(name); const spec = (await this.store.mcpRaw())[name], resolved = spec && await this.resolve(name, spec)
    return { command: resolved?.command ?? '', args: resolved?.args ?? [], env: Object.fromEntries(Object.keys(resolved?.env ?? {}).map(k => [k, '[saved]'])) }
  }
  private wrapper(spec: any): boolean { return /^(?:cmd|npx|uvx|uv)(?:\.exe|\.cmd)?$/i.test(path.basename(spec.command ?? '')) }
  private async direct(spec: LaunchSpec): Promise<LaunchSpec & { args: string[]; env: Record<string, string> }> {
    const launch = { ...spec, args: [...spec.args ?? []], env: { ...spec.env } }
    const command = await fs.realpath(launch.command).catch(() => launch.command)
    if (/node(?:\.exe)?$/i.test(command) && launch.args[0]) {
      let dir = path.dirname(launch.args[0])
      while (dir !== path.dirname(dir)) {
        if (path.basename(dir) === 'node_modules') { launch.env.PATH = path.join(dir, '.bin') + path.delimiter + (launch.env.PATH ?? process.env.PATH ?? ''); break }
        dir = path.dirname(dir)
      }
    }
    let bin = path.dirname(command), root = path.dirname(bin)
    if (!await exists(path.join(root, 'pyvenv.cfg')) && launch.command.includes(path.sep + 'bin' + path.sep)) {
      const tools = path.join(path.dirname(path.dirname(launch.command)), 'uv-tools')
      for (const tool of await fs.readdir(tools).catch(() => [])) {
        const candidate = path.join(tools, tool), scripts = path.join(candidate, process.platform === 'win32' ? 'Scripts' : 'bin')
        if (await exists(path.join(scripts, path.basename(launch.command)))) { root = candidate; bin = scripts; break }
      }
    }
    if (await exists(path.join(root, 'pyvenv.cfg'))) {
      const python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python')
      launch.env = { ...launch.env, PATH: bin + path.delimiter + (launch.env.PATH ?? process.env.PATH ?? ''), VIRTUAL_ENV: root, PYTHONNOUSERSITE: '1' }
      if (await exists(python) && !/^python(?:[\d.]*)?(?:\.exe)?$/i.test(path.basename(command))) {
        const name = path.basename(launch.command).replace(/\.exe$/i, '')
        launch.command = python
        launch.args = ['-c', "import sys; from importlib.metadata import entry_points; name=sys.argv.pop(1); sys.argv[0]=name; next(p for p in entry_points(group='console_scripts') if p.name==name).load()()", name, ...launch.args]
      }
    }
    return launch
  }
  private async legacyPython(spec: any, source?: McpSource): Promise<LaunchSpec | undefined> {
    if (!source || !['blender', 'aws'].includes(source.kind) || !this.wrapper(spec)) return
    const index = (spec.args ?? []).indexOf('--directory'), dir = index >= 0 ? spec.args[index + 1] : undefined
    if (!dir || !path.isAbsolute(dir)) return
    const root = path.join(dir, '.venv'), bin = path.join(root, process.platform === 'win32' ? 'Scripts' : 'bin'), python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python')
    if (!await exists(python)) return
    const entry = source.kind === 'blender' ? 'blender-mcp' : 'mcp-proxy-for-aws'
    return { command: python, args: ['-c', "import sys; from importlib.metadata import entry_points; name=sys.argv.pop(1); sys.argv[0]=name; next(p for p in entry_points(group='console_scripts') if p.name==name).load()()", entry, ...source.args ?? []], env: { ...spec.env, PATH: bin + path.delimiter + (process.env.PATH ?? ''), VIRTUAL_ENV: root, PYTHONNOUSERSITE: '1' } }
  }
  async resolve(name: string, spec: any): Promise<any | undefined> {
    validateName(name)
    if (!spec.command) return spec
    const source = mcpSource(name, spec)
    const override = JSON.parse(await readText(path.join(this.root, 'overrides', name + '.json')) ?? 'null')
    if (override?.fingerprint === this.definitionHash(name, spec) && await this.viable(override) && !(source && this.wrapper(override))) return this.direct({ command: (await this.command(override.command))!, args: override.args, env: { ...spec.env, ...override.env } })
    const legacy = await this.legacyPython(override?.fingerprint === this.definitionHash(name, spec) ? override : spec, source)
    if (legacy) return legacy
    if (source) {
      const receipt = await this.receipt(name, source)
      if (receipt) {
        if (source.kind === 'workspace-gws') return { command: receipt.command, args: [path.join(path.dirname(process.argv[1]), 'manager.mjs'), '--workspace'] }
        const inherited = { ...spec.env }
        if (source.kind === 'aws' && spec.command === '@device') { delete inherited.AWS_PROFILE; delete inherited.AWS_MCP_PROXY_PROFILES }
        return this.direct({ command: receipt.command, args: receipt.args, env: { ...inherited, ...receipt.env } })
      }
      if (source.kind === 'workspace-gws' || this.wrapper(spec)) return undefined
    }
    if (await this.viable(spec)) return this.direct({ ...spec, command: (await this.command(spec.command))! })
    return undefined
  }
  async statuses(): Promise<Record<string, McpDeviceStatus>> {
    const result: Record<string, McpDeviceStatus> = {}
    for (const [name, spec] of Object.entries(await this.store.mcpRaw())) {
      if (!spec.command) continue
      try {
        const source = mcpSource(name, spec), resolved = await this.resolve(name, spec)
        if (source?.kind === 'aws' && resolved && !await this.command('aws')) { result[name] = { state: 'Needs sign-in', detail: 'Server files are installed. AWS CLI and an authenticated local profile are still required on this device.', canPrepare: true }; continue }
        const checked = this.probes[name], recent = checked && Date.now() - (checked.checkedAt ?? 0) < 600_000 ? checked : undefined
        result[name] = resolved ? recent ?? { state: 'Ready to launch', detail: 'Installed on this device. A coding client starts its session when it connects; restart clients after changing configuration.', canPrepare: !!source } : { state: 'Needs setup', detail: source ? 'Prepare this device to install its local server and runtime.' : 'This custom launch command or its files are missing on this device. Edit its local launch or use a remote endpoint.', canPrepare: !!source }
      } catch { result[name] = { state: 'Needs setup', detail: 'Invalid device launch or installation metadata. Review the MCP definition.', canPrepare: false } }
    }
    return result
  }
  private async blender(): Promise<any | undefined> {
    // Reuse the working Blender Lab installation, including its existing addon environment.
    let native: any = {}
    try { native = JSON.parse(await readText(path.join(this.home, '.gemini/config/mcp_config.json')) ?? '{}') } catch { /* A damaged client config must not block preparation. */ }
    const candidates = [native.mcpServers?.blender, { command: path.join(this.home, '.local/bin/blender-mcp'), args: [] }]
    for (const candidate of candidates) if (candidate?.command && /blender-mcp$/.test(candidate.command) && await this.viable(candidate)) {
      const real = await fs.realpath(candidate.command)
      if (real.includes('/uv/tools/blender-mcp/')) {
        const lib = path.join(path.dirname(path.dirname(real)), 'lib')
        for (const version of await fs.readdir(lib).catch(() => [])) {
          const origin = JSON.parse(await readText(path.join(lib, version, 'site-packages/blender_mcp-1.0.3.dist-info/direct_url.json')) ?? 'null')
          if (origin?.url === 'https://projects.blender.org/lab/blender_mcp.git') return candidate
        }
      }
    }
  }
  async preview(names?: string[]): Promise<McpSetupPreview> {
    const master = await this.store.mcpRaw(), statuses = await this.statuses()
    const selected = names ?? Object.keys(master).filter(name => statuses[name]?.state === 'Needs setup' && statuses[name]?.canPrepare)
    const entries: McpSetupPreview['entries'] = []
    for (const name of selected) {
      validateName(name); const spec = master[name]; if (!spec) throw new Error('Server not found')
      const source = mcpSource(name, spec); if (!source) throw new Error(`${name}: no portable installation recipe`)
      const reuse = source.kind === 'blender' && process.platform === 'darwin' ? await this.blender() : undefined
      entries.push({ name, source, action: reuse ? 'Reuse existing Blender Lab launcher and addon configuration' : `Install pinned ${source.package ?? source.kind} ${source.version} in private app storage`, note: source.kind === 'aws' ? 'AWS CLI and a local authenticated profile are required. Sign-in is a separate action.' : source.kind === 'workspace-gws' ? 'Installs current gws; the AI Usage adapter uses imported Google credentials with explicit account selection.' : source.package === 'computer-use-mcp' ? 'macOS Accessibility and Screen Recording permissions may be needed. No desktop action is performed during connection checks.' : name === 'playwright-cdp' ? 'Chrome must already expose the selected local CDP port.' : source.kind === 'blender' ? 'Blender and the matching Blender Lab addon must be installed. Blender Lab server license: GPL-3.0-or-later.' : undefined })
    }
    const ticket: Ticket = { id: randomUUID(), createdAt: Date.now(), platform: `${process.platform}/${process.arch}`, entries, masterHash: hash(JSON.stringify(master)) }
    await atomicWrite(path.join(this.root, 'tickets', ticket.id + '.json'), JSON.stringify(ticket))
    const { masterHash: _hash, ...preview } = ticket; return preview
  }
  private async run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    const result = await exec(command, args, { env: { ...process.env, ...env }, timeout: 600_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    return result.stdout
  }
  private async download(url: string, file: string): Promise<void> {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
    const chunks: Uint8Array[] = []; let size = 0
    for await (const bytes of response.body as any) { size += bytes.length; if (size > 200 * 1024 * 1024) throw new Error('Download exceeds 200 MiB'); chunks.push(bytes) }
    await atomicWrite(file, Buffer.concat(chunks))
  }
  private async untar(archive: string, destination: string): Promise<void> {
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe') : '/usr/bin/tar'
    const names = await this.run(tar, ['-tzf', archive])
    if (names.split('\n').some(name => name.startsWith('/') || /^[a-z]:/i.test(name) || name.replaceAll('\\', '/').split('/').includes('..'))) throw new Error('Unsafe archive member')
    const types = await this.run(tar, ['-tvzf', archive]); if (types.split('\n').some(line => /^[lh]/.test(line))) throw new Error('Linked archive members are unsupported')
    await fs.mkdir(destination, { recursive: true }); await this.run(tar, ['-xzf', archive, '-C', destination])
  }
  private async node(): Promise<{ node: string; npm: string; env: NodeJS.ProcessEnv }> {
    const bin = path.join(this.root, 'runtime'), node = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node')
    if (!await exists(node)) { await fs.mkdir(bin, { recursive: true }); await fs.copyFile(process.execPath, node); if (process.platform !== 'win32') await fs.chmod(node, 0o755) }
    const npm = path.join(path.dirname(process.argv[1]), 'npm/bin/npm-cli.js')
    if (!await exists(npm)) throw new Error('This app build has no bundled npm. Install the updated AI Usage app.')
    return { node, npm, env: { PATH: bin + path.delimiter + (process.env.PATH ?? ''), npm_config_cache: path.join(this.root, 'npm-cache') } }
  }
  private async uv(): Promise<string> {
    const existing = await this.command('uv'); if (existing) return existing
    if (process.platform !== 'darwin') throw new Error('Install uv, then prepare again')
    const target = path.join(this.root, 'runtime', 'uv'); if (await exists(target)) return target
    const stage = path.join(this.root, 'downloads', randomUUID()); await fs.mkdir(stage, { recursive: true })
    const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    const archive = path.join(stage, 'uv.tgz'); await this.download(`https://github.com/astral-sh/uv/releases/download/0.12.7/uv-${triple}.tar.gz`, archive)
    await this.untar(archive, path.join(stage, 'payload')); await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(stage, 'payload', `uv-${triple}`, 'uv'), target); await fs.chmod(target, 0o755)
    await fs.rm(stage, { recursive: true, force: true }); return target
  }
  private async install(name: string, source: McpSource): Promise<Receipt> {
    const root = path.join(this.root, 'servers', name, this.fingerprint(source).slice(0, 16)); await fs.mkdir(root, { recursive: true })
    let command: string, args: string[], env: Record<string, string> = {}, note: string | undefined
    if (source.kind === 'blender' && process.platform === 'darwin') {
      const reuse = await this.blender()
      if (reuse) return { fingerprint: this.fingerprint(source), command: reuse.command, args: reuse.args ?? [], env: reuse.env, preparedAt: Date.now(), note: 'Reuses existing Blender Lab installation' }
    }
    if (source.kind === 'npm') {
      const runtime = await this.node()
      await this.run(runtime.node, [runtime.npm, 'install', '--prefix', root, '--no-audit', '--no-fund', `${source.package}@${source.version}`], runtime.env)
      const packageRoot = path.join(root, 'node_modules', source.package!), manifest = JSON.parse((await readText(path.join(packageRoot, 'package.json')))!)
      const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0]
      if (typeof bin !== 'string') throw new Error('Package has no executable')
      const entry = path.resolve(packageRoot, bin); if (!entry.startsWith(packageRoot + path.sep) || !await exists(entry)) throw new Error('Invalid package executable')
      command = runtime.node; args = [entry, ...(source.args ?? [])]
      env.PATH = path.join(root, 'node_modules', '.bin') + path.delimiter + runtime.env.PATH!
      if (source.package === '@playwright/mcp') {
        env.PLAYWRIGHT_BROWSERS_PATH = path.join(this.root, 'browsers')
        if (name !== 'playwright-cdp') {
          const playwright = path.join(root, 'node_modules', 'playwright', 'cli.js')
          await this.run(command, [playwright, 'install', 'chromium'], { ...runtime.env, ...env })
          args.push('--browser', 'chromium')
        }
      }
    } else if (source.kind === 'workspace-gws') {
      const runtime = await this.node()
      await this.run(runtime.node, [runtime.npm, 'install', '--prefix', root, '--no-audit', '--no-fund', `@googleworkspace/cli@${source.version}`], runtime.env)
      const entry = path.join(root, 'node_modules/@googleworkspace/cli/run.js')
      if (!await exists(entry)) throw new Error('gws package is missing its runner')
      command = runtime.node; args = [entry]; env.PATH = path.join(root, 'node_modules', '.bin') + path.delimiter + runtime.env.PATH!
      note = 'Official gws through AI Usage; each request chooses its account by name. Imported app credentials are used.'
    } else {
      const uv = await this.uv(), tools = path.join(root, 'uv-tools'), bin = path.join(root, 'bin')
      const uvEnv = { UV_TOOL_DIR: tools, UV_TOOL_BIN_DIR: bin, UV_PYTHON_INSTALL_DIR: path.join(this.root, 'python'), UV_PYTHON_PREFERENCE: 'only-managed' }
      let packageSpec = `mcp-proxy-for-aws==${source.version}`
      if (source.kind === 'blender') {
        if (!await this.command('git')) throw new Error('Install Git, then prepare Blender again. On macOS, run xcode-select --install in Terminal.')
        // The archive endpoint can return 403 while the official Git endpoint works.
        packageSpec = `git+https://projects.blender.org/lab/blender_mcp.git@${source.revision}#subdirectory=mcp`
      }
      await this.run(uv, ['tool', 'install', '--python', '3.11', packageSpec], uvEnv)
      const binary = source.kind === 'blender' ? 'blender-mcp' : 'mcp-proxy-for-aws'
      command = path.join(bin, binary + (process.platform === 'win32' ? '.exe' : '')); args = source.kind === 'aws' ? source.args ?? [] : []
      if (source.kind === 'aws') { const aws = await this.command('aws'); if (aws) env.PATH = path.dirname(aws) + path.delimiter + (process.env.PATH ?? ''); note = 'Select a local AWS profile and sign in before using tools' }
      // Blender is connected through its addon; do not launch the user's main application.
    }
    if (!await exists(command)) throw new Error('Installation did not create its launcher')
    return { fingerprint: this.fingerprint(source), ...await this.direct({ command, args, env }), preparedAt: Date.now(), note }
  }
  async workspaceRunner(): Promise<{ command: string; args: string[]; env?: Record<string, string> }> {
    const raw = await this.store.mcpRaw()
    for (const [name, spec] of Object.entries(raw)) {
      const source = mcpSource(name, spec)
      if (source?.kind === 'workspace-gws') { const saved = await this.receipt(name, source); if (saved) return { ...saved, ...await this.direct(saved) } }
    }
    throw new Error('Prepare the gws Workspace adapter on this device first')
  }
  async confirm(id: string): Promise<{ prepared: string[]; failed: Record<string, string> }> {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid preparation preview')
    const file = path.join(this.root, 'tickets', id + '.json'), ticket = JSON.parse(await readText(file) ?? 'null') as Ticket | null
    if (!ticket || Date.now() - ticket.createdAt > 600_000) throw new Error('Preparation preview expired')
    if (ticket.masterHash !== hash(JSON.stringify(await this.store.mcpRaw()))) throw new Error('The library changed. Preview preparation again.')
    const prepared: string[] = [], failed: Record<string, string> = {}
    for (const item of ticket.entries) {
      try {
        const receipt = await this.install(item.name, item.source); await atomicWrite(this.receiptPath(item.name), JSON.stringify(receipt))
        delete this.probes[item.name]; prepared.push(item.name)
        await fs.appendFile(path.join(this.store.pool, 'INSTALLED_TOOLS.md'), `\n- AI Usage device MCP ${item.name}: ${item.source.package ?? item.source.kind} ${item.source.version}; ${receipt.command}. ${receipt.note ?? ''}\n`)
      } catch (e) { failed[item.name] = `Preparation failed: ${(e as Error).message.split('\n')[0].slice(0, 500)}` }
    }
    await fs.rm(file, { force: true }); return { prepared, failed }
  }
  async setAwsProfile(name: string, profile: string): Promise<void> {
    validateName(profile)
    const spec = (await this.store.mcpRaw())[name], source = spec && mcpSource(name, spec)
    if (source?.kind !== 'aws') throw new Error('This server is not an AWS proxy')
    const receipt = await this.receipt(name, source); if (!receipt) throw new Error('Prepare AWS MCP first')
    const aws = await this.command('aws'); if (!aws) throw new Error('Install the official AWS CLI on this device first')
    const listed = await exec(aws, ['configure', 'list-profiles'], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true })
    if (!listed.stdout.split(/\r?\n/).includes(profile)) throw new Error('This AWS profile does not exist on this device. Sign in locally first.')
    receipt.env = { ...receipt.env, AWS_PROFILE: profile, AWS_MCP_PROXY_PROFILES: profile, AWS_REGION: 'us-east-1', PATH: path.dirname(aws) + path.delimiter + (process.env.PATH ?? '') }
    await atomicWrite(this.receiptPath(name), JSON.stringify(receipt)); delete this.probes[name]
  }
  async probe(name: string): Promise<McpDeviceStatus> {
    validateName(name); const spec = (await this.store.mcpRaw())[name], resolved = spec && await this.resolve(name, spec)
    if (!resolved?.command) throw new Error('Prepare this local server before checking its connection')
    if (!this.supervisor) throw new Error('Open AI Usage to run a contained MCP connection check')
    const transport = this.supervisor.transport(name, resolved, 'discovery')
    const client = new Client({ name: 'AI Usage connection check', version: APP_VERSION }, { capabilities: {} })
    let timer: NodeJS.Timeout | undefined, errorText = ''
    try {
      const operation = (async () => { const connection = client.connect(transport); await connection; const list = await client.listTools(); return list.tools.length })()
      const count = await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Connection timed out')), 60_000) })])
      const requirement = name === 'google-workspace' ? 'Google consent was not checked.' : name === 'computer-use' ? 'Desktop permissions were not checked.' : name === 'playwright-cdp' ? 'The browser debugging connection was not checked.' : name === 'blender' ? 'Blender scene operations were not checked.' : ''
      return this.probes[name] = { state: 'Connection verified', detail: `${count} tools listed. The temporary check has finished. ${requirement}`, tools: count, checkedAt: Date.now(), canPrepare: !!mcpSource(name, spec) }
    } catch (error) {
      let detail = `${(error as Error).message} ${errorText}`
      if (name === 'aws-mcp' && !await this.command('aws')) detail = 'AWS CLI is missing from this device. Install the official AWS CLI, select a local profile, and run aws login in Terminal.'
      for (const value of Object.values(resolved.env ?? {})) if (typeof value === 'string' && value.length > 3) detail = detail.split(value).join('[saved]')
      detail = detail.replace(/Bearer\s+\S+|(?:access_token|refresh_token|client_secret)["\s:=]+[^\s",}]+/gi, '[redacted]').slice(0, 900)
      const state = /credential|unauthorized|expired|login|auth|profile/i.test(detail) || name === 'aws-mcp' ? 'Needs sign-in' : /accessibility|permission|screen recording/i.test(detail) ? 'Needs permissions' : /9222|CDP|browser/i.test(detail) ? 'Needs browser' : 'Connection failed'
      return this.probes[name] = { state, detail, canPrepare: !!mcpSource(name, spec), checkedAt: Date.now() }
    } finally { if (timer) clearTimeout(timer); await client.close().catch(() => undefined); await transport.close().catch(() => undefined) }
  }
}
