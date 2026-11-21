import { APP_VERSION } from '../shared/version'
import readline from 'node:readline'
import path from 'node:path'
import os from 'node:os'
import { kvGet, kvSet, openDb, purgeScanData } from './db'
import { Updater } from './updater'
import type { UpdatePrefs } from '../shared/update'
import { appDbPath, userDataPath } from './paths'
import { getSettings, saveSettings } from './settings'
import { getAnalytics, getHistory, getOverview, getProviderDetail } from './queries'
import { priceCatalog } from './pricing'
import { getQuotaSnapshot, startQuotaService } from './quota'
import { OPENROUTER_KEY_REF, findOpenRouterKey, verifyOpenRouterKey } from './openrouter-quota'
import { Scanner } from './scanner'
import { ManagerService } from './manager/service'
import { PROVIDER_IDS } from '../shared/types'
import { makeQuotaCards, trayQuotaLine } from '../shared/quotas'
import { redact } from '../../proxies/endpoints'
import { atomicWrite } from './manager/storage'
import { ipcPath } from './manager/auth-broker'

const send = (frame: unknown): void => { process.stdout.write(JSON.stringify(frame) + '\n') }
const event = (name: string): void => send({ event: name })
let nativeId = 0
const nativePending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
const native = (method: string, value: string): Promise<string> => new Promise((resolve, reject) => {
  // Keychain reads can wait on a macOS approval prompt; give the person time to answer it.
  const limit = method === 'protect' || method === 'unprotect' ? 10 * 60_000 : 30_000
  const id = ++nativeId, timer = setTimeout(() => { nativePending.delete(id); reject(new Error(limit > 30_000 ? 'Timed out waiting for Keychain approval. Allow AI Usage in the Keychain prompt, then reopen AI Usage.' : 'Native operation timed out')) }, limit)
  nativePending.set(id, { resolve, reject, timer }); send({ nativeId: id, native: method, value })
})
const db = openDb(appDbPath()), offline = process.env.AIU_OFFLINE === '1'
const scanner = new Scanner(db, () => getSettings(db), () => event('data:updated'))
const updater = new Updater({ installed: APP_VERSION, dataDir: userDataPath(), prefs: { read: () => kvGet<UpdatePrefs>(db, 'update.prefs') ?? null, write: prefs => kvSet(db, 'update.prefs', prefs) },
  notify: () => event('update:updated'), busy: () => manager.activity(),
  // Packaged Windows app: the broker runs on aiu-node.exe next to the relay it must move aside.
  installDir: process.platform === 'win32' && /^aiu-node/i.test(path.basename(process.execPath)) ? path.dirname(process.execPath) : undefined })
