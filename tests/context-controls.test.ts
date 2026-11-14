import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as toml } from 'smol-toml'
import { McpAuthBroker, ipcPath } from '../src/main/manager/auth-broker'
import { ManagerStore, Vault, atomicWrite } from '../src/main/manager/storage'
import { SyncEngine } from '../src/main/manager/sync'
import { McpMetricsStore, compactNames, compactToolList, parseRelayName, searchTools } from '../src/main/manager/mcp-metrics'
import type { LocalRuntime } from '../src/main/manager/local-runtime'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const temp = async (): Promise<string> => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-context-')); roots.push(root); return root }

const TOOLS = Array.from({ length: 40 }, (_, i) => ({ name: i === 7 ? 'decompile_function' : `tool_${i}`, description: i === 7 ? 'Decompile one native function to pseudo-code' : `Fixture tool number ${i}`, inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'x'.repeat(200) } } }, outputSchema: { type: 'object', description: 'y'.repeat(800) } }))
const VISIBLE = Buffer.byteLength(JSON.stringify(TOOLS.map(({ outputSchema: _o, ...t }) => t)))

describe('compact tool helpers', () => {
  it('parses the compact relay suffix', () => {
    expect(parseRelayName('rea@compact')).toEqual({ name: 'rea', compact: true })
    expect(parseRelayName('rea')).toEqual({ name: 'rea', compact: false })
  })
  it('replaces a large tool list with two small tools that name every tool', () => {
    const list = compactToolList('rea', TOOLS)
    expect(list.tools.map(t => t.name)).toEqual([compactNames('rea').search, compactNames('rea').call])
    expect(list.tools[0].description).toContain('decompile_function')
    expect(JSON.stringify(list).length).toBeLessThan(JSON.stringify(TOOLS).length / 3)
  })
  it('finds tools by keyword or exact names', () => {
    expect(searchTools(TOOLS, 'decompile native')[0].name).toBe('decompile_function')
    expect(searchTools(TOOLS, 'tool_3, tool_4').map(t => t.name)).toEqual(['tool_3', 'tool_4'])
    expect(searchTools(TOOLS, 'fixture', 50)).toHaveLength(20)
  })
})

async function brokerFixture() {
  const root = await temp(), native = async (_method: string, value: string) => value
  const store = new ManagerStore(path.join(root, 'pool'), path.join(root, 'data')); await store.load()
  await atomicWrite(path.join(store.pool, 'mcp.json'), JSON.stringify({ mcpServers: { big: { command: 'node', args: ['server.mjs'] } } }))
  const vault = new Vault(path.join(root, 'vault.json'), native); await vault.load()
  const forwarded: any[] = []
  // A fake local worker: answers initialize, lists TOOLS and echoes calls.
  const runtime = {
    sessions: new Set(), queued: 0, queuedBytes: 0, supervisor: { paused: () => false, status: { workers: [] } },
    session: (_name: string, _spec: unknown, reply: (value: any) => void) => ({
      send: async (message: any) => {
        forwarded.push(message)
        if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'big', version: '1' } } })
        else if (message.method === 'tools/list') reply({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
        else if (message.method === 'tools/call') reply({ jsonrpc: '2.0', id: message.id, result: message.params.name === 'tool_9' ? { isError: true, content: [] } : { content: [{ type: 'text', text: `ran ${message.params.name} ${JSON.stringify(message.params.arguments)}` }] } })
      },
      close: async () => undefined
    })
  } as unknown as LocalRuntime
  const metrics = new McpMetricsStore(path.join(root, 'data'))
  const broker = new McpAuthBroker(store, vault, native, () => {}, async () => ({ command: 'node', args: ['server.mjs'] }), runtime, metrics)
  await broker.start(async () => undefined)
  const connect = async (server: string) => {
    const socket = net.createConnection(ipcPath(store.pool)); await new Promise(resolve => socket.once('connect', resolve))
    let buffer = ''; const waiting: Array<(value: any) => void> = []
    socket.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); waiting.shift()?.(JSON.parse(line)) } })
    const call = (id: number, method: string, params: any = {}) => new Promise<any>(resolve => { waiting.push(resolve); socket.write(JSON.stringify({ token: broker.token, server, message: { jsonrpc: '2.0', id, method, params } }) + '\n') })
    await call(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    return { socket, call }
  }
  return { broker, metrics, forwarded, connect }
}

