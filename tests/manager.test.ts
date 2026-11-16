import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as toml } from 'smol-toml'
import { ManagerStore, atomicWrite, normalizeSkillFolders, Vault } from '../src/main/manager/storage'
import { ManagerService } from '../src/main/manager/service'
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
  it('does not pause when a client brings back an older variant of an AI Usage relay entry', async () => {
    const { home, engine } = await fixture(); expect((await engine.sync()).conflicts).toEqual([])
    const file = path.join(home, '.claude.json'), doc = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(doc.mcpServers.shared.args).toContain('--relay')
    doc.mcpServers.shared.args = [...doc.mcpServers.shared.args.slice(0, -1), 'shared@older-variant']
    await atomicWrite(file, JSON.stringify(doc))
    const preview = await engine.preview(), change = preview.changes.find(c => c.path === file)!
    expect(change.conflict).toBe(false)
    expect((await engine.apply(preview.id)).conflicts).toEqual([])
    expect(JSON.parse(await fs.readFile(file, 'utf8')).mcpServers.shared.args.at(-1)).toBe('shared')
    // A real outside edit of a managed entry still pauses and is explained.
    doc.mcpServers.shared = { command: 'something-else', args: [] }
    await atomicWrite(file, JSON.stringify(doc))
    const edited = (await engine.preview()).changes.find(c => c.path === file)!
    expect(edited.conflict).toBe(true); expect(edited.details?.[0]).toMatch(/MCP server “shared”/)
  })
  it('describes planned writes and lets each edited file be overwritten or skipped', async () => {
    const { home, engine } = await fixture()
    const first = await engine.preview(), claude = path.join(home, '.claude.json')
    const planned = first.changes.find(c => c.path === claude)!
    expect(planned.kind).toBe('settings'); expect(planned.action).toBeDefined()
    expect(planned.planned?.some(line => /MCP server “shared”/.test(line))).toBe(true)
    expect((await engine.apply(first.id)).conflicts).toEqual([])
    const doc = JSON.parse(await fs.readFile(claude, 'utf8')); doc.mcpServers.shared = { command: 'something-else', args: [] }
    await atomicWrite(claude, JSON.stringify(doc))
    // Skip: nothing written to the edited file, it stays reported as paused.
    const skipped = await engine.preview(); expect(skipped.changes.find(c => c.path === claude)!.conflict).toBe(true)
    const kept = await engine.apply(skipped.id, false, { skip: [claude] })
    expect(kept.conflicts).toEqual([claude]); expect(JSON.parse(await fs.readFile(claude, 'utf8')).mcpServers.shared.command).toBe('something-else')
    // Overwrite: AI Usage's entry is written back and the pause clears.
    const again = await engine.preview(), edited = again.changes.find(c => c.path === claude)!
    expect(edited.planned?.some(line => /now launched through AI Usage/.test(line))).toBe(true)
    expect((await engine.apply(again.id, false, { overwrite: [claude] })).conflicts).toEqual([])
    expect(JSON.parse(await fs.readFile(claude, 'utf8')).mcpServers.shared.args).toContain('--relay')
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
describe('skill folders and deletion', () => {
  it('validates and deduplicates skill folder definitions', () => {
    const folders = normalizeSkillFolders([
      { id: 'folder-a', name: '  AWS  ', skills: ['aws-iam', 'aws-cdk', 'aws-iam'] },
      { id: 'folder-b', name: 'Cloudflare', skills: ['aws-cdk', 'wrangler'] }
    ])
    expect(folders).toEqual([
      { id: 'folder-a', name: 'AWS', skills: ['aws-cdk', 'aws-iam'] },
      { id: 'folder-b', name: 'Cloudflare', skills: ['wrangler'] }
    ])
    expect(() => normalizeSkillFolders([{ id: 'folder-a', name: '', skills: [] }])).toThrow('1 to 80')
    expect(() => normalizeSkillFolders([
      { id: 'folder-a', name: 'Cloud', skills: [] },
      { id: 'folder-b', name: 'cloud', skills: [] }
    ])).toThrow('already exists')
    expect(() => normalizeSkillFolders([{ id: 'folder-a', name: 'Bad', skills: ['../escape'] }])).toThrow('Unsafe')
  })
  it('deletes active, parked, and symlinked skills without touching symlink targets', async () => {
    const { home, store } = await fixture()
    await atomicWrite(path.join(store.parkedSkillRoot, 'parked/SKILL.md'), '---\nname: parked\ndescription: Parked skill\n---\n')
    const outsideTarget = path.join(home, 'external-skill')
    await atomicWrite(path.join(outsideTarget, 'SKILL.md'), '---\nname: linked\ndescription: Linked\n---\n')
    await fs.mkdir(store.skillRoot, { recursive: true })
    await fs.symlink(outsideTarget, path.join(store.skillRoot, 'linked'), 'junction')

    await store.deleteSkill('example')
    await store.deleteSkill('parked')
    await store.deleteSkill('linked')

    await expect(fs.lstat(path.join(store.skillRoot, 'example'))).rejects.toThrow()
    await expect(fs.lstat(path.join(store.parkedSkillRoot, 'parked'))).rejects.toThrow()
    await expect(fs.lstat(path.join(store.skillRoot, 'linked'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outsideTarget, 'SKILL.md'), 'utf8')).toContain('Linked')
    await expect(store.deleteSkill('missing-skill')).rejects.toThrow('Unknown skill')
    await expect(store.deleteSkill('../escape')).rejects.toThrow('Unsafe')
  })
  it('saves folders, toggles skills in batches, and scrubs references on delete', async () => {
    const { home } = await fixture()
    const pool = path.join(home, '.agents'), data = path.join(home, 'data')
    await atomicWrite(path.join(pool, 'skills/extra/SKILL.md'), '---\nname: extra\ndescription: Extra skill\n---\n')
    const service = new ManagerService(pool, data, home, async () => '', () => undefined)
    await service.store.load(); await service.vault.load()
    service.store.config.profiles.push({ id: 'dev', name: 'Dev', agentId: 'codex', mcpNames: [], disabledSkills: ['example', 'extra'], instructions: true })

    await service.dispatch('skillFolders:save', [{ id: 'f-cloud', name: 'Cloud', skills: ['example', 'extra'] }])
    expect(service.store.config.skillFolders).toEqual([{ id: 'f-cloud', name: 'Cloud', skills: ['example', 'extra'] }])

    await service.dispatch('skill:setManyEnabled', { names: ['example', 'extra'], enabled: false })
    expect(service.store.config.disabledSkills).toEqual(['example', 'extra'])
    expect(await fs.stat(path.join(pool, 'skills-disabled/example/SKILL.md')).then(() => true, () => false)).toBe(true)

    await service.dispatch('skill:delete', 'example')
    expect(service.store.config.disabledSkills).toEqual(['extra'])
    expect(service.store.config.profiles[0].disabledSkills).toEqual(['extra'])
    expect(service.store.config.skillFolders?.[0].skills).toEqual(['extra'])

    await service.dispatch('skill:setManyEnabled', { names: ['extra'], enabled: true })
    expect(service.store.config.disabledSkills).toEqual([])
    expect(await fs.stat(path.join(pool, 'skills/extra/SKILL.md')).then(() => true, () => false)).toBe(true)
  })
  it('preserves and validates skill folders through Sharing export and import', async () => {
    const { home, store } = await fixture(), folder = path.join(home, 'shared')
    const vault = new Vault(path.join(store.data, 'vault.json'), async (_m, value) => value); await vault.load()
    const sharing = new Sharing(store, vault, home); await sharing.load(); await sharing.configure(folder, 'sufficiently long password')
    store.config.skillFolders = [{ id: 'folder-cloud', name: 'Cloudflare', skills: ['example'] }]
    await sharing.publish()

    store.config.skillFolders = []
    await sharing.import(true)
    expect(store.config.skillFolders).toEqual([{ id: 'folder-cloud', name: 'Cloudflare', skills: ['example'] }])

    const tampered: any = { config: { ...structuredClone(store.config), skillFolders: [{ id: 'bad', name: 'Bad', skills: ['../escape'] }] }, mcp: await store.mcpRaw(), instructions: 'Shared', skills: {}, credentials: {} }
    await atomicWrite(path.join(folder, 'ai-usage-shared.encrypted.json'), JSON.stringify(encryptBundle(tampered, 'sufficiently long password', 'newer')))
    await expect(sharing.import(true)).rejects.toThrow('Unsafe')
  })
  it('prunes empty leftover directories inside managed skill targets without touching links or native folders', async () => {
    const { home } = await fixture()
    const pool = path.join(home, '.agents'), data = path.join(home, 'data')
    await atomicWrite(path.join(pool, 'skills/opera-browser-cli/SKILL.md'), '---\nname: opera-browser-cli\ndescription: Browser CLI\n---\n')
    await atomicWrite(path.join(pool, 'skills/opera-browser-cli/scripts/run.js'), 'console.log(1)')
    await fs.mkdir(path.join(home, '.claude/skills/native-empty'), { recursive: true })
    const linkedSource = path.join(home, 'external-native-skill')
    await atomicWrite(path.join(linkedSource, 'SKILL.md'), '---\nname: linked-native\ndescription: Native link\n---\n')
    await fs.symlink(linkedSource, path.join(home, '.claude/skills/linked-native'), 'junction')

    const service = new ManagerService(pool, data, home, async () => '', () => undefined)
    await service.store.load(); await service.vault.load()
    service.store.config.autoSync = true

    const synced = await service.sync.sync()
    expect(synced.conflicts).toEqual([])
    expect(await fs.stat(path.join(home, '.claude/skills/opera-browser-cli/scripts/run.js')).then(() => true, () => false)).toBe(true)
    expect(await fs.stat(path.join(home, '.gemini/config/skills/opera-browser-cli/scripts/run.js')).then(() => true, () => false)).toBe(true)

    await service.dispatch('skill:delete', 'opera-browser-cli')
    await expect(fs.lstat(path.join(home, '.claude/skills/opera-browser-cli'))).rejects.toThrow()
    await expect(fs.lstat(path.join(home, '.gemini/config/skills/opera-browser-cli'))).rejects.toThrow()
    expect(await fs.lstat(path.join(home, '.claude/skills/native-empty')).then(s => s.isDirectory(), () => false)).toBe(true)
    expect(await fs.lstat(path.join(home, '.claude/skills/linked-native')).then(s => s.isSymbolicLink(), () => false)).toBe(true)
    expect(await fs.stat(path.join(home, '.claude/skills/example/SKILL.md')).then(() => true, () => false)).toBe(true)
    expect(await fs.stat(path.join(home, '.claude/skills')).then(() => true, () => false)).toBe(true)

    // Restoring initial skill sync also prunes the directory it created cleanly.
    const freshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-restore-pruned-')); roots.push(freshHome)
    const freshStore = new ManagerStore(path.join(freshHome, '.agents'), path.join(freshHome, 'data')); await freshStore.load()
    await atomicWrite(path.join(freshStore.pool, 'mcp.json'), '{"mcpServers":{}}')
    await atomicWrite(path.join(freshStore.pool, 'skills/one/scripts/helper.sh'), '#!/bin/sh\n')
    await atomicWrite(path.join(freshStore.pool, 'skills/one/SKILL.md'), '---\nname: one\ndescription: One\n---\n')
    await atomicWrite(path.join(freshHome, '.claude.json'), '{}')
    const freshSync = new SyncEngine(freshStore, freshHome)
    const first = await freshSync.sync()
    expect(await fs.stat(path.join(freshHome, '.claude/skills/one/scripts/helper.sh')).then(() => true, () => false)).toBe(true)
    await freshSync.restore(first.backupId!)
    await expect(fs.lstat(path.join(freshHome, '.claude/skills/one'))).rejects.toThrow()
  })
  it('writes a single marked GEMINI.md block when both Gemini CLI and Antigravity share ~/.gemini/GEMINI.md', async () => {
    const { home, store, engine } = await fixture()
    const geminiFile = path.join(home, '.gemini/GEMINI.md')
    await atomicWrite(geminiFile, 'Personal note above\n')
    expect((await engine.sync()).conflicts).toEqual([])
    const afterFirst = await fs.readFile(geminiFile, 'utf8')
    expect(afterFirst.match(/<!-- AI Usage shared instructions -->/g)?.length).toBe(1)
    expect(afterFirst.match(/Master instructions/g)?.length).toBe(1)
    expect(afterFirst).toContain('Personal note above')

    // Second sync must be idempotent (no duplicate appended!).
    expect((await engine.sync()).conflicts).toEqual([])
    const afterSecond = await fs.readFile(geminiFile, 'utf8')
    expect(afterSecond).toBe(afterFirst)

    // Upgrading an older unmarked copy replaces instead of appending a second copy.
    const f2 = await fixture()
    const g2 = path.join(f2.home, '.gemini/GEMINI.md')
    await atomicWrite(g2, 'Master instructions\n')
    expect((await f2.engine.sync()).conflicts).toEqual([])
    const upgraded = await fs.readFile(g2, 'utf8')
    expect(upgraded.match(/Master instructions/g)?.length).toBe(1)
    expect(upgraded.match(/<!-- AI Usage shared instructions -->/g)?.length).toBe(1)

    // If Antigravity profile disables instructions while Gemini keeps them, Gemini's shared block stays.
    store.config.profiles.push({ id: 'agy-no-inst', name: 'Agy no inst', agentId: 'antigravity', mcpNames: [], disabledSkills: [], instructions: false })
    store.config.activeProfiles.antigravity = 'agy-no-inst'
    expect((await engine.sync()).conflicts).toEqual([])
    expect(await fs.readFile(geminiFile, 'utf8')).toContain('<!-- AI Usage shared instructions -->')
  })
  it('deletes removed skills on Sharing import and propagates deletions cleanly via SyncEngine', async () => {
    const source = await fixture(), target = await fixture(), folder = path.join(source.home, 'shared')
    await atomicWrite(path.join(source.store.pool, 'skills/aws-extra/SKILL.md'), '---\nname: aws-extra\ndescription: Extra\n---\n')
    await atomicWrite(path.join(source.store.pool, 'skills/aws-keep/SKILL.md'), '---\nname: aws-keep\ndescription: Keep\n---\n')
    source.store.config.skillFolders = [{ id: 'folder-aws', name: 'AWS', skills: ['aws-extra', 'aws-keep'] }]
    await source.store.save()
    const sourceVault = new Vault(path.join(source.store.data, 'vault.json'), async (_m, v) => v); await sourceVault.load()
    const sourceSharing = new Sharing(source.store, sourceVault, source.home); await sourceSharing.load(); await sourceSharing.configure(folder, 'sufficiently long password')
    await sourceSharing.publish()

    const targetVault = new Vault(path.join(target.store.data, 'vault.json'), async (_m, v) => v); await targetVault.load()
    const targetSharing = new Sharing(target.store, targetVault, target.home); await targetSharing.load(); await targetSharing.configure(folder, 'sufficiently long password')
    await targetSharing.import(true)
    expect((await target.engine.sync()).conflicts).toEqual([])
    expect(await fs.stat(path.join(target.home, '.claude/skills/aws-extra/SKILL.md')).then(() => true, () => false)).toBe(true)

    // Delete aws-extra on source, update folder, re-publish, then import on target.
    await source.store.deleteSkill('aws-extra')
    source.store.config.skillFolders = [{ id: 'folder-aws', name: 'AWS', skills: ['aws-keep'] }]
    await source.store.save()
    await sourceSharing.publish()

    // Also ensure a linked local skill on target survives import pruning untouched.
    const linked = path.join(target.home, 'linked-skill')
    await atomicWrite(path.join(linked, 'SKILL.md'), '---\nname: linked\ndescription: Linked\n---\n')
    await fs.symlink(linked, path.join(target.store.pool, 'skills/linked'), 'junction')

    await targetSharing.import(true)
    expect(target.store.config.skillFolders).toEqual([{ id: 'folder-aws', name: 'AWS', skills: ['aws-keep'] }])
    await expect(fs.lstat(path.join(target.store.pool, 'skills/aws-extra'))).rejects.toThrow()
    expect(await fs.lstat(path.join(target.store.pool, 'skills/linked')).then(s => s.isSymbolicLink(), () => false)).toBe(true)
    expect((await target.engine.sync()).conflicts).toEqual([])
    await expect(fs.lstat(path.join(target.home, '.claude/skills/aws-extra'))).rejects.toThrow()
    expect(await fs.stat(path.join(target.home, '.claude/skills/aws-keep/SKILL.md')).then(() => true, () => false)).toBe(true)

    // Rollback also restores skills that would have been removed by a failing import.
    const badBundle: any = { config: structuredClone(source.store.config), mcp: await source.store.mcpRaw(), instructions: 'Shared', skills: {}, credentials: { __invalid_ref: 'x' } }
    // Force write failure via a read-only/invalid mcp.json target or symlink check wouldn't reach writes; trigger a vault write failure instead.
    let fail = true
    const rollbackVault = new Vault(path.join(target.store.data, 'vault.json'), async (_m, v) => { if (fail && v === 'boom') throw new Error('Rollback trigger'); return v }); await rollbackVault.load()
    const rollbackSharing = new Sharing(target.store, rollbackVault, target.home); await rollbackSharing.load(); await rollbackSharing.configure(folder, 'sufficiently long password')
    badBundle.credentials = { first: 'boom' }
    await atomicWrite(path.join(folder, 'ai-usage-shared.encrypted.json'), JSON.stringify(encryptBundle(badBundle, 'sufficiently long password', 'fail-rev')))
    await expect(rollbackSharing.import(true)).rejects.toThrow('Rollback trigger')
    fail = false
    expect(await fs.stat(path.join(target.store.pool, 'skills/aws-keep/SKILL.md')).then(() => true, () => false)).toBe(true)
  })
})
