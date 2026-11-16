import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openExternalDb } from './db'
import type { AntigravityQuotaDTO } from '../shared/types'
import { antigravityRpc } from './antigravity-rpc'

/**
 * Antigravity (Google) subscription quota — built from scratch (the macOS
 * AIUsage app reportedly struggles here). Approach, verified live:
 *
 * 1. The IDE stores its Google OAuth state in VS Code's state.vscdb
 *    (key `antigravityUnifiedStateSync.oauthToken`) as
 *    base64(protobuf{ base64(protobuf{ access: "ya29...", "Bearer", refresh }) }).
 * 2. The OAuth client secret is embedded in the installed `agy` binary
 *    (GOCSPX-… strings — the same technique the open-source agyp switcher uses).
 * 3. Refresh the access token via oauth2.googleapis.com, then call the
 *    cloudcode-pa "loadCodeAssist" + "retrieveUserQuotaSummary" internal APIs
 *    the Antigravity CLI itself uses, read-only.
 */

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CLOUDCODE_BASE = 'https://daily-cloudcode-pa.googleapis.com'
const SECRET_REGEX = /GOCSPX-[A-Za-z0-9_-]{28}/g

export function antigravityBinaryCandidates(): string[] {
  if (process.platform === 'darwin') {
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')]
    return [
      ...roots.flatMap((root) => ['Antigravity.app', 'Antigravity IDE.app'].map((name) => path.join(root, name, 'Contents', 'Resources', 'bin', 'language_server'))),
      path.join(os.homedir(), '.local', 'bin', 'agy')
    ]
  }
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  return [
    path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'bin', 'language_server.exe'),
    path.join(programFiles, 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join(localAppData, 'agy', 'bin', 'agy.exe')
  ]
}

interface PbField {
  field: number
  value: number | Uint8Array
}

