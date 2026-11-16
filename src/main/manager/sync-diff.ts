/*
 * Plain-language description of a synced file's changes. Two directions use the same comparison:
 *  - 'edit': what changed in the file since AI Usage last wrote it (an outside edit, past tense);
 *  - 'plan': what the pending sync will write into it (future tense).
 * Config files are compared on the entries AI Usage manages (see SyncEngine.owned). Values that
 * can carry secrets (env, headers, args, URLs) are never shown: the description names the field
 * and says that it changed.
 */
type Json = Record<string, unknown>
export type DiffMode = 'edit' | 'plan'
const MAX = 8
const SHOWN = new Set(['command', 'type', 'transport'])
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const record = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const quote = (v: unknown): string => { const text = typeof v === 'string' ? v : JSON.stringify(v); return text.length > 60 ? `${text.slice(0, 57)}…` : text }

function fieldChange(key: string, before: unknown, after: unknown): string {
  if (before === undefined) return `${key} was added`
  if (after === undefined) return `${key} was removed`
  if (SHOWN.has(key)) return `${key} changed from ${quote(before)} to ${quote(after)}`
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return `${key} changed (${before.length} → ${after.length} items)`
    const at = before.map((v, i) => same(v, after[i]) ? 0 : i + 1).filter(Boolean)
    return `${key} changed (item ${at.join(', ')} of ${before.length})`
  }
  const a = record(before), b = record(after), keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k]))
  if (keys.length && !Array.isArray(before) && !Array.isArray(after)) return `${key} changed (${keys.slice(0, 4).join(', ')}${keys.length > 4 ? `, +${keys.length - 4} more` : ''})`
  return `${key} changed`
}

/** Fields that differ between two entries. An entry pointing at AI Usage's relay is described as such. */
function fields(a: Json, b: Json): string[] {
  if (b.aiUsageRelay && !a.aiUsageRelay) return ['now launched through AI Usage']
  if (a.aiUsageRelay && !b.aiUsageRelay) return ['no longer launched through AI Usage']
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k])).map(k => fieldChange(k, a[k], b[k]))
}

function entries(label: string, before: Json, after: Json, out: string[], mode: DiffMode): void {
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(name in after)) { out.push(mode === 'plan' ? `Removes ${label} “${name}”` : `${label} “${name}” was removed from the file`); continue }
    if (!(name in before)) { out.push(mode === 'plan' ? `Adds ${label} “${name}”` : `${label} “${name}” was added to the file`); continue }
    if (same(before[name], after[name])) continue
    const changed = fields(record(before[name]), record(after[name]))
    out.push(`${mode === 'plan' ? `Updates ${label}` : label} “${name}”: ${changed.length ? changed.join('; ') : 'its entry changed'}`)
  }
}

/** Compares two results of SyncEngine.owned (stable JSON of the managed parts of a config file). */
export function describeOwnedEdits(baseline: string, current: string, mode: DiffMode = 'edit'): string[] {
  const a = record(JSON.parse(baseline)), b = record(JSON.parse(current)), out: string[] = []
  entries('MCP server', record(a.mcp), record(b.mcp), out, mode)
  entries('skill override', record(a.skillOverrides), record(b.skillOverrides), out, mode)
  entries('skill permission', record(a.permission), record(b.permission), out, mode)
  const was = new Set((a.disabled as string[] | undefined) ?? []), now = new Set((b.disabled as string[] | undefined) ?? [])
  for (const name of now) if (!was.has(name)) out.push(mode === 'plan' ? `Turns off skill “${name}” in this client` : `Skill “${name}” was disabled in the client`)
  for (const name of was) if (!now.has(name)) out.push(mode === 'plan' ? `Turns skill “${name}” back on in this client` : `Skill “${name}” was enabled again in the client`)
  if (!same(a.skillConfig, b.skillConfig)) out.push(mode === 'plan' ? 'Updates the list of shared skill folders' : 'The list of shared skill folders changed')
  return limit(out.map(capitalize))
}

/** Line-level summary for instruction files. */
export function describeTextEdits(baseline: string, current: string, mode: DiffMode = 'edit'): string[] {
  const lines = (text: string): string[] => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const before = lines(baseline), after = lines(current), had = new Set(before), has = new Set(after)
  const added = after.filter(l => !had.has(l)), removed = before.filter(l => !has.has(l)), out: string[] = []
  if (!added.length && !removed.length) return [mode === 'plan' ? 'Only spacing or line order changes' : 'Only spacing or line order changed']
  const count = `${added.length} ${added.length === 1 ? 'line' : 'lines'} added, ${removed.length} removed`
  out.push(mode === 'plan' ? (baseline.trim() ? count : `Creates the file (${after.length} ${after.length === 1 ? 'line' : 'lines'})`) : `${count} since the last sync`)
  if (mode === 'plan' && !baseline.trim()) return out
  for (const line of added.slice(0, 3)) out.push(`Added: ${quote(line)}`)
  for (const line of removed.slice(0, 3)) out.push(`Removed: ${quote(line)}`)
  return limit(out)
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
function limit(out: string[]): string[] { return out.length > MAX ? [...out.slice(0, MAX), `and ${out.length - MAX} more changes`] : out }
