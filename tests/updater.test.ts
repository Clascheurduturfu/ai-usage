import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedAssetUrl, compareVersions, parseVersion, selectUpdate, Updater, type GhRelease } from '../src/main/updater'
import type { UpdatePrefs } from '../src/shared/update'

const v = (s: string) => parseVersion(s)!
const bytes = Buffer.from('installer bytes')
const sha = createHash('sha256').update(bytes).digest('hex')
let nextId = 1
function release(tag: string, prerelease: boolean, extra: Partial<GhRelease> = {}, digest: string | null = `sha256:${sha}`): GhRelease {
  const version = tag.replace(/^v/, ''), id = nextId++
  return { id, tag_name: tag, name: `AI Usage ${version}`, draft: false, prerelease, body: 'notes', html_url: `https://github.com/o/r/releases/tag/${tag}`,
    assets: [{ id: id * 10, name: `AI Usage_${version}_x64-setup.exe`, size: bytes.length, digest }, { id: id * 10 + 1, name: `AI Usage_${version}_aarch64.dmg`, size: bytes.length, digest }], ...extra }
}

describe('version order', () => {
  it('compares numeric prerelease parts and ranks finals above their prereleases', () => {
    expect(compareVersions(v('1.1.0-beta.10'), v('1.1.0-beta.9'))).toBeGreaterThan(0)
    expect(compareVersions(v('1.1.0'), v('1.1.0-rc.1'))).toBeGreaterThan(0)
    expect(compareVersions(v('1.1.0-rc.1'), v('1.1.0-beta.12'))).toBeGreaterThan(0)
    expect(compareVersions(v('v2.0.0'), v('1.99.99'))).toBeGreaterThan(0)
    expect(compareVersions(v('1.0.0-beta'), v('1.0.0-beta.1'))).toBeLessThan(0)
    for (const bad of ['latest', '1.0', '01.0.0', 'v1.0.0-', 'preview']) expect(parseVersion(bad)).toBeNull()
  })
})

