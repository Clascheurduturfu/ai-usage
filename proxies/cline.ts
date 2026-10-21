import fs from 'node:fs/promises'
import { atomicWrite, hash } from '../src/main/manager/storage'

export class ClineCredentials {
  private refreshTask: Promise<string> | null = null
  constructor(private file: string, private baseUrl: string, private portable?: { read(): Promise<Record<string, any> | null>; write(auth: Record<string, any>): Promise<void> }) {}
  async token(force = false): Promise<string> {
    if (this.refreshTask) return this.refreshTask
    this.refreshTask = this.readOrRefresh(force).finally(() => { this.refreshTask = null })
    return this.refreshTask
  }
  private async readOrRefresh(force: boolean): Promise<string> {
    let original: string | null = null
    try { original = await fs.readFile(this.file, 'utf8') } catch { /* A portable session can be used when this client is absent. */ }
    const data = original ? JSON.parse(original) : null
    const auth = data?.providers?.cline?.settings?.auth ?? await this.portable?.read()
    if (!auth?.accessToken) throw new Error('Cline has no signed-in account')
    if (!force && (!auth.expiresAt || Number(auth.expiresAt) > Date.now() + 60_000)) return auth.accessToken
    if (!auth.refreshToken) throw new Error('Cline session expired; sign in again')
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken }), signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`Cline authentication refresh failed: HTTP ${response.status}`)
    const updated = await response.json() as Record<string, any>
    if (!updated.access_token) throw new Error('Cline refresh did not return an access token')
    if (original) {
      const latest = await fs.readFile(this.file, 'utf8')
      if (hash(latest) !== hash(original)) throw new Error('Cline sign-in changed during refresh; reconnect the endpoint')
    }
    auth.accessToken = updated.access_token
    auth.refreshToken = updated.refresh_token ?? auth.refreshToken
    auth.expiresAt = Date.now() + Number(updated.expires_in ?? 3600) * 1000
    if (original) await atomicWrite(this.file, JSON.stringify(data, null, 2) + '\n')
    else await this.portable?.write(auth)
    return auth.accessToken
  }
}
