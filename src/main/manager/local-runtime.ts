import { createHash, randomUUID } from 'node:crypto'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types'
import { NativeSupervisor, NativeTransport, type LaunchSpec } from './native-supervisor'

type Frame = any
interface Metadata { initialize: Frame; tools?: Frame }
interface Pending { resolve(value: Frame): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** Cache protocol discovery only. Tool results and account data never enter this cache. */
export class LocalRuntime {
  private cache = new Map<string, { expires: number; value: Metadata }>()
  private discoveryQueues = new Map<string, Promise<unknown>>()
  private discovery = new Map<string, Promise<Metadata>>()
  readonly sessions = new Set<LocalSession>()
  queued = 0
  queuedBytes = 0
  constructor(readonly supervisor: NativeSupervisor, readonly notify: () => void) {}
  session(name: string, spec: LaunchSpec, reply: (message: Frame) => void, clientPid?: number): LocalSession {
    const session = new LocalSession(this, name, spec, reply, clientPid)
    this.sessions.add(session)
    return session
  }
  async metadata(session: LocalSession, initialize: Frame): Promise<Metadata> {
    const contextual = !!Object.keys(initialize.params?.capabilities ?? {}).length
    const key = createHash('sha256').update(JSON.stringify({ name: session.name, spec: session.spec, params: initialize.params, context: contextual ? session.contextId : undefined })).digest('hex')
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
    const running = this.discovery.get(key)
    if (running) return running
    const task = (this.discoveryQueues.get(session.name) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const transport = this.supervisor.transport(session.name, session.spec, 'discovery')
      const channel = new WorkerChannel(transport, session.reply)
      session.control = channel
      try {
        await transport.start()
        const result = await channel.request({ ...initialize, id: undefined })
        if (result.error) throw new Error(result.error.message)
        await channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const tools = result.result?.capabilities?.tools ? await channel.request({ jsonrpc: '2.0', method: 'tools/list' }) : undefined
        const value = { initialize: result.result, tools: tools?.error ? undefined : tools?.result }
        // Servers using roots, sampling or elicitation may customize discovery per client.
        if (!Object.keys(initialize.params?.capabilities ?? {}).length) {
          if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!)
          this.cache.set(key, { value, expires: Date.now() + 10 * 60_000 })
        }
        return value
      } finally { if (session.control === channel) session.control = undefined; await channel.close() }
    })
    this.discoveryQueues.set(session.name, task)
    this.discovery.set(key, task)
    try { return await task } finally { this.discovery.delete(key); if (this.discoveryQueues.get(session.name) === task) this.discoveryQueues.delete(session.name) }
  }
  async stop(name: string): Promise<void> {
    await this.supervisor.control('stop', name)
    await Promise.allSettled([...this.sessions].filter(s => name === '*' || s.name === name).map(s => s.release()))
  }
  invalidate(): void { this.cache.clear() }
  status(): Array<{ name: string; clientPid?: number; workerId?: string; lastActivity: number; pending: number; active: number }> {
    return [...this.sessions].map(s => ({ name: s.name, clientPid: s.clientPid, workerId: s.worker?.transport.id, lastActivity: s.lastActivity, pending: s.pending, active: s.active }))
  }
}

class WorkerChannel {
  private pending = new Map<string, Pending>()
  private prefix = 'aiu-' + randomUUID() + '-'
  private sequence = 0
  private closed = false
  private requestIds = new Map<string, string>()
  constructor(readonly transport: NativeTransport, private reply: (message: Frame) => void, private stopped?: () => void) {
    transport.onmessage = message => {
      const frame = message as Frame, key = String(frame.id), pending = this.pending.get(key)
      if (pending && !frame.method) { clearTimeout(pending.timer); this.pending.delete(key); pending.resolve(frame) }
      else this.reply(message)
    }
    transport.onclose = () => { this.rejectAll(new Error('MCP worker stopped or disconnected')); this.stopped?.() }
    transport.onerror = error => { this.rejectAll(error); this.stopped?.() }
  }
  private rejectAll(error: Error): void { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }; this.pending.clear() }
  send(message: Frame): Promise<void> { return this.transport.send(message as JSONRPCMessage) }
  async request(message: Frame): Promise<Frame> {
    if (this.closed) throw new Error('MCP worker stopped')
    const id = this.prefix + ++this.sequence
    const original = message.id === undefined ? undefined : String(message.id)
    if (original) this.requestIds.set(original, id)
    try { return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        void this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Request timed out' } }).catch(() => undefined)
        reject(new Error('MCP request timed out'))
      }, 180_000)
      this.pending.set(id, { resolve, reject, timer })
      void this.send({ ...message, id }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error) })
    }) } finally { if (original) this.requestIds.delete(original) }
  }
  async cancel(message: Frame): Promise<void> { const id = this.requestIds.get(String(message.params?.requestId)); if (id) await this.send({ ...message, params: { ...message.params, requestId: id } }) }
  async close(): Promise<void> { this.rejectAll(new Error('MCP stopped')); await this.transport.close() }
}