describe('relay metrics and compact mode', () => {
  it('measures tool lists and counts calls, including failures', async () => {
    const { broker, metrics, connect } = await brokerFixture()
    try {
      const { socket, call } = await connect('big')
      expect((await call(1, 'tools/list')).result.tools).toHaveLength(40)
      await call(2, 'tools/call', { name: 'tool_1', arguments: {} }); await call(3, 'tools/call', { name: 'tool_1', arguments: {} }); await call(4, 'tools/call', { name: 'tool_9', arguments: {} })
      const big = metrics.snapshot().big
      expect(big.tools).toBe(40); expect(big.schemaBytes).toBe(VISIBLE)
      expect(big.calls).toBe(3); expect(big.errors).toBe(1); expect(big.byTool).toEqual({ tool_1: 2, tool_9: 1 })
      socket.destroy()
    } finally { await broker.close() }
  })
  it('serves search + call to compact clients and forwards the real tool', async () => {
    const { broker, metrics, forwarded, connect } = await brokerFixture()
    try {
      const { socket, call } = await connect('big@compact'), names = compactNames('big')
      const listed = await call(1, 'tools/list')
      expect(listed.result.tools.map((t: any) => t.name)).toEqual([names.search, names.call])
      const found = JSON.parse((await call(2, 'tools/call', { name: names.search, arguments: { query: 'decompile' } })).result.content[0].text)
      expect(found[0]).toMatchObject({ name: 'decompile_function', inputSchema: { type: 'object' } })
      const ran = await call(3, 'tools/call', { name: names.call, arguments: { name: 'decompile_function', arguments: { address: '0x10' } } })
      expect(ran.result.content[0].text).toBe('ran decompile_function {"address":"0x10"}')
      expect(forwarded.some(m => m.method === 'tools/call' && m.params.name === 'decompile_function')).toBe(true)
      expect(metrics.snapshot().big).toMatchObject({ tools: 40, calls: 1, byTool: { decompile_function: 1 } })
      expect((await call(4, 'tools/call', { name: names.call, arguments: {} })).error.message).toContain(names.search)
      socket.destroy()
    } finally { await broker.close() }
  })
})

describe('context budget estimate', () => {
  const agent = (id: 'claude' | 'zcode') => ({ id, name: id, installed: true, configPath: '', skillControl: id === 'claude' ? 'native' as const : 'shared' as const, endpointSupport: false, restartRequired: true })
  const snapshot = (config: Record<string, unknown> = {}) => ({
    config: { schema: 2, revision: '', autoSync: false, endpoints: [], proxies: [], profiles: [], activeProfiles: {}, ...config },
    agents: [agent('claude'), agent('zcode')], skills: [{ name: 'skill', description: 'x'.repeat(360), path: '', valid: true }], mcp: [{ name: 'big', transport: 'stdio' as const }, { name: 'small', transport: 'stdio' as const }],
    proxies: [], sharing: { folder: '', enabled: false, unlocked: false, pending: 0 }, secrets: [], logs: [], instructions: 'r'.repeat(4000),
    mcpMetrics: { big: { tools: 170, schemaBytes: 400_000, calls: 0, errors: 0, byTool: {} }, small: { tools: 2, schemaBytes: 800, calls: 0, errors: 0, byTool: {} } }
  }) as any
  it('charges eager clients for every schema and lazy clients for names only', async () => {
    const { agentBudget } = await import('../src/renderer/src/lib/budget')
    const data = snapshot()
    const eager = agentBudget(data.agents[1], data), lazy = agentBudget(data.agents[0], data)
    expect(eager.mcp).toBe(100_200); expect(eager.over).toBe(true); expect(eager.instructions).toBe(1000); expect(eager.skills).toBe(101)
    expect(lazy.mcp).toBe(172 * 15); expect(lazy.over).toBe(false)
  })
  it('drops disabled servers and shrinks compact ones', async () => {
    const { agentBudget } = await import('../src/renderer/src/lib/budget')
    expect(agentBudget(snapshot().agents[1], snapshot({ disabledMcp: ['big'] })).mcp).toBe(200)
    const compact = agentBudget(snapshot().agents[1], snapshot({ compactMcp: ['big'] }))
    expect(compact.mcp).toBeLessThan(2000); expect(compact.lines.find(l => l.name === 'big')?.note).toBe('compact')
  })
  it('suggests disabling only costly servers idle for a fully observed window', async () => {
    const { idleServers } = await import('../src/renderer/src/lib/budget')
    const now = Date.UTC(2026, 10, 14), day = 86_400_000
    const data = snapshot()
    data.mcpMetrics = {
      big: { tools: 50, schemaBytes: 400_800, calls: 1, errors: 0, lastCall: now - 40 * day, trackedSince: now - 60 * day, byTool: {} },
      small: { tools: 2, schemaBytes: 800, calls: 0, errors: 0, trackedSince: now - 60 * day, byTool: {} }
    }
    expect(idleServers(data, now).map(s => s.name)).toEqual(['big'])
    data.mcpMetrics.big.lastCall = now - 2 * day
    expect(idleServers(data, now)).toEqual([])
    // A fresh install has not observed 30 days yet: nothing is flagged.
    data.mcpMetrics.big = { ...data.mcpMetrics.big, lastCall: undefined, trackedSince: now - 5 * day }
    expect(idleServers(data, now)).toEqual([])
    data.mcpMetrics.big.trackedSince = now - 31 * day
    expect(idleServers(data, now)[0]?.name).toBe('big')
    data.config.compactMcp = ['big']
    expect(idleServers(data, now)).toEqual([])
  })
})

