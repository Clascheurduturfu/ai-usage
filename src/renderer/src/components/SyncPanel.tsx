import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, FileText, FolderOpen, History, Info, Settings2 } from 'lucide-react'
import type { ManagerSnapshot, SyncChange, SyncPreview, SyncResult } from '../../../shared/manager'
import { api } from '../lib/ipc'
import { Btn, Panel } from './ui'

type Action = (work: () => Promise<unknown>, success?: string) => Promise<void>
type Decision = 'overwrite' | 'skip'
type Kind = NonNullable<SyncChange['kind']>
/** One reviewable line: a settings or instructions file, or every file of one skill across clients. */
interface Item { key: string; kind: Kind; title: string; clients: string[]; paths: string[]; counts: Record<'add' | 'update' | 'remove', number>; planned?: string[]; details?: string[]; conflict: boolean; waitFor?: string }

const fileName = (file: string): string => file.split(/[\\/]/).pop() || file
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
const kindOf = (c: SyncChange): Kind => c.kind ?? (c.target.endsWith(' skills') ? 'skill' : c.target.endsWith(' instructions') ? 'instructions' : 'settings')
const clientOf = (target: string): string => target.replace(/ (skills|instructions)$/, '')

function group(changes: SyncChange[]): Item[] {
  const items = new Map<string, Item>()
  for (const c of changes) {
    const kind = kindOf(c), skill = kind === 'skill' ? c.skill ?? fileName(c.path) : undefined
    const key = skill ? `skill:${skill}:${c.conflict}` : `file:${c.path}`
    const item = items.get(key) ?? { key, kind, title: skill ?? c.target, clients: [], paths: [], counts: { add: 0, update: 0, remove: 0 }, planned: c.planned, details: c.details, conflict: c.conflict, waitFor: c.waitFor }
    const client = clientOf(c.target)
    if (!item.clients.includes(client)) item.clients.push(client)
    item.paths.push(c.path); item.counts[c.action ?? 'update']++
    items.set(key, item)
  }
  const order: Record<Kind, number> = { settings: 0, instructions: 1, skill: 2 }
  return [...items.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title))
}

/** "Removed" / "Added" / "12 added · 3 updated" for a group of files. */
function verb(item: Item): { label: string; tone: 'add' | 'update' | 'remove' } {
  const parts = (['add', 'update', 'remove'] as const).filter(k => item.counts[k])
  const words = { add: 'added', update: 'updated', remove: 'removed' } as const
  if (parts.length === 1) {
    const only = parts[0], n = item.counts[only]
    return { tone: only, label: item.kind === 'skill' ? `${plural(n, 'file')} ${words[only]}` : only === 'add' ? 'New file' : only === 'remove' ? 'Deleted' : 'Updated' }
  }
  return { tone: 'update', label: parts.map(k => `${item.counts[k].toLocaleString()} ${words[k]}`).join(' · ') }
}

function Badge({ item }: { item: Item }) {
  const { label, tone } = verb(item)
  return <span className={`sync-badge sync-badge-${tone}`}>{label}</span>
}

function Bullets({ title, lines, tone }: { title: string; lines: string[]; tone?: 'warn' }) {
  return <div className={`sync-details ${tone === 'warn' ? 'sync-details-warn' : ''}`}><span>{title}</span><ul>{lines.map(line => <li key={line}>{line}</li>)}</ul></div>
}

