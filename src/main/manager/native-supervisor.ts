import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { FrameReader } from './frame-reader'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types'
import type { NativeCall } from './storage'

export interface LaunchSpec { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
export interface NativeWorker { id: string; name: string; kind: string; pid: number; memoryBytes: number; processes: number }
export interface RuntimeStatus { paused: string[]; workers: NativeWorker[] }
export class NativeSupervisor {
  private process?: ChildProcess
  private port = 0
  private token = randomBytes(32).toString('hex')
  private starting?: Promise<void>
  status: RuntimeStatus = { paused: [], workers: [] }
  constructor(readonly data: string, private native: NativeCall, private notify: () => void, readonly pool?: string) {}
  executable(): string { return process.env.AIU_MCP_EXE ?? path.join(path.dirname(process.env.AIU_HOST_EXE ?? process.execPath), process.platform === 'win32' ? 'aiu-mcp.exe' : 'aiu-mcp') }
  start(): Promise<void> {
    return this.starting ??= (async () => {
      await fs.access(this.executable())
      const child = this.process = spawn(this.executable(), ['--supervisor', this.data], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child.stderr?.on('data', () => undefined)
      child.once('close', () => { this.port = 0; this.starting = undefined; this.status = { paused: this.status.paused, workers: [] }; this.notify() })
      const info = await new Promise<{ port: number; token: string }>((resolve, reject) => {
        const lines = new FrameReader(child.stdout!), timer = setTimeout(() => { lines.close(); reject(new Error('Native supervisor did not start')); child.kill() }, 15_000)
        child.once('error', reject); lines.once('line', text => { clearTimeout(timer); lines.close(); try { resolve(JSON.parse(text)) } catch { reject(new Error('Invalid native supervisor handshake')) } })
        child.stdin!.write(JSON.stringify({ token: this.token, pool: this.pool }) + '\n')
      })
      this.port = info.port
      await this.native('mcp-supervisor', JSON.stringify(info))
      await this.refresh()
    })()
  }
  async socket(): Promise<net.Socket> {
    if (!this.port) await this.start()
    return new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port: this.port }); socket.once('connect', () => resolve(socket)); socket.once('error', reject) })
  }
  frame(action: string, fields: Record<string, unknown> = {}): string { return JSON.stringify({ token: this.token, action, ...fields }) + '\n' }
  async control(action: string, name?: string, fields: Record<string, unknown> = {}): Promise<RuntimeStatus> {
    const socket = await this.socket(), lines = new FrameReader(socket)
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { lines.close(); socket.destroy() }
      socket.setTimeout(5000, () => { cleanup(); reject(new Error('Supervisor control timed out')) }); socket.on('error', reject)
      lines.once('line', text => { cleanup(); try { const status = JSON.parse(text); if (status.error) throw new Error(status.error); this.status = status; resolve(status); this.notify() } catch (error) { reject(error) } })
      socket.write(this.frame(action, { ...fields, ...(name ? { name } : {}) }))
    })
  }
  async refresh(): Promise<void> { await this.control('status') }
  paused(name: string): boolean { return this.status.paused.includes(name) || this.status.paused.includes('*') }
  alive(): boolean { return !!this.process && this.process.exitCode === null && this.process.signalCode === null && this.port > 0 }
  transport(name: string, spec: LaunchSpec, kind = 'stateful'): NativeTransport { return new NativeTransport(this, name, spec, kind) }
  async run(name: string, spec: LaunchSpec, signal?: AbortSignal): Promise<{ stdout: string }> {
    signal?.throwIfAborted()
    const transport = this.transport(name, spec, 'stateless'); let stdout = ''
    const cancel = (): void => { void transport.close().catch(() => undefined) }
    signal?.addEventListener('abort', cancel, { once: true })
    const result = new Promise<{ stdout: string }>((resolve, reject) => {
      const timer = setTimeout(() => { cancel(); reject(new Error('Command timed out')) }, 60_000)
      const fail = (error: Error): void => { clearTimeout(timer); reject(error) }
      transport.onstdout = text => { stdout += text; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { cancel(); fail(new Error('Command output exceeds 8 MiB')) } }
      transport.onexit = code => { clearTimeout(timer); code === 0 ? resolve({ stdout }) : fail(new Error(`${name} exited with status ${code}; reconnect or review its configuration`)) }
      transport.onerror = fail
      transport.onclose = () => fail(new Error('Command stopped or disconnected'))
      void transport.start(true).catch(fail)
    })
    try { return await result } finally { signal?.removeEventListener('abort', cancel); await transport.close().catch(() => undefined) }
  }
  async close(): Promise<void> { const child = this.process; if (!child) return; this.process = undefined; if (child.exitCode !== null || child.signalCode !== null) { this.port = 0; return }; await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve() }, 10_000); child.once('close', () => { clearTimeout(timer); resolve() }); child.stdin?.end() }); this.port = 0 }
}
export class NativeTransport {
  readonly id = randomUUID()
  pid?: number
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  onstdout?: (text: string) => void
  onstderr?: (text: string) => void
  onexit?: (code: number) => void
  private socket?: net.Socket
  private lines?: FrameReader
  constructor(private supervisor: NativeSupervisor, readonly name: string, readonly spec: LaunchSpec, readonly kind: string) {}
  async start(exec = false): Promise<void> {
    const socket = this.socket = await this.supervisor.socket(), lines = this.lines = new FrameReader(socket)
    socket.on('error', e => this.onerror?.(e)); socket.once('close', () => { lines.close(); this.onclose?.() })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Worker start timed out')); socket.destroy() }, 30_000)
      lines.on('line', text => { if (text.length > 16 * 1024 * 1024) { socket.destroy(); return }; try {
        const event = JSON.parse(text)
        if (event.error) { clearTimeout(timer); const error = new Error(event.error); reject(error); this.onerror?.(error); socket.destroy() }
        else if (event.event === 'started') { clearTimeout(timer); this.pid = event.pid; resolve() }
        else if (event.event === 'message') this.onmessage?.(event.message)
        else if (event.event === 'stdout') this.onstdout?.(event.text)
        else if (event.event === 'stderr') this.onstderr?.(event.text)
        else if (event.event === 'exit') { this.onexit?.(event.code); socket.destroy() }
      } catch { this.onerror?.(new Error('Malformed supervisor response')); socket.destroy() } })
      socket.once('close', () => { clearTimeout(timer); reject(new Error('Worker disconnected before startup')) })
      socket.write(this.supervisor.frame('spawn', { ...this.spec, id: this.id, name: this.name, kind: this.kind, exec, diagnostics: !!this.onstderr }))
    })
  }
  async send(message: JSONRPCMessage): Promise<void> { if (!this.socket || this.socket.destroyed) throw new Error('Worker is not running'); await new Promise<void>((resolve, reject) => this.socket!.write(JSON.stringify({ message }) + '\n', error => error ? reject(error) : resolve())) }
  async close(): Promise<void> { try { if (this.pid && this.supervisor.alive() && !this.socket?.destroyed) await this.supervisor.control('release', undefined, { id: this.id }) } finally { this.lines?.close(); this.socket?.destroy() } }
}