async function syncFixture() {
  const home = await temp()
  const store = new ManagerStore(path.join(home, '.agents'), path.join(home, 'data')); await store.load()
  await atomicWrite(path.join(store.pool, 'mcp.json'), JSON.stringify({ mcpServers: { heavy: { command: process.execPath, args: ['heavy.mjs'] }, light: { command: process.execPath, args: ['light.mjs'] } } }))
  await atomicWrite(path.join(store.pool, 'manager-runtime.json'), JSON.stringify({ node: process.execPath, cli: path.join(home, 'manager.mjs') }))
  await atomicWrite(path.join(store.pool, 'skills/big-skill/SKILL.md'), '---\nname: big-skill\ndescription: Large\n---\nBody')
  await atomicWrite(path.join(home, '.codex/config.toml'), 'model = "keep"\n')
  await atomicWrite(path.join(home, '.claude.json'), '{}')
  return { home, store, engine: new SyncEngine(store, home) }
}

describe('global library controls in sync', () => {
  it('removes a globally disabled MCP and skill from every client', async () => {
    const { home, store, engine } = await syncFixture()
    const claudeSkill = path.join(home, '.claude/skills/big-skill/SKILL.md'), shared = path.join(store.skillRoot, 'big-skill/SKILL.md'), parked = path.join(store.parkedSkillRoot, 'big-skill/SKILL.md')
    const present = (file: string) => fs.access(file).then(() => true, () => false)
    await engine.sync()
    // Claude Code reads its own folder, so it gets a copy of the shared skills.
    expect(await fs.readFile(claudeSkill, 'utf8')).toContain('name: big-skill')
    store.config.disabledMcp = ['heavy']; store.config.disabledSkills = ['big-skill']
    expect((await engine.sync()).conflicts).toEqual([])
    const codex = toml(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')) as any
    expect(codex.mcp_servers.heavy).toBeUndefined(); expect(codex.mcp_servers.light).toBeDefined()
    // The folder itself leaves the shared library, so clients that scan it stop seeing it.
    expect(await present(shared)).toBe(false); expect(await present(parked)).toBe(true); expect(await present(claudeSkill)).toBe(false)
    expect(codex.skills.config).toEqual([])
    expect((await store.skills()).map(s => s.name)).toEqual(['big-skill'])
    expect(await store.skillPath('big-skill')).toBe(parked)
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.heavy).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8')).skillOverrides['big-skill']).toBe('off')
    store.config.disabledMcp = []; store.config.disabledSkills = []
    expect((await engine.sync()).conflicts).toEqual([])
    expect((toml(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')) as any).mcp_servers.heavy).toBeDefined()
    expect(await present(shared)).toBe(true); expect(await present(parked)).toBe(false); expect(await present(claudeSkill)).toBe(true)
  })
  it('compacts relays for eager clients only', async () => {
    const { home, store, engine } = await syncFixture()
    store.config.compactMcp = ['heavy']
    await engine.sync()
    const codex = toml(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')) as any
    expect(codex.mcp_servers.heavy.args.at(-1)).toBe('heavy@compact'); expect(codex.mcp_servers.light.args.at(-1)).toBe('light')
    const claude = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.heavy.args.at(-1)).toBe('heavy')
  })
})
