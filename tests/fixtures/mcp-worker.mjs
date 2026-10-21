import readline from 'node:readline'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const file = process.argv[2]
if (process.argv.includes('--grandchild')) { setInterval(() => {}, 1000) }
else if (process.argv.includes('--child')) {
  const child = spawn(process.execPath, [process.argv[1], file, '--grandchild'], { detached: process.platform === 'darwin', stdio: 'ignore' })
  fs.appendFileSync(file, JSON.stringify({ grandchild: child.pid }) + '\n')
  setInterval(() => {}, 1000)
} else {
  let initialized = false, ready = false, pendingInitialize, roots = []
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      initialized = true; fs.appendFileSync(file, JSON.stringify({ initialized: process.pid }) + '\n')
      const result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      if (message.params.capabilities?.roots) { pendingInitialize = { id: message.id, result }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'roots-init', method: 'roots/list' }) + '\n') }
      else reply(message.id, result)
    }
    else if (message.id === 'roots-init' && message.result) { roots = message.result.roots; reply(pendingInitialize.id, pendingInitialize.result); pendingInitialize = undefined }
    else if (message.method === 'notifications/initialized') ready = initialized
    else if (message.method === 'tools/list' && ready) reply(message.id, { tools: [{ name: roots[0]?.name ?? 'fixture', inputSchema: { type: 'object' } }] })
    else if (message.method === 'tools/call' && ready) {
      const args = message.params.arguments ?? {}
      if (args.children) { const child = spawn(process.execPath, [process.argv[1], file, '--child'], { stdio: 'ignore' }); fs.appendFileSync(file, JSON.stringify({ child: child.pid }) + '\n') }
      setTimeout(() => reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, ready, roots }) }] }), args.delay ?? 0)
    } else if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Handshake required' } }) + '\n')
  })
}
