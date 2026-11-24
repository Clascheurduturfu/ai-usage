import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsFile } from '../paths'
import { kvGet, kvSet, openExternalDb, upsertEvents, type DB, type UpsertEvent } from '../db'
import { hashLine } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

/**
 * Cursor (editor and `cursor-agent` CLI) keeps no usable token counts on disk: the editor's
 * `cursorDiskKV` bubbles record `tokenCount` as zeros on current builds, and the CLI transcripts
 * have none. The billed per-request split lives in the account's usage export, the same CSV the
 * dashboard downloads. AI Usage reads it read-only with the editor's own sign-in
 * (`cursorAuth/accessToken` in `state.vscdb`), at most every 30 minutes.
 * Column names checked against CodeBurn's importer (getagentseal/codeburn src/cursor-import.ts).
 */
export function cursorStateDb(settings?: Pick<Settings, 'paths'>): string {
  const custom = settings?.paths.cursor?.trim()
  if (custom) return custom.endsWith('.vscdb') ? custom : path.join(custom, 'User', 'globalStorage', 'state.vscdb')
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming') : path.join(os.homedir(), '.config')
  return path.join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

const EXPORT_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv'

/** The editor's session JWT and the user id inside its `sub` claim ("auth0|user_…" → "user_…"). */
export function cursorSessionFromToken(token: string | null | undefined): { cookie: string } | { error: string } {
  if (!token) return { error: 'Sign in to Cursor on this device, then refresh.' }
  if (token.startsWith('cursor-safe-storage:')) return { error: 'This Cursor version encrypts its sign-in on disk, so AI Usage cannot read your usage yet.' }
  const parts = token.split('.')
  if (parts.length !== 3) return { error: 'Cursor’s saved sign-in is in an unknown format.' }
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { sub?: unknown }
    const user = typeof payload.sub === 'string' ? payload.sub.split('|').pop() : undefined
    if (!user) return { error: 'Cursor’s saved sign-in has no user id.' }
    return { cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${user}::${token}`)}` }
  } catch { return { error: 'Cursor’s saved sign-in could not be read.' } }
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []; let cell = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) { if (c === '"' && line[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false; else cell += c }
    else if (c === '"') quoted = true
    else if (c === ',') { cells.push(cell); cell = '' }
    else cell += c
  }
  cells.push(cell)
  return cells.map(v => v.trim())
}
const count = (v: string | undefined): number => { const x = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(x) ? Math.round(x) : 0 }

/** One event per billed request. Rows have no request id, so the whole row is the key. */
export function parseCursorUsageCsv(text: string, source = 'cursor:usage-export'): UpsertEvent[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase())
  const col = (...names: string[]): number => header.findIndex(h => names.some(n => h === n))
  const iDate = col('date'), iModel = col('model'), iKind = col('kind'), iWith = col('input (w/ cache write)'), iWithout = col('input (w/o cache write)'), iRead = col('cache read'), iOut = col('output tokens', 'output'), iTotal = col('total tokens'), iCost = col('cost'), iAgent = col('cloud agent id'), iMax = col('max mode')
  if (iDate < 0 || iOut < 0) return []
  return lines.slice(1).flatMap(line => {
    const cells = splitCsvLine(line)
    const raw = cells[iDate] ?? ''
    const ts = Date.parse(raw) || Date.parse(raw.replace(' ', 'T') + 'Z')
    if (!Number.isFinite(ts)) return []
    const withWrite = count(cells[iWith]), without = count(cells[iWithout]), cacheRead = count(cells[iRead]), output = count(cells[iOut]), total = count(cells[iTotal])
    // The two input columns are separate buckets when they add up to the total with reads and output;
    // otherwise "with cache write" already includes the plain input.
    const nested = total > 0 && Math.abs(withWrite + without + cacheRead + output - total) > 1 && Math.abs(withWrite + cacheRead + output - total) <= 1
    const input = without, cacheWrite = nested ? Math.max(0, withWrite - without) : withWrite
    if (input + cacheWrite + cacheRead + output <= 0) return []
    const costText = cells[iCost] ?? '', cost = /\d/.test(costText) && !/included|free/i.test(costText) ? Number(costText.replace(/[^\d.]/g, '')) : NaN
    const agent = iAgent >= 0 && cells[iAgent] ? cells[iAgent] : null
    return [{
      id: `cursor:${hashLine(line)}`, provider: 'cursor', ts, session_id: agent, project: null,
      model: (iModel >= 0 && cells[iModel]) || null, kind: 'tokens',
      input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, reasoning_tokens: 0,
      cost_usd: Number.isFinite(cost) && cost > 0 ? cost : null, source_file: source,
      meta: JSON.stringify({ kind: iKind >= 0 ? cells[iKind] || null : null, maxMode: iMax >= 0 ? cells[iMax] || null : null, granularity: 'request' })
    }]
  })
}

export interface CursorUsageState { fetchedAt: number; error?: string; rows?: number }

function readToken(file: string): string | null {
  const external = openExternalDb(file)
  try {
    const row = external.prepare(`SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'`).get() as { value?: unknown } | undefined
    const value = row?.value
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null
  } finally { external.close() }
}

/** Pull new usage rows since the last one stored (90 days on first run or after a reindex). */
export async function syncCursorUsage(db: DB, settings: Pick<Settings, 'paths'>, now = Date.now()): Promise<CursorUsageState | null> {
  const file = cursorStateDb(settings)
  if (!existsFile(file)) return null
  const previous = kvGet<CursorUsageState>(db, 'cursor:usage')
  if (previous && !previous.error && now - previous.fetchedAt < 25 * 60_000) return previous
  let state: CursorUsageState
  try {
    const session = cursorSessionFromToken(readToken(file))
    if ('error' in session) state = { fetchedAt: now, error: session.error }
    else {
      const last = (db.prepare(`SELECT MAX(ts) t FROM usage_events WHERE provider = 'cursor'`).get() as { t: number | null }).t
      const start = last ? last - 86_400_000 : now - 90 * 86_400_000
      const url = `${EXPORT_URL}?startDate=${start}&endDate=${now}&strategy=tokens`
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { Cookie: session.cookie, Accept: 'text/csv', Origin: 'https://cursor.com', Referer: 'https://cursor.com/dashboard', 'User-Agent': 'ai-usage' } })
      if (res.status === 401 || res.status === 403) state = { fetchedAt: now, error: 'Cursor refused its saved sign-in. Open Cursor once (sign in again if it asks), then refresh.' }
      else if (!res.ok) state = { fetchedAt: now, error: `Cursor usage export: HTTP ${res.status}` }
      else {
        const events = parseCursorUsageCsv(await res.text())
        upsertEvents(db, events)
        state = { fetchedAt: now, rows: events.length }
      }
    }
  } catch (error) { state = { fetchedAt: now, error: `Cursor usage: ${(error as Error).message}` } }
  kvSet(db, 'cursor:usage', state)
  return state
}

export const cursorAdapter: ProviderAdapter = {
  id: 'cursor',
  watchRoots() { return [] },
  status(settings) {
    const file = cursorStateDb(settings)
    return { status: existsFile(file) ? 'ok' : 'no-data', path: file, note: existsFile(file) ? 'Token usage comes from your Cursor account’s usage export, refreshed with the live quotas.' : 'Cursor is not installed or not signed in on this device. Sign in to the Cursor editor once; its usage then appears here.' }
  },
  // Rows arrive from the account export during the quota refresh, not from local files.
  scan(): ScanOutcome { return { filesScanned: 0, eventsAdded: 0, errors: [] } }
}
