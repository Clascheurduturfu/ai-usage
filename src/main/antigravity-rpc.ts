import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
type Method = 'GetMcpServerStates' | 'GetAllSkills' | 'RefreshMcpServers' | 'GetUserStatus' | 'RetrieveUserQuotaSummary'
type Endpoint = { port: number; csrf: string; checkedAt: number }
let cached: Endpoint | undefined
let discovery: Promise<Endpoint | undefined> | undefined

async function request(endpoint: Endpoint, method: Method): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codeium-Csrf-Token': endpoint.csrf },
    body: method === 'RetrieveUserQuotaSummary' ? JSON.stringify({ request: {}, forceRefresh: true }) : '{}', signal: AbortSignal.timeout(5000), redirect: 'error'
  })
  if (!response.ok) throw new Error(`Antigravity local API: HTTP ${response.status}`)
  return response.json()
}
async function probe(csrf: string, ports: number[]): Promise<Endpoint | undefined> {
  for (const port of ports) {
    const endpoint = { port, csrf, checkedAt: Date.now() }
    try { await request(endpoint, 'GetMcpServerStates'); return endpoint } catch { /* The HTTPS listener is not the JSON API. */ }
  }
}
async function discoverMac(): Promise<Endpoint | undefined> {
  const { stdout } = await exec('/bin/ps', ['-ax', '-o', 'uid=,pid=,command='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!match || Number(match[1]) !== process.getuid?.() || !/^(?:\/Applications\/|\/Users\/[^/]+\/Applications\/)Antigravity[^/]*\.app\/Contents\/.*\/language_server(?:_macos_(?:arm|arm64|x64))?\b/.test(match[3])) continue
    const csrf = match[3].match(/--csrf_token(?:=|\s+)(\S+)/)?.[1]
    if (!csrf) continue
    const listeners = await exec('/usr/sbin/lsof', ['-a', '-p', match[2], '-iTCP', '-sTCP:LISTEN', '-nP', '-Fn'], { timeout: 5000, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: '' }))
    const ports = [...new Set([...listeners.stdout.matchAll(/^n(?:127\.0\.0\.1|\[::1\]|\*):(\d+)$/gm)].map(m => Number(m[1])))].filter(port => port > 0 && port < 65536)
    const found = await probe(csrf, ports)
    if (found) return found
  }
}
/** Windows: the current user's installed language_server.exe, its CSRF token and loopback listeners. */
async function discoverWindows(): Promise<Endpoint | undefined> {
  const local = (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')).toLowerCase()
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true })
  if (!stdout.trim()) return undefined
  const list = ([] as Array<{ ProcessId: number; ExecutablePath?: string; CommandLine?: string }>).concat(JSON.parse(stdout))
  const servers = list.filter(p => p.ExecutablePath?.toLowerCase().startsWith(path.join(local, 'programs') + path.sep) && /antigravity/i.test(p.ExecutablePath))
  if (!servers.length) return undefined
  const { stdout: table } = await exec('netstat.exe', ['-ano', '-p', 'TCP'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  for (const server of servers) {
    const csrf = server.CommandLine?.match(/--csrf_token(?:=|\s+)(\S+)/)?.[1]
    if (!csrf) continue
    const ports = [...new Set([...table.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/gm)].filter(m => Number(m[2]) === server.ProcessId).map(m => Number(m[1])))]
    const found = await probe(csrf, ports)
    if (found) return found
  }
}
const discover = (): Promise<Endpoint | undefined> => process.platform === 'win32' ? discoverWindows() : discoverMac()
// Windows uses the local server only for quotas; MCP status there still comes from the config files.
const WINDOWS_METHODS: ReadonlySet<Method> = new Set(['GetUserStatus', 'RetrieveUserQuotaSummary'])
/** Only the current user's installed Antigravity client, with no prompts or tool actions. */
export async function antigravityRpc(method: Method): Promise<any | undefined> {
  if (!(process.platform === 'darwin' || (process.platform === 'win32' && WINDOWS_METHODS.has(method))) || process.env.AIU_PROFILE || (process.env.AIU_HOME && process.env.AIU_HOME !== os.homedir())) return undefined
  try {
    if (!cached || Date.now() - cached.checkedAt > 60_000) {
      discovery ??= discover().finally(() => { discovery = undefined })
      cached = await discovery
    }
    if (!cached) return undefined
    return await request(cached, method)
  } catch { cached = undefined; return undefined }
}
