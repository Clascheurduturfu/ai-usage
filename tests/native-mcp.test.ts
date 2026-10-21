import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeSupervisor } from '../src/main/manager/native-supervisor'
import { LocalRuntime } from '../src/main/manager/local-runtime'
const executable = process.env.AIU_MCP_EXE
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-native-'))
  closers.push(() => fs.rm(root, { recursive: true, force: true }))
  const supervisor = new NativeSupervisor(root, async (_method, value) => value, () => undefined, root)
  await supervisor.start(); closers.push(() => supervisor.close())
  const runtime = new LocalRuntime(supervisor, () => undefined)
  const journal = path.join(root, 'fixture-events.jsonl')
  const spec = { command: process.execPath, args: [path.resolve('tests/fixtures/mcp-worker.mjs'), journal] }
  const frames: any[][] = []
  const session = () => { const replies: any[] = []; frames.push(replies); const s = runtime.session('fixture', spec, message => replies.push(message)); closers.push(() => s.close()); return s }
  const initialize = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }
  return { root, supervisor, runtime, journal, session, frames, initialize, spec }
}
describe.skipIf(!executable)('native MCP ownership and virtual sessions', () => {
  it('keeps root-dependent metadata isolated and replays each client roots on wake', async () => {
    const f = await setup()
    const frames: any[][] = [[], []]
    const sessions = frames.map((replies, index) => {
      const roots = [{ uri: 'file:///example-' + index, name: 'root-' + index }]
      const s = f.runtime.session('fixture', f.spec, message => { if (message.method === 'roots/list') void s.send({ jsonrpc: '2.0', id: message.id, result: { roots } }); else replies.push(message) })
      closers.push(() => s.close()); return s
    })
    await Promise.all(sessions.map(s => s.send({ ...f.initialize, params: { ...f.initialize.params, capabilities: { roots: {} } } })))
    for (const [index, s] of sessions.entries()) {
      await s.send({ jsonrpc: '2.0', id: 'list', method: 'tools/list' })
      expect(frames[index].at(-1).result.tools[0].name).toBe('root-' + index)
      await s.send({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'fixture' } })
      expect(JSON.parse(frames[index].at(-1).result.content[0].text).roots[0].name).toBe('root-' + index)
    }
  })
  it('keeps six initialized clients idle and replays the handshake on demand', async () => {
    const f = await setup()
    const sessions = Array.from({ length: 6 }, f.session)
    await Promise.all(sessions.map(s => s.send(f.initialize)))
    await f.supervisor.refresh(); expect(f.supervisor.status.workers).toHaveLength(0)
    const events = (await fs.readFile(f.journal, 'utf8')).trim().split('\n')
    expect(events).toHaveLength(1)
    await sessions[0].send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture', arguments: {} } })
    expect(JSON.parse(f.frames[0].at(-1).result.content[0].text).ready).toBe(true)
    await f.supervisor.refresh(); expect(f.supervisor.status.workers).toHaveLength(1)
  })
  it('does not queue a second client behind a slow client and Stop interrupts work', async () => {
    const f = await setup(), slow = f.session(), fast = f.session()
    await Promise.all([slow.send(f.initialize), fast.send(f.initialize)])
    const pending = slow.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture', arguments: { delay: 20_000 } } }).catch(error => error)
    const started = Date.now()
    await fast.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fixture', arguments: {} } })
    expect(Date.now() - started).toBeLessThan(3000)
    await f.runtime.stop('fixture')
    expect(await pending).toBeInstanceOf(Error)
    await f.supervisor.refresh(); expect(f.supervisor.status.workers).toHaveLength(0)
    await expect(fast.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })).rejects.toThrow('paused')
    await f.supervisor.control('resume', 'fixture')
    await fast.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fixture' } })
    expect(JSON.parse(f.frames[1].at(-1).result.content[0].text).ready).toBe(true)
  }, 15_000)
  it('kills owned children and grandchildren while leaving an unrelated process intact', async () => {
    const f = await setup(), s = f.session()
    await s.send(f.initialize)
    await s.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture', arguments: { children: true } } })
    for (let i = 0; i < 30; i++) { if ((await fs.readFile(f.journal, 'utf8')).includes('grandchild')) break; await new Promise(r => setTimeout(r, 50)) }
    const events = (await fs.readFile(f.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const pids = events.flatMap(e => [e.child, e.grandchild].filter(Boolean))
    expect(pids).toHaveLength(2)
    await f.runtime.stop('fixture')
    for (let i = 0; i < 40; i++) { if (pids.every(pid => { try { process.kill(pid, 0); return false } catch { return true } })) break; await new Promise(r => setTimeout(r, 50)) }
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  }, 15_000)
  it('reserves capacity for discovery when six isolated workers are resident', async () => {
    const f = await setup()
    const workers = Array.from({ length: 6 }, (_, i) => f.supervisor.transport('stateful-' + i, f.spec))
    for (const worker of workers) { await worker.start(); closers.push(() => worker.close()) }
    const ninth = f.supervisor.transport('overflow', f.spec)
    await expect(ninth.start()).rejects.toThrow('Pool saturated')
    const s = f.session(); await s.send(f.initialize)
    expect(f.frames[0][0].result.serverInfo.name).toBe('fixture')
  })
  it.each(['disconnect', 'quit', 'crash'])('cleans owned trees on %s', async mode => {
    const f = await setup(), s = f.session(); await s.send(f.initialize)
    await s.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture', arguments: { children: true } } })
    for (let i = 0; i < 40; i++) { if ((await fs.readFile(f.journal, 'utf8')).includes('grandchild')) break; await new Promise(r => setTimeout(r, 50)) }
    const events = (await fs.readFile(f.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const pids = events.flatMap(e => [e.child, e.grandchild].filter(Boolean)); expect(pids).toHaveLength(2)
    if (mode === 'disconnect') await s.close()
    else if (mode === 'quit') await f.supervisor.close()
    else (f.supervisor as any).process.kill('SIGKILL')
    for (let i = 0; i < 80; i++) { if (pids.every(pid => { try { process.kill(pid, 0); return false } catch { return true } })) break; await new Promise(r => setTimeout(r, 50)) }
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)
  it('bounds queued requests and cancels them on Stop without blocking control', async () => {
    const f = await setup(), s = f.session(); await s.send(f.initialize)
    const first = s.send({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'fixture', arguments: { delay: 20_000 } } }).catch(error => error)
    for (let i = 0; i < 40 && !s.worker; i++) await new Promise(r => setTimeout(r, 25))
    const pending = Array.from({ length: 16 }, (_, id) => s.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fixture' } }).catch(error => error))
    await expect(s.send({ jsonrpc: '2.0', id: 'overflow', method: 'tools/call', params: { name: 'fixture' } })).rejects.toThrow('queue is full')
    const started = Date.now(); await f.runtime.stop('fixture'); expect(Date.now() - started).toBeLessThan(3000)
    expect(await first).toBeInstanceOf(Error); expect((await Promise.all(pending)).every(error => error instanceof Error)).toBe(true)
    expect(f.runtime.queuedBytes).toBe(0); expect(f.runtime.queued).toBe(0)
  }, 15_000)
})
