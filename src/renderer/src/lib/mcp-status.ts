import type { ManagerSnapshot, McpRecord } from '../../../shared/manager'
import { isPublicMcp } from '../../../shared/mcp-auth'

export type McpTone = 'ok' | 'idle' | 'busy' | 'warn' | 'error' | 'off'
export type McpPrimary = 'check' | 'signIn' | 'reconnect' | 'resume' | 'prepare' | 'manage' | 'help'
export interface McpStatus { tone: McpTone; label: string; detail: string; primary?: McpPrimary }

const SETUP_HELP = new Set(['aws-mcp', 'google-workspace', 'computer-use', 'blender', 'playwright-cdp'])
export const hasSetupHelp = (name: string): boolean => SETUP_HELP.has(name)

const ago = (time?: number): string => {
  if (!time) return ''
  const minutes = Math.round((Date.now() - time) / 60_000)
  return minutes < 1 ? 'checked just now' : minutes < 60 ? `checked ${minutes} min ago` : `checked ${Math.round(minutes / 60)} h ago`
}
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** One status per MCP: what state it is in, why, and the single most useful next action. */
export function mcpStatus(s: McpRecord, data: ManagerSnapshot): McpStatus {
  if (data.runtime?.paused.includes(s.name)) return { tone: 'off', label: 'Stopped', detail: 'Stopped on this device. Coding clients cannot use it until you resume it. Sign-ins are kept.', primary: 'resume' }
  return s.transport === 'http' ? remoteStatus(s, data) : localStatus(s, data)
}

function remoteStatus(s: McpRecord, data: ManagerSnapshot): McpStatus {
  const managed = !!data.config.mcpAuth?.[s.name]?.enabled, publicServer = isPublicMcp(s.url)
  if (!managed) return { tone: 'off', label: 'Direct', detail: 'Coding clients connect to this URL themselves and handle any sign-in on their own.', primary: 'manage' }
  const auth = data.auth?.[s.name] ?? '', probe = data.remoteMcp?.[s.name]
  if (auth === 'Waiting for browser sign-in') return { tone: 'busy', label: 'Waiting for browser', detail: 'Finish signing in in your browser, then return here.' }
  if (auth === 'Sign-in required') return { tone: 'warn', label: 'Sign-in needed', detail: 'Sign in once on this device. Sign-ins are not shared between devices.', primary: 'signIn' }
  if (auth.includes('Sign-in kept')) return { tone: 'warn', label: 'Provider issue', detail: auth.replace(' · Sign-in kept, retry shortly', '. The provider is having trouble; your sign-in is kept.'), primary: 'check' }
  if (/Reconnect required|^Sign-in failed|Sign-in expired|unavailable; sign in again/.test(auth)) return { tone: 'error', label: 'Reconnect needed', detail: auth.replace(' · Reconnect required', '. Reconnect to sign in again on this device.'), primary: 'reconnect' }
  if (probe?.state === 'Connection failed') return { tone: 'error', label: 'Connection failed', detail: probe.detail, primary: 'check' }
  const signIn = publicServer ? 'Public server, no sign-in needed' : 'Signed in on this device'
  if (probe?.clients) return { tone: 'ok', label: 'Connected', detail: `${plural(probe.clients, 'coding client')} connected through AI Usage · ${signIn}`, primary: 'check' }
  const verified = probe?.state === 'Connection verified' ? ` · ${plural(probe.tools ?? 0, 'tool')}, ${ago(probe.checkedAt)}` : ''
  return { tone: 'idle', label: 'Ready', detail: `${signIn}${verified}. No coding client is using it right now.`, primary: 'check' }
}

function localStatus(s: McpRecord, data: ManagerSnapshot): McpStatus {
  const state = data.deviceMcp?.[s.name]
  const workers = data.runtime?.workers.filter(w => w.name === s.name) ?? []
  const clients = state?.clients ?? data.runtime?.sessions.filter(session => session.name === s.name).length ?? 0
  const memory = workers.reduce((sum, w) => sum + w.memoryBytes, 0) / 1048576
  if (!state) return { tone: 'idle', label: 'Checking…', detail: 'Reading this device’s setup.' }
  if (state.state === 'Needs setup') return { tone: 'warn', label: 'Needs setup', detail: state.detail, primary: state.canPrepare ? 'prepare' : hasSetupHelp(s.name) ? 'help' : undefined }
  if (state.state === 'Needs sign-in') return { tone: 'warn', label: 'Sign-in needed', detail: state.detail, primary: hasSetupHelp(s.name) ? 'help' : 'check' }
  if (state.state === 'Connection failed') return { tone: 'error', label: 'Failed to start', detail: state.detail, primary: 'check' }
  // Live counts decide the rest: a process alive now, clients attached, or neither.
  if (workers.length) return { tone: 'ok', label: 'Running', detail: `Process running now · ${plural(clients, 'client')} · ${memory.toFixed(0)} MiB`, primary: 'check' }
  if (clients) return { tone: 'ok', label: 'Connected', detail: s.name === 'google-workspace' ? `${plural(clients, 'client')} connected · each Google request runs a short command, so no process stays open` : `${plural(clients, 'client')} connected · no process right now, it starts on the next tool call`, primary: 'check' }
  const verified = state.state === 'Connection verified' ? `${plural(state.tools ?? 0, 'tool')}, ${ago(state.checkedAt)} · ` : ''
  return { tone: 'idle', label: 'Ready', detail: `Installed · ${verified}no coding client is using it right now. It starts when one does.`, primary: 'check' }
}
