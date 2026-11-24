import { parse as parseYaml } from 'yaml'

/**
 * DeepSeek Harness has no MCP JSON file: servers are `@deepseek-ai/dsh-mcp-client` rows inserted
 * by a Cordis YAML patch, `<DSH_HOME>/cordis.patch.yml`, which every profile (CLI web, desktop,
 * headless) layers on. AI Usage owns one marked block in that file and leaves the rest alone.
 * Rows are written as JSON flow mappings (valid YAML), one per line, so the block reads back
 * without a YAML writer. The file must stay a YAML list: an empty or comments-only file fails boot,
 * so `[]` stands in when nothing else is left.
 */
export const DSH_START = '# >>> AI Usage shared MCP servers (managed by AI Usage; change them there)'
export const DSH_END = '# <<< AI Usage shared MCP servers'
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BLOCK = new RegExp(`\\n?${escape(DSH_START)}[\\s\\S]*?${escape(DSH_END)}[^\\n]*\\n?`)

type Spec = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }

export function dshRow(name: string, s: Spec): string {
  const config = s.command
    ? { serverName: name, transport: 'stdio', command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) }
    : { serverName: name, transport: 'streamable-http', url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) }
  return JSON.stringify({ id: `aiu-${name}`, name: '@deepseek-ai/dsh-mcp-client', config })
}

/** The patch file with AI Usage's block replaced, or null when it cannot be merged safely (reason in warnings). */
export function renderDshPatch(current: string | null, entries: Array<[string, Spec]>, warnings: string[]): string | null {
  const text = (current ?? '').replace(/\r\n/g, '\n')
  const rows: string[] = []
  for (const [name, spec] of entries) {
    if (!SERVER_NAME.test(name)) { warnings.push(`DeepSeek Harness: “${name}” was left out; its server names allow only letters, digits, - and _, up to 32 characters`); continue }
    rows.push(dshRow(name, spec))
  }
  const had = text.includes(DSH_START)
  let rest = text.replace(BLOCK, '\n').replace(/\n{3,}/g, '\n\n')
  const meaningful = (): string[] => rest.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
  if (!rows.length) {
    if (!had) return current
    return (meaningful().length ? rest.trimEnd() : rest.trim() ? `${rest.trimEnd()}\n[]` : '[]') + '\n'
  }
  const own = meaningful()
  if (own.length === 1 && own[0].trim() === '[]') rest = rest.split('\n').filter(l => l.trim() !== '[]').join('\n')
  else if (own.length && own[0].trim().startsWith('[')) { warnings.push('DeepSeek Harness: cordis.patch.yml is written as one inline list, so AI Usage left it unchanged. Rewrite it as one “- …” item per line to let AI Usage add its servers.'); return null }
  const after = `${rest.trim() ? `${rest.trimEnd()}\n\n` : ''}${[DSH_START, '- insert:', ...rows.map(row => `    - ${row}`), DSH_END].join('\n')}\n`
  try { if (!Array.isArray(parseYaml(after))) throw new Error('not a list') }
  catch { warnings.push('DeepSeek Harness: cordis.patch.yml could not be read as a YAML list, so AI Usage left it unchanged. Open it to check.'); return null }
  return after
}

/** The servers inside AI Usage's block, by name, for comparing what changed outside AI Usage. */
export function dshOwnedServers(text: string): Record<string, unknown> {
  const block = text.replace(/\r\n/g, '\n').match(BLOCK)?.[0] ?? ''
  const servers: Record<string, unknown> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*-\s+(\{.*\})\s*$/)
    if (!m) continue
    try { const row = JSON.parse(m[1]) as { config?: { serverName?: string } & Record<string, unknown> }; if (row.config?.serverName) { const { serverName, ...rest } = row.config; servers[serverName] = rest } }
    catch { servers[`invalid line ${Object.keys(servers).length + 1}`] = line.trim() }
  }
  return servers
}
