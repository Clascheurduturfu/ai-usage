import fs from 'node:fs'
import type { ProviderId, Settings } from '../shared/types'
import type { DB } from './db'
import { ADAPTERS } from './providers'
import type { ScanOutcome } from './providers/types'

export interface ScannerStatusSnapshot {
  lastScanAt: number
  scanning: boolean
  filesScanned: number
  eventsIndexed: number
  errors: string[]
}

/**
 * Minimum time between watch-triggered rescans, for every provider. While you
 * actively work, your AI tools write their ledgers every few seconds and the
 * watch events would otherwise cause a scan -> aggregate -> UI refresh cycle
 * about every 5s. The dashboard's Rescan button bypasses this throttle and
 * refreshes immediately.
 */
const MIN_RESCAN_INTERVAL_MS = 5 * 60 * 1000

/**
 * Coordinates incremental scans of all provider data sources.
 * - fullScan() runs once at startup (and on demand).
 * - watch() attaches fs watchers to provider roots; changes trigger a
 *   debounced re-scan of just the affected provider, then a UI refresh.
 */
export class Scanner {
  private scanning = false
  private lastScanAt = 0
  private filesScanned = 0
  private eventsIndexed = 0
  private errors: string[] = []
  private watchers: fs.FSWatcher[] = []
  private pending = new Set<ProviderId>()
  private debounceTimer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private lastProviderScanAt = new Map<ProviderId, number>()
  private throttleTimers = new Map<ProviderId, NodeJS.Timeout>()
  private active: Promise<void> = Promise.resolve()
  private fullScanTask: Promise<void> | null = null
  private closed = false

  constructor(
    private db: DB,
    private getSettings: () => Settings,
    private onScanComplete: () => void
  ) {}

  status(): ScannerStatusSnapshot {
    return {
      lastScanAt: this.lastScanAt,
      scanning: this.scanning,
      filesScanned: this.filesScanned,
      eventsIndexed: this.eventsIndexed,
      errors: this.errors.slice(-10)
    }
  }

  fullScan(): Promise<void> {
    if (this.fullScanTask) return this.fullScanTask
    this.fullScanTask = this.enqueue(async () => {
      this.errors = []
      for (const id of Object.keys(ADAPTERS) as ProviderId[]) {
        if (this.closed) break
        await this.scanProviderNow(id)
      }
    }).finally(() => { this.fullScanTask = null })
    return this.fullScanTask
  }

  scanProvider(id: ProviderId): Promise<void> {
    return this.enqueue(() => this.scanProviderNow(id))
  }

  whenIdle(): Promise<void> { return this.active }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const task = this.active.then(async () => {
      if (this.closed) return
      this.scanning = true
      try { await run() } finally {
        this.scanning = false
        this.lastScanAt = Date.now()
        if (!this.closed) this.onScanComplete()
      }
    })
    this.active = task.catch(() => undefined)
    return task
  }

  private async scanProviderNow(id: ProviderId): Promise<void> {
    const settings = this.getSettings()
    const adapter = ADAPTERS[id]
    this.lastProviderScanAt.set(id, Date.now())
    try {
      const outcome: ScanOutcome = adapter.scan(settings, this.db)
      this.filesScanned += outcome.filesScanned
      this.eventsIndexed += outcome.eventsAdded
      if (outcome.errors.length > 0) this.errors.push(...outcome.errors)
    } catch (err) {
      this.errors.push(`${id}: ${(err as Error).message}`)
    }
    // scan is synchronous work; yield so the event loop can breathe
    await new Promise((r) => setTimeout(r, 0))
  }

  watch(): void {
    this.stopWatch()
    const settings = this.getSettings()
    for (const id of Object.keys(ADAPTERS) as ProviderId[]) {
      for (const spec of ADAPTERS[id].watchRoots(settings)) {
        try {
          if (!fs.existsSync(spec.path)) continue
          const watcher = fs.watch(
            spec.path,
            { recursive: spec.recursive },
            () => this.scheduleProviderRescan(id)
          )
          watcher.on('error', () => {
            try {
              watcher.close()
            } catch {
              /* ignore */
            }
          })
          this.watchers.push(watcher)
        } catch {
          // Directory missing or not watchable — skip silently.
        }
      }
    }
  }

  stopWatch(): void {
    this.pending.clear()
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.debounceTimer = null
    this.rescanTimer = null
    for (const timer of this.throttleTimers.values()) clearTimeout(timer)
    this.throttleTimers.clear()
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        /* ignore */
      }
    }
    this.watchers = []
  }

  private scheduleProviderRescan(id: ProviderId): void {
    // Antigravity's token-monitor artifacts are rewritten continuously while
    // the IDE runs, which would otherwise trigger a scan every few seconds.
    // Hard-throttle those providers to a minimum interval.
    const minInterval = MIN_RESCAN_INTERVAL_MS
    const since = Date.now() - (this.lastProviderScanAt.get(id) ?? 0)
    if (minInterval > 0 && since < minInterval) {
      // too soon: schedule one trailing rescan at the allowed time
      if (!this.throttleTimers.has(id)) {
        const t = setTimeout(
          () => {
            this.throttleTimers.delete(id)
            this.scheduleProviderRescan(id)
          },
          minInterval - since
        )
        this.throttleTimers.set(id, t)
      }
      return
    }
    this.pending.add(id)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flushPending()
    }, 4000)
  }

  private flushPending(): void {
    if (this.rescanTimer) return
    const run = (): void => {
      this.rescanTimer = null
      const next = this.pending.values().next()
      if (next.done) return
      const id = next.value
      this.pending.delete(id)
      this.lastProviderScanAt.set(id, Date.now())
      void this.scanProvider(id).then(() => {
        if (!this.closed) this.rescanTimer = setTimeout(run, 500)
      })
    }
    run()
  }

  close(): void {
    this.closed = true
    this.stopWatch()
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    for (const t of this.throttleTimers.values()) clearTimeout(t)
    this.throttleTimers.clear()
  }
}
