import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClaudeQuotaDTO } from '../shared/types'

/**
 * Live Claude subscription limits, the same numbers Claude Code's /usage screen shows.
 * Reads Claude Code's own CLI sign-in (~/.claude/.credentials.json, or the macOS Keychain item
 * "Claude Code-credentials") and calls GET api.anthropic.com/api/oauth/usage. Read-only.
 *
 * AI Usage never refreshes the token itself: Anthropic rotates the refresh token on use, so a
 * refresh done outside Claude Code would sign it out. When the token has expired (it lasts a few
 * hours, and Claude Desktop's Code tab signs in separately, so the CLI's copy goes stale), AI Usage
 * runs `claude auth status`, which makes Claude Code renew its own sign-in the same way a second
 * terminal would. Checked on 2026-11-21: the expired token was renewed for another 16 hours.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const exec = promisify(execFile)
interface OAuth { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string }
type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined

const WINDOWS: Array<[key: string, id: string, label: string]> = [
  ['five_hour', 'five_hour', '5-hour window'], ['seven_day', 'seven_day', 'Weekly window'],
  ['seven_day_opus', 'seven_day_opus', 'Weekly · Opus'], ['seven_day_sonnet', 'seven_day_sonnet', 'Weekly · Sonnet']
]

function configDir(): string { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') }

export async function readClaudeOAuth(): Promise<OAuth | null> {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(configDir(), '.credentials.json'), 'utf8'))
    if (file?.claudeAiOauth?.accessToken) return file.claudeAiOauth
  } catch { /* not a CLI sign-in on this path */ }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 })
      const item = JSON.parse(stdout.trim())
      if (item?.claudeAiOauth?.accessToken) return item.claudeAiOauth
    } catch { /* no item, locked keychain or access refused */ }
  }
  return null
}

/** "default_claude_max_5x" / subscriptionType "max" → "Max 5x". */
export function claudePlanName(oauth: Pick<OAuth, 'subscriptionType' | 'rateLimitTier'>): string | undefined {
  const tier = oauth.rateLimitTier?.match(/max_(\d+)x/i)?.[1]
  const type = oauth.subscriptionType?.toLowerCase()
  if (type === 'max' || tier) return `Max${tier ? ` ${tier}x` : ''}`
  if (type) return type.charAt(0).toUpperCase() + type.slice(1)
  return undefined
}

export function parseClaudeUsage(payload: Record<string, Window>): ClaudeQuotaDTO['windows'] {
  return WINDOWS.flatMap(([key, id, label]) => {
    const w = payload?.[key]
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return []
    const reset = w.resets_at ? Date.parse(w.resets_at) : Number.NaN
    return [{ id, label, usedPercent: Math.max(0, Math.min(100, w.utilization)), resetAt: Number.isFinite(reset) ? reset : null }]
  })
}

/** Claude Code's own command, preferring the CLI install, then the copy bundled in Claude Desktop. */
export function claudeCli(home = os.homedir(), platform: NodeJS.Platform = process.platform): string | null {
  const exe = platform === 'win32' ? 'claude.exe' : 'claude'
  const found = (file: string): boolean => { try { return fs.statSync(file).isFile() } catch { return false } }
  const onPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe))
  const fixed = [path.join(home, '.local/bin', exe), path.join(home, '.claude/local', exe), ...(platform === 'darwin' ? ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'] : [])]
  for (const file of [...fixed, ...onPath]) if (found(file)) return file
  // Claude Desktop keeps Claude Code under claude-code/<version>/<build>/.
  const bundled = path.join(home, platform === 'darwin' ? 'Library/Application Support/Claude/claude-code' : platform === 'win32' ? 'AppData/Roaming/Claude/claude-code' : '.config/Claude/claude-code')
  const versions = (() => { try { return fs.readdirSync(bundled) } catch { return [] } })().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const version of versions) for (const build of (() => { try { return fs.readdirSync(path.join(bundled, version)) } catch { return [] } })()) {
    const file = path.join(bundled, version, build, ...(platform === 'darwin' ? ['claude.app', 'Contents', 'MacOS', 'claude'] : [exe]))
    if (found(file)) return file
  }
  return null
}

const expired = (oauth: OAuth): boolean => typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now() + 60_000

/**
 * macOS: `claude auth status` reports the sign-in without renewing the Keychain copy (seen with
 * 2.1.325 and 2.1.330 on 2026-11-21), while starting Claude Code renews it before any prompt, as
 * running `claude` in a terminal does. Start it in a hidden terminal (`script` gives it one), wait
 * until the saved sign-in is valid again, then close it. No prompt is sent, so no quota is used.
 */