function ItemRow({ item, act, decision, decide }: { item: Item; act: Action; decision?: Decision; decide?: (d: Decision) => void }) {
  const Icon = item.kind === 'skill' ? FolderOpen : item.kind === 'instructions' ? FileText : Settings2
  const skill = item.kind === 'skill'
  return <div className={`sync-row ${item.conflict ? 'sync-row-attention' : ''} ${decision === 'skip' ? 'sync-row-skipped' : ''}`}>
    <Icon size={16} aria-hidden />
    <div className="sync-row-text">
      <div className="sync-row-title"><strong>{item.title}</strong><Badge item={item} /></div>
      {skill
        ? <p>Skill folder in {item.clients.join(' and ')}{item.counts.remove && !item.counts.add && !item.counts.update ? ' — this skill is no longer in your shared library' : ''}</p>
        : <code title={item.paths[0]}>{item.paths[0]}</code>}
      {item.waitFor && <p className="sync-wait">Written as soon as you quit {item.waitFor}. While it is open it saves this file from memory and would undo the change.</p>}
      {item.conflict && !!item.details?.length && <Bullets tone="warn" title="Changed outside AI Usage since the last sync" lines={item.details} />}
      {!skill && !!item.planned?.length && <Bullets title={item.conflict ? 'AI Usage would write' : 'This sync will'} lines={item.planned} />}
      {skill && <details className="sync-files"><summary>Show {plural(item.paths.length, 'file')}</summary><ul>{item.paths.slice(0, 200).map(p => <li key={p}><code>{p}</code></li>)}{item.paths.length > 200 && <li>…and {(item.paths.length - 200).toLocaleString()} more</li>}</ul></details>}
      {item.conflict && decide && <div className="sync-choice" role="radiogroup" aria-label={`What to do with ${item.title}`}>
        <button type="button" role="radio" aria-checked={decision === 'overwrite'} className={decision === 'overwrite' ? 'on' : ''} onClick={() => decide('overwrite')}>
          <strong>Use AI Usage’s version</strong>
          <small>{skill ? 'Puts the shared copy back.' : item.kind === 'instructions' ? 'Writes the shared instructions over the edit.' : 'Writes the lines above. Only AI Usage’s entries change; the rest of the file stays.'}</small>
        </button>
        <button type="button" role="radio" aria-checked={decision === 'skip'} className={decision === 'skip' ? 'on' : ''} onClick={() => decide('skip')}>
          <strong>Leave it as it is</strong>
          <small>Nothing is written to {item.paths.length === 1 ? 'this file' : 'these files'}. Sync stays paused for {item.paths.length === 1 ? 'it' : 'them'} until you choose again.</small>
        </button>
      </div>}
    </div>
    {item.conflict && !skill && <Btn onClick={() => void act(() => api().openPath(item.paths[0]))}><ExternalLink size={13} />Open</Btn>}
  </div>
}

