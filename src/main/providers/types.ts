import type { ProviderId, ProviderStatus, Settings } from '../../shared/types'
import type { DB } from '../db'

export interface WatchSpec {
  path: string
  recursive: boolean
}

export interface ScanOutcome {
  filesScanned: number
  eventsAdded: number
  errors: string[]
}

export interface ProviderStatusInfo {
  status: ProviderStatus
  path: string
  note?: string
}

export interface ProviderAdapter {
  id: ProviderId
  /** Places to watch for data changes. Dirs may not exist yet (created later by the tool). */
  watchRoots(settings: Settings): WatchSpec[]
  /** Human-facing availability check. */
  status(settings: Settings): ProviderStatusInfo
  /** Read the provider's local data into the app DB. Must be idempotent. */
  scan(settings: Settings, db: DB): ScanOutcome
}