export function startClaudeHidden(cli: string, read: typeof readClaudeOAuth = readClaudeOAuth, limitMs = 30_000): Promise<boolean> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: process.env.TERM || 'xterm-256color' }; delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY
    let child: ChildProcess, done = false, timer: NodeJS.Timeout | undefined
    const stop = (ok: boolean): void => {
      if (done) return; done = true; clearInterval(timer)
      // The terminal and Claude Code share a process group of their own.
      try { process.kill(-child.pid!, 'SIGTERM') } catch { child?.kill('SIGTERM') }
      resolve(ok)
    }
    try { child = spawn('/usr/bin/script', ['-q', '/dev/null', cli], { cwd: os.homedir(), env, stdio: ['pipe', 'ignore', 'ignore'], detached: true }) } catch { resolve(false); return }
    child.on('error', () => stop(false))
    const started = Date.now()
    timer = setInterval(() => { void read().then(oauth => { if (oauth?.accessToken && !expired(oauth)) stop(true); else if (Date.now() - started > limitMs) stop(false) }, () => undefined) }, 2_000)
  })
}

let lastRenewal = { at: 0, error: undefined as string | undefined }
/**
 * Lets Claude Code renew its expired CLI sign-in (see the note at the top). At most once every
 * 10 minutes; returns why it could not, or undefined when Claude Code says it is signed in.
 */
export async function renewClaudeSignIn(run: typeof exec = exec, cli = claudeCli(), read: typeof readClaudeOAuth = readClaudeOAuth, platform: NodeJS.Platform = process.platform, start = startClaudeHidden): Promise<string | undefined> {
  if (Date.now() - lastRenewal.at < 10 * 60_000) return lastRenewal.error
  lastRenewal = { at: Date.now(), error: undefined }
  if (!cli) return (lastRenewal.error = 'Claude Code is not installed as a command on this device')
  try {
    const env = { ...process.env }; delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY
    const { stdout } = await run(cli, ['auth', 'status', '--json'], { timeout: 45_000, windowsHide: true, env })
    const status = JSON.parse(String(stdout).trim() || '{}')
    if (status.loggedIn === false) lastRenewal.error = 'Claude Code is signed out on this device'
  } catch (error) { lastRenewal.error = `renewing failed (${(error as Error).message.split(/\r?\n/)[0].slice(0, 160)})` }
  if (!lastRenewal.error && platform === 'darwin') {
    const now = await read().catch(() => null)
    if (now?.accessToken && expired(now) && !await start(cli, read)) lastRenewal.error = 'starting Claude Code did not renew it within 30 seconds'
  }
  return lastRenewal.error
}
/** Test hook: forget the last renewal attempt. */
export function resetClaudeRenewal(): void { lastRenewal = { at: 0, error: undefined } }

export async function fetchClaudeQuota(deps: { read?: typeof readClaudeOAuth; renew?: () => Promise<string | undefined> } = {}): Promise<ClaudeQuotaDTO> {
  const read = deps.read ?? readClaudeOAuth, renew = deps.renew ?? (() => renewClaudeSignIn())
  const base: ClaudeQuotaDTO = { fetchedAt: Date.now(), windows: [] }
  let oauth = await read()
  if (!oauth?.accessToken) return { ...base, error: 'No Claude Code CLI sign-in on this device. Run `claude` in a terminal and sign in with /login to show your live limits.' }
  const plan = claudePlanName(oauth)
  const stale = (why?: string): ClaudeQuotaDTO => ({ ...base, plan, error: `Claude Code’s sign-in expired and AI Usage could not have it renewed${why ? `: ${why}` : ''}. Run \`claude\` once in a terminal, then refresh.` })
  let renewed = false
  const renewNow = async (): Promise<ClaudeQuotaDTO | null> => {
    renewed = true
    const why = await renew(), next = await read()
    if (!next?.accessToken || expired(next)) return stale(why)
    oauth = next; return null
  }
  if (expired(oauth)) { const failed = await renewNow(); if (failed) return failed }
  try {
    const get = (): Promise<Response> => fetch(USAGE_URL, { signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${oauth!.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'ai-usage' } })
    let res = await get()
    // A token revoked early (signed in again elsewhere) also gets one renewal.
    if (res.status === 401 && !renewed) { const failed = await renewNow(); if (failed) return failed; res = await get() }
    if (res.status === 401) return { ...base, plan, error: 'Anthropic refused the Claude Code sign-in. Run `claude` once in a terminal (use /login if it asks), then refresh.' }
    if (!res.ok) return { ...base, plan, error: `Claude usage: HTTP ${res.status}` }
    const windows = parseClaudeUsage(await res.json() as Record<string, Window>)
    return { ...base, plan, windows, error: windows.length ? undefined : 'Anthropic returned no usage windows for this account.' }
  } catch (error) { return { ...base, plan, error: `Claude usage: ${(error as Error).message}` } }
}