export class LocalSession {
  readonly contextId = randomUUID()
  worker?: WorkerChannel
  control?: WorkerChannel
  private initialize?: Frame
  private metadata?: Metadata
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0
  private closed = false
  private queuedIds = new Set<string>()
  private cancelled = new Set<string>()
  private roots?: Frame
  pending = 0
  active = 0
  lastActivity = Date.now()
  constructor(readonly runtime: LocalRuntime, readonly name: string, readonly spec: LaunchSpec, readonly reply: (message: Frame) => void, readonly clientPid?: number) {}
  private assertAvailable(): void { if (this.closed || this.runtime.supervisor.paused(this.name)) throw new Error('MCP paused or disconnected; Resume in AI Usage') }
  private async ensureWorker(): Promise<WorkerChannel> {
    this.assertAvailable()
    if (this.worker) return this.worker
    if (!this.initialize) throw new Error('Initialize the MCP first')
    const generation = this.generation
    const transport = this.runtime.supervisor.transport(this.name, this.spec)
    const channel = new WorkerChannel(transport, message => {
      if (message.method === 'roots/list' && this.roots) { void channel.send({ jsonrpc: '2.0', id: message.id, result: this.roots }).catch(() => undefined); return }
      this.reply(message)
    }, () => { if (this.worker === channel) this.worker = undefined; this.runtime.notify() })
    this.worker = channel
    try {
      await transport.start()
      const response = await channel.request({ ...this.initialize, id: undefined })
      if (response.error) throw new Error(response.error.message)
      await channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      this.assertAvailable()
      if (generation !== this.generation) throw new Error('MCP stopped during startup')
      this.runtime.notify()
      return channel
    } catch (error) { if (this.worker === channel) this.worker = undefined; await channel.close(); throw error }
  }
  async send(message: Frame): Promise<void> {
    this.assertAvailable(); this.lastActivity = Date.now()
    // Protocol control must never wait behind a tool invocation.
    if (!message.method) {
      if (message.result?.roots) this.roots = message.result
      await (this.control ?? this.worker)?.send(message); return
    }
    if (message.method === 'notifications/cancelled') {
      if (this.queuedIds.has(String(message.params?.requestId))) this.cancelled.add(String(message.params?.requestId))
      await (this.control ?? this.worker)?.cancel(message)
      return
    }
    if (message.id === undefined) { if (message.method === 'notifications/roots/list_changed') this.roots = undefined; if (message.method !== 'notifications/initialized') await (this.control ?? this.worker)?.send(message); return }
    if (message.method === 'ping') { this.reply({ jsonrpc: '2.0', id: message.id, result: {} }); return }
    const bytes = Buffer.byteLength(JSON.stringify(message))
    if (this.pending >= 16 || this.runtime.queued >= 64 || this.runtime.queuedBytes + bytes > 16 * 1024 * 1024) throw new Error('MCP queue is full; wait for a request to finish or Stop this MCP')
    this.queuedIds.add(String(message.id))
    this.pending++; this.runtime.queued++; this.runtime.queuedBytes += bytes
    const generation = this.generation
    const run = this.queue.catch(() => undefined).then(async () => {
      this.queuedIds.delete(String(message.id))
      this.pending--; this.runtime.queued--; this.runtime.queuedBytes -= bytes
      this.assertAvailable(); if (generation !== this.generation) throw new Error('MCP stopped; queued request cancelled')
      if (this.cancelled.delete(String(message.id))) throw new Error('MCP request cancelled')
      this.active++; this.runtime.notify()
      try {
        if (message.method === 'initialize') {
          if (this.initialize) throw new Error('MCP already initialized')
          this.initialize = message
          try { this.metadata = await this.runtime.metadata(this, message); this.reply({ jsonrpc: '2.0', id: message.id, result: this.metadata.initialize }) }
          catch (error) { this.initialize = undefined; throw error }
          return
        }
        if (message.method === 'tools/list' && !message.params?.cursor && this.metadata?.tools) { this.reply({ jsonrpc: '2.0', id: message.id, result: this.metadata.tools }); return }
        const worker = await this.ensureWorker()
        const response = await worker.request(message)
        this.reply({ ...response, id: message.id })
      } finally { this.active--; this.lastActivity = Date.now(); this.runtime.notify() }
    })
    this.queue = run
    await run
  }
  async release(): Promise<void> { this.generation++; const worker = this.worker, control = this.control; this.worker = undefined; this.control = undefined; await Promise.all([worker?.close(), control?.close()]); this.runtime.notify() }
  async close(): Promise<void> { this.closed = true; await this.release(); this.runtime.sessions.delete(this) }
}
