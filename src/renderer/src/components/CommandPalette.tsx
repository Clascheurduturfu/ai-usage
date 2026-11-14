import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, FileText, History, Minimize2, Power, Search, Server, type LucideIcon } from 'lucide-react'
import type { ManagerSnapshot } from '../../../shared/manager'
import { api } from '../lib/ipc'
import { fmtTokens, mcpEagerTokens, relayable } from '../lib/budget'

export interface Command {
  id: string
  group: string
  label: string
  hint?: string
  /** Extra words that should find this command. */
  keywords?: string
  icon?: LucideIcon
  run: () => void
}

/** Library switches straight from the palette: enable, disable or compact any MCP or skill. */
function libraryCommands(data: ManagerSnapshot, act: (label: string, work: () => Promise<unknown>, done: string) => void): Command[] {
  const off = new Set(data.config.disabledMcp ?? []), compact = new Set(data.config.compactMcp ?? []), skillsOff = new Set(data.config.disabledSkills ?? [])
  const commands: Command[] = []
  for (const server of data.mcp) {
    const enabled = !off.has(server.name), tokens = mcpEagerTokens(server.name, data)
    const cost = tokens === undefined ? 'not measured yet' : `~${fmtTokens(tokens)} tokens in eager agents`
    commands.push({ id: `mcp-enable:${server.name}`, group: 'MCP servers', icon: Power, label: `${enabled ? 'Disable' : 'Enable'} ${server.name}`, hint: enabled ? `Remove from every agent · ${cost}` : 'Add back to every agent',
      keywords: `mcp server ${enabled ? 'turn off remove' : 'turn on'}`, run: () => act(server.name, () => api().setMcpEnabled(server.name, !enabled), `${server.name} ${enabled ? 'disabled' : 'enabled'} for every agent. Restart open clients to apply.`) })
    if (enabled && relayable(server, data)) {
      const on = compact.has(server.name)
      commands.push({ id: `mcp-compact:${server.name}`, group: 'MCP servers', icon: Minimize2, label: `${on ? 'Show full tool list for' : 'Compact'} ${server.name}`, hint: on ? 'Eager agents load every schema again' : 'Eager agents get a search tool instead of every schema',
        keywords: 'mcp compact tokens context', run: () => act(server.name, () => api().setMcpCompact(server.name, !on), `${server.name} ${on ? 'now shows every tool' : 'compacted'}. Restart eager clients to apply.`) })
    }
  }
  for (const skill of data.skills) {
    const enabled = !skillsOff.has(skill.name)
    commands.push({ id: `skill:${skill.name}`, group: 'Skills', icon: FileText, label: `${enabled ? 'Disable' : 'Enable'} skill ${skill.name}`, hint: skill.description.slice(0, 90),
      keywords: 'skill', run: () => act(skill.name, () => api().setSkillEnabled(skill.name, !enabled), `Skill ${skill.name} ${enabled ? 'disabled' : 'enabled'}.`) })
  }
  return commands
}

function matches(command: Command, words: string[]): number {
  if (!words.length) return 1
  const label = command.label.toLowerCase(), haystack = `${label} ${command.group} ${command.keywords ?? ''}`.toLowerCase()
  if (!words.every(w => haystack.includes(w))) return 0
  // Prefer label hits, and labels whose words start with the query.
  return words.reduce((n, w) => n + (label.includes(w) ? 2 : 0) + (label.split(/\s+/).some(part => part.startsWith(w)) ? 1 : 0), 1)
}

export function CommandPalette({ commands, close, runAction, searchHistory }: {
  commands: Command[]
  close: () => void
  runAction: (name: string, fn: () => Promise<unknown>, message?: string) => Promise<void>
  searchHistory: (query: string) => void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [library, setLibrary] = useState<ManagerSnapshot | null>(null)
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus(); api().getManager().then(setLibrary, () => setLibrary(null)) }, [])
  const all = useMemo(() => [...commands, ...(library ? libraryCommands(library, (label, work, done) => void runAction(`palette:${label}`, work, done)) : [])], [commands, library, runAction])
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = useMemo(() => {
    const ranked = all.map(c => [c, matches(c, words)] as const).filter(([, score]) => score > 0)
    if (words.length) ranked.sort((a, b) => b[1] - a[1])
    const result = ranked.map(([c]) => c).slice(0, 40)
    if (query.trim()) result.push({ id: 'history-search', group: 'Usage history', icon: History, label: `Search usage history for “${query.trim()}”`, run: () => searchHistory(query.trim()) })
    return result
  }, [all, words.join(' '), query, searchHistory])
  useEffect(() => setIndex(0), [query])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index])
  const run = (command: Command | undefined): void => { if (!command) return; close(); command.run() }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(shown.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[index]) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }
  let lastGroup = ''
  return <div className="palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
      <label className="palette-input"><Search size={16} aria-hidden="true" />
        <input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="Go to a page, toggle an MCP or skill, search usage…" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={shown[index] ? `palette-${index}` : undefined} aria-label="Command" />
        <kbd>Esc</kbd>
      </label>
      <div className="palette-list" id="palette-list" role="listbox" ref={list}>
        {shown.map((command, i) => {
          const Icon = command.icon ?? Server, header = command.group !== lastGroup ? command.group : null
          lastGroup = command.group
          return <div key={command.id} role="presentation">
            {header && <div className="palette-group" role="presentation">{header}</div>}
            <div id={`palette-${i}`} role="option" aria-selected={i === index} className={`palette-item ${i === index ? 'active' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => run(command)}>
              <Icon size={15} aria-hidden="true" /><span className="palette-label">{command.label}</span>{command.hint && <small>{command.hint}</small>}{i === index && <CornerDownLeft size={13} className="palette-enter" aria-hidden="true" />}
            </div>
          </div>
        })}
        {!shown.length && <p className="palette-empty">Nothing matches. Try a page, tool, MCP or skill name.</p>}
      </div>
    </div>
  </div>
}
