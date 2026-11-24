import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as toml } from 'smol-toml'
import { parse as yaml } from 'yaml'
import { openDb } from '../src/main/db'
import { scanJsonlFile } from '../src/main/providers/jsonl'
import { createPiParser } from '../src/main/providers/pi'
import { createKimiParser } from '../src/main/providers/kimi'
import { decodeZstdFrames, latestSessionLog, parseDshSession } from '../src/main/providers/deepseek'
import { mistralAdapter } from '../src/main/providers/mistral'
import { cursorSessionFromToken, parseCursorUsageCsv } from '../src/main/providers/cursor'
import { DSH_END, DSH_START, dshOwnedServers, renderDshPatch } from '../src/main/manager/dsh-patch'
import { ManagerStore, atomicWrite } from '../src/main/manager/storage'
import { SyncEngine } from '../src/main/manager/sync'
import { surfaceSummary } from '../src/shared/harnesses'
import type { Settings } from '../src/shared/types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const tmp = (prefix: string): string => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(dir); return dir }
const run = (parser: { line(s: string): void; events(): any[] }, lines: unknown[]): any[] => { for (const l of lines) parser.line(JSON.stringify(l)); return parser.events() }

describe('pi sessions', () => {
  const header = { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-11-24T14:00:00.000Z', cwd: 'C:\\proj' }
  const assistant = { type: 'message', id: 'b2c3d4e5', parentId: 'a1', timestamp: '2026-11-24T14:00:02.000Z', message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', timestamp: 1795528801200, usage: { input: 1200, output: 340, cacheRead: 50000, cacheWrite: 800, reasoning: 120, totalTokens: 52340, cost: { total: 0.0267 } } } }
  it('records each model call with its cost, and a fork lands on the same row', () => {
    const events = run(createPiParser('a.jsonl', null), [header, { type: 'message', id: 'u1', timestamp: '2026-11-24T14:00:01.000Z', message: { role: 'user' } }, assistant])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ provider: 'pi', ts: 1795528801200, session_id: 'sess-1', project: 'C:\\proj', model: 'claude-sonnet-4-5', input_tokens: 1200, output_tokens: 340, cache_read_tokens: 50000, cache_write_tokens: 800, reasoning_tokens: 120, cost_usd: 0.0267 })
    const fork = run(createPiParser('b.jsonl', null), [{ ...header, id: 'sess-2', parentSession: 'sess-1' }, assistant])
    expect(fork[0].id).toBe(events[0].id)
  })
  it('counts compaction and usage entries under the current model, and leaves local models unpriced', () => {
    const events = run(createPiParser('a.jsonl', null), [header, { type: 'model_change', id: 'm', timestamp: '2026-11-24T14:00:00.500Z', provider: 'ollama', modelId: 'qwen3:8b' },
      { type: 'compaction', id: 'c', timestamp: '2026-11-24T14:05:00.000Z', summary: '…', usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
      { type: 'usage', id: 'u', timestamp: '2026-11-24T14:06:00.000Z', kind: 'classify', provider: 'openai', model: 'gpt-5-mini', usage: { input: 10, output: 5 } }])
    expect(events.map(e => [e.model, e.input_tokens, e.cost_usd])).toEqual([['qwen3:8b', 900, null], ['gpt-5-mini', 10, null]])
  })
})

describe('Kimi Code sessions', () => {
  it('reads usage.record lines only, resolves the model alias and keys forks alike', () => {
    const file = path.join('home', 'sessions', 'wd_x', 'session_1', 'agents', 'main', 'wire.jsonl')
    const record = { type: 'usage.record', agentId: 'main', model: 'kimi-code/k3', usage: { inputOther: 14168, output: 8, inputCacheRead: 2000, inputCacheCreation: 10 }, usageScope: 'turn', time: 1795098852473 }
    const events = run(createKimiParser(file, null, { 'kimi-code/k3': 'kimi-k2.6' }), [
      { type: 'metadata', protocol_version: '1.5', created_at: 1795098850000 }, record,
      { type: 'context.append_loop_event', agentId: 'main', event: { type: 'step.end', usage: record.usage }, time: record.time }])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ provider: 'kimi', session_id: 'session_1', model: 'kimi-k2.6', input_tokens: 14168, output_tokens: 8, cache_read_tokens: 2000, cache_write_tokens: 10 })
    const fork = run(createKimiParser(path.join('home', 'sessions', 'wd_x', 'session_2', 'agents', 'main', 'wire.jsonl'), null, {}), [record])
    expect(fork[0].id).toBe(events[0].id)
    expect(fork[0].model).toBe('k3')
  })
})

