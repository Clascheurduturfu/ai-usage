import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { UpdateChannel, UpdatePrefs, UpdateStatus } from '../shared/update'

/*
 * In-app updates from GitHub Releases.
 *
 * Contract (kept in step with .github/workflows/release.yml):
 * - Tag `v<semver>`. Stable releases are published, not prerelease, with a final version.
 *   Preview releases are published prereleases with a prerelease version (1.1.0-beta.3).
 * - Preview users are also offered a newer Stable, so they never get stuck behind it.
 * - One package per platform, named by Tauri: `AI Usage_<version>_x64-setup.exe` (Windows)
 *   and `AI Usage_<version>_aarch64.dmg` (Apple Silicon).
 * - Every package must carry GitHub's `sha256:` asset digest. A package without one is not
 *   installed in the app; the Releases page stays available for a manual install.
 */

export const REPOSITORY = 'Clascheurduturfu/ai-usage'
const API = 'https://api.github.com'
const MAX_PACKAGE = 1024 * 1024 * 1024
const DAY = 86_400_000
/** Hosts GitHub uses to serve release asset bytes after the API redirect. */
const ASSET_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'])

export interface SemVer { major: number; minor: number; patch: number; pre: Array<string | number> }
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: string): SemVer | null {
  const m = SEMVER.exec(value.trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.').map(p => /^\d+$/.test(p) ? Number(p) : p) : [] }
}

/** Semantic-version precedence: numeric prerelease parts compare as numbers, and a final release beats its prereleases. */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] - b[key]
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) + (b.pre.length ? 1 : 0)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

export interface GhAsset { id: number; name: string; size: number; digest?: string | null; state?: string }
export interface GhRelease { id: number; tag_name: string; name?: string | null; draft: boolean; prerelease: boolean; body?: string | null; html_url: string; published_at?: string | null; assets: GhAsset[] }
export interface Selected { release: GhRelease; version: string; asset: GhAsset; sha256: string }

export function packagePattern(platform: string, arch: string): RegExp | null {
  if (platform === 'win32' && arch === 'x64') return /_x64-setup\.exe$/i
  if (platform === 'darwin' && arch === 'arm64') return /_aarch64\.dmg$/i
  if (platform === 'darwin' && arch === 'x64') return /_x64\.dmg$/i
  return null
}

/**
 * Picks the newest release this channel accepts that is newer than the installed version.
 * Returns null when up to date. Throws when the newest candidate has no single verifiable package:
 * silently falling back to an older release would hide a broken publication.
 */
export function selectUpdate(releases: GhRelease[], channel: UpdateChannel, installed: string, platform: string, arch: string): Selected | null {
  const current = parseVersion(installed)
  if (!current) throw new Error(`Installed version ${installed} is not a semantic version`)
  const candidates = releases.flatMap(release => {
    const version = parseVersion(release.tag_name)
    if (release.draft || !version) return []
    // Channel provenance comes from the release flag and the version; they must agree.
    const final = !version.pre.length
    if (release.prerelease === final) return []
    if (channel === 'stable' && !final) return []
    return compareVersions(version, current) > 0 ? [{ release, version }] : []
  }).sort((a, b) => compareVersions(b.version, a.version))
  const best = candidates[0]
  if (!best) return null
  const versionText = best.release.tag_name.replace(/^v/, ''), pattern = packagePattern(platform, arch)
  if (!pattern) throw new Error('In-app updates are not available for this platform; download it from Releases')
  const assets = best.release.assets.filter(a => pattern.test(a.name) && a.name.includes(`_${versionText}_`) && (a.state ?? 'uploaded') === 'uploaded')
  if (assets.length !== 1) throw new Error(`Release ${versionText} has ${assets.length ? 'more than one' : 'no'} package for this device; download it from Releases`)
  const asset = assets[0]
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACKAGE) throw new Error(`Release ${versionText} has an invalid package size`)
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase()
  if (!sha256) throw new Error(`Release ${versionText} has no SHA-256 checksum, so it is not installed in the app; download it from Releases`)
  return { release: best.release, version: versionText, asset, sha256 }
}

/** Follows API redirects only to GitHub asset hosts, over HTTPS. Public repository: no credentials are sent. */
export function allowedAssetUrl(url: URL): boolean { return url.protocol === 'https:' && ASSET_HOSTS.has(url.hostname) }

type Fetch = typeof fetch
export interface UpdaterOptions {
  installed: string
  dataDir: string
  platform?: string
  arch?: string
  repository?: string
  prefs: { read(): UpdatePrefs | null; write(prefs: UpdatePrefs): void }
  notify: () => void
  fetch?: Fetch
  /** Names activity that must not be interrupted by an installer closing the app. */
  busy?: () => string | null
  /** Hands the verified package to the platform. Defaults to the real launcher. */
  launch?: (file: string, kind: UpdateStatus['installKind']) => Promise<void>
  now?: () => number
}

