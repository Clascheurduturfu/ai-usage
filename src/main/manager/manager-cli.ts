import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

const pool = process.env.AIU_POOL ?? path.join(os.homedir(), '.agents')
let runtime = JSON.parse(await fs.readFile(path.join(pool, 'manager-runtime.json'), 'utf8'))
const initialToken = runtime.token
let socket: net.Socket | undefined
let waitedForManager = false
const startLock = path.join(pool, 'manager-start.lock')
let ownsStartLock = false
for (let i = 0; i < 30; i++) {
  try { socket = await new Promise<net.Socket>((resolve, reject) => { const s = net.createConnection(runtime.pipe); s.once('connect', () => resolve(s)); s.once('error', reject) }); break }
  catch {
    waitedForManager = true
    if (!i && runtime.app) {
      let previous: { startedAt?: number } = {}
      try { previous = JSON.parse(await fs.readFile(startLock, 'utf8')) } catch { /* Another relay may still be writing the startup lock. */ }
      if (previous.startedAt && Date.now() - previous.startedAt > 60_000) await fs.rm(startLock, { force: true })
      try { await fs.writeFile(startLock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 }); ownsStartLock = true }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      if (ownsStartLock) spawn(runtime.app, ['--hidden'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}
if (ownsStartLock) await fs.rm(startLock, { force: true })
if (!socket) throw new Error('Open AI Usage to use the manager CLI')
runtime = JSON.parse(await fs.readFile(path.join(pool, 'manager-runtime.json'), 'utf8'))
// A new listener can become reachable just before its runtime file is replaced.
if (waitedForManager) for (let i = 0; i < 50 && runtime.token === initialToken; i++) {
  await new Promise(resolve => setTimeout(resolve, 100))
  runtime = JSON.parse(await fs.readFile(path.join(pool, 'manager-runtime.json'), 'utf8'))
}
const lines = readline.createInterface({ input: socket })
if (process.argv.includes('--relay')) {
  const name = process.argv[process.argv.indexOf('--relay') + 1]
  if (!name) throw new Error('Specify an MCP name')
  lines.on('line', line => process.stdout.write(line + '\n'))
  const input = readline.createInterface({ input: process.stdin })
  input.on('line', line => { try { socket!.write(JSON.stringify({ token: runtime.token, server: name, message: JSON.parse(line) }) + '\n') } catch { process.stderr.write('Invalid MCP JSON\n') } })
  input.on('close', () => socket!.end()); socket.on('close', () => process.exit(0))
} else if (process.argv.includes('--workspace')) {
  lines.on('line', line => process.stdout.write(line + '\n'))
  const input = readline.createInterface({ input: process.stdin })
  input.on('line', line => { try { socket!.write(JSON.stringify({ token: runtime.token, workspace: true, message: JSON.parse(line) }) + '\n') } catch { process.stderr.write('Invalid MCP JSON\n') } })
  input.on('close', () => socket!.end()); socket.on('close', () => process.exit(0))
} else {
  const [kind, action, source, ...rest] = process.argv.slice(2)
  let method: string, params: any
  if ((kind === 'skill' || kind === 'mcp') && action === 'add') { method = 'install:preview'; params = { kind, source, selected: rest.find(v => v.startsWith('--path='))?.slice(7) } }
  else if ((kind === 'skill' || kind === 'mcp') && action === 'install') { method = 'install:confirm'; params = source }
  else if (kind === 'mcp' && action === 'login') { method = 'mcp:login'; params = source }
  else if (kind === 'mcp' && action === 'stop') { method = 'mcp:pause'; params = source ?? '*' }
  else if (kind === 'mcp' && action === 'resume') { method = 'mcp:resume'; params = source ?? '*' }
  else if (kind === 'mcp' && action === 'prepare') { method = 'mcp:preparePreview'; params = source ? [source, ...rest] : undefined }
  else if (kind === 'mcp' && action === 'confirm-prepare') { method = 'mcp:prepare'; params = source }
  else if (kind === 'mcp' && action === 'check') { method = 'mcp:check'; params = source }
  else if (kind === 'mcp' && action === 'aws-profile') { method = 'mcp:awsProfile'; params = { name: source, profile: rest[0] } }
  else if (kind === 'workspace' && action === 'import') { method = 'workspace:importAccount'; params = { account: source, credential: JSON.parse(await fs.readFile(rest[0], 'utf8')), projectId: rest.find(v => v.startsWith('--project='))?.slice(10) } }
  else if (kind === 'workspace' && action === 'import-stdin') { let value = ''; for await (const chunk of process.stdin) { value += chunk.toString(); if (value.length > 128_000) throw new Error('Credential is too large') }; method = 'workspace:importAccount'; params = { account: source, credential: JSON.parse(value), projectId: rest.find(v => v.startsWith('--project='))?.slice(10) } }
  else if (kind === 'workspace' && action === 'enable') { method = 'workspace:enable'; params = null }
  else if (kind === 'workspace' && action === 'client-stdin') { let value = ''; for await (const chunk of process.stdin) { value += chunk.toString(); if (value.length > 128_000) throw new Error('OAuth client is too large') }; method = 'workspace:configureClient'; params = JSON.parse(value) }
  else if (kind === 'sync') { method = 'manager:sync'; params = null }
  else throw new Error('Usage: skill|mcp add URL [--path=...], skill|mcp install PREVIEW_ID, mcp login NAME, workspace import ACCOUNT FILE, workspace import-stdin ACCOUNT, workspace enable, sync. Add previews only; install explicitly confirms.')
  socket.write(JSON.stringify({ token: runtime.token, id: 1, method, params }) + '\n')
  let received = false
  lines.once('line', line => { received = true; const response = JSON.parse(line); if (response.error) { process.stderr.write(response.error + '\n'); process.exitCode = 1 } else process.stdout.write(JSON.stringify(response.result, null, 2) + '\n'); socket!.end() })
  socket.once('close', () => { if (!received) { process.stderr.write('Manager disconnected before replying; restart AI Usage and retry\n'); process.exitCode = 1 } })
  socket.setTimeout(300_000, () => { process.stderr.write('Manager command timed out\n'); socket!.destroy(); process.exitCode = 1 })
}