/** Shared library → Sync: what state the agent files are in, what a sync will write, and a clear choice for each edited file. */
export function SyncPanel({ data, act, busy }: { data: ManagerSnapshot; act: Action; busy: boolean }) {
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const last = data.lastSync, paused = last?.conflicts ?? []
  const items = useMemo(() => group(preview?.changes ?? []), [preview])
  const attention = items.filter(i => i.conflict), ready = items.filter(i => !i.conflict)
  const undecided = attention.filter(i => !decisions[i.key]).length
  const skipped = attention.filter(i => decisions[i.key] === 'skip').flatMap(i => i.paths)
  const overwrite = attention.filter(i => decisions[i.key] === 'overwrite').flatMap(i => i.paths)
  const writes = (preview?.changes.length ?? 0) - skipped.length
  const review = (): Promise<void> => act(async () => { setDecisions({}); setPreview(await api().previewSync()) })
  const close = (): void => { setPreview(null); setDecisions({}) }
  const counts = (kind: Kind): number => preview?.changes.filter(c => kindOf(c) === kind).length ?? 0
  const skillCount = new Set(items.filter(i => i.kind === 'skill').map(i => i.title)).size
  const scope = [
    counts('settings') && plural(counts('settings'), 'settings file'),
    counts('instructions') && plural(counts('instructions'), 'instructions file'),
    counts('skill') && `${plural(counts('skill'), 'skill file')} in ${plural(skillCount, 'skill')}`
  ].filter(Boolean).join(', ')
  const apply = (): Promise<void> => act(async () => {
    const r: SyncResult = await api().applySync(preview!.id, { overwrite, skip: skipped })
    const unexpected = r.conflicts.filter(p => !skipped.includes(p))
    if (unexpected.length) throw new Error(r.warnings.join('; ') || 'Some files changed again. Review them once more.')
    close()
  }, skipped.length ? `Synced; ${plural(skipped.length, 'file')} left as ${skipped.length === 1 ? 'it was' : 'they were'}` : 'Agents synced')

  return <div className="sync-panel">
    {paused.length
      ? <Panel className="sync-status sync-status-attention">
          <AlertTriangle size={20} aria-hidden />
          <div role="alert">
            <h2>Sync is paused: {plural(paused.length, 'file')} changed outside AI Usage</h2>
            <p>Something else edited {paused.length === 1 ? 'this file' : 'these files'} after the last sync, usually the client itself saving its settings. AI Usage stopped so it would not overwrite those edits without asking. Your MCP sign-ins are not affected.</p>
            <ul>{paused.map(file => <li key={file}><strong>{fileName(file)}</strong><code title={file}>{file}</code></li>)}</ul>
            {!preview && <Btn variant="primary" disabled={busy} onClick={() => void review()}>Review and decide<ArrowRight size={14} /></Btn>}
          </div>
        </Panel>
      : <Panel className="sync-status">
          <CheckCircle2 size={20} aria-hidden />
          <div role="status">
            <h2>{last?.waiting?.length ? 'Claude Desktop updates when you quit it' : last ? 'Agents are in sync' : 'Nothing synced yet in this session'}</h2>
            <p>{last?.waiting?.length ? `Claude Desktop is open, and it saves its settings file from memory, so a change written now would be undone. AI Usage writes it as soon as you fully quit Claude Desktop (${navigator.platform.startsWith('Mac') ? 'Claude → Quit' : 'tray icon → Quit'}); the new MCP list loads the next time you start it.` : last ? (last.changed ? `The last sync updated ${plural(last.changed, 'file')}.` : 'The last sync found nothing to change.') : 'Check what a sync would write to each agent before applying it.'}</p>
            {!preview && <Btn disabled={busy} onClick={() => void review()}>Check for changes</Btn>}
          </div>
        </Panel>}

    {/* While paused, the banner already says why; the last result's own message would repeat it. */}
    {!!last?.warnings.length && !paused.length && <Panel className="sync-notes"><Info size={15} aria-hidden /><ul>{last.warnings.map(w => <li key={w}>{w}</li>)}</ul></Panel>}

    {preview && <Panel className="manager-block sync-review">
      <div className="sync-review-head">
        <h2>{preview.changes.length ? 'What this sync will do' : 'Everything is up to date'}</h2>
        <p className="muted">{preview.changes.length ? `${scope}.` : 'No agent file needs to change.'}</p>
      </div>
      {!!attention.length && <section aria-label="Needs your decision">
        <h3 className="sync-group sync-group-attention">Edited outside AI Usage — choose for each ({attention.length})</h3>
        <p className="sync-hint">To keep a change to a shared MCP server or skill for good, make it in Shared library instead: an edit made directly in one agent’s file is replaced the next time that file syncs.</p>
        <div className="sync-list">{attention.map(i => <ItemRow key={i.key} item={i} act={act} decision={decisions[i.key]} decide={d => setDecisions(prev => ({ ...prev, [i.key]: d }))} />)}</div>
      </section>}
      {!!ready.length && <section aria-label="Ready to update">
        <h3 className="sync-group">Ready to write ({ready.length})</h3>
        <div className="sync-list">{ready.map(i => <ItemRow key={i.key} item={i} act={act} />)}</div>
      </section>}
      {!!preview.warnings.length && <ul className="sync-warnings">{preview.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
      <div className="manager-actions sync-apply">
        {!!preview.changes.length && <Btn variant="primary" disabled={busy || !!undecided || writes <= 0 && !skipped.length} onClick={() => void apply()}>
          {writes > 0 ? `Write ${plural(writes, 'file')}` : 'Leave everything as it is'}
        </Btn>}
        <Btn variant="ghost" disabled={busy} onClick={close}>{preview.changes.length ? 'Cancel' : 'Close'}</Btn>
        {!!undecided && <span className="muted">Choose what to do with {undecided === 1 ? 'the edited file' : `the ${undecided} edited items`} above first.</span>}
      </div>
    </Panel>}

    {last?.backupId && <Panel className="sync-undo">
      <History size={16} aria-hidden />
      <div><strong>Undo the last sync</strong><p>Puts the {plural(last.changed, 'file')} it changed back to how {last.changed === 1 ? 'it was' : 'they were'} before. Refused if a file was edited since.</p></div>
      <Btn disabled={busy} onClick={() => void act(async () => { const r = await api().restoreSync(last.backupId!); if (r.conflicts.length) throw new Error(r.warnings.join('; ') || 'Some files changed again.') }, 'Previous sync restored')}>Undo last sync</Btn>
    </Panel>}

    <Panel className="manager-block sync-settings">
      <h2>Automatic sync</h2>
      <label className="manager-check"><input type="checkbox" checked={data.config.autoSync} onChange={e => void act(() => api().setAutoSync(e.target.checked))} />Sync automatically when the shared library changes</label>
      <label className="manager-check"><input type="checkbox" checked={data.config.syncNotifications !== false} onChange={e => void act(() => api().setSyncNotifications(e.target.checked))} />System notification after a successful sync</label>
      <p className="muted">Changes are grouped for 1.5 seconds before syncing. A file edited outside AI Usage pauses sync and notifies you once.</p>
    </Panel>
  </div>
}
