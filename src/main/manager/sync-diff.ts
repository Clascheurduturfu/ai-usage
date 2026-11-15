/*
 * Plain-language description of what changed in a synced file since AI Usage last wrote it.
 * Config files are compared on the entries AI Usage manages (see SyncEngine.owned), because
 * only those raise a conflict. Values that can carry secrets (env, headers, args, URLs) are
 * never shown: the description names the field and says that it changed.
 */
type Json = Record<string, unknown>
const MAX = 8
const SHOWN = new Set(['command', 'type', 'transport'])
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const record = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const quote = (v: unknown): string => { const text = typeof v === 'string' ? v : JSON.stringify(v); return text.length > 60 ? `${text.slice(0, 57)}…` : text }

function fieldChange(key: string, before: unknown, after: unknown): string {
  if (before === undefined) return `${key} was added`
  if (after === undefined) return `${key} was removed`
  if (SHOWN.has(key)) return `${key} changed from ${quote(before)} to ${quote(after)}`
  if (Array.isArray(before) && Array.isArray(after) && before.length !== after.length) return `${key} changed (${before.length} → ${after.length} items)`
  const a = record(before), b = record(after), keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k]))
  if (keys.length && !Array.isArray(before) && !Array.isArray(after)) return `${key} changed (${keys.slice(0, 4).join(', ')}${keys.length > 4 ? `, +${keys.length - 4} more` : ''})`
  return `${key} changed`
}

function entries(label: string, before: Json, after: Json, out: string[]): void {
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(name in after)) { out.push(`${label} “${name}” was removed from the file`); continue }
    if (!(name in before)) { out.push(`${label} “${name}” was added to the file`); continue }
    if (same(before[name], after[name])) continue
    const a = record(before[name]), b = record(after[name])
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k])).map(k => fieldChange(k, a[k], b[k]))
    out.push(`${label} “${name}”: ${fields.length ? fields.join('; ') : 'its entry changed'}`)
  }
}

/** Compares two results of SyncEngine.owned (stable JSON of the managed parts of a config file). */
export function describeOwnedEdits(baseline: string, current: string): string[] {
  const a = record(JSON.parse(baseline)), b = record(JSON.parse(current)), out: string[] = []
  entries('MCP server', record(a.mcp), record(b.mcp), out)
  entries('Skill override', record(a.skillOverrides), record(b.skillOverrides), out)
  entries('Skill permission', record(a.permission), record(b.permission), out)
  const was = new Set((a.disabled as string[] | undefined) ?? []), now = new Set((b.disabled as string[] | undefined) ?? [])
  for (const name of now) if (!was.has(name)) out.push(`Skill “${name}” was disabled in the client`)
  for (const name of was) if (!now.has(name)) out.push(`Skill “${name}” was enabled again in the client`)
  if (!same(a.skillConfig, b.skillConfig)) out.push('The list of shared skill folders changed')
  return limit(out)
}

/** Line-level summary for instruction files, which AI Usage replaces as a whole. */
export function describeTextEdits(baseline: string, current: string): string[] {
  const lines = (text: string): string[] => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const before = lines(baseline), after = lines(current), had = new Set(before), has = new Set(after)
  const added = after.filter(l => !had.has(l)), removed = before.filter(l => !has.has(l)), out: string[] = []
  if (!added.length && !removed.length) return ['Only spacing or line order changed']
  out.push(`${added.length} ${added.length === 1 ? 'line' : 'lines'} added, ${removed.length} removed since the last sync`)
  for (const line of added.slice(0, 3)) out.push(`Added: ${quote(line)}`)
  for (const line of removed.slice(0, 3)) out.push(`Removed: ${quote(line)}`)
  return limit(out)
}

function limit(out: string[]): string[] { return out.length > MAX ? [...out.slice(0, MAX), `and ${out.length - MAX} more changes`] : out }
