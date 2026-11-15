import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Check, ChevronDown, FileText, Folder, FolderInput, FolderMinus, FolderOpen, FolderPlus, Plus, Save, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { ManagerSnapshot, SkillFolder, SkillInfo } from '../../../shared/manager'
import { api } from '../lib/ipc'
import { fmtTokens, skillTokens } from '../lib/budget'
import { Btn, ConfirmDialog, Drawer, Toggle } from './ui'

export type LibraryAction = (work: () => Promise<unknown>, success?: string) => Promise<void>

const FOLDER_OPEN_KEY = 'aiu:v1:skill-folders:open'
const supportsPopover = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype

const folderId = (): string => `folder-${crypto.randomUUID().slice(0, 8)}`
const moveSkillList = (folders: SkillFolder[], skill: string, targetId: string | null): SkillFolder[] =>
  folders.map(f => {
    const filtered = f.skills.filter(name => name !== skill)
    if (f.id === targetId) filtered.push(skill)
    return { ...f, skills: [...new Set(filtered)].sort((a, b) => a.localeCompare(b)) }
  })

function readOpenFolders(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDER_OPEN_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function FolderEditor({
  folder,
  folders,
  skills,
  initialSkill,
  close,
  saved,
  act
}: {
  folder: SkillFolder | null
  folders: SkillFolder[]
  skills: SkillInfo[]
  initialSkill?: string
  close(): void
  saved(id: string): void
  act: LibraryAction
}) {
  const [name, setName] = useState(folder?.name ?? '')
  const [selected, setSelected] = useState<Set<string>>(() => {
    const valid = new Set(skills.map(s => s.name))
    const set = new Set((folder?.skills ?? []).filter(name => valid.has(name)))
    if (initialSkill && valid.has(initialSkill)) set.add(initialSkill)
    return set
  })
  const [filter, setFilter] = useState('')
  const [formError, setFormError] = useState('')

  const otherOwner = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of folders) {
      if (folder && f.id === folder.id) continue
      for (const s of f.skills) map.set(s, f.name)
    }
    return map
  }, [folders, folder])

  const query = filter.trim().toLowerCase()
  const visible = useMemo(
    () => skills.filter(s => !query || s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)),
    [skills, query]
  )

  const toggleSkill = (skillName: string, checked: boolean): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (checked) next.add(skillName); else next.delete(skillName)
      return next
    })
  }

  const selectVisible = (): void => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const s of visible) next.add(s.name)
      return next
    })
  }

  const clearVisible = (): void => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const s of visible) next.delete(s.name)
      return next
    })
  }

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed) { setFormError('Enter a folder name.'); return }
    if (trimmed.length > 80) { setFormError('Folder name must be 80 characters or fewer.'); return }
    const duplicate = folders.find(f => f.id !== folder?.id && f.name.toLowerCase() === trimmed.toLowerCase())
    if (duplicate) { setFormError(`A folder named "${duplicate.name}" already exists.`); return }
    setFormError('')

    const id = folder?.id ?? folderId()
    const picked = [...selected].sort((a, b) => a.localeCompare(b))
    const cleaned = folders.map(f => ({
      ...f,
      skills: f.skills.filter(s => !selected.has(s))
    }))
    const next = folder
      ? cleaned.map(f => f.id === id ? { id, name: trimmed, skills: picked } : f)
      : [...cleaned, { id, name: trimmed, skills: picked }]

    void act(async () => {
      await api().saveSkillFolders(next)
      saved(id)
      close()
    }, folder ? `Updated folder "${trimmed}"` : `Created folder "${trimmed}"`)
  }

  return (
    <Drawer title={folder ? `Manage ${folder.name}` : 'New skill folder'} close={close}>
      <div className="manager-form">
        <label className="manager-field">
          <span>Folder name</span>
          <input
            value={name}
            maxLength={80}
            placeholder="e.g. AWS, Cloudflare, Workflows"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          />
        </label>
        <p className="muted">Folders organize skills only inside AI Usage. On disk, skills stay flat in <code>skills</code> so every client still loads them normally.</p>
        <div className="folder-picker-head">
          <span>Skills ({selected.size} selected)</span>
          <div className="folder-picker-bulk">
            <Btn variant="ghost" onClick={selectVisible} disabled={!visible.length}>Select visible</Btn>
            <Btn variant="ghost" onClick={clearVisible} disabled={!visible.length}>Clear visible</Btn>
          </div>
        </div>
        <label className="search-field">
          <Search size={14} />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter skills to assign…" aria-label="Filter skills to assign" />
        </label>
        <div className="manager-choice-list">
          {visible.map(s => {
            const elsewhere = otherOwner.get(s.name)
            return (
              <label key={s.name}>
                <input
                  type="checkbox"
                  checked={selected.has(s.name)}
                  onChange={e => toggleSkill(s.name, e.target.checked)}
                />
                <div className="folder-choice-copy">
                  <strong>{s.name}{elsewhere ? <span className="chip">{elsewhere}</span> : null}</strong>
                  {s.description && <small>{s.description}</small>}
                </div>
              </label>
            )
          })}
          {!visible.length && <p className="muted skill-empty">No skill matches "{filter}".</p>}
        </div>
        {formError && <p role="alert" className="workspace-form-error">{formError}</p>}
        <div className="manager-actions">
          <Btn variant="primary" onClick={submit}><Save size={14} />{folder ? 'Save folder' : 'Create folder'}</Btn>
          <Btn onClick={close}>Cancel</Btn>
        </div>
      </div>
    </Drawer>
  )
}

