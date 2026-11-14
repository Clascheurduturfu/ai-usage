/** Stable takes final releases only; Preview also takes the rolling prerelease. */
export type UpdateChannel = 'stable' | 'preview'

export interface UpdatePrefs { channel: UpdateChannel; autoCheck: boolean; lastCheck?: number }

export interface UpdateStatus {
  channel: UpdateChannel
  autoCheck: boolean
  installed: string
  repository: string
  releasesUrl: string
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
  checkedAt?: number
  message?: string
  available?: { version: string; name: string; notes: string; url: string; prerelease: boolean; publishedAt?: string; size: number }
  progress?: { received: number; total: number }
  /** installer: Windows setup replaces and relaunches the app. disk-image: macOS opens the DMG for a manual drag. */
  installKind: 'installer' | 'disk-image' | 'manual'
}