export class Updater {
  private prefs: UpdatePrefs
  private state: UpdateStatus['state'] = 'idle'
  private message?: string
  private selected?: Selected
  private file?: string
  private progress?: UpdateStatus['progress']
  private generation = 0
  private readonly platform: string
  private readonly arch: string
  private readonly repo: string
  private readonly http: Fetch
  private readonly now: () => number
  constructor(private options: UpdaterOptions) {
    this.platform = options.platform ?? process.platform; this.arch = options.arch ?? process.arch
    this.repo = options.repository ?? REPOSITORY; this.http = options.fetch ?? fetch; this.now = options.now ?? Date.now
    const saved = options.prefs.read()
    this.prefs = { channel: saved?.channel === 'preview' ? 'preview' : 'stable', autoCheck: saved?.autoCheck !== false, lastCheck: saved?.lastCheck }
  }
  private installKind(): UpdateStatus['installKind'] { return this.platform === 'win32' ? 'installer' : this.platform === 'darwin' ? 'disk-image' : 'manual' }
  status(): UpdateStatus {
    const s = this.selected
    return { channel: this.prefs.channel, autoCheck: this.prefs.autoCheck, installed: this.options.installed, repository: this.repo,
      releasesUrl: `https://github.com/${this.repo}/releases`, state: this.state, checkedAt: this.prefs.lastCheck, message: this.message, progress: this.progress, installKind: this.installKind(),
      available: s ? { version: s.version, name: s.release.name || `AI Usage ${s.version}`, notes: (s.release.body ?? '').slice(0, 4000), url: s.release.html_url, prerelease: s.release.prerelease, publishedAt: s.release.published_at ?? undefined, size: s.asset.size } : undefined }
  }
  private set(state: UpdateStatus['state'], message?: string): void { this.state = state; this.message = message; this.options.notify() }
  private save(): void { this.options.prefs.write(this.prefs) }
  private reset(): void { this.generation++; this.selected = undefined; this.file = undefined; this.progress = undefined; this.set('idle') }
  setChannel(channel: UpdateChannel): UpdateStatus {
    if (channel !== 'stable' && channel !== 'preview') throw new Error('Unknown update channel')
    if (this.state === 'downloading' || this.state === 'installing') throw new Error('Wait for the current update to finish')
    // A stale result from the other channel must never be installed.
    this.prefs.channel = channel; this.save(); this.reset(); return this.status()
  }
  setAutoCheck(enabled: boolean): UpdateStatus { this.prefs.autoCheck = !!enabled; this.save(); this.options.notify(); return this.status() }
  /** One check shortly after launch, at most once a day. There is no polling loop. */
  async checkOnLaunch(): Promise<void> {
    if (!this.prefs.autoCheck || this.now() - (this.prefs.lastCheck ?? 0) < DAY) return
    await this.check().catch(() => undefined)
  }
  private headers(accept = 'application/vnd.github+json'): Record<string, string> { return { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AI-Usage-Updater' } }
  private async api<T>(route: string): Promise<T> {
    let response: Response
    try { response = await this.http(`${API}/repos/${this.repo}${route}`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) }) }
    catch { throw new Error('Cannot reach GitHub. Check your connection, or open Releases later.') }
    // GitHub answers 404, not 403, for a private repository without credentials.
    if (response.status === 404) throw new Error('No public releases were found. The app checks without credentials, so a private repository is not visible; use Releases instead')
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      throw new Error(`GitHub rate limit reached${reset ? `; try again after ${new Date(reset * 1000).toLocaleTimeString()}` : '; try again later'}`)
    }
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    return await response.json() as T
  }
  async check(): Promise<UpdateStatus> {
    if (this.state === 'downloading' || this.state === 'installing') return this.status()
    const generation = ++this.generation, channel = this.prefs.channel
    this.selected = undefined; this.file = undefined; this.progress = undefined; this.set('checking')
    try {
      // A bounded feed: the 30 most recent releases cover the rolling Preview and recent Stable.
      const releases = await this.api<GhRelease[]>('/releases?per_page=30')
      if (generation !== this.generation) return this.status()
      const selected = selectUpdate(Array.isArray(releases) ? releases : [], channel, this.options.installed, this.platform, this.arch)
      this.prefs.lastCheck = this.now(); this.save()
      this.selected = selected ?? undefined
      const preview = parseVersion(this.options.installed)?.pre.length
      this.set(selected ? 'available' : 'up-to-date', selected ? undefined : channel === 'stable' && preview ? 'You are on a Preview build. The next Stable newer than it will be offered; nothing is downgraded.' : undefined)
    } catch (error) {
      if (generation === this.generation) { this.prefs.lastCheck = this.now(); this.save(); this.set('error', (error as Error).message) }
    }
    return this.status()
  }
  private async staging(): Promise<string> {
    const root = path.join(this.options.dataDir, 'updates')
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    const directory = path.join(root, randomUUID())
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    return directory
  }
  /** Removes packages from earlier attempts; the installer has finished by the time the app runs again. */
  async cleanup(): Promise<void> { await fs.rm(path.join(this.options.dataDir, 'updates'), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined) }
  async download(): Promise<UpdateStatus> {
    const selected = this.selected, generation = this.generation
    if (!selected || this.state !== 'available') throw new Error('Check for updates first')
    this.progress = { received: 0, total: selected.asset.size }; this.set('downloading')
    let file: string | undefined
    try {
      const directory = await this.staging()
      // Our own file name: release-controlled text never names a path or reaches a command line.
      file = path.join(directory, `AI-Usage-${selected.version.replace(/[^0-9A-Za-z.-]/g, '')}${this.platform === 'win32' ? '-setup.exe' : '.dmg'}`)
      let url = new URL(`${API}/repos/${this.repo}/releases/assets/${selected.asset.id}`), response: Response | undefined
      for (let hop = 0; hop < 6; hop++) {
        response = await this.http(url, { headers: this.headers('application/octet-stream'), redirect: 'manual', signal: AbortSignal.timeout(30 * 60_000) })
        if (response.status >= 300 && response.status < 400) {
          const next = new URL(response.headers.get('location') ?? '', url)
          if (!allowedAssetUrl(next)) throw new Error(`Refusing to download from ${next.hostname}`)
          url = next; continue
        }
        break
      }
      if (!response || response.status >= 300) throw new Error(response ? `Download failed (${response.status}); the release may have changed, check again` : 'Too many redirects')
      if (!response.body) throw new Error('Empty download')
      const hash = createHash('sha256'), handle = await fs.open(file, 'wx', 0o600)
      let received = 0, lastNotify = 0
      try {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > selected.asset.size) { await reader.cancel(); throw new Error('The package is larger than its release metadata') }
          hash.update(value); await handle.write(value)
          if (generation !== this.generation) { await reader.cancel(); throw new Error('Update channel changed') }
          if (this.now() - lastNotify > 250) { lastNotify = this.now(); this.progress = { received, total: selected.asset.size }; this.options.notify() }
        }
      } finally { await handle.close() }
      if (received !== selected.asset.size) throw new Error('The download is incomplete; check again')
      if (hash.digest('hex') !== selected.sha256) throw new Error('The package does not match its published SHA-256 checksum; it was discarded')
      this.file = file; this.progress = { received, total: received }
      this.set('ready', this.platform === 'darwin' ? 'Verified. Opening the disk image lets you replace AI Usage in Applications.' : 'Verified. Install closes AI Usage, updates it and opens it again.')
    } catch (error) {
      if (file) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined)
      this.progress = undefined
      if (generation === this.generation) this.set('error', (error as Error).message)
    }
    return this.status()
  }
  async install(): Promise<UpdateStatus> {
    const selected = this.selected, file = this.file
    if (!selected || !file || this.state !== 'ready') throw new Error('Download and verify the update first')
    const busy = this.options.busy?.()
    if (busy) throw new Error(`Wait for ${busy} to finish before installing`)
    // The rolling Preview can be replaced at any time: confirm this exact package is still published.
    let current: GhRelease
    try { current = await this.api<GhRelease>(`/releases/${selected.release.id}`) } catch (error) { this.set('error', `${(error as Error).message}. Check again for the current release.`); return this.status() }
    const same = current.assets.find(a => a.id === selected.asset.id)
    if (current.draft || current.tag_name !== selected.release.tag_name || !same || same.digest?.toLowerCase() !== `sha256:${selected.sha256}`) { this.selected = undefined; this.set('error', 'This release changed after it was downloaded. Check again.'); return this.status() }
    const kind = this.installKind()
    if (kind === 'manual') throw new Error('Install this update from Releases')
    this.set('installing', kind === 'installer' ? 'The installer is closing AI Usage and will open it again.' : 'Drag AI Usage onto Applications in the opened window, then reopen it.')
    try { await (this.options.launch ?? launchPackage)(file, kind) }
    catch (error) { this.set('error', `Could not start the installer: ${(error as Error).message}`) }
    if (kind === 'disk-image') this.set('ready', 'Disk image opened. Replace AI Usage in Applications, then reopen it.')
    return this.status()
  }
}

/**
 * Windows: the broker runs in the shell's kill-on-close job, so a child would die when the
 * installer closes the app. WMI creates the installer outside that job. The path is our own
 * staging file and travels in an environment variable, never inside the script text.
 * The Tauri NSIS installer in passive mode (/P) closes the running app and /R relaunches it.
 */
export async function launchPackage(file: string, kind: UpdateStatus['installKind']): Promise<void> {
  if (kind === 'disk-image') { await run('/usr/bin/open', [file], {}); return }
  const script = '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = (\'"\' + $env:AIU_UPDATE_PACKAGE + \'" /P /R\') }; if ($r.ReturnValue -ne 0) { exit [int]$r.ReturnValue }'
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { AIU_UPDATE_PACKAGE: file })
}

function run(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')) }, 60_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit code ${code}`)) })
  })
}