const pool = process.env.AIU_POOL || path.join(os.homedir(), '.agents')
const manager = new ManagerService(pool, userDataPath(), process.env.AIU_HOME || os.homedir(), native, () => event('manager:updated'))
// The OpenRouter key saved in Settings lives in the manager's encrypted vault.
const savedOpenRouterKey = (): Promise<string | undefined> => ready.then(() => manager.vault.refs().includes(OPENROUTER_KEY_REF) ? manager.vault.get(OPENROUTER_KEY_REF) : undefined)
let stopping = false
let managerError: string | undefined
const ready = manager.start().catch(error => {
  managerError = redact(error instanceof Error ? error.message : String(error))
  manager.log(managerError); event('data:updated')
  send({ event: 'backend:error', data: managerError })
})
const quota = offline ? null : startQuotaService(db, APP_VERSION, () => event('data:updated'), savedOpenRouterKey)
function validateFilter(filter: any): void { if (!filter || ![1, 7, 30, 90].includes(filter.days) || (filter.provider && !PROVIDER_IDS.includes(filter.provider))) throw new Error('Invalid usage filter') }
async function dispatch(method: string, params: any): Promise<any> {
  switch (method) {
    case 'app:meta': return { version: APP_VERSION, platform: process.platform, userDataPath: userDataPath(), appDbPath: appDbPath(), managerError }
    case 'settings:get': return getSettings(db)
    case 'settings:set': {
      const old = getSettings(db), next = saveSettings(db, params)
      if (old.launchAtLogin !== next.launchAtLogin) await native('autostart', String(next.launchAtLogin))
      if (JSON.stringify(old.paths) !== JSON.stringify(next.paths)) { scanner.watch(); void scanner.whenIdle().then(() => scanner.fullScan()) }
      event('data:updated'); return next
    }
    case 'data:overview': return getOverview(db, getSettings(db), scanner.status())
    case 'data:provider': if (!PROVIDER_IDS.includes(params)) throw new Error('Unknown tool'); return getProviderDetail(db, params, getSettings(db))
    case 'data:analytics': validateFilter(params ?? { days: 90 }); return getAnalytics(db, getSettings(db), Date.now(), params ?? { days: 90 })
    case 'data:history': validateFilter(params); if (!Number.isFinite(params.offset ?? 0) || !Number.isFinite(params.limit ?? 25)) throw new Error('Invalid page'); return getHistory(db, getSettings(db), params)
    case 'pricing:catalog': return priceCatalog((db.prepare('SELECT DISTINCT model FROM usage_events WHERE model IS NOT NULL').all() as Array<{ model: string }>).map(row => row.model))
    case 'pricing:source': if (!priceCatalog().some(price => price.sourceUrl === params)) throw new Error('Unknown pricing source'); return native('open-url', params)
    case 'quota:get': return getQuotaSnapshot(db)
    case 'update:status': return updater.status()
    case 'update:check': return updater.check()
    case 'update:channel': return updater.setChannel(params)
    case 'update:autoCheck': return updater.setAutoCheck(!!params)
    case 'update:download': return updater.download()
    case 'update:install': return updater.install()
    case 'update:releases': return native('open-url', updater.status().releasesUrl)
    case 'tray:quotas': {
      const settings = getSettings(db), cards = makeQuotaCards(getQuotaSnapshot(db), settings, getOverview(db, settings, scanner.status())), now = Date.now()
      return settings.pinnedQuotas.map(id => cards.find(card => card.id === id)).filter(card => !!card).map(card => ({ id: card.id, text: trayQuotaLine(card, now) }))
    }
    case 'openrouter:key': {
      await ready
      if (params === null) await manager.vault.delete(OPENROUTER_KEY_REF)
      else if (params !== undefined) { const key = String(params).trim(), label = await verifyOpenRouterKey(key); await manager.vault.set(OPENROUTER_KEY_REF, key); void quota?.refresh(); return { saved: true, zcode: !!findOpenRouterKey(), label } }
      if (params === null) void quota?.refresh()
      return { saved: manager.vault.refs().includes(OPENROUTER_KEY_REF), zcode: !!findOpenRouterKey() }
    }
    case 'quota:refresh': if (offline) throw new Error('Live quota refresh is disabled in offline mode'); await quota?.refresh(); return getQuotaSnapshot(db)
    case 'scan:full': await scanner.fullScan(); return scanner.status()
    case 'scan:reindex': await scanner.whenIdle(); purgeScanData(db); await scanner.fullScan(); return scanner.status()
    case 'app:shutdown': await shutdown(); return null
    default: await ready; if (managerError) throw new Error(`Shared manager: ${managerError}. Startup log: ${path.join(userDataPath(), 'broker-startup.log')}`); return manager.dispatch(method, params)
  }
}
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true
  scanner.close(); quota?.stop(); await manager.close(); await scanner.whenIdle(); db.close()
  process.exit(0)
}
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  let frame: any
  try { frame = JSON.parse(line) } catch { return }
  if (frame.nativeId) {
    const pending = nativePending.get(frame.nativeId)
    if (pending) { clearTimeout(pending.timer); nativePending.delete(frame.nativeId); if (frame.error) pending.reject(new Error(frame.error)); else pending.resolve(frame.result ?? '') }
    return
  }
  if (typeof frame.id !== 'number' || typeof frame.method !== 'string' || stopping) return
  void dispatch(frame.method, frame.params).then(result => send({ id: frame.id, result: result ?? null }), error => send({ id: frame.id, error: redact(error instanceof Error ? error.message : String(error)) }))
})
input.on('close', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
// One update check shortly after launch (at most daily, if enabled); no polling loop.
if (!offline) { void updater.cleanup(); setTimeout(() => void updater.checkOnLaunch(), 20_000).unref() }
void ready.then(() => {
  if (!managerError && !process.env.AIU_PROFILE && !process.env.AIU_HOME) {
    // Re-register at every start: an entry written by an older install path (or from
    // inside another app's package registry) would otherwise silently never run.
    void native('autostart', String(getSettings(db).launchAtLogin)).catch(error => manager.log(`Launch at login: ${error.message}`))
    void atomicWrite(path.join(pool, 'manager-runtime.json'), JSON.stringify({ relay: manager.supervisor.executable(), node: process.execPath, sync: path.join(path.dirname(process.argv[1]), 'sync.mjs'), cli: path.join(path.dirname(process.argv[1]), 'manager.mjs'), pipe: ipcPath(pool), token: manager.auth.token, app: process.env.AIU_HOST_EXE, version: APP_VERSION }, null, 2)).catch(error => manager.log(error.message))
  }
  event('backend:ready')
}).catch(error => send({ event: 'backend:error', data: redact(error.message) }))
if (process.env.AIU_NO_SCAN !== '1') { scanner.watch(); void scanner.fullScan().catch(error => manager.log(error.message)) }