describe('release selection', () => {
  const feed = [release('v1.0.3', false), release('v1.1.0-beta.2', true), release('v1.1.0-beta.10', true), release('v1.2.0', false, { draft: true }), release('v1.4.0', true), release('nightly', true)]
  it('gives Stable final releases only', () => {
    expect(selectUpdate(feed, 'stable', '1.0.2', 'win32', 'x64')?.version).toBe('1.0.3')
  })
  it('gives Preview the newest prerelease, numerically, and ignores mislabeled releases and drafts', () => {
    const pick = selectUpdate(feed, 'preview', '1.0.2', 'win32', 'x64')!
    expect(pick.version).toBe('1.1.0-beta.10'); expect(pick.asset.name).toBe('AI Usage_1.1.0-beta.10_x64-setup.exe'); expect(pick.sha256).toBe(sha)
    expect(selectUpdate(feed, 'preview', '1.0.2', 'darwin', 'arm64')?.asset.name).toBe('AI Usage_1.1.0-beta.10_aarch64.dmg')
  })
  it('offers Preview users a newer Stable', () => {
    expect(selectUpdate([...feed, release('v1.1.0', false)], 'preview', '1.1.0-beta.10', 'win32', 'x64')?.version).toBe('1.1.0')
  })
  it('never downgrades a Preview install that switches to Stable', () => {
    expect(selectUpdate(feed, 'stable', '1.1.0-beta.10', 'win32', 'x64')).toBeNull()
  })
  it('rejects a newest release without one verifiable package', () => {
    expect(() => selectUpdate([release('v1.0.4', false, {}, null)], 'stable', '1.0.2', 'win32', 'x64')).toThrow(/SHA-256/)
    expect(() => selectUpdate([release('v1.0.4', false, { assets: [] })], 'stable', '1.0.2', 'win32', 'x64')).toThrow(/no package/)
    const twice = release('v1.0.4', false); twice.assets.push({ ...twice.assets[0], id: 999 })
    expect(() => selectUpdate([twice], 'stable', '1.0.2', 'win32', 'x64')).toThrow(/more than one/)
    expect(() => selectUpdate([release('v1.0.4', false)], 'stable', '1.0.2', 'linux', 'x64')).toThrow(/not available/)
  })
  it('only follows HTTPS redirects to GitHub asset hosts', () => {
    expect(allowedAssetUrl(new URL('https://release-assets.githubusercontent.com/x'))).toBe(true)
    expect(allowedAssetUrl(new URL('http://objects.githubusercontent.com/x'))).toBe(false)
    expect(allowedAssetUrl(new URL('https://evil.example/x'))).toBe(false)
  })
})

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>
async function harness(routes: Route, options: { installed?: string; busy?: string; platform?: string } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-update-'))
  let prefs: UpdatePrefs | null = null
  const launched: string[] = []
  const updater = new Updater({ installed: options.installed ?? '1.0.2', dataDir, platform: options.platform ?? 'win32', arch: 'x64', repository: 'o/r',
    prefs: { read: () => prefs, write: p => { prefs = { ...p } } }, notify: () => undefined, busy: () => options.busy ?? null,
    fetch: (async (input: string | URL, init?: RequestInit) => routes(String(input), init)) as typeof fetch,
    launch: async file => { launched.push(file) } })
  return { updater, dataDir, launched, prefs: () => prefs }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('updater flow', () => {
  it('checks, downloads through an allowed redirect, verifies and hands off the installer', async () => {
    const r = release('v1.0.3', false)
    const { updater, launched, prefs } = await harness(url => {
      if (url.endsWith('/releases?per_page=30')) return json([r])
      if (url.endsWith(`/releases/assets/${r.assets[0].id}`)) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/blob' } })
      if (url === 'https://release-assets.githubusercontent.com/blob') return new Response(bytes)
      if (url.endsWith(`/releases/${r.id}`)) return json(r)
      return new Response('missing', { status: 404 })
    })
    expect((await updater.check()).state).toBe('available')
    expect(prefs()?.lastCheck).toBeTypeOf('number')
    const ready = await updater.download()
    expect(ready.state).toBe('ready'); expect(ready.progress).toEqual({ received: bytes.length, total: bytes.length })
    expect((await updater.install()).state).toBe('installing')
    expect(launched).toHaveLength(1); expect(await fs.readFile(launched[0])).toEqual(bytes)
    expect(path.basename(launched[0])).toBe('AI-Usage-1.0.3-setup.exe')
  })
  it('discards a package whose bytes do not match the digest', async () => {
    const r = release('v1.0.3', false)
    const { updater, dataDir } = await harness(url => url.includes('per_page') ? json([r]) : new Response(Buffer.from('tampered bytes!')))
    await updater.check()
    const result = await updater.download()
    expect(result.state).toBe('error'); expect(result.message).toMatch(/SHA-256/)
    expect(await fs.readdir(path.join(dataDir, 'updates')).then(list => list.length)).toBe(0)
  })
  it('refuses redirects to other hosts and oversized bodies', async () => {
    const r = release('v1.0.3', false)
    const evil = await harness(url => url.includes('per_page') ? json([r]) : new Response(null, { status: 302, headers: { location: 'https://evil.example/payload' } }))
    await evil.updater.check(); expect((await evil.updater.download()).message).toMatch(/evil\.example/)
    const big = await harness(url => url.includes('per_page') ? json([r]) : new Response(Buffer.concat([bytes, bytes])))
    await big.updater.check(); expect((await big.updater.download()).message).toMatch(/larger/)
  })
  it('drops a result that arrives after the channel changed', async () => {
    let answer!: (r: Response) => void
    const { updater } = await harness(() => new Promise<Response>(resolve => { answer = resolve }))
    const pending = updater.check()
    updater.setChannel('preview')
    answer(json([release('v1.0.3', false)]))
    expect((await pending).state).toBe('idle'); expect(updater.status().available).toBeUndefined()
  })
  it('stops when the rolling release disappeared or the library is busy', async () => {
    const r = release('v1.1.0-beta.3', true)
    let gone = false
    const routes: Route = url => url.includes('per_page') ? json([r]) : url.endsWith(`/releases/${r.id}`) ? (gone ? json({ message: 'Not Found' }, 404) : json(r)) : new Response(bytes)
    const busy = await harness(routes, { busy: 'a sync' })
    busy.updater.setChannel('preview'); await busy.updater.check(); await busy.updater.download()
    await expect(busy.updater.install()).rejects.toThrow(/a sync/)
    const { updater, launched } = await harness(routes)
    updater.setChannel('preview'); await updater.check(); await updater.download()
    gone = true
    const result = await updater.install()
    expect(result.state).toBe('error'); expect(launched).toEqual([])
  })
  it('reports rate limits and keeps the saved channel', async () => {
    const { updater, prefs } = await harness(() => new Response('{}', { status: 403, headers: { 'x-ratelimit-reset': '1800000000' } }))
    updater.setChannel('preview')
    const result = await updater.check()
    expect(result.state).toBe('error'); expect(result.message).toMatch(/rate limit/)
    expect(prefs()?.channel).toBe('preview')
  })
  it('checks at launch at most once a day', async () => {
    let calls = 0
    const { updater } = await harness(() => { calls++; return json([]) })
    await updater.checkOnLaunch(); await updater.checkOnLaunch()
    expect(calls).toBe(1); expect(updater.status().state).toBe('up-to-date')
  })
})
