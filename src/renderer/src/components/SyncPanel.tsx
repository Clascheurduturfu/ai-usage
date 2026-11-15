import { useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, FileWarning, History, Info } from 'lucide-react'
import type { ManagerSnapshot, SyncChange, SyncPreview, SyncResult } from '../../../shared/manager'
import { api } from '../lib/ipc'
import { Btn, Panel } from './ui'

type Action = (work: () => Promise<unknown>, success?: string) => Promise<void>
const ensureSync = (r: SyncResult): void => { if (r.conflicts.length) throw new Error(r.warnings.join('; ') || 'Some files changed again. Review them once more.') }
const fileName = (file: string): string => file.split(/[\\/]/).pop() || file
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function ChangeRow({ change, act }: { change: SyncChange; act: Action }) {
  return <div className={`sync-row ${change.conflict ? 'sync-row-attention' : ''}`}>
    {change.conflict ? <FileWarning size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
    <div className="sync-row-text">
      <strong>{change.target}</strong>
      <code title={change.path}>{change.path}</code>
      <p>{change.conflict ? 'Edited outside AI Usage since the last sync. Nothing is written to it until you decide.' : change.summary}</p>
      {change.conflict && !!change.details?.length && <div className="sync-details">
        <span>What changed in the file</span>
        <ul>{change.details.map(line => <li key={line}>{line}</li>)}</ul>
      </div>}
    </div>
    {change.conflict
      ? <Btn onClick={() => void act(() => api().openPath(change.path))}><ExternalLink size={13} />Open file</Btn>
      : <span className="sync-pill">Ready</span>}
  </div>
}

/** Shared library → Sync: what state the agent files are in, what needs a decision and what each action does. */
export function SyncPanel({ data, act, busy }: { data: ManagerSnapshot; act: Action; busy: boolean }) {
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const last = data.lastSync, paused = last?.conflicts ?? []
  const attention = preview?.changes.filter(c => c.conflict) ?? [], ready = preview?.changes.filter(c => !c.conflict) ?? []
  const review = (): Promise<void> => act(async () => setPreview(await api().previewSync()))

  return <div className="sync-panel">
    {paused.length
      ? <Panel className="sync-status sync-status-attention">
          <AlertTriangle size={20} aria-hidden />
          <div role="alert">
            <h2>Sync is paused: {plural(paused.length, 'file')} changed outside AI Usage</h2>
            <p>Something else edited {paused.length === 1 ? 'this file' : 'these files'} after the last sync, usually the client itself saving its settings. AI Usage stopped so it would not overwrite those edits. Your MCP sign-ins are not affected.</p>
            <ul>{paused.map(file => <li key={file}><strong>{fileName(file)}</strong><code title={file}>{file}</code></li>)}</ul>
            {!preview && <Btn variant="primary" disabled={busy} onClick={() => void review()}>Review and resolve<ArrowRight size={14} /></Btn>}
          </div>
        </Panel>
      : <Panel className="sync-status">
          <CheckCircle2 size={20} aria-hidden />
          <div role="status">
            <h2>{last ? 'Agents are in sync' : 'Nothing synced yet in this session'}</h2>
            <p>{last ? (last.changed ? `The last sync updated ${plural(last.changed, 'file')}.` : 'The last sync found nothing to change.') : 'Check what a sync would write to each agent before applying it.'}</p>
            {!preview && <Btn disabled={busy} onClick={() => void review()}>Check for changes</Btn>}
          </div>
        </Panel>}

    {!!last?.warnings.length && <Panel className="sync-notes"><Info size={15} aria-hidden /><ul>{last.warnings.map(w => <li key={w}>{w}</li>)}</ul></Panel>}

    {preview && <Panel className="manager-block sync-review">
      <div className="sync-review-head">
        <h2>{preview.changes.length ? 'What this sync will do' : 'Everything is up to date'}</h2>
        <p className="muted">{preview.changes.length
          ? `${plural(preview.changes.length, 'file')} to update${attention.length ? `, ${attention.length} of them ${attention.length === 1 ? 'needs' : 'need'} your decision first` : ''}.`
          : 'No agent file needs to change.'}</p>
      </div>
      {!!attention.length && <section aria-label="Needs your decision">
        <h3 className="sync-group sync-group-attention">Needs your decision ({attention.length})</h3>
        <div className="sync-list">{attention.map(c => <ChangeRow key={c.path} change={c} act={act} />)}</div>
        <div className="sync-decision">
          <p><strong>Keep the outside edits</strong> accepts the {attention.length === 1 ? 'change' : 'changes'} listed above and lifts the pause. You then see what AI Usage will write before anything is updated. <strong>Not now</strong> closes this review and leaves sync paused.</p>
          <div className="manager-actions">
            <Btn variant="primary" disabled={busy} onClick={() => void act(async () => setPreview(await api().adoptSyncEdits(preview.id)), 'Outside edits kept. Check what will be written, then update.')}>Keep the outside edits and continue</Btn>
            <Btn variant="ghost" disabled={busy} onClick={() => setPreview(null)}>Not now</Btn>
          </div>
        </div>
      </section>}
      {!!ready.length && <section aria-label="Ready to update">
        <h3 className="sync-group">Ready to update ({ready.length})</h3>
        <div className="sync-list">{ready.map(c => <ChangeRow key={c.path} change={c} act={act} />)}</div>
      </section>}
      {!!preview.warnings.length && <ul className="sync-warnings">{preview.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
      {!attention.length && <div className="manager-actions">
        {!!preview.changes.length && <Btn variant="primary" disabled={busy} onClick={() => void act(async () => { ensureSync(await api().applySync(preview.id)); setPreview(null) }, 'Agents synced')}>Update {plural(preview.changes.length, 'file')}</Btn>}
        <Btn variant="ghost" disabled={busy} onClick={() => setPreview(null)}>{preview.changes.length ? 'Cancel' : 'Close'}</Btn>
      </div>}
    </Panel>}

    {last?.backupId && <Panel className="sync-undo">
      <History size={16} aria-hidden />
      <div><strong>Undo the last sync</strong><p>Puts the {plural(last.changed, 'file')} it changed back to how {last.changed === 1 ? 'it was' : 'they were'} before. Refused if a file was edited since.</p></div>
      <Btn disabled={busy} onClick={() => void act(async () => ensureSync(await api().restoreSync(last.backupId!)), 'Previous sync restored')}>Undo last sync</Btn>
    </Panel>}

    <Panel className="manager-block sync-settings">
      <h2>Automatic sync</h2>
      <label className="manager-check"><input type="checkbox" checked={data.config.autoSync} onChange={e => void act(() => api().setAutoSync(e.target.checked))} />Sync automatically when the shared library changes</label>
      <label className="manager-check"><input type="checkbox" checked={data.config.syncNotifications !== false} onChange={e => void act(() => api().setSyncNotifications(e.target.checked))} />System notification after a successful sync</label>
      <p className="muted">Changes are grouped for 1.5 seconds before syncing. A file edited outside AI Usage pauses sync and notifies you once.</p>
    </Panel>
  </div>
}
