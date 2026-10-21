import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

describe.skipIf(!process.env.AIU_MCP_EXE)('native MCP relay duplex transport', () => {
  it('reads replies while forwarding subsequent requests over the same connection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-relay-'))
    const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\aiu-fixture-' + randomUUID() : path.join(root, 'manager.sock')
    const sockets = new Set<net.Socket>()
    const token = randomUUID(), frames: any[] = []
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined)
      let bytes = ''
      socket.on('data', chunk => {
        bytes += chunk
        while (bytes.includes('\n')) {
          const end = bytes.indexOf('\n'), frame = JSON.parse(bytes.slice(0, end)); bytes = bytes.slice(end + 1); frames.push(frame)
          if (frame.message.id !== undefined) socket.write(JSON.stringify({ jsonrpc: '2.0', id: frame.message.id, result: { echoed: frame.message.method } }) + '\n')
        }
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve) })
    await fs.writeFile(path.join(root, 'manager-runtime.json'), JSON.stringify({ pipe, token }))
    const child = spawn(process.env.AIU_MCP_EXE!, ['--workspace'], { env: { ...process.env, AIU_POOL: root }, windowsHide: true })
    const replies: any[] = []; let output = ''; child.stderr.resume()
    child.stdout.on('data', chunk => { output += chunk; while (output.includes('\n')) { const end = output.indexOf('\n'); replies.push(JSON.parse(output.slice(0, end))); output = output.slice(end + 1) } })
    try {
      for (let id = 1; id <= 8; id++) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: id === 1 ? 'initialize' : 'ping' }) + '\n')
        for (let attempt = 0; attempt < 100 && replies.length < id; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
        expect(replies.at(-1)?.id).toBe(id)
      }
      expect(frames).toHaveLength(8)
      expect(frames.every(frame => frame.token === token && frame.workspace && typeof frame.clientPid === 'number')).toBe(true)
    } finally {
      child.kill(); for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
