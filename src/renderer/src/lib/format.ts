import type { ProviderId } from '../../../shared/types'

export function fmtTokens(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}K`
  return `${Math.round(v)}`
}

export function fmtUsd(v: number): string {
  if (v === 0) return '$0.00'
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 100) return `$${v.toFixed(2)}`
  return `$${Math.round(v).toLocaleString('en-US')}`
}

export function fmtPct(v: number): string {
  return `${Math.round(v)}%`
}

export function fmtCount(v: number): string {
  return v.toLocaleString('en-US')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${fmtDate(ts)}, ${hh}:${mm}`
}

export function shortDateKey(date: string): string {
  // "2026-09-14" -> "Sep 14"
  const [, m, d] = date.split('-')
  const mi = parseInt(m, 10) - 1
  if (Number.isNaN(mi)) return date
  return `${MONTHS[mi]} ${parseInt(d, 10)}`
}

export function relTime(ts: number | null, now = Date.now()): string {
  if (ts === null) return 'never'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return fmtDate(ts)
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function countdownTo(target: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((target - now) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Compact basename of a full project path, with parent for context. */
export function projectLabel(p: string): string {
  const norm = p.replaceAll('\\', '/')
  const parts = norm.split('/').filter(Boolean)
  if (parts.length <= 1) return p
  const base = parts[parts.length - 1]
  const parent = parts[parts.length - 2]
  if (parts.length >= 3 && parent) return `${parent}/${base}`
  return base
}

export const PROVIDER_COLORS: Record<ProviderId, string> = {
  claude: '#e8825a',
  codex: '#2fbf95',
  gemini: '#6ea8ff',
  opencode: '#35c4d4',
  zcode: '#a78bfa',
  antigravity: '#7c9eff',
  copilot: '#9aa7c7',
  mistral: '#ff7000'
}

/** Providers that record activity (requests) instead of token counts. */
export const REQUEST_KIND_PROVIDERS: ProviderId[] = ['gemini', 'copilot', 'mistral']

export function isRequestKind(id: ProviderId): boolean {
  return REQUEST_KIND_PROVIDERS.includes(id)
}

/** Unit shown for request-kind providers. */
export const REQUEST_UNIT: Partial<Record<ProviderId, string>> = {
  gemini: 'messages',
  copilot: 'turns',
  mistral: 'messages'
}

/** Label of the per-provider "model" dimension. */
export const MODEL_DIMENSION: Partial<Record<ProviderId, string>> = {
  copilot: 'Agents'
}
