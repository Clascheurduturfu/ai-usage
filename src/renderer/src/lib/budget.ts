import { LAZY_TOOL_AGENTS, type AgentInfo, type ManagerSnapshot, type McpRecord } from '../../../shared/manager'

/** Rough model-agnostic estimate: ~4 bytes of JSON or English per token. */
export const toTokens = (bytes: number): number => Math.round(bytes / 4)
export const DEFAULT_BUDGET = 30_000
// Kimi Code and DeepSeek Harness read the shared ~/.agents/AGENTS.md themselves.
const INSTRUCTION_AGENTS = new Set(['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'zcode', 'mistral', 'pi', 'kimi', 'deepseek'])
/** Lazy clients still list tool names; budget ~15 tokens per deferred tool. */
const DEFERRED_PER_TOOL = 15

export type McpCost = { tokens: number; mode: 'eager' | 'compact' | 'deferred' | 'unmeasured' }
export interface BudgetLine { kind: 'mcp' | 'skills' | 'instructions'; name: string; tokens: number; note?: string }
export interface AgentBudget { agent: AgentInfo; total: number; mcp: number; skills: number; instructions: number; lines: BudgetLine[]; lazy: boolean; unmeasured: string[]; over: boolean }

/** True when AI Usage relays this MCP, which compact mode requires. */
export function relayable(server: McpRecord, data: ManagerSnapshot): boolean { return server.transport === 'stdio' || !!data.config.mcpAuth?.[server.name]?.enabled }
export function mcpEagerTokens(name: string, data: ManagerSnapshot): number | undefined { const bytes = data.mcpMetrics?.[name]?.schemaBytes; return bytes === undefined ? undefined : toTokens(bytes) }
/** Compact mode exposes two tools whose description lists every tool name. */
export function compactTokens(name: string, data: ManagerSnapshot): number { const tools = data.mcpMetrics?.[name]?.tools ?? 0; return toTokens(900 + Math.min(6000, tools * 18)) }

export function mcpCost(server: McpRecord, agent: AgentInfo, data: ManagerSnapshot): McpCost {
  const eager = mcpEagerTokens(server.name, data), tools = data.mcpMetrics?.[server.name]?.tools
  if (LAZY_TOOL_AGENTS.includes(agent.id)) return tools === undefined ? { tokens: 0, mode: 'unmeasured' } : { tokens: tools * DEFERRED_PER_TOOL, mode: 'deferred' }
  if (data.config.compactMcp?.includes(server.name) && relayable(server, data)) return { tokens: compactTokens(server.name, data), mode: 'compact' }
  return eager === undefined ? { tokens: 0, mode: 'unmeasured' } : { tokens: eager, mode: 'eager' }
}

export const skillTokens = (skill: { name: string; description: string }): number => toTokens(skill.name.length + skill.description.length + 40)

/** Estimated always-loaded customization context (tool schemas, skill index, rules) for one agent. */
export function agentBudget(agent: AgentInfo, data: ManagerSnapshot): AgentBudget {
  const profile = data.config.profiles.find(p => p.id === data.config.activeProfiles[agent.id])
  const offMcp = new Set(data.config.disabledMcp ?? []), offSkills = new Set([...(data.config.disabledSkills ?? []), ...(profile?.disabledSkills ?? [])])
  const lines: BudgetLine[] = [], unmeasured: string[] = []
  for (const server of data.mcp) {
    if (offMcp.has(server.name) || (profile && !profile.mcpNames.includes(server.name))) continue
    if (agent.id === 'claude-desktop' && server.transport === 'http') continue
    const cost = mcpCost(server, agent, data)
    if (cost.mode === 'unmeasured') unmeasured.push(server.name)
    else lines.push({ kind: 'mcp', name: server.name, tokens: cost.tokens, note: cost.mode })
  }
  // Global disables leave the shared folder for everyone; profile exclusions need native per-skill control.
  const globalOff = new Set(data.config.disabledSkills ?? [])
  if (agent.skillControl !== 'none') for (const skill of data.skills) {
    if (globalOff.has(skill.name) || (agent.skillControl === 'native' && offSkills.has(skill.name))) continue
    lines.push({ kind: 'skills', name: skill.name, tokens: skillTokens(skill) })
  }
  if (INSTRUCTION_AGENTS.has(agent.id) && (!profile || profile.instructions) && data.instructions) lines.push({ kind: 'instructions', name: 'Shared instructions', tokens: toTokens(data.instructions.length) })
  const sum = (kind: BudgetLine['kind']): number => lines.filter(l => l.kind === kind).reduce((n, l) => n + l.tokens, 0)
  const mcp = sum('mcp'), skills = sum('skills'), instructions = sum('instructions'), total = mcp + skills + instructions
  return { agent, total, mcp, skills, instructions, lines: lines.sort((a, b) => b.tokens - a.tokens), lazy: LAZY_TOOL_AGENTS.includes(agent.id), unmeasured, over: total > (data.config.contextBudget ?? DEFAULT_BUDGET) }
}

export const IDLE_DAYS = 30, IDLE_MIN_TOKENS = 5000
export interface IdleServer { name: string; tokens: number; lastCall?: number; tools?: number }
/**
 * Enabled servers that cost at least IDLE_MIN_TOKENS in eager clients and had no
 * relayed call for IDLE_DAYS. Only relayed servers are counted, and only once a
 * full window has been observed, so a new install never flags everything.
 */
export function idleServers(data: ManagerSnapshot, now = Date.now()): IdleServer[] {
  const cutoff = now - IDLE_DAYS * 86_400_000
  return data.mcp.filter(s => !data.config.disabledMcp?.includes(s.name) && relayable(s, data)).flatMap(s => {
    const m = data.mcpMetrics?.[s.name], eager = mcpEagerTokens(s.name, data)
    if (!m || eager === undefined || (m.trackedSince ?? now) > cutoff || (m.lastCall ?? 0) > cutoff) return []
    const tokens = data.config.compactMcp?.includes(s.name) ? compactTokens(s.name, data) : eager
    return tokens >= IDLE_MIN_TOKENS ? [{ name: s.name, tokens, lastCall: m.lastCall, tools: m.tools }] : []
  }).sort((a, b) => b.tokens - a.tokens)
}

export function libraryBudgets(data: ManagerSnapshot): AgentBudget[] { return data.agents.filter(a => a.installed).map(a => agentBudget(a, data)).sort((a, b) => b.total - a.total) }

export function fmtTokens(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n) }
