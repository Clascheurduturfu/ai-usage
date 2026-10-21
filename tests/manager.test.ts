import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as toml } from 'smol-toml'
import { ManagerStore, atomicWrite, Vault } from '../src/main/manager/storage'
import { SyncEngine } from '../src/main/manager/sync'
import { encryptBundle, decryptBundle, mapMcpPaths, Sharing } from '../src/main/manager/sharing'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-manager-')); roots.push(home)
  const store = new ManagerStore(path.join(home, '.agents'), path.join(home, 'data')); await store.load()
  await atomicWrite(path.join(store.pool, 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: process.execPath, args: ['server.mjs'], env: { TEST: 'value' } }, remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'test' } }, 'google-workspace': { command: '@device' } } }))
  await atomicWrite(path.join(store.pool, 'manager-runtime.json'), JSON.stringify({ node: process.execPath, cli: path.join(home, 'manager.mjs') }))
  await atomicWrite(path.join(store.pool, 'AGENTS.md'), 'Master instructions')
  await atomicWrite(path.join(store.pool, 'skills/example/SKILL.md'), '---\nname: example\ndescription: Fixture skill\n---\nBody')
  await atomicWrite(path.join(home, '.codex/config.toml'), 'model = "keep"\n[mcp_servers.node_repl]\ncommand = "internal"\n[mcp_servers.custom]\ncommand = "own"\n')
  await atomicWrite(path.join(home, '.claude.json'), '{"account":"preserved","mcpServers":{"custom":{"command":"own"}}}')
  await atomicWrite(path.join(home, '.gemini/settings.json'), '{\n// Personal settings\n"theme":"keep",\n}')
  await atomicWrite(path.join(home, '.gemini/config/mcp_config.json'), '{}')
  const engine = new SyncEngine(store, home); return { home, store, engine }
}
describe('shared manager writes', () => {
  it('preserves client settings and internal servers, converts transports and omits unprepared Workspace', async () => {
    const { home, engine } = await fixture(); const result = await engine.sync(); expect(result.conflicts).toEqual([])
    const codex = toml(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')) as any
    expect(codex.model).toBe('keep'); expect(codex.mcp_servers.node_repl.command).toBe('internal'); expect(codex.mcp_servers.custom.command).toBe('own'); expect(codex.mcp_servers.remote.http_headers.Authorization).toBe('test')
    expect(codex.mcp_servers.shared.args).toEqual([path.join(home, 'manager.mjs'), '--relay', 'shared'])
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')); expect(claude.account).toBe('preserved'); expect(claude.mcpServers.custom.command).toBe('own')
    const gemini = await fs.readFile(path.join(home, '.gemini/settings.json'), 'utf8'); expect(gemini).toContain('// Personal settings'); expect(gemini).toContain('httpUrl')
    const agy = JSON.parse(await fs.readFile(path.join(home, '.gemini/config/mcp_config.json'), 'utf8')); expect(agy.mcpServers['google-workspace']).toBeUndefined(); expect(agy.mcpServers.remote.serverUrl).toBe('https://mcp.example/mcp')
  })
  it('refuses an edited file after preview without partial writes', async () => {
    const { home, engine } = await fixture(), preview = await engine.preview()
    const original = await fs.readFile(path.join(home, '.claude.json'), 'utf8')
    await atomicWrite(path.join(home, '.codex/config.toml'), 'model="newer"')
    const result = await engine.apply(preview.id); expect(result.changed).toBe(0); expect(result.conflicts.length).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).toBe(original)
  })
  it('restores original bytes and refuses to overwrite edits after a sync', async () => {
    const { home, engine } = await fixture(), original = await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')
    const result = await engine.sync(); expect((await engine.restore(result.backupId!)).conflicts).toEqual([])
    expect(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')).toBe(original)
    const again = await engine.sync(); await atomicWrite(path.join(home, '.codex/config.toml'), 'model="user-edited"')
    expect((await engine.restore(again.backupId!)).changed).toBe(0)
  })
  it('applies native profile exclusions without touching unrelated skill settings', async () => {
    const { home, store, engine } = await fixture()
    store.config.profiles.push({ id: 'focused', name: 'Focused', agentId: 'codex', mcpNames: ['remote'], disabledSkills: ['example'], instructions: true }); store.config.activeProfiles.codex = 'focused'
    await engine.sync()
    const codex = toml(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')) as any
    expect(codex.mcp_servers.shared).toBeUndefined(); expect(codex.mcp_servers.node_repl).toBeDefined(); expect(codex.skills.config[0].enabled).toBe(false)
  })
  it('keeps a malformed client untouched while syncing valid clients', async () => {
    const { home, engine } = await fixture(); await atomicWrite(path.join(home, '.gemini/settings.json'), '{ invalid }')
    const result = await engine.sync(); expect(result.warnings.some(w => w.includes('cannot parse'))).toBe(true); expect(await fs.readFile(path.join(home, '.gemini/settings.json'), 'utf8')).toBe('{ invalid }'); expect(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).toContain('preserved')
  })
})
describe('portable credential encryption', () => {
  it.each([true, false])('keeps the local MCP sign-in even when a bundle carries a newer grant (same registration: %s)', async (sameRegistration) => {
    const { home, store } = await fixture(), folder = path.join(home, 'shared')
    store.config.mcpAuth = { remote: { enabled: true, secretRef: 'remote-auth' } }
    const vault = new Vault(path.join(store.data, 'vault.json'), async (_method, value) => value); await vault.load()
    const local = { client: { client_id: 'local-client' }, tokens: { refresh_token: 'local-refresh' }, tokensUpdatedAt: 1 }
    await vault.set('remote-auth', JSON.stringify(local))
    const remote = { client: { client_id: sameRegistration ? 'local-client' : 'remote-client' }, tokens: { refresh_token: 'remote-refresh' }, tokensUpdatedAt: 2 }
    const sharing = new Sharing(store, vault, home); await sharing.load(); await sharing.configure(folder, 'sufficiently long password')
    const bundle: any = { config: structuredClone(store.config), mcp: await store.mcpRaw(), instructions: 'Shared', skills: {}, credentials: { 'remote-auth': JSON.stringify(remote) } }
    await atomicWrite(path.join(folder, 'ai-usage-shared.encrypted.json'), JSON.stringify(encryptBundle(bundle, 'sufficiently long password', 'new')))
    await sharing.import(true)
    expect(JSON.parse(await vault.get('remote-auth'))).toEqual(local)
  })
  it('keeps a local MCP sign-in setting that the publishing device never enabled', async () => {
    const { home, store } = await fixture(), folder = path.join(home, 'shared')
    const vault = new Vault(path.join(store.data, 'vault.json'), async (_method, value) => value); await vault.load()
    const sharing = new Sharing(store, vault, home); await sharing.load(); await sharing.configure(folder, 'sufficiently long password')
    const bundle: any = { config: structuredClone(store.config), mcp: await store.mcpRaw(), instructions: 'Shared', skills: {}, credentials: {} }
    store.config.mcpAuth = { remote: { enabled: true, secretRef: 'remote-auth' } }; await vault.set('remote-auth', '{"tokens":{"refresh_token":"local"}}')
    await atomicWrite(path.join(folder, 'ai-usage-shared.encrypted.json'), JSON.stringify(encryptBundle(bundle, 'sufficiently long password', 'new')))
    await sharing.import(true)
    expect(store.config.mcpAuth).toEqual({ remote: { enabled: true, secretRef: 'remote-auth' } })
    expect(await vault.get('remote-auth')).toBe('{"tokens":{"refresh_token":"local"}}')
  })
  it('publishes the MCP sign-in setting but not the device-bound grant', async () => {
    const { home, store } = await fixture(), folder = path.join(home, 'shared')
    store.config.mcpAuth = { remote: { enabled: true, secretRef: 'remote-auth' } }
    const vault = new Vault(path.join(store.data, 'vault.json'), async (_method, value) => value); await vault.load()
    await vault.set('remote-auth', '{"tokens":{"refresh_token":"device-only"}}')
    const sharing = new Sharing(store, vault, home); await sharing.load(); await sharing.configure(folder, 'sufficiently long password')
    await sharing.publish()
    const bundle = decryptBundle(JSON.parse(await fs.readFile(path.join(folder, 'ai-usage-shared.encrypted.json'), 'utf8')), 'sufficiently long password')
    expect(bundle.config.mcpAuth?.remote?.enabled).toBe(true)
    expect(bundle.credentials['remote-auth']).toBeUndefined()
  })
  it('relocates home and pool paths while keeping remote URLs intact', () => {
    const portable = mapMcpPaths({ command: 'C:\\Users\\source\\.agents\\mcp\\server.exe', args: ['C:\\Users\\source\\Documents\\test.py'], url: 'https://example.com/mcp' }, 'C:\\Users\\source', 'C:\\Users\\source\\.agents', true)
    const local = mapMcpPaths(portable, '/Users/target', '/Users/target/.agents', false)
    expect(local.command).toBe(path.join('/Users/target/.agents', 'mcp/server.exe')); expect(local.args[0]).toBe(path.join('/Users/target', 'Documents/test.py')); expect(local.url).toBe('https://example.com/mcp')
  })
  it('restores the protected vault when a shared import fails', async () => {
    const { home, store } = await fixture(), folder = path.join(home, 'shared')
    let fail = false
    const vault = new Vault(path.join(store.data, 'vault.json'), async (_m, value) => { if (fail && value === 'fail') throw new Error('Fixture crypto failure'); return value }); await vault.load()
    const sharing = new Sharing(store, vault, home); await sharing.load(); await sharing.configure(folder, 'sufficiently long password')
    const oldVault = vault.protectedSnapshot(), oldMcp = await fs.readFile(path.join(store.pool, 'mcp.json'), 'utf8'), oldConfig = structuredClone(store.config)
    const bundle: any = { config: store.config, mcp: {}, instructions: 'New', skills: {}, credentials: { first: 'new-secret', second: 'fail' } }
    await atomicWrite(path.join(folder, 'ai-usage-shared.encrypted.json'), JSON.stringify(encryptBundle(bundle, 'sufficiently long password', 'new'))); fail = true
    await expect(sharing.import()).rejects.toThrow('crypto failure')
    expect(vault.protectedSnapshot()).toEqual(oldVault); expect(store.config).toEqual(oldConfig); expect(await fs.readFile(path.join(store.pool, 'mcp.json'), 'utf8')).toBe(oldMcp)
  })
  it('round-trips credentials without exposing plaintext and authenticates metadata', () => {
    const bundle: any = { config: { schema: 1 }, credentials: { key: 'secret-value' }, mcp: {}, skills: {}, instructions: 'Shared' }
    const encrypted = encryptBundle(bundle, 'a sufficiently long password', 'revision', 'parent')
    expect(JSON.stringify(encrypted)).not.toContain('secret-value'); expect(decryptBundle(encrypted, 'a sufficiently long password')).toEqual(bundle)
    expect(() => decryptBundle(encrypted, 'wrong password')).toThrow('Incorrect sharing password')
    expect(() => decryptBundle({ ...encrypted, revision: 'tampered' }, 'a sufficiently long password')).toThrow('Incorrect sharing password')
  })
})
