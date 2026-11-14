import { useEffect, useState } from 'react'
import { Gauge, Minimize2, MoonStar, Power, Ruler } from 'lucide-react'
import type { ManagerSnapshot } from '../../../shared/manager'
import { api } from '../lib/ipc'
import { DEFAULT_BUDGET, IDLE_DAYS, fmtTokens, idleServers, libraryBudgets, mcpEagerTokens, relayable, type AgentBudget } from '../lib/budget'
import { Btn, Panel } from './ui'

type Action = (work: () => Promise<unknown>, success?: string) => Promise<void>

// "Keep" on an idle suggestion is a per-device preference: hide it until the next window.
const KEEP_KEY = 'aiu.idleKeep'
const readKept = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(KEEP_KEY) ?? '{}') } catch { return {} } }
const ago = (ts?: number): string => ts ? `last called ${Math.round((Date.now() - ts) / 86_400_000)} days ago` : `no calls since tracking started`

function BudgetBar({ budget, scale, limit }: { budget: AgentBudget; scale: number; limit: number }): React.ReactElement {
  const pct = (n: number): string => `${Math.max(0, (n / scale) * 100)}%`
  return <div className="budget-bar" role="img" aria-label={`${budget.agent.name}: about ${fmtTokens(budget.total)} tokens; MCP ${fmtTokens(budget.mcp)}, skills ${fmtTokens(budget.skills)}, instructions ${fmtTokens(budget.instructions)}`}>
    <span className="seg-mcp" style={{ width: pct(budget.mcp) }} /><span className="seg-skills" style={{ width: pct(budget.skills) }} /><span className="seg-rules" style={{ width: pct(budget.instructions) }} />
    <i className="budget-limit-mark" style={{ left: pct(limit) }} aria-hidden="true" />
  </div>
}

/** Always-loaded customization context per agent, with the biggest contributors one click away. */
export function ContextBudget({ data, act, busy }: { data: ManagerSnapshot; act: Action; busy: boolean }): React.ReactElement {
  const limit = data.config.contextBudget ?? DEFAULT_BUDGET
  const [draft, setDraft] = useState(String(limit))
  useEffect(() => setDraft(String(limit)), [limit])
  const budgets = libraryBudgets(data), scale = Math.max(limit * 1.25, ...budgets.map(b => b.total))
  const worst = budgets.find(b => !b.lazy) ?? budgets[0]
  const unmeasured = data.mcp.filter(s => !data.config.disabledMcp?.includes(s.name) && data.mcpMetrics?.[s.name]?.tools === undefined)
  const [kept, setKept] = useState(readKept)
  const idle = idleServers(data).filter(s => (kept[s.name] ?? 0) < Date.now() - IDLE_DAYS * 86_400_000)
  const keep = (name: string): void => { const next = { ...kept, [name]: Date.now() }; setKept(next); try { localStorage.setItem(KEEP_KEY, JSON.stringify(next)) } catch { /* preference only */ } }
  const heavy = data.mcp.filter(s => !data.config.disabledMcp?.includes(s.name) && !data.config.compactMcp?.includes(s.name) && !idle.some(i => i.name === s.name)).map(s => ({ s, tokens: mcpEagerTokens(s.name, data) ?? 0 })).filter(h => h.tokens >= 3000).sort((a, b) => b.tokens - a.tokens).slice(0, 3)
  const measure = (): Promise<void> => act(async () => {
    const failed: string[] = []
    for (const s of unmeasured) { try { const r = await api().checkMcp(s.name); if (r.state !== 'Connection verified') failed.push(s.name) } catch { failed.push(s.name) } }
    return failed.length ? `Measured ${unmeasured.length - failed.length} of ${unmeasured.length}. Not reachable now: ${failed.join(', ')}.` : `Measured ${unmeasured.length} servers.`
  })
  const syncNote = (r: { conflicts: string[] }): void => { if (r.conflicts.length) throw new Error('Saved, but some client files have local edits. Review Shared library → Agent sync.') }
  return <Panel className="budget-panel">
    <div className="budget-head">
      <div className="budget-hero"><span className={`budget-icon ${worst?.over ? 'over' : ''}`}><Gauge size={18} /></span><div>
        <div className="eyebrow">CONTEXT BUDGET</div>
        <h2>{worst ? <>~{fmtTokens(worst.total)} tokens before the first message <small>in {worst.agent.name}</small></> : 'No coding agents detected yet'}</h2>
        <p>Estimated always-loaded context from MCP tool schemas, the skill index and shared rules. Claude Code and Antigravity defer tool schemas; eager clients load all of them on every turn.</p>
      </div></div>
      <label className="budget-limit"><span>Warn above</span><input type="number" min={1000} step={5000} value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => { if (Number(draft) !== limit) void act(() => api().setContextBudget(Number(draft)), 'Context budget saved') }} aria-label="Context budget in tokens" /><span>tokens</span></label>
    </div>
    {budgets.length > 0 && <div className="budget-rows">{budgets.map(b => <div className={`budget-row ${b.over ? 'over' : ''}`} key={b.agent.id}>
      <div className="budget-agent"><strong>{b.agent.name}</strong><small>{b.lazy ? 'tools on demand' : 'loads every schema'}</small></div>
      <BudgetBar budget={b} scale={scale} limit={limit} />
      <div className="budget-total"><strong className="tnum">~{fmtTokens(b.total)}</strong>{b.over && <span className="tone-error">over budget</span>}</div>
    </div>)}</div>}
    <div className="budget-foot">
      <div className="budget-legend"><span><i className="seg-mcp" />MCP tools</span><span><i className="seg-skills" />Skill index</span><span><i className="seg-rules" />Instructions</span><span><i className="budget-limit-swatch" />Your limit</span></div>
      {unmeasured.length > 0 && <Btn disabled={busy} onClick={() => void measure()} title={unmeasured.map(s => s.name).join(', ')}><Ruler size={13} />Measure {unmeasured.length} unmeasured</Btn>}
    </div>
    {idle.length > 0 && <div className="budget-heavy budget-idle">{idle.map(s => <div key={s.name}>
      <MoonStar size={15} aria-hidden="true" /><span><strong>{s.name}</strong> costs ~{fmtTokens(s.tokens)} tokens per turn in eager agents, {ago(s.lastCall)}. Turn it off until you need it?</span>
      <Btn disabled={busy} onClick={() => void act(async () => syncNote(await api().setMcpEnabled(s.name, false)), `${s.name} disabled for every agent. Its setup is kept.`)}><Power size={13} />Disable</Btn>
      <Btn disabled={busy} onClick={() => keep(s.name)}>Keep</Btn>
    </div>)}</div>}
    {heavy.length > 0 && <div className="budget-heavy">{heavy.map(({ s, tokens }) => <div key={s.name}>
      <span><strong>{s.name}</strong> costs ~{fmtTokens(tokens)} tokens in every eager agent ({data.mcpMetrics?.[s.name]?.tools} tools).</span>
      {relayable(s, data) && <Btn disabled={busy} onClick={() => void act(async () => syncNote(await api().setMcpCompact(s.name, true)), `${s.name} compacted. Restart eager clients to apply.`)}><Minimize2 size={13} />Compact</Btn>}
      <Btn disabled={busy} onClick={() => void act(async () => syncNote(await api().setMcpEnabled(s.name, false)), `${s.name} disabled for every agent.`)}><Power size={13} />Disable</Btn>
    </div>)}</div>}
  </Panel>
}
