import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ManagerService } from '../src/main/manager/service'
import { atomicWrite } from '../src/main/manager/storage'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture(servers: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-mcp-save-')); roots.push(root)
  const pool = path.join(root, 'pool'), data = path.join(root, 'data')
  await atomicWrite(path.join(pool, 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  const service = new ManagerService(pool, data, root, async (_method, value) => value, () => undefined)
  await service.store.load(); await service.vault.load()
  const master = async () => JSON.parse(await fs.readFile(path.join(pool, 'mcp.json'), 'utf8')).mcpServers
  return { service, master, data }
}

it('refuses to overwrite another server when adding or renaming', async () => {
  const { service, master } = await fixture({ one: { command: 'one', args: [] }, two: { command: 'two', args: [] } })
  try {
    await expect(service.dispatch('mcp:save', { server: { name: 'two', transport: 'stdio', command: 'new', args: [] } })).rejects.toThrow('already exists')
    await expect(service.dispatch('mcp:save', { server: { name: 'two', transport: 'stdio', command: 'one', args: [] }, oldName: 'one' })).rejects.toThrow('already exists')
    expect((await master()).two.command).toBe('two')
  } finally { await service.auth.close() }
})

it('keeps fields the editor does not manage', async () => {
  const { service, master } = await fixture({ files: { command: 'node', args: ['a.mjs'], cwd: '/work', timeout: 30 } })
  try {
    await service.dispatch('mcp:save', { server: { name: 'files', transport: 'stdio', command: 'node', args: ['b.mjs'], env: {} }, oldName: 'files' })
    expect(await master()).toMatchObject({ files: { command: 'node', args: ['b.mjs'], cwd: '/work', timeout: 30 } })
  } finally { await service.auth.close() }
})

it('carries the device launch override and sign-in setting across a rename', async () => {
  const { service, master, data } = await fixture({ old: { command: 'node', args: ['server.mjs'] } })
  try {
    await service.preparation.setOverride('old', { command: process.execPath, args: ['local.mjs'] })
    await service.dispatch('mcp:save', { server: { name: 'renamed', transport: 'stdio', command: 'node', args: ['server.mjs'] }, oldName: 'old' })
    expect(Object.keys(await master())).toEqual(['renamed'])
    const overrides = await fs.readdir(path.join(data, 'mcp-device', 'overrides'))
    expect(overrides).toContain('renamed.json'); expect(overrides).not.toContain('old.json')
  } finally { await service.auth.close() }
})

it('drops a remote sign-in when the server URL changes', async () => {
  const { service } = await fixture({ remote: { type: 'http', url: 'https://one.example/mcp' } })
  try {
    service.store.config.mcpAuth = { remote: { enabled: true, secretRef: 'remote-auth' } }; await service.vault.set('remote-auth', '{"tokens":{}}')
    const result = await service.dispatch('mcp:save', { server: { name: 'remote', transport: 'http', url: 'https://two.example/mcp', headers: {} }, oldName: 'remote' })
    expect(service.store.config.mcpAuth?.remote).toBeUndefined(); expect(service.vault.refs()).not.toContain('remote-auth')
    expect(result.warnings.join(' ')).toContain('sign in again')
  } finally { await service.auth.close() }
})