function readProtobuf(buf: Uint8Array): PbField[] {
  const fields: PbField[] = []
  let i = 0
  while (i < buf.length) {
    const tag = buf[i]
    i += 1
    const field = tag >> 3
    const wire = tag & 7
    if (wire === 2) {
      let len = buf[i]
      if (len < 128) {
        i += 1
      } else {
        len = (len & 0x7f) | (buf[i + 1] << 7)
        i += 2
      }
      fields.push({ field, value: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 0) {
      let val = 0
      let shift = 0
      while (i < buf.length) {
        const b = buf[i]
        i += 1
        val |= (b & 0x7f) << shift
        shift += 7
        if ((b & 0x80) === 0) break
      }
      fields.push({ field, value: val })
    } else {
      break
    }
  }
  return fields
}

const b64 = (s: string): Buffer => Buffer.from(s + '===', 'base64')

/**
 * Extract the refresh token from the IDE's state.vscdb blob.
 * Exported for unit tests with an explicit db file path.
 */
export function extractAntigravityRefreshToken(stateDbPath: string): string | null {
  let db: ReturnType<typeof openExternalDb> | null = null
  try {
    db = openExternalDb(stateDbPath)
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('antigravityUnifiedStateSync.oauthToken') as { value: string } | undefined
    if (!row?.value) return null
    const outer = readProtobuf(b64(row.value))
    for (const f1 of outer) {
      if (f1.field !== 1 || !(f1.value instanceof Uint8Array)) continue
      for (const f2 of readProtobuf(f1.value)) {
        if (f2.field !== 2 || !(f2.value instanceof Uint8Array)) continue
        for (const f3 of readProtobuf(f2.value)) {
          if (f3.field !== 1 || !(f3.value instanceof Uint8Array)) continue
          const inner = readProtobuf(b64(Buffer.from(f3.value).toString('utf8')))
          for (const f4 of inner) {
            if (f4.field === 3 && f4.value instanceof Uint8Array) {
              const s = Buffer.from(f4.value).toString('utf8')
              return s.startsWith('1//') ? s : null
            }
          }
        }
      }
    }
    return null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

export function stateDbPath(): string {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  const candidates = ['Antigravity IDE', 'Antigravity'].map((name) => path.join(base, name, 'User', 'globalStorage', 'state.vscdb'))
  return candidates.filter((file) => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? candidates[0]
}

export function extractAntigravityAccessToken(file: string): string | null {
  let db: ReturnType<typeof openExternalDb> | null = null
  try {
    db = openExternalDb(file)
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.oauthToken') as { value: string } | undefined
    if (!row?.value) return null
    for (const f1 of readProtobuf(b64(row.value))) {
      if (f1.field !== 1 || !(f1.value instanceof Uint8Array)) continue
      for (const f2 of readProtobuf(f1.value)) {
        if (f2.field !== 2 || !(f2.value instanceof Uint8Array)) continue
        for (const f3 of readProtobuf(f2.value)) {
          if (f3.field !== 1 || !(f3.value instanceof Uint8Array)) continue
          for (const f4 of readProtobuf(b64(Buffer.from(f3.value).toString('utf8')))) {
            if (f4.field === 1 && f4.value instanceof Uint8Array) {
              const token = Buffer.from(f4.value).toString('utf8')
              if (token.startsWith('ya29.')) return token
            }
          }
        }
      }
    }
    return null
  } catch { return null } finally { db?.close() }
}

let cachedClientSecret: string | null | undefined
let cachedSecretCandidates: string[] = []
let verifiedClientSecret: string | null = null

function standaloneToken(): { access_token?: string; refresh_token?: string; expiry?: string } | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token'), 'utf8'))
    return data.token && typeof data.token === 'object' ? data.token : null
  } catch { return null }
}

function scanBinaryForSecrets(file: string): string[] {
  const CHUNK = 8 * 1024 * 1024
  const OVERLAP = 64
  const found: string[] = []
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(CHUNK + OVERLAP)
    let offset = 0
    while (true) {
      const read = fs.readSync(fd, buf, 0, CHUNK + OVERLAP, offset)
      if (read === 0) break
      const m = buf.toString('latin1', 0, read).match(SECRET_REGEX)
      if (m) found.push(...m)
      offset += CHUNK
    }
  } finally {
    fs.closeSync(fd)
  }
  return found
}

/**
 * Client secrets embedded in the installed Antigravity binary (agyp's technique).
 * Scans in chunks so a 200MB binary doesn't block the process for long.
 */
export function findAntigravityClientSecret(binaryPath?: string): string | null {
  if (cachedClientSecret !== undefined) return cachedClientSecret
  const targets = binaryPath ? [binaryPath] : antigravityBinaryCandidates().filter((file) => fs.existsSync(file))
  const found: string[] = []
  for (const file of targets) {
    try {
      const matches = scanBinaryForSecrets(file)
      if (matches.length) {
        found.push(...matches)
        break
      }
    } catch {
      /* try next binary candidate */
    }
  }
  cachedSecretCandidates = [...new Set(found)]
  cachedClientSecret = cachedSecretCandidates[0] ?? null
  return cachedClientSecret
}

/** Secret confirmed to work with the live OAuth refresh endpoint in this session. */
export function verifiedAntigravityClientSecret(): string | null {
  return verifiedClientSecret
}

/** Test hook. */
export function resetClientSecretCache(): void {
  cachedClientSecret = undefined
  cachedSecretCandidates = []
  verifiedClientSecret = null
}

async function refreshAccessToken(refreshToken: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  const res = await fetch(OAUTH_TOKEN_URL, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`)
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('refresh returned no access token')
  return data.access_token
}

interface CloudCodeResp {
  paidTier?: { name?: string }
  currentTier?: { name?: string; id?: string }
  planInfo?: { planType?: string; monthlyPromptCredits?: number }
  availablePromptCredits?: number
  cloudaicompanionProject?: string | { id?: string }
}

interface QuotaSummaryResp {
  groups?: Array<{
    displayName?: string
    buckets?: Array<{
      bucketId?: string
      displayName?: string
      window?: string
      resetTime?: string
      description?: string
      remainingFraction?: number
    }>
  }>
}

interface AvailableModelsResp {
  models?: Record<string, {
    displayName?: string
    quotaInfo?: { remainingFraction?: number; resetTime?: string }
  }>
}

type RawModelQuota = { id: string; label?: string; remainingFraction?: number; resetTime?: string }

/**
 * The API is proto3 JSON, which omits zero values: an exhausted model has a `resetTime` and no
 * `remainingFraction`. Only a model with neither carries no quota information.
 */
export function modelRemaining(remainingFraction: unknown, resetTime: unknown): number | null {
  if (typeof remainingFraction === 'number' && Number.isFinite(remainingFraction)) return remainingFraction
  return typeof resetTime === 'string' && Number.isFinite(Date.parse(resetTime)) ? 0 : null
}

function hasGeminiBucket(buckets: AntigravityQuotaDTO['buckets']): boolean {
  return buckets.some((b) => /gemini/i.test(`${b.id} ${b.group} ${b.label}`))
}

/** Synthesize Gemini quota bucket(s) from model quota entries when retrieveUserQuotaSummary omits them. */
export function geminiBucketsFromModels(models: Iterable<RawModelQuota>): AntigravityQuotaDTO['buckets'] {
  const summarize = (list: Array<{ remainingFraction: number; resetTime: number | null }>) => {
    const remainingFraction = Math.max(0, Math.min(1, Math.min(...list.map((m) => m.remainingFraction))))
    const resets = list.map((m) => m.resetTime).filter((t): t is number => t !== null)
    return { remainingFraction, resetTime: resets.length ? Math.min(...resets) : null }
  }
  const pro: Array<{ remainingFraction: number; resetTime: number | null }> = []
  const flash: Array<{ remainingFraction: number; resetTime: number | null }> = []
  for (const model of models) {
    const text = `${model.id} ${model.label ?? ''}`
    if (!/gemini/i.test(text)) continue
    const frac = modelRemaining(model.remainingFraction, model.resetTime)
    if (frac === null) continue
    const parsed = model.resetTime ? Date.parse(model.resetTime) : Number.NaN
    const entry = { remainingFraction: frac, resetTime: Number.isFinite(parsed) ? parsed : null }
    if (/(?:^|[-_\s])pro(?:[-_\s(]|$)/i.test(text)) pro.push(entry)
    else flash.push(entry)
  }
  if (!pro.length && !flash.length) return []
  if (pro.length && flash.length) {
    const proSum = summarize(pro), flashSum = summarize(flash)
    if (Math.round(proSum.remainingFraction * 100) !== Math.round(flashSum.remainingFraction * 100) || proSum.resetTime !== flashSum.resetTime) {
      return [
        { id: 'gemini-pro', group: 'Gemini Pro', label: 'Gemini Pro', window: '', ...proSum, description: 'Google Gemini Pro models' },
        { id: 'gemini-flash', group: 'Gemini Flash', label: 'Gemini Flash', window: '', ...flashSum, description: 'Google Gemini Flash models' }
      ]
    }
  }
  const all = summarize([...pro, ...flash])
  return [{ id: 'gemini', group: 'Gemini models', label: 'Gemini models', window: '', ...all, description: 'Google Gemini models' }]
}

async function cloudcodePost<T>(endpoint: string, accessToken: string, payload: unknown): Promise<T> {
  const res = await fetch(`${CLOUDCODE_BASE}/v1internal:${endpoint}`, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity'
    },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`)
  return (await res.json()) as T
}

/**
 * Fetch the live Antigravity subscription snapshot. Read-only; never writes
 * back to the IDE's storage (the IDE refreshes its own tokens independently).
 * `clientSecret` may be injected so callers can cache it across restarts.
 */
export async function fetchAntigravityQuota(clientSecret?: string): Promise<AntigravityQuotaDTO | null> {
  const base = { fetchedAt: Date.now(), availablePromptCredits: null, monthlyPromptCredits: null, buckets: [] }
  try {
    {
      // The running client refreshes its own OAuth session (macOS and Windows; returns nothing when
      // Antigravity is closed, and the cloud path below takes over). Reading its model
      // quotas avoids pairing a standalone refresh token with an IDE client ID.
      const [response, quota] = await Promise.all([antigravityRpc('GetUserStatus'), antigravityRpc('RetrieveUserQuotaSummary')])
      const user = response?.userStatus
      const grouped: AntigravityQuotaDTO['buckets'] = (quota?.response?.groups ?? []).flatMap((group: any) => (group.buckets ?? []).flatMap((bucket: any) => {
        bucket = { ...bucket, remainingFraction: modelRemaining(bucket.remainingFraction, bucket.resetTime) }
        if (bucket.remainingFraction === null) return []
        const reset = Date.parse(bucket.resetTime ?? '')
        return [{ id: String(bucket.bucketId ?? `${group.displayName}-${bucket.window}`), group: String(group.displayName ?? 'Quota'), label: String(bucket.displayName ?? bucket.bucketId ?? 'Quota'), window: String(bucket.window ?? ''), remainingFraction: Math.max(0, Math.min(1, bucket.remainingFraction)), resetTime: Number.isFinite(reset) ? reset : null, description: bucket.description ?? null }]
      }))
      const clientModels: RawModelQuota[] = (user?.cascadeModelConfigData?.clientModelConfigs ?? []).map((model: any) => ({
        id: String(model.modelOrAlias?.model ?? model.modelId ?? model.label ?? ''),
        label: typeof model.label === 'string' ? model.label : undefined,
        remainingFraction: model.quotaInfo?.remainingFraction,
        resetTime: model.quotaInfo?.resetTime
      }))
      if (grouped.length) {
        const buckets = hasGeminiBucket(grouped) ? grouped : [...grouped, ...geminiBucketsFromModels(clientModels)]
        return { ...base, fetchedAt: Date.now(), plan: user?.userTier?.name ?? user?.planStatus?.planInfo?.planName ?? 'unknown', buckets }
      }
      if (user) {
        const buckets = (user.cascadeModelConfigData?.clientModelConfigs ?? []).flatMap((model: any) => {
          const remaining = modelRemaining(model.quotaInfo?.remainingFraction, model.quotaInfo?.resetTime)
          if (remaining === null) return []
          const label = String(model.label ?? model.modelId ?? 'Model'), reset = Date.parse(model.quotaInfo?.resetTime ?? '')
          return [{ id: String(model.modelId ?? label), group: label, label, window: '', remainingFraction: Math.max(0, Math.min(1, remaining)), resetTime: Number.isFinite(reset) ? reset : null, description: 'Reported by the running Antigravity client' }]
        })
        if (buckets.length) return { ...base, fetchedAt: Date.now(), plan: user.userTier?.name ?? user.planStatus?.planInfo?.planName ?? 'unknown', buckets }
      }
    }
    const standalone = standaloneToken(), file = stateDbPath()
    const refreshToken = process.platform === 'darwin' && standalone?.refresh_token ? standalone.refresh_token : extractAntigravityRefreshToken(file) ?? standalone?.refresh_token
    const metadata = {
      metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    }
    let accessToken = process.platform === 'darwin' ? standalone?.access_token ?? extractAntigravityAccessToken(file) : undefined
    let load: CloudCodeResp | undefined
    if (accessToken) {
      try { load = await cloudcodePost<CloudCodeResp>('loadCodeAssist', accessToken, metadata) }
      catch (error) { if (!(error as Error).message.endsWith('HTTP 401')) throw error }
    }
    if (!load) {
      if (!refreshToken) throw new Error('Sign in to Antigravity on this machine. No supported OAuth state was found.')
      const initialSecret = clientSecret ?? findAntigravityClientSecret()
      if (!initialSecret) throw new Error('Antigravity OAuth client metadata was not found in the installed app. Open or update Antigravity, then refresh.')
      let refreshError: Error | undefined
      const tryCandidates = async (candidates: string[]): Promise<boolean> => {
        for (const candidate of candidates) {
          try {
            accessToken = await refreshAccessToken(refreshToken, candidate)
            verifiedClientSecret = candidate
            refreshError = undefined
            return true
          } catch (error) {
            refreshError = error as Error
            if (!refreshError.message.endsWith('HTTP 400') && !refreshError.message.endsWith('HTTP 401')) throw error
          }
        }
        return false
      }
      // Try injected/cached secret first; on rejection scan installed binary so all embedded GOCSPX candidates are tried.
      const tried = [...new Set([initialSecret, ...cachedSecretCandidates])]
      if (!await tryCandidates(tried)) {
        findAntigravityClientSecret()
        const remaining = cachedSecretCandidates.filter((c) => !tried.includes(c))
        if (remaining.length) await tryCandidates(remaining)
      }
      if (refreshError) throw refreshError
      load = await cloudcodePost<CloudCodeResp>('loadCodeAssist', accessToken!, metadata)
    }

    const plan =
      load.paidTier?.name ?? load.planInfo?.planType ?? load.currentTier?.name ?? load.currentTier?.id ?? 'unknown'
    const project = load.cloudaicompanionProject
    const projectId = typeof project === 'string' ? project : project?.id
    if (!accessToken) throw new Error('Antigravity did not provide an access token')

    const payload = projectId ? { project: projectId } : {}
    const [summaryResult, modelsResult] = await Promise.allSettled([
      cloudcodePost<QuotaSummaryResp>('retrieveUserQuotaSummary', accessToken, payload),
      cloudcodePost<AvailableModelsResp>('fetchAvailableModels', accessToken, payload)
    ])
    if (summaryResult.status === 'rejected' && modelsResult.status === 'rejected') {
      return { ...base, plan, error: `Quota summary unavailable: ${(summaryResult.reason as Error).message}` }
    }

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null
    const summaryBuckets: AntigravityQuotaDTO['buckets'] = (summary?.groups ?? []).flatMap((g) =>
      (g.buckets ?? []).map((b) => ({
        id: b.bucketId ?? '',
        group: g.displayName ?? 'Quota',
        label: b.displayName ?? b.bucketId ?? '',
        window: b.window ?? '',
        remainingFraction: b.remainingFraction ?? 0,
        resetTime: b.resetTime ? Date.parse(b.resetTime) : null,
        description: b.description ?? null
      }))
    )
    const modelEntries: RawModelQuota[] = modelsResult.status === 'fulfilled'
      ? Object.entries(modelsResult.value.models ?? {}).map(([id, info]) => ({
        id,
        label: info.displayName,
        remainingFraction: info.quotaInfo?.remainingFraction,
        resetTime: info.quotaInfo?.resetTime
      }))
      : []
    const buckets = hasGeminiBucket(summaryBuckets)
      ? summaryBuckets
      : [...summaryBuckets, ...geminiBucketsFromModels(modelEntries)]

    return {
      ...base,
      plan,
      availablePromptCredits: load.availablePromptCredits ?? null,
      monthlyPromptCredits: load.planInfo?.monthlyPromptCredits ?? null,
      buckets,
      error: buckets.length ? undefined : 'The provider returned no quota windows. Refresh after opening Antigravity.'
    }
  } catch (err) {
    return { ...base, plan: 'unknown', error: (err as Error).message }
  }
}
