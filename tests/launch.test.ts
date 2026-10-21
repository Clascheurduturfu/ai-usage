import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentLauncher } from '../src/main/manager/launch'
import { ManagerStore, Vault, atomicWrite } from '../src/main/manager/storage'

const roots: string[] = []
const originalHost = process.env.AIU_HOST_EXE
afterEach(async () => { if (originalHost === undefined) delete process.env.AIU_HOST_EXE; else process.env.AIU_HOST_EXE = originalHost; for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-launch-')); roots.push(root)
  process.env.AIU_HOST_EXE = path.join(root, 'app.exe')
  const store = new ManagerStore(path.join(root, '.agents'), path.join(root, 'data')); await store.load()
  const statusFile = path.join(root, 'approval.json'), calls: string[] = []
  const native = async (method: string, value: string): Promise<string> => {
    calls.push(method)
    if (method === 'desktop-read') return '{}'
    if (method.startsWith('desktop-')) return JSON.stringify({ pending: true, statusFile, helper: path.join(root, 'helper.bat') })
    return value
  }
  const vault = new Vault(path.join(store.data, 'vault.json'), native); await vault.load(); await vault.set('client', 'fixture-client-key')
  store.config.proxies.push({ id: 'proxy', name: 'Fixture', port: 18317, autostart: false, clientSecretRef: 'client', routes: [{ alias: 'claude-sonnet-4-6', model: 'upstream', endpointId: 'default-ollama', family: 'sonnet' }] })
  store.config.profiles.push({ id: 'desktop', name: 'Fixture', agentId: 'claude-desktop', proxyId: 'proxy', model: 'claude-sonnet-4-6', mcpNames: [], disabledSkills: [], instructions: false })
  const launcher = new AgentLauncher(store, vault, { start: async () => undefined } as any, native, root)
  return { root, launcher, statusFile, calls, backup: path.join(store.data, 'endpoint-defaults/claude-desktop.json') }
}
it('reports pending Windows approval without claiming the default was applied', async () => {
  const { launcher, statusFile, calls, backup } = await fixture()
  expect((await launcher.applyDefault('desktop')).changed).toBe(0)
  expect((await launcher.applyDefault('desktop')).changed).toBe(0)
  expect(calls.filter(c => c === 'desktop-apply')).toHaveLength(1)
  await atomicWrite(statusFile, '{"ok":true}')
  expect((await launcher.applyDefault('desktop')).changed).toBe(2)
  expect(JSON.parse(await fs.readFile(backup, 'utf8')).pending).toBeUndefined()
})
it('retains the backup until an elevated restore actually completes', async () => {
  const { launcher, statusFile, backup } = await fixture()
  await launcher.applyDefault('desktop'); await atomicWrite(statusFile, '{"ok":true}'); await launcher.applyDefault('desktop')
  await fs.rm(statusFile)
  expect((await launcher.restore('claude-desktop')).changed).toBe(0)
  await expect(launcher.applyDefault('desktop')).rejects.toThrow('Finish Restore')
  expect(await fs.readFile(backup, 'utf8')).toContain('protectedBefore')
  await atomicWrite(statusFile, '{"ok":true}')
  expect((await launcher.restore('claude-desktop')).changed).toBe(1)
  await expect(fs.access(backup)).rejects.toThrow()
})
it('allows retry after a denied pending application', async () => {
  const { launcher, statusFile, backup } = await fixture()
  await launcher.applyDefault('desktop'); await atomicWrite(statusFile, '{"ok":false,"error":"Declined"}')
  await expect(launcher.applyDefault('desktop')).rejects.toThrow('retry')
  await expect(fs.access(backup)).rejects.toThrow()
  await fs.rm(statusFile)
  expect((await launcher.applyDefault('desktop')).changed).toBe(0)
})