describe('DeepSeek Harness sessions', () => {
  const line = (v: unknown): string => JSON.stringify(v) + '\n'
  const header = { type: 'session', version: 4, id: 'sid', createdAt: 1795600000000, cwd: 'C:\\proj', isSeeded: false, delegationDepth: 0 }
  const call = (id: string, seq: number, input: number) => ({ type: 'assistant/message', seq, time: 1795600004200 + seq, data: { turn: 0, step: 0, message: { id, role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } }, stream: [], usage: { inputTokens: input, outputTokens: 240, cacheReadTokens: 4096 } } })
  it('reads concatenated zstd frames and keeps the complete ones when the last is cut off', () => {
    const frames = [line(header), line(call('m1', 7, 812))].map(text => zlib.zstdCompressSync(Buffer.from(text)))
    expect(decodeZstdFrames(Buffer.concat(frames))).toBe(line(header) + line(call('m1', 7, 812)))
    const cut = Buffer.concat([...frames, zlib.zstdCompressSync(Buffer.from(line(call('m2', 9, 5)))).subarray(0, 12)])
    expect(decodeZstdFrames(cut)).toBe(line(header) + line(call('m1', 7, 812)))
    // Node 24 decodes only the first frame of a concatenation, so each frame must be decoded alone.
    const seen: Buffer[] = []
    decodeZstdFrames(cut, b => { seen.push(Buffer.from(b)); return zlib.zstdDecompressSync(b) })
    expect(seen).toEqual(frames)
    const skippable = Buffer.alloc(12); skippable.writeUInt32LE(0x184d2a50, 0); skippable.writeUInt32LE(4, 4)
    expect(decodeZstdFrames(Buffer.concat([frames[0], skippable, frames[1]]))).toBe(line(header) + line(call('m1', 7, 812)))
  })
  it('records each call once and skips what a fork inherited', () => {
    const events = parseDshSession([header, call('m1', 7, 812)].map(line).join(''), 'x/session.v4.jsonl.zstd')
    expect(events[0]).toMatchObject({ provider: 'deepseek', id: 'deepseek:m1', model: 'deepseek-flash', input_tokens: 812, output_tokens: 240, cache_read_tokens: 4096, project: 'C:\\proj' })
    const forked = parseDshSession([{ ...header, id: 'child', isSeeded: true }, call('m1', 7, 812), { type: 'session/end-seed', seq: 8, time: 1, data: { inherited: true } }, call('m3', 9, 50)].map(line).join(''), 'y/session.v4.jsonl.zstd')
    expect(forked.map(e => e.id)).toEqual(['deepseek:m3'])
  })
  it('picks the newest log generation', () => {
    const dir = tmp('aiu-dsh-')
    for (const name of ['session.jsonl', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.lock']) fs.writeFileSync(path.join(dir, name), '')
    expect(path.basename(latestSessionLog(dir)!)).toBe('session.v4.jsonl.zstd')
  })
})

describe('Mistral Vibe unified sessions', () => {
  it('records how much a session total grew, dated when it changed', () => {
    const root = tmp('aiu-vibe3-'), dir = path.join(root, 'logs', 'session', 'unified', 'sess-9')
    const write = (gen: string, input: number, output: number, cached: number, updatedAt: string): void => {
      fs.mkdirSync(path.join(dir, 'generations', gen), { recursive: true })
      fs.writeFileSync(path.join(dir, 'generations', gen, 'projection-state.json'), JSON.stringify({ snapshot: { session: { id: 'sess-9', createdAt: '2026-11-24T09:00:00Z', updatedAt, tokenUsage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedInputTokens: cached } } } }))
      fs.writeFileSync(path.join(dir, 'CURRENT'), gen)
    }
    fs.writeFileSync(path.join(root, 'config.toml'), '')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ session_id: 'sess-9', environment: { working_directory: 'C:\\proj' }, config: { active_model: 'devstral', model_name: 'devstral-2' } }))
    const db = openDb(path.join(root, 'usage.db')), settings = { paths: { mistral: root } } as unknown as Settings
    try {
      write('0000000000000001', 10_000, 500, 6_000, '2026-11-24T10:00:00Z')
      expect(mistralAdapter.scan(settings, db).eventsAdded).toBe(1)
      write('0000000000000002', 15_000, 900, 9_000, '2026-11-24T11:00:00Z')
      mistralAdapter.scan(settings, db)
      const rows = db.prepare(`SELECT ts, model, project, input_tokens i, output_tokens o, cache_read_tokens c FROM usage_events WHERE provider = 'mistral' ORDER BY ts`).all() as any[]
      expect(rows.map(r => [r.i, r.o, r.c])).toEqual([[4_000, 500, 6_000], [2_000, 400, 3_000]])
      expect(rows[1]).toMatchObject({ ts: Date.parse('2026-11-24T11:00:00Z'), model: 'devstral-2', project: 'C:\\proj' })
      expect(mistralAdapter.scan(settings, db).eventsAdded).toBe(0)
    } finally { db.close() }
  })
})