export function SkillsLibrary({
  data,
  act,
  busy,
  onEditSkill,
  onAddSkill
}: {
  data: ManagerSnapshot
  act: LibraryAction
  busy: boolean
  onEditSkill(name: string): void
  onAddSkill(): void
}) {
  const [skillQuery, setSkillQuery] = useState('')
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(readOpenFolders)
  const [editingFolder, setEditingFolder] = useState<{ folder: SkillFolder | null; initialSkill?: string } | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'skill'; skill: SkillInfo } | { kind: 'folder'; folder: SkillFolder } | null>(null)
  const [moveMenu, setMoveMenu] = useState<{ skill: string; anchorName: string; rect: { top: number; bottom: number; right: number } } | null>(null)
  const [draggedSkill, setDraggedSkill] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const sectionId = useId()

  useEffect(() => {
    try { localStorage.setItem(FOLDER_OPEN_KEY, JSON.stringify(openMap)) } catch { /* ignore */ }
  }, [openMap])

  useEffect(() => {
    const el = popoverRef.current
    if (!el) return
    if (moveMenu && supportsPopover) {
      try { if (!el.matches(':popover-open')) el.showPopover() } catch { /* ignore */ }
    } else if (!moveMenu && supportsPopover) {
      try { if (el.matches(':popover-open')) el.hidePopover() } catch { /* ignore */ }
    }
  }, [moveMenu])

  useEffect(() => {
    if (!moveMenu || supportsPopover) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMoveMenu(null) }
    const onPointer = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setMoveMenu(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointer)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onPointer) }
  }, [moveMenu])

  const folders = data.config.skillFolders ?? []
  const off = useMemo(() => new Set(data.config.disabledSkills ?? []), [data.config.disabledSkills])
  const query = skillQuery.trim().toLowerCase()

  const folderBySkill = useMemo(() => {
    const map = new Map<string, SkillFolder>()
    for (const f of folders) for (const s of f.skills) if (!map.has(s)) map.set(s, f)
    return map
  }, [folders])

  const skillByName = useMemo(() => new Map(data.skills.map(s => [s.name, s])), [data.skills])

  const folderEntries = useMemo(() => folders.map(folder => {
    const all = folder.skills.map(name => skillByName.get(name)).filter((s): s is SkillInfo => !!s)
    const folderMatches = !!query && folder.name.toLowerCase().includes(query)
    const shown = !query || folderMatches
      ? all
      : all.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
    return { folder, all, shown }
  }), [folders, skillByName, query])

  const ungrouped = useMemo(() => {
    const list = data.skills.filter(s => !folderBySkill.has(s.name))
    return !query ? list : list.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
  }, [data.skills, folderBySkill, query])

  const indexTokens = useMemo(
    () => data.skills.filter(s => !off.has(s.name)).reduce((n, s) => n + skillTokens(s), 0),
    [data.skills, off]
  )

  const toggleFolderOpen = (id: string): void => setOpenMap(prev => ({ ...prev, [id]: !prev[id] }))
  const expandAll = (open: boolean): void => setOpenMap(Object.fromEntries(folders.map(f => [f.id, open])))

  const saveFolders = (next: SkillFolder[], message: string): void => {
    void act(async () => { await api().saveSkillFolders(next) }, message)
  }

  const moveSkill = (skillName: string, targetFolderId: string | null): void => {
    const current = folderBySkill.get(skillName)
    if ((current?.id ?? null) === targetFolderId) return
    const next = moveSkillList(folders, skillName, targetFolderId)
    const targetName = folders.find(f => f.id === targetFolderId)?.name
    if (targetFolderId) setOpenMap(prev => ({ ...prev, [targetFolderId]: true }))
    saveFolders(next, targetName ? `Moved ${skillName} to ${targetName}` : `Removed ${skillName} from ${current?.name ?? 'folder'}`)
  }

  const setFolderEnabled = (folder: SkillFolder, names: string[], enabled: boolean): void => {
    if (!names.length) return
    void act(async () => {
      const r = await api().setSkillsEnabled(names, enabled)
      if (r.conflicts.length) throw new Error('Saved, but some client files have local edits. Review Agent sync.')
    }, `${enabled ? 'Enabled' : 'Disabled'} ${names.length} ${names.length === 1 ? 'skill' : 'skills'} in ${folder.name}`)
  }

  const closePopover = (): void => {
    try { popoverRef.current?.hidePopover?.() } catch { /* ignore */ }
    setMoveMenu(null)
  }

  const onDragOverZone = (e: DragEvent<HTMLElement>, targetId: string): void => {
    if (busy || !draggedSkill) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== targetId) setDropTarget(targetId)
  }

  const onDragLeaveZone = (e: DragEvent<HTMLElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null)
  }

  const onDropZone = (e: DragEvent<HTMLElement>, targetId: string | null): void => {
    e.preventDefault()
    setDropTarget(null)
    const dropped = e.dataTransfer.getData('application/x-aiu-skill') || draggedSkill
    setDraggedSkill(null)
    if (dropped && !busy) moveSkill(dropped, targetId)
  }

  const renderSkillRow = (s: SkillInfo, idx: string): React.ReactElement => {
    const enabled = !off.has(s.name)
    const anchorName = `--skill-move-${idx}`
    const inFolder = folderBySkill.get(s.name)
    const isMenuOpen = moveMenu?.skill === s.name
    return (
      <div
        key={s.name}
        className={`skill-row ${enabled ? '' : 'mcp-disabled'} ${draggedSkill === s.name ? 'skill-dragging' : ''}`}
        draggable={!busy}
        onDragStart={e => {
          setDraggedSkill(s.name)
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('application/x-aiu-skill', s.name)
          e.dataTransfer.setData('text/plain', s.name)
        }}
        onDragEnd={() => { setDraggedSkill(null); setDropTarget(null) }}
      >
        <FileText size={16} />
        <div>
          <h3>{s.name}{!s.valid && <span className="chip chip-warn">Check format</span>}</h3>
          <p title={s.description || s.issue}>{s.description || s.issue}</p>
        </div>
        <span className="chip" title="Estimated tokens this skill adds to each agent's skill index">~{fmtTokens(skillTokens(s))}</span>
        <button
          type="button"
          className="icon-btn skill-action-btn"
          disabled={busy}
          aria-label={`Move ${s.name} to a folder`}
          aria-expanded={isMenuOpen}
          title={inFolder ? `In ${inFolder.name} — move folder` : 'Move to folder'}
          style={{ ['anchorName' as string]: anchorName } as CSSProperties}
          onClick={e => {
            if (isMenuOpen) { closePopover(); return }
            const rect = e.currentTarget.getBoundingClientRect()
            setMoveMenu({ skill: s.name, anchorName, rect: { top: rect.top, bottom: rect.bottom, right: rect.right } })
          }}
        >
          <FolderInput size={14} />
        </button>
        <Btn variant="ghost" onClick={() => onEditSkill(s.name)}>Edit</Btn>
        <button
          type="button"
          className="icon-btn skill-delete-btn"
          disabled={busy}
          aria-label={`Delete skill ${s.name}`}
          title={`Delete ${s.name}`}
          onClick={() => setConfirm({ kind: 'skill', skill: s })}
        >
          <Trash2 size={14} />
        </button>
        <Toggle
          checked={enabled}
          disabled={busy}
          label={`Enable ${s.name} for every agent`}
          onChange={value => void act(async () => {
            const r = await api().setSkillEnabled(s.name, value)
            if (r.conflicts.length) throw new Error('Saved, but some client files have local edits. Review Agent sync.')
          }, value ? `${s.name} enabled for every agent` : `${s.name} disabled for every agent`)}
        />
      </div>
    )
  }

  const visibleFolders = folderEntries.filter(entry => !query || entry.shown.length > 0)
  const anyClosed = folders.some(f => !openMap[f.id])
  const anyVisible = visibleFolders.length > 0 || ungrouped.length > 0
  const skillsFolderPath = data.instructionSource?.replace(/[/\\]AGENTS\.md$/, '') + '/skills'
  const currentMenuFolder = moveMenu ? folderBySkill.get(moveMenu.skill) : undefined

  const fallbackPopoverStyle = moveMenu ? ({
    ['positionAnchor' as string]: moveMenu.anchorName,
    ['--popover-top' as string]: `${Math.min(window.innerHeight - 240, moveMenu.rect.bottom + 6)}px`,
    ['--popover-right' as string]: `${Math.max(12, window.innerWidth - moveMenu.rect.right)}px`
  } as CSSProperties) : undefined

  return (
    <>
      <div className="mcp-list-summary">
        <span><strong>{data.skills.length}</strong> skills</span>
        {folders.length > 0 && <span><strong>{folders.length}</strong> {folders.length === 1 ? 'folder' : 'folders'}</span>}
        {off.size > 0 && <span className="tone-off"><strong>{off.size}</strong> disabled</span>}
        <span className="tone-idle">index ~<strong>{fmtTokens(indexTokens)}</strong> tokens per agent</span>
        <span style={{ flex: 1 }} />
        <label className="search-field skill-search">
          <Search size={14} />
          <input placeholder="Filter skills…" value={skillQuery} onChange={e => setSkillQuery(e.target.value)} aria-label="Filter skills" />
        </label>
        <Btn onClick={() => setEditingFolder({ folder: null })}><FolderPlus size={14} />New folder</Btn>
        <Btn onClick={onAddSkill}><Plus size={13} />Add from URL</Btn>
        <Btn onClick={() => void act(() => api().openPath(skillsFolderPath))}><FolderOpen size={14} />Open library</Btn>
      </div>

      {off.size > 0 && <p className="muted">Disabled skills are moved to <code>skills-disabled</code> beside the library, so no client loads them. Restart open clients after a change.</p>}

      {folders.length > 0 && visibleFolders.length > 0 && (
        <div className="skill-section-head">
          <span>Folders</span>
          {folders.length > 1 && !query && (
            <Btn variant="ghost" onClick={() => expandAll(anyClosed)}>{anyClosed ? 'Expand all' : 'Collapse all'}</Btn>
          )}
        </div>
      )}

      {visibleFolders.length > 0 && (
        <div className="skill-folders">
          {visibleFolders.map(({ folder, all, shown }, fIdx) => {
            const isOpen = !!query || !!openMap[folder.id]
            const panelId = `${sectionId}-folder-${folder.id}`
            const enabledCount = all.filter(s => !off.has(s.name)).length
            const allEnabled = all.length > 0 && enabledCount === all.length
            const partiallyEnabled = enabledCount > 0 && enabledCount < all.length
            const activeTokens = all.filter(s => !off.has(s.name)).reduce((n, s) => n + skillTokens(s), 0)
            const isDrop = dropTarget === folder.id

            return (
              <section
                key={folder.id}
                className={`skill-folder ${isOpen ? 'skill-folder-open' : ''} ${isDrop ? 'skill-folder-drop' : ''}`}
                onDragOver={e => onDragOverZone(e, folder.id)}
                onDragLeave={onDragLeaveZone}
                onDrop={e => onDropZone(e, folder.id)}
              >
                <div className="skill-folder-head">
                  <button
                    type="button"
                    className="skill-folder-trigger"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggleFolderOpen(folder.id)}
                  >
                    <ChevronDown size={15} className="skill-folder-chevron" />
                    <span className="skill-folder-icon">{isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
                    <span className="skill-folder-name">{folder.name}</span>
                    <span className="chip">
                      {query ? `${shown.length} / ${all.length}` : all.length} {all.length === 1 && !query ? 'skill' : 'skills'}
                    </span>
                    {all.length > 0 && enabledCount < all.length && (
                      <span className="chip chip-muted">{enabledCount} active</span>
                    )}
                    <span className="chip" title="Estimated tokens enabled skills in this folder add per agent">
                      ~{fmtTokens(activeTokens)}
                    </span>
                  </button>
                  <div className="skill-folder-actions">
                    <Btn variant="ghost" disabled={busy} onClick={() => setEditingFolder({ folder })} title={`Rename or choose skills for ${folder.name}`}>
                      <SlidersHorizontal size={13} />Manage
                    </Btn>
                    <button
                      type="button"
                      className="icon-btn skill-delete-btn"
                      disabled={busy}
                      aria-label={`Remove folder ${folder.name}`}
                      title="Remove folder (keeps skills in library)"
                      onClick={() => setConfirm({ kind: 'folder', folder })}
                    >
                      <FolderMinus size={14} />
                    </button>
                    <Toggle
                      checked={allEnabled}
                      partial={partiallyEnabled}
                      disabled={busy || all.length === 0}
                      label={`Enable all skills in ${folder.name}`}
                      title={allEnabled ? `Disable all ${all.length} skills in ${folder.name}` : `Enable all ${all.length} skills in ${folder.name}`}
                      onChange={value => setFolderEnabled(folder, all.map(s => s.name), value)}
                    />
                  </div>
                </div>

                {isOpen && (
                  <div id={panelId} className="skill-folder-body">
                    {shown.length > 0 ? (
                      <div className="skill-list">
                        {shown.map((s, sIdx) => renderSkillRow(s, `${fIdx}-${sIdx}`))}
                      </div>
                    ) : (
                      <div className="skill-folder-empty">
                        <p className="muted">No skills in this folder yet. Drag any skill card here or choose skills.</p>
                        <Btn variant="ghost" onClick={() => setEditingFolder({ folder })}>Choose skills</Btn>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      {folders.length > 0 && (ungrouped.length > 0 || (draggedSkill && folderBySkill.has(draggedSkill))) && (
        <div
          className={`skill-ungrouped-zone ${dropTarget === '__ungrouped__' ? 'skill-folder-drop' : ''}`}
          onDragOver={e => onDragOverZone(e, '__ungrouped__')}
          onDragLeave={onDragLeaveZone}
          onDrop={e => onDropZone(e, null)}
        >
          <div className="skill-section-head">
            <span>Ungrouped ({ungrouped.length})</span>
            {draggedSkill && folderBySkill.has(draggedSkill) && <span className="muted">Drop here to remove from {folderBySkill.get(draggedSkill)?.name}</span>}
          </div>
          {ungrouped.length > 0 && (
            <div className="skill-list">
              {ungrouped.map((s, idx) => renderSkillRow(s, `u-${idx}`))}
            </div>
          )}
        </div>
      )}

      {folders.length === 0 && (
        <div className="skill-list">
          {ungrouped.map((s, idx) => renderSkillRow(s, `u-${idx}`))}
          {!ungrouped.length && <p className="muted skill-empty">No skill matches “{skillQuery}”.</p>}
        </div>
      )}

      {folders.length > 0 && !anyVisible && (
        <p className="muted skill-empty">No skill or folder matches “{skillQuery}”.</p>
      )}

      {moveMenu && (
        <div
          ref={popoverRef}
          popover={supportsPopover ? 'auto' : undefined}
          className="skill-folder-popover"
          style={fallbackPopoverStyle}
          onToggle={e => {
            if ((e.nativeEvent as ToggleEvent).newState === 'closed') setMoveMenu(null)
          }}
        >
          <div className="skill-popover-label">Move <strong>{moveMenu.skill}</strong></div>
          {folders.map(f => {
            const active = currentMenuFolder?.id === f.id
            return (
              <button
                key={f.id}
                type="button"
                className={active ? 'active' : undefined}
                onClick={() => {
                  const target = moveMenu.skill
                  closePopover()
                  moveSkill(target, f.id)
                }}
              >
                <Folder size={13} />
                <span>{f.name}</span>
                {active && <Check size={13} />}
              </button>
            )
          })}
          {currentMenuFolder && (
            <button
              type="button"
              onClick={() => {
                const target = moveMenu.skill
                closePopover()
                moveSkill(target, null)
              }}
            >
              <FolderMinus size={13} />
              <span>Remove from folder</span>
            </button>
          )}
          <div className="skill-popover-sep" />
          <button
            type="button"
            onClick={() => {
              const target = moveMenu.skill
              closePopover()
              setEditingFolder({ folder: null, initialSkill: target })
            }}
          >
            <FolderPlus size={13} />
            <span>New folder with skill…</span>
          </button>
        </div>
      )}

      {editingFolder && (
        <FolderEditor
          folder={editingFolder.folder}
          folders={folders}
          skills={data.skills}
          initialSkill={editingFolder.initialSkill}
          close={() => setEditingFolder(null)}
          saved={id => setOpenMap(prev => ({ ...prev, [id]: true }))}
          act={act}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'skill' ? `Delete skill "${confirm.skill.name}"?` : confirm ? `Remove folder "${confirm.folder.name}"?` : ''}
        confirmLabel={confirm?.kind === 'skill' ? 'Delete skill' : 'Remove folder'}
        danger={confirm?.kind === 'skill'}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const current = confirm
          setConfirm(null)
          if (!current) return
          if (current.kind === 'skill') {
            void act(() => api().deleteSkill(current.skill.name), `Deleted skill "${current.skill.name}"`)
          } else {
            const next = folders.filter(f => f.id !== current.folder.id)
            saveFolders(next, `Removed folder "${current.folder.name}"`)
          }
        }}
      >
        {confirm?.kind === 'skill' && (
          <>
            <p>This permanently deletes the skill directory from your shared library, removes it from all folders and agent profiles, and updates connected coding agents.</p>
            <code>{confirm.skill.path}</code>
          </>
        )}
        {confirm?.kind === 'folder' && (
          <p>
            This only removes the folder grouping in AI Usage. All {confirm.folder.skills.length}{' '}
            {confirm.folder.skills.length === 1 ? 'skill' : 'skills'} inside "{confirm.folder.name}" stay in your library as ungrouped.
          </p>
        )}
      </ConfirmDialog>
    </>
  )
}
