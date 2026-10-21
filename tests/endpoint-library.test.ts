import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagerStore, atomicWrite, Vault } from '../src/main/manager/storage'
import { Sharing, encryptBundle } from '../src/main/manager/sharing'
import { defaultEndpoints } from '../src/shared/endpoint-catalog'
import { responsesToChat, requireStateless } from '../proxies/responses'

describe('endpoint migration and sharing', () => {
  it('preserves IDs, keys, caches and references while separating legacy custom endpoints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-endpoints-'))
    try {
      const pool = path.join(root, 'pool'), data = path.join(root, 'data')
      const old: any = { schema: 1, revision: 'old', autoSync: false, endpoints: [{ id: 'local', name: 'Local', provider: 'ollama', protocol: 'ollama', credentialKind: 'api-key', baseUrl: 'http://127.0.0.1:11434', models: ['sample-model'], secretRef: 'key' }, { id: 'draft', name: 'Incomplete', protocol: 'openai', credentialKind: 'api-key', baseUrl: '', models: [] }], profiles: [{ id: 'example', endpointId: 'local' }], proxies: [], activeProfiles: {} }
      await atomicWrite(path.join(pool, 'manager.json'), JSON.stringify(old))
      const store = new ManagerStore(pool, data); await store.load()
      expect(store.config.endpoints.filter(e => !e.catalogId)).toHaveLength(2)
      expect(store.config.endpoints.find(e => e.id === 'local')).toMatchObject({ protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:11434/v1', secretRef: 'key', models: ['sample-model'] })
      expect(store.config.endpoints.find(e => e.id === 'draft')?.draft).toBe(true)
      expect(store.config.profiles[0].endpointId).toBe('local')
      const saved = JSON.parse(await fs.readFile(path.join(pool, 'manager.json'), 'utf8'))
      expect(saved.endpoints).toBeUndefined(); expect(saved.schema).toBe(2)
      await new ManagerStore(pool, data).load()
      const library = JSON.parse(await fs.readFile(path.join(pool, 'endpoints.custom.json'), 'utf8'))
      expect(library.custom.map((e: any) => e.id)).toEqual(['local', 'draft'])
      expect(defaultEndpoints()).toHaveLength(20)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('round-trips default overrides and custom keys through encrypted sharing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-endpoint-sharing-'))
    try {
      const store = new ManagerStore(path.join(root, 'pool'), path.join(root, 'data')); await store.load()
      const vault = new Vault(path.join(root, 'data/vault.json'), async (_method, value) => value); await vault.load()
      await fs.mkdir(path.join(store.pool, 'skills'), { recursive: true })
      const endpoint = store.config.endpoints.find(e => e.catalogId === 'openai')!
      endpoint.models = ['example']; endpoint.secretRef = 'fixture-key'; await vault.set('fixture-key', 'fixture-secret'); await store.save()
      const sharing = new Sharing(store, vault, root); await sharing.load(); await sharing.configure(path.join(root, 'sharing'), 'long fixture password'); await sharing.publish()
      endpoint.models = ['changed']; await store.save()
      await sharing.import(true)
      expect(store.config.endpoints.find(e => e.catalogId === 'openai')?.models).toEqual(['example'])
      expect(await vault.get('fixture-key')).toBe('fixture-secret')
      expect(await fs.readFile(path.join(root, 'sharing/ai-usage-shared.encrypted.json'), 'utf8')).not.toContain('fixture-secret')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
describe('Responses conversion feature boundaries', () => {
  it.each([{ previous_response_id: 'resp_example' }, { conversation: 'example' }, { store: true }, { background: true }])('rejects state that cannot be emulated: %j', input => {
    expect(() => requireStateless(input)).toThrow('Unsupported Feature')
  })
  it('rejects hosted tools instead of silently dropping them', () => {
    expect(() => responsesToChat({ input: 'Example', tools: [{ type: 'web_search_preview' }] })).toThrow('hosted tool')
  })
})
