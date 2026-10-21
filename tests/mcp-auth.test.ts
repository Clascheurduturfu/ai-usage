import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import net from 'node:net'
import { McpAuthBroker, ipcPath } from '../src/main/manager/auth-broker'
import { ManagerStore, Vault, atomicWrite } from '../src/main/manager/storage'
import type { LocalRuntime } from '../src/main/manager/local-runtime'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

async function fixture(refresh: boolean | 'outage') {
  const refreshWorks = refresh === true, upstream = { expireNext: false }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-oauth-')); roots.push(root)
  const native = async (_method: string, value: string) => value
  const store = new ManagerStore(path.join(root, 'pool'), path.join(root, 'data')); await store.load()
  store.config.mcpAuth = { remote: { enabled: true, secretRef: 'remote-auth' } }
  await atomicWrite(path.join(store.pool, 'mcp.json'), JSON.stringify({ mcpServers: { remote: { url: 'https://mcp.example/mcp' } } }))
  const vaultFile = path.join(root, 'vault.json')
  const vault = new Vault(vaultFile, native); await vault.load()
  const metadata = { issuer: 'https://mcp.example', authorization_endpoint: 'https://mcp.example/authorize', token_endpoint: 'https://mcp.example/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }
  const resource = { resource: 'https://mcp.example/mcp', authorization_servers: ['https://mcp.example'] }
  const saved = JSON.stringify({ client: { client_id: 'fixture-client', issuer: metadata.issuer }, tokens: { access_token: 'expired', refresh_token: 'fixture-refresh', token_type: 'Bearer', issuer: metadata.issuer }, discovery: { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata: resource } })
  await vault.set('remote-auth', saved)
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/token' && refresh !== 'outage') return Response.json(refreshWorks ? { access_token: 'renewed', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 } : { error: 'invalid_grant', error_description: 'Private provider detail must not appear in status' }, { status: refreshWorks ? 200 : 400 })
    if (url.pathname === '/token' && refresh === 'outage') return Response.json({ error: 'server_error' }, { status: 502 })
    if (url.pathname.includes('oauth-protected-resource')) return Response.json(resource)
    if (url.pathname.includes('oauth-authorization-server')) return Response.json(metadata)
    if (new Headers(init?.headers).get('authorization') !== 'Bearer renewed') return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' } })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const frame = JSON.parse(String(init?.body ?? '{}'))
    if (frame.id === undefined) return new Response(null, { status: 202 })
    if (frame.method !== 'initialize' && upstream.expireNext) { upstream.expireNext = false; return new Response('Session not found', { status: 404 }) }
    return Response.json({ jsonrpc: '2.0', id: frame.id, result: frame.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [{ name: 'example', inputSchema: { type: 'object' } }] } })
  })
  vi.stubGlobal('fetch', fetcher)
  const broker = new McpAuthBroker(store, vault, native, () => {}, async () => {}, { sessions: new Set(), queued: 0, queuedBytes: 0, supervisor: { paused: () => false, status: { workers: [] } } } as unknown as LocalRuntime)
  return { broker, store, vault, vaultFile, saved, fetcher, upstream }
}

it('retains a rejected saved grant and reports the refresh failure without private provider detail', async () => {
  const { broker, vault, saved } = await fixture(false)
  try {
    const result = await broker.check('remote')
    expect(result.state).toBe('Connection failed')
    expect(result.detail).toContain('HTTP 400 (invalid_grant)')
    expect(result.detail).not.toContain('Private provider detail')
    expect(await vault.get('remote-auth')).toBe(saved)
    expect(await broker.currentStatus('remote')).toContain('Reconnect required')
  } finally { await broker.close() }
})

it('persists rotated tokens after a successful refresh and can reload them after restart', async () => {
  const { broker, vault, vaultFile } = await fixture(true)
  try {
    expect((await broker.check('remote')).state).toBe('Connection verified')
    const updated = JSON.parse(await vault.get('remote-auth'))
    expect(updated.tokens.refresh_token).toBe('rotated')
    expect(updated.tokens.access_token).toBe('renewed')
    expect(updated.tokensUpdatedAt).toBeGreaterThan(0)
    const reloaded = new Vault(vaultFile, async (_method, value) => value)
    await reloaded.load(); expect(await reloaded.get('remote-auth')).toBe(JSON.stringify(updated))
  } finally { await broker.close() }
})

it('stages an independent registration on reconnect and preserves the old grant until success', async () => {
  const { broker, vault, saved } = await fixture(false)
  try {
    const provider = (broker as unknown as { provider(name: string, interactive: boolean): import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider }).provider('remote', true)
    expect(await provider.clientInformation()).toBeUndefined()
    expect(await provider.tokens()).toBeUndefined()
    await provider.saveClientInformation!({ client_id: 'independent-client', issuer: 'https://mcp.example' })
    expect(await vault.get('remote-auth')).toBe(saved)
    await provider.saveTokens({ access_token: 'independent-access', refresh_token: 'independent-refresh', token_type: 'Bearer', issuer: 'https://mcp.example' })
    const updated = JSON.parse(await vault.get('remote-auth'))
    expect(updated.client.client_id).toBe('independent-client')
    expect(updated.tokens.refresh_token).toBe('independent-refresh')
  } finally { await broker.close() }
})

async function relay(broker: McpAuthBroker, pool: string) {
  await broker.start(async () => undefined)
  const socket = net.createConnection(ipcPath(pool)); await new Promise(resolve => socket.once('connect', resolve))
  let buffer = ''; const waiting: Array<(value: any) => void> = []
  socket.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf(String.fromCharCode(10))) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); waiting.shift()?.(JSON.parse(line)) } })
  const call = (id: number, method: string, params: any = {}) => new Promise<any>(resolve => { waiting.push(resolve); socket.write(JSON.stringify({ token: broker.token, server: 'remote', message: { jsonrpc: '2.0', id, method, params } }) + String.fromCharCode(10)) })
  return { socket, call }
}
const initialize = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }

it('returns the sign-in failure to the coding client instead of closing the connection', async () => {
  const { broker, store } = await fixture(false)
  try {
    const { socket, call } = await relay(broker, store.pool)
    const response = await call(1, 'initialize', initialize)
    expect(response.error.message).toContain('HTTP 400 (invalid_grant)')
    expect(socket.destroyed).toBe(false)
    socket.destroy()
  } finally { await broker.close() }
})

it('keeps the saved sign-in when the token service has an outage', async () => {
  const { broker, vault, saved } = await fixture('outage')
  try {
    const result = await broker.check('remote')
    expect(result.detail).toContain('sign-in is kept')
    expect(await broker.currentStatus('remote')).toContain('Sign-in kept')
    expect(await vault.get('remote-auth')).toBe(saved)
  } finally { await broker.close() }
})

it('reopens an expired upstream session and retries the request once', async () => {
  const { broker, store, upstream } = await fixture(true)
  try {
    const { socket, call } = await relay(broker, store.pool)
    expect((await call(1, 'initialize', initialize)).result.serverInfo.name).toBe('fixture')
    upstream.expireNext = true
    const listed = await call(2, 'tools/list')
    expect(listed.result.tools[0].name).toBe('example')
    socket.destroy()
  } finally { await broker.close() }
})
