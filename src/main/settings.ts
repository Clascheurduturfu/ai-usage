import type { Settings } from '../shared/types'
import type { DB } from './db'
import { kvGet, kvSet } from './db'

export const CLAUDE_PLAN_PRESETS: Record<Settings['claudePlan'], number> = {
  pro: 45_000,
  max5: 160_000,
  max20: 400_000,
  custom: 160_000
}

export const DEFAULT_SETTINGS: Settings = {
  pinnedQuotas: ['codex', 'antigravity', 'openrouter'],
  theme: 'dark',
  launchAtLogin: false,
  startMinimized: false,
  claudePlan: 'max5',
  claude5hLimit: CLAUDE_PLAN_PRESETS.max5,
  claudeWeeklyLimit: null,
  openrouterByokMonthlyAllowance: 300,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  ntfyToken: '',
  pricingOverrides: {},
  paths: {}
}

export function getSettings(db: DB): Settings {
  const stored = kvGet<Partial<Settings>>(db, 'settings') ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    pricingOverrides: { ...(stored.pricingOverrides ?? {}) },
    paths: { ...(stored.paths ?? {}) }
  }
}

export function saveSettings(db: DB, patch: Partial<Settings>): Settings {
  const current = getSettings(db)
  const next: Settings = { ...current, ...patch }
  if (patch.claudePlan && patch.claudePlan !== current.claudePlan && patch.claude5hLimit === undefined) {
    next.claude5hLimit = CLAUDE_PLAN_PRESETS[patch.claudePlan]
  }
  for (const key of ['claude5hLimit', 'openrouterByokMonthlyAllowance'] as const) {
    if (!Number.isFinite(next[key]) || next[key] < 0) throw new Error('Limits must be positive numbers or zero.')
  }
  if (next.claudeWeeklyLimit !== null && (!Number.isFinite(next.claudeWeeklyLimit) || next.claudeWeeklyLimit < 0)) {
    throw new Error('Weekly limit must be a positive number or empty.')
  }
  if (!['dark', 'light', 'system'].includes(next.theme)) throw new Error('Choose a valid theme.')
  if (!Array.isArray(next.pinnedQuotas) || next.pinnedQuotas.some((id) => !['codex', 'antigravity', 'openrouter', 'claude'].includes(id))) {
    throw new Error('Unknown subscription card.')
  }
  next.pinnedQuotas = [...new Set(next.pinnedQuotas)]
  next.paths = Object.fromEntries(Object.entries(next.paths).filter(([, p]) => p?.trim()).map(([id, p]) => [id, p!.trim()]))
  for (const price of Object.values(next.pricingOverrides)) {
    for (const value of Object.values(price)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Prices must be positive numbers or zero.')
    }
  }
  if (next.ntfyTopic && (!/^[\w-]+$/.test(next.ntfyTopic) || !/^https?:\/\//.test(next.ntfyServer))) {
    throw new Error('Enter an HTTP(S) sync server and a topic containing only letters, numbers, underscores or hyphens.')
  }
  kvSet(db, 'settings', next)
  return next
}
