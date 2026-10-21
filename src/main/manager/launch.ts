import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'smol-toml'
import { parse as parseJson } from 'jsonc-parser'
import type { AgentProfile, LaunchSelection, SyncResult } from '../../shared/manager'
import { ManagerStore, Vault, atomicWrite, readText, validateName, type NativeCall } from './storage'
import { ProxySupervisor } from '../../../proxies/server'

const endpointPaths = (file: string): string[][] => file.endsWith('.toml') ? [['model'], ['model_provider'], ['model_providers', 'ai_usage']] : [['apiKeyHelper'], ...['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].map(k => ['env', k])]
const parseSettings = (text: string | null, file: string): any => file.endsWith('.toml') ? parse(text ?? '') : parseJson(text ?? '{}')
const field = (doc: any, keys: string[]): any => keys.reduce((v, k) => v?.[k], doc)
function endpointUnchanged(current: string | null, expected: string, file: string): boolean {
  const a = parseSettings(current, file), b = parseSettings(expected, file)
  return endpointPaths(file).every(keys => JSON.stringify(field(a, keys)) === JSON.stringify(field(b, keys)))
}
function restoreEndpoint(current: string | null, original: string | null, file: string): string {
  const doc = parseSettings(current, file), before = parseSettings(original, file)
  for (const keys of endpointPaths(file)) {
    let target = doc; for (const key of keys.slice(0, -1)) { target[key] ??= {}; target = target[key] }
    const value = field(before, keys), key = keys.at(-1)!
    if (value === undefined) delete target[key]; else target[key] = value
  }
  return file.endsWith('.toml') ? stringify(doc) + '\n' : JSON.stringify(doc, null, 2) + '\n'
}

export class AgentLauncher {
  constructor(private store: ManagerStore, private vault: Vault, private proxies: ProxySupervisor, private native: NativeCall, private home: string) {}
  private profile(id: string): AgentProfile { const p = this.store.config.profiles.find(p => p.id === id); if (!p) throw new Error('Profile not found'); return p }
  private approval(pending: any): SyncResult { return { changed: 0, conflicts: [], warnings: [`Windows approval is pending. A helper terminal opened at ${pending.helper}. Press a key and approve the Windows prompt, then click the same action again to verify completion.`] } }
  private pending(value: string): any { try { const parsed = JSON.parse(value); return parsed.pending ? parsed : null } catch { return null } }
  private async connection(profile: AgentProfile): Promise<{ base: string; key: string; ref?: string; model: string; protocol: string }> {
    if (!profile.proxyId && profile.endpointId) {
      const endpoint = this.store.config.endpoints.find(e => e.id === profile.endpointId)
      if (!endpoint) throw new Error('Endpoint not found')
      if (endpoint.credentialKind !== 'api-key' || profile.claudeCompatibility || profile.agentId === 'claude-desktop' || (profile.agentId === 'claude' && endpoint.protocol !== 'anthropic') || (profile.agentId === 'codex' && endpoint.protocol !== 'openai-responses')) {
        const model = profile.model || endpoint.models[0]; if (!model) throw new Error('Choose an upstream model')
        const alias = profile.claudeCompatibility || profile.agentId === 'claude-desktop' ? 'claude-sonnet-4-6' : model
        let proxy = this.store.config.proxies.find(p => p.managedEndpointId === endpoint.id)
        if (!proxy) {
          let port = 8787; const used = new Set(this.store.config.proxies.map(p => p.port)); while (used.has(port)) port++
          proxy = { id: 'account-' + endpoint.id, name: endpoint.name, managedEndpointId: endpoint.id, port, autostart: false, authMode: 'none', clientSecretRef: '', routes: [] }; this.store.config.proxies.push(proxy)
        }
        const route = { alias, endpointId: endpoint.id, model, ...(alias === 'claude-sonnet-4-6' ? { family: 'sonnet' as const } : {}) }
        const index = proxy.routes.findIndex(r => r.alias === alias)
        if (index < 0 || JSON.stringify(proxy.routes[index]) !== JSON.stringify(route)) { await this.proxies.stop(proxy.id); if (index < 0) proxy.routes.push(route); else proxy.routes[index] = route; await this.store.save() }
        profile = { ...profile, proxyId: proxy.id, model: alias }
      }
    }
    if (profile.proxyId) {
      const proxy = this.store.config.proxies.find(p => p.id === profile.proxyId); if (!proxy) throw new Error('Proxy not found')
      await this.proxies.start(proxy)
      const alias = proxy.routes.find(route => route.alias === profile.model || route.model === profile.model)?.alias ?? profile.model ?? proxy.routes[0]?.alias
      return { base: `http://127.0.0.1:${proxy.port}/v1`, key: proxy.authMode === 'none' ? '' : await this.vault.get(proxy.clientSecretRef), ref: proxy.authMode === 'none' ? undefined : proxy.clientSecretRef, model: alias, protocol: 'proxy' }
    }
    const endpoint = this.store.config.endpoints.find(e => e.id === profile.endpointId)
    if (!endpoint) throw new Error('Select an endpoint or proxy for this profile')
    if (endpoint.credentialKind !== 'api-key') throw new Error('Account-backed endpoints need a local proxy; select a proxy in this profile')
    return { base: endpoint.baseUrl.replace(/\/$/, '') + (endpoint.provider === 'ollama' && !endpoint.baseUrl.endsWith('/v1') ? '/v1' : ''), key: await this.vault.get(endpoint.secretRef) || (endpoint.provider === 'ollama' ? 'ollama' : ''), ref: endpoint.secretRef, model: profile.model || endpoint.models[0] || '', protocol: endpoint.protocol }
  }
  async launch(selection: LaunchSelection): Promise<{ pid: number }> {
    const profile = this.profile(selection.profileId), c = await this.connection(profile)
    if (!c.model) throw new Error('Choose a model first')
    const environment = { ...process.env, AI_USAGE_API_KEY: c.key }
    let command: string, args: string[] = []
    if (profile.agentId === 'claude') {
      if (!['anthropic', 'proxy'].includes(c.protocol)) throw new Error('Claude needs the Anthropic protocol; create a proxy route first')
      command = 'claude'; Object.assign(environment, { ANTHROPIC_BASE_URL: c.base.replace(/\/v1$/, ''), ANTHROPIC_AUTH_TOKEN: c.key || 'ai-usage-no-auth', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: c.model }); args = ['--model', c.model]
    } else if (profile.agentId === 'codex') {
      command = 'codex'; args = ['-c', 'model_provider="ai_usage"', '-c', 'model_providers.ai_usage.name="AI Usage"', '-c', `model_providers.ai_usage.base_url=${JSON.stringify(c.base)}`, '-c', 'model_providers.ai_usage.env_key="AI_USAGE_API_KEY"', '-c', 'model_providers.ai_usage.wire_api="responses"', '-m', c.model]
    } else if (profile.agentId === 'opencode') {
      command = 'opencode'; Object.assign(environment, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { ai_usage: { npm: c.protocol === 'openai-responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible', name: 'AI Usage', options: { baseURL: c.base, apiKey: '{env:AI_USAGE_API_KEY}' }, models: { [c.model]: { name: c.model } } } }, model: `ai_usage/${c.model}` }) })
    } else throw new Error('This client does not have a verified isolated endpoint launcher yet')
    args.push(...(selection.extraArgs ?? []))
    const cwd = selection.cwd ?? this.home; if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Working directory does not exist')
    if (process.platform === 'win32') {
      // Arguments are passed through environment JSON, never interpolated into shell source.
      Object.assign(environment, { AIU_LAUNCH_COMMAND: command, AIU_LAUNCH_ARGS: JSON.stringify(args) })
      const script = "$a = @(ConvertFrom-Json $env:AIU_LAUNCH_ARGS); & $env:AIU_LAUNCH_COMMAND @a"
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', script], { cwd, env: environment, detached: true, stdio: 'ignore', windowsHide: false })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref(); return { pid: child.pid! }
    }
    if (process.platform === 'darwin') {
      const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
      const file = path.join(this.store.data, 'launches', randomUUID() + '.command')
      const credential = c.ref && process.env.AIU_HOST_EXE ? `"$(${quote(process.env.AIU_HOST_EXE)} ${quote('--credential-ref=' + c.ref)} ${quote('--profile=' + this.store.data)})"` : undefined
      const exports = Object.entries(environment).filter(([name]) => name === 'AI_USAGE_API_KEY' || name.startsWith('ANTHROPIC_') || name === 'OPENCODE_CONFIG_CONTENT')
        .map(([name, value]) => `export ${name}=${credential && ['AI_USAGE_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(name) ? credential : quote(value ?? '')}`).join('\n')
      const script = `#!/bin/sh\n# Private launch handoff; remove it before starting the client.\nrm -f -- "$0"\ncd ${quote(cwd)} || exit 1\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"\n${exports}\n${[command, ...args].map(quote).join(' ')}\n`
      await atomicWrite(file, script); await fs.chmod(file, 0o700)
      try { await this.native('launch-terminal', file) } catch (e) { await fs.rm(file, { force: true }); throw e }
      return { pid: 0 }
    }
    throw new Error('Terminal launching is unavailable on this platform')
  }
  async applyDefault(profileId: string): Promise<SyncResult> {
    const profile = this.profile(profileId), c = await this.connection(profile)
    if (!c.model) throw new Error('Choose a model first')
    const backup = path.join(this.store.data, 'endpoint-defaults', profile.agentId + '.json')
    const previous = JSON.parse(await readText(backup) ?? 'null')
    if (previous?.pending) {
      if (previous.pending.operation === 'restore') throw new Error('Finish Restore previous default before applying another profile')
      const status = JSON.parse(await readText(previous.pending.statusFile) ?? 'null')
      if (!status) return this.approval(previous.pending)
      if (status.ok) { delete previous.pending; delete previous.previousBackup; await atomicWrite(backup, JSON.stringify(previous)); return { changed: 2, conflicts: [], warnings: ['Desktop gateway configured. Restart Claude Desktop.'] } }
      if (previous.previousBackup) await atomicWrite(backup, JSON.stringify(previous.previousBackup)); else await fs.rm(backup); throw new Error(`${status.error}. Click Apply to retry.`)
    }
    const exe = process.env.AIU_HOST_EXE
    if (!exe) throw new Error('Native credential helper is unavailable')
    const helperArgs = ['--credential-ref=' + (c.ref ?? ''), '--profile=' + this.store.data]
    if (profile.agentId === 'claude-desktop') {
      const proxy = this.store.config.proxies.find(p => p.id === profile.proxyId || (p.managedEndpointId === profile.endpointId && p.port === Number(new URL(c.base).port)))
      if (!proxy) throw new Error('Claude Desktop requires a compatible account endpoint')
      if (!proxy.routes.some(r => r.family)) throw new Error('Set a Claude family (Sonnet, Opus or Haiku) on the proxy route first')
      const values = { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: c.base, inferenceGatewayApiKey: c.key || 'ai-usage-no-auth', inferenceGatewayAuthScheme: 'bearer', inferenceCredentialKind: 'static', deploymentMode: '3p', disableDeploymentModeChooser: 1, inferenceModels: JSON.stringify(proxy.routes.filter(r => r.family).map(r => ({ id: r.alias, display_name: r.alias, anthropic_family_tier: r.family, is_family_default: true }))) }
      const before = await this.native('desktop-read', '')
      if (previous?.kind === 'registry') { const expected = JSON.parse(await this.native('unprotect', previous.protectedAfter)), current = JSON.parse(before); if (Object.values(current).some((fields: any) => Object.entries(expected).some(([name, value]) => fields[name] !== value))) throw new Error('Desktop policies changed outside AI Usage; restore or review before applying') }
      const saved = { kind: 'registry', profileId, protectedBefore: previous?.protectedBefore ?? await this.native('protect', before), protectedAfter: await this.native('protect', JSON.stringify(values)), pending: undefined as any, previousBackup: previous ?? undefined }
      await atomicWrite(backup, JSON.stringify(saved))
      try { const pending = this.pending(await this.native('desktop-apply', JSON.stringify(values))); if (pending) { saved.pending = { ...pending, operation: 'apply' }; await atomicWrite(backup, JSON.stringify(saved)); return this.approval(pending) } } catch (e) { if (previous) await atomicWrite(backup, JSON.stringify(previous)); else await fs.rm(backup, { force: true }); throw e }
      delete saved.previousBackup; await atomicWrite(backup, JSON.stringify(saved))
      return { changed: 2, conflicts: [], warnings: ['Restart Claude Desktop to load the gateway. Its required policy stores the configured credential in the current-user registry.'] }
    }
    let file: string, after: string
    if (profile.agentId === 'claude') {
      if (!['anthropic', 'proxy'].includes(c.protocol)) throw new Error('Claude needs an Anthropic endpoint or proxy')
      file = path.join(this.home, '.claude/settings.json')
      const doc = parseJson(await readText(file) ?? '{}')
      doc.env = { ...(doc.env ?? {}), ANTHROPIC_BASE_URL: c.base.replace(/\/v1$/, ''), ANTHROPIC_MODEL: c.model }
      delete doc.env.ANTHROPIC_AUTH_TOKEN; delete doc.env.ANTHROPIC_API_KEY
      if (!c.ref) { doc.env.ANTHROPIC_AUTH_TOKEN = 'ai-usage-no-auth'; delete doc.apiKeyHelper }
      else doc.apiKeyHelper = `"${exe}" ${helperArgs.map(a => `"${a}"`).join(' ')}`
      after = JSON.stringify(doc, null, 2) + '\n'
    } else if (profile.agentId === 'codex') {
      file = path.join(this.home, '.codex/config.toml')
      const doc: any = parse(await readText(file) ?? '')
      doc.model_provider = 'ai_usage'; doc.model = c.model; doc.model_providers ??= {}
      doc.model_providers.ai_usage = { name: 'AI Usage', base_url: c.base, wire_api: 'responses', ...(c.ref ? { auth: { command: exe, args: helperArgs } } : { requires_openai_auth: false }) }
      after = stringify(doc) + '\n'
    } else throw new Error('Permanent endpoint defaults are supported for Claude Code, Codex and Claude Desktop; use Launch for OpenCode')
    if (previous?.kind === 'file' && !endpointUnchanged(await readText(file), previous.after, file)) throw new Error('Client endpoint settings changed outside AI Usage; review them before applying')
    const before = previous?.kind === 'file' ? previous.before : await readText(file)
    await atomicWrite(backup, JSON.stringify({ kind: 'file', profileId, file, before, after }))
    try { await atomicWrite(file, after) } catch (e) { if (previous) await atomicWrite(backup, JSON.stringify(previous)); else await fs.rm(backup, { force: true }); throw e }
    return { changed: 1, conflicts: [], warnings: [] }
  }
  async restore(agentId: string): Promise<SyncResult> {
    validateName(agentId)
    const backup = path.join(this.store.data, 'endpoint-defaults', agentId + '.json'), data = JSON.parse(await readText(backup) ?? 'null')
    if (!data) throw new Error('No endpoint default backup is available')
    if (data.pending) {
      const status = JSON.parse(await readText(data.pending.statusFile) ?? 'null')
      if (!status) return this.approval(data.pending)
      if (!status.ok) { if (data.pending.operation === 'apply') await fs.rm(backup); else { delete data.pending; await atomicWrite(backup, JSON.stringify(data)) }; throw new Error(status.error) }
      if (data.pending.operation === 'restore') { await fs.rm(backup); return { changed: 1, conflicts: [], warnings: ['Desktop policy restored. Restart Claude Desktop.'] } }
      delete data.pending; await atomicWrite(backup, JSON.stringify(data))
    }
    if (data.kind === 'registry') {
      const pending = this.pending(await this.native('desktop-restore', JSON.stringify({ before: JSON.parse(await this.native('unprotect', data.protectedBefore)), after: JSON.parse(await this.native('unprotect', data.protectedAfter)) })))
      if (pending) { data.pending = { ...pending, operation: 'restore' }; await atomicWrite(backup, JSON.stringify(data)); return this.approval(pending) }
    } else {
      const current = await readText(data.file)
      if (!endpointUnchanged(current, data.after, data.file)) return { changed: 0, conflicts: [data.file], warnings: ['Standard profile refused because the endpoint has newer local edits. Review those edits first.'] }
      await atomicWrite(data.file, restoreEndpoint(current, data.before, data.file))
    }
    await fs.rm(backup); return { changed: 1, conflicts: [], warnings: [] }
  }
}