describe('Cursor usage export', () => {
  it('reads billed rows with separate or nested cache-write columns', () => {
    const header = 'Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost'
    const separate = parseCursorUsageCsv(`${header}\n2026-11-20T10:00:00.000Z,,,Usage-based,claude-4.5-sonnet,No,1000,200,5000,300,6500,$0.12\n`)
    expect(separate[0]).toMatchObject({ provider: 'cursor', model: 'claude-4.5-sonnet', input_tokens: 200, cache_write_tokens: 1000, cache_read_tokens: 5000, output_tokens: 300, cost_usd: 0.12 })
    const nested = parseCursorUsageCsv(`${header}\n"2026-11-20T10:00:00.000Z",,,Included,auto,No,1000,200,5000,300,6300,Included\n`)
    expect(nested[0]).toMatchObject({ input_tokens: 200, cache_write_tokens: 800, cost_usd: null })
    expect(parseCursorUsageCsv(`${header}\n2026-11-20T10:00:00.000Z,,,Errored,auto,No,0,0,0,0,0,$0.00\n`)).toEqual([])
  })
  it('builds the dashboard cookie from the editor sign-in, and says when it is encrypted', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'auth0|user_123' })).toString('base64url')
    expect(cursorSessionFromToken(`h.${payload}.s`)).toEqual({ cookie: `WorkosCursorSessionToken=${encodeURIComponent(`user_123::h.${payload}.s`)}` })
    expect('error' in cursorSessionFromToken('cursor-safe-storage:v1:abc')).toBe(true)
  })
})

describe('DeepSeek Harness patch block', () => {
  it('adds, replaces and removes only AI Usage’s block, keeping the file a YAML list', () => {
    const warnings: string[] = []
    const mine = '# my settings\n- id: settings\n  config: {}\n'
    const added = renderDshPatch(mine, [['github', { command: 'C:\\Program Files\\node.exe', args: ['x.js', '--relay', 'github'] }], ['web', { url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }]], warnings)!
    expect(added.startsWith(mine.trimEnd())).toBe(true)
    const doc = yaml(added) as any[]
    expect(doc[1].insert.map((r: any) => r.config)).toEqual([
      { serverName: 'github', transport: 'stdio', command: 'C:\\Program Files\\node.exe', args: ['x.js', '--relay', 'github'] },
      { serverName: 'web', transport: 'streamable-http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }])
    expect(Object.keys(dshOwnedServers(added))).toEqual(['github', 'web'])
    const replaced = renderDshPatch(added, [['web', { url: 'https://y/mcp' }]], warnings)!
    expect(replaced.split(DSH_START)).toHaveLength(2)
    expect(Object.keys(dshOwnedServers(replaced))).toEqual(['web'])
    expect(renderDshPatch(replaced, [], warnings)).toBe(mine)
    expect(renderDshPatch(`${DSH_START}\n- insert:\n    - {"id":"aiu-a","name":"x","config":{"serverName":"a"}}\n${DSH_END}\n`, [], warnings)).toBe('[]\n')
    expect(yaml(renderDshPatch('[]\n', [['a', { command: 'x' }]], warnings)!)).toHaveLength(1)
    expect(renderDshPatch(null, [], warnings)).toBeNull()
    expect(renderDshPatch('[{id: x}]\n', [['a', { command: 'x' }]], warnings)).toBeNull()
    renderDshPatch(null, [['a'.repeat(33), { command: 'x' }]], warnings)
    expect(warnings.some(w => w.includes('32 characters'))).toBe(true)
  })
})

describe('new sync targets', () => {
  async function fixture() {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiu-harness-')); roots.push(home)
    const store = new ManagerStore(path.join(home, '.agents'), path.join(home, 'data')); await store.load()
    await atomicWrite(path.join(store.pool, 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: process.execPath, args: ['server.mjs'] }, remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'test' } } } }))
    await atomicWrite(path.join(store.pool, 'manager-runtime.json'), JSON.stringify({ node: process.execPath, cli: path.join(home, 'manager.mjs') }))
    await atomicWrite(path.join(store.pool, 'AGENTS.md'), 'Master instructions')
    await atomicWrite(path.join(home, '.vibe/config.toml'), 'active_model = "devstral"\n\n[[mcp_servers]]\nname = "mine"\ntransport = "stdio"\ncommand = "own"\n')
    await atomicWrite(path.join(home, '.kimi-code/config.toml'), '')
    await atomicWrite(path.join(home, '.dsh/cordis.patch.yml'), '[]\n')
    await atomicWrite(path.join(home, '.pi/agent/settings.json'), '{}')
    await atomicWrite(path.join(home, '.cursor/mcp.json'), '{}')
    return { home, engine: new SyncEngine(store, home) }
  }
  it('writes each client’s own MCP format and instructions file', async () => {
    const { home, engine } = await fixture()
    expect((await engine.sync()).conflicts).toEqual([])
    const relay = [path.join(home, 'manager.mjs'), '--relay', 'shared']
    const vibe = toml(await fsp.readFile(path.join(home, '.vibe/config.toml'), 'utf8')) as any
    expect(vibe.active_model).toBe('devstral')
    expect(vibe.mcp_servers.map((s: any) => s.name)).toEqual(['mine', 'shared', 'remote'])
    expect(vibe.mcp_servers[1]).toMatchObject({ transport: 'stdio', command: [process.execPath], args: relay })
    expect(vibe.mcp_servers[2]).toMatchObject({ transport: 'streamable-http', url: 'https://mcp.example/mcp', auth: { type: 'static', headers: { Authorization: 'test' } } })
    expect(await fsp.readFile(path.join(home, '.vibe/AGENTS.md'), 'utf8')).toBe('Master instructions')
    const kimi = JSON.parse(await fsp.readFile(path.join(home, '.kimi-code/mcp.json'), 'utf8')).mcpServers
    expect(kimi.remote).toEqual({ url: 'https://mcp.example/mcp', headers: { Authorization: 'test' } })
    const pi = JSON.parse(await fsp.readFile(path.join(home, '.pi/agent/mcp.json'), 'utf8')).mcpServers
    expect(pi.shared).toEqual({ command: process.execPath, args: relay })
    expect(await fsp.readFile(path.join(home, '.pi/agent/AGENTS.md'), 'utf8')).toBe('Master instructions')
    expect(JSON.parse(await fsp.readFile(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers.shared.type).toBe('stdio')
    const dsh = yaml(await fsp.readFile(path.join(home, '.dsh/cordis.patch.yml'), 'utf8')) as any[]
    expect(dsh).toHaveLength(1); expect(dsh[0].insert.map((r: any) => r.config.serverName)).toEqual(['shared', 'remote'])
    // Kimi Code and DeepSeek Harness read ~/.agents/AGENTS.md themselves: no copy.
    await expect(fsp.access(path.join(home, '.kimi-code/AGENTS.md'))).rejects.toThrow()
    // A second sync changes nothing and nothing counts as an outside edit.
    const again = await engine.preview(); expect(again.changes.filter(c => c.conflict)).toEqual([])
  })
  it('keeps Vibe in sync when Vibe rewrites its own file, and leaves user rows in the DeepSeek patch alone', async () => {
    const { home, engine } = await fixture(); await engine.sync()
    const file = path.join(home, '.vibe/config.toml'), doc = toml(await fsp.readFile(file, 'utf8')) as any
    // Vibe re-serialises the whole file when it saves a setting: other key order, same entries.
    await atomicWrite(file, `theme = "dark"\nactive_model = "devstral"\n${(await fsp.readFile(file, 'utf8')).split('\n').filter(l => !l.startsWith('active_model')).join('\n')}`)
    const dsh = path.join(home, '.dsh/cordis.patch.yml')
    await atomicWrite(dsh, `- id: settings\n  config: {}\n\n${await fsp.readFile(dsh, 'utf8')}`)
    const preview = await engine.preview()
    expect(preview.changes.filter(c => c.conflict)).toEqual([])
    expect(doc.mcp_servers).toHaveLength(3)
    await engine.sync()
    expect((yaml(await fsp.readFile(dsh, 'utf8')) as any[])[0].id).toBe('settings')
  })
})

describe('surfaces', () => {
  it('lists what this device has first', () => {
    expect(surfaceSummary([{ kind: 'cli', label: 'CLI', detected: false }, { kind: 'desktop', label: 'Desktop app', detected: true }])).toBe('Desktop app + CLI')
  })
})
