import path from 'node:path'
import type { McpMetrics } from '../../shared/manager'
import { atomicWrite, readText } from './storage'

type Tool = { name: string; description?: string; inputSchema?: unknown; [key: string]: unknown }

/**
 * Per-MCP tool inventory and call counters. Only names and counts are kept;
 * arguments and results never enter this file.
 */
export class McpMetricsStore {
  private values: Record<string, McpMetrics> = {}
  private timer?: NodeJS.Timeout
  constructor(private data: string) {}
  private file(): string { return path.join(this.data, 'mcp-metrics.json') }
  async load(): Promise<void> {
    try { this.values = JSON.parse(await readText(this.file()) ?? '{}') } catch { this.values = {} }
    for (const entry of Object.values(this.values)) entry.trackedSince ??= entry.measuredAt ?? Date.now()
  }
  private entry(name: string): McpMetrics { return this.values[name] ??= { calls: 0, errors: 0, byTool: {}, trackedSince: Date.now() } }
  private persist(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void atomicWrite(this.file(), JSON.stringify(this.values)).catch(() => undefined) }, 2000)
    this.timer.unref()
  }
  recordTools(name: string, tools: Tool[]): void {
    const entry = this.entry(name)
    entry.tools = tools.length; entry.schemaBytes = modelVisibleBytes(tools); entry.measuredAt = Date.now()
    this.persist()
  }
  recordCall(name: string, tool: string, ok: boolean): void {
    const entry = this.entry(name)
    entry.calls++; if (!ok) entry.errors++; entry.lastCall = Date.now()
    // Bound the per-tool map; a misbehaving client must not grow it without limit.
    if (tool && (entry.byTool[tool] !== undefined || Object.keys(entry.byTool).length < 500)) entry.byTool[tool] = (entry.byTool[tool] ?? 0) + 1
    this.persist()
  }
  rename(from: string, to: string): void { if (this.values[from]) { this.values[to] = this.values[from]; delete this.values[from]; this.persist() } }
  forget(name: string): void { delete this.values[name]; this.persist() }
  resetCalls(name?: string): void { for (const [key, entry] of Object.entries(this.values)) if (!name || key === name) { entry.calls = 0; entry.errors = 0; entry.byTool = {}; entry.trackedSince = Date.now(); delete entry.lastCall }; this.persist() }
  snapshot(): Record<string, McpMetrics> { return structuredClone(this.values) }
  async flush(): Promise<void> { if (this.timer) { clearTimeout(this.timer); this.timer = undefined }; await atomicWrite(this.file(), JSON.stringify(this.values)).catch(() => undefined) }
}

/**
 * Bytes of what a client turns into model tool definitions: name, description and
 * input schema. outputSchema only validates results and can dwarf the rest (REA's
 * output schemas are ~76% of its tools/list), so it is not counted.
 */
export function modelVisibleBytes(tools: Tool[]): number {
  return Buffer.byteLength(JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))))
}

/** Splits a relay server name such as `rea@compact` into its MCP name and mode. */
export function parseRelayName(raw: string): { name: string; compact: boolean } {
  return raw.endsWith('@compact') ? { name: raw.slice(0, -'@compact'.length), compact: true } : { name: raw, compact: false }
}

const prefix = (server: string): string => server.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)
export const compactNames = (server: string): { search: string; call: string } => ({ search: `${prefix(server)}_search_tools`, call: `${prefix(server)}_call_tool` })

/**
 * Replaces a large tool list with two small tools. The model sees every tool
 * name, searches for the few it needs, then calls them through the second tool.
 */
export function compactToolList(server: string, tools: Tool[]): { tools: Tool[] } {
  const names = compactNames(server)
  let catalog = tools.map(t => t.name).join(', ')
  if (catalog.length > 6000) catalog = catalog.slice(0, 6000).replace(/,[^,]*$/, '') + ', …'
  return { tools: [
    { name: names.search, description: `Find ${server} tools before using them. ${server} offers ${tools.length} tools; their full schemas are loaded only on request to save context. Search with keywords (or exact tool names, comma separated) and get back each match's description and input schema, then run it with ${names.call}. Available tools: ${catalog}`,
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords, or exact tool names separated by commas' }, limit: { type: 'number', description: 'Maximum matches to return (default 6, max 20)' } }, required: ['query'] } },
    { name: names.call, description: `Run one ${server} tool found with ${names.search}. Pass its exact name and arguments matching its input schema.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Exact tool name' }, arguments: { type: 'object', description: 'Arguments for that tool', additionalProperties: true } }, required: ['name'] } }
  ] }
}

export function searchTools(tools: Tool[], query: string, limit = 6): Tool[] {
  const max = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 6))
  const exact = query.split(/[,\s]+/).map(v => v.trim()).filter(Boolean)
  const byName = new Map(tools.map(t => [t.name, t]))
  const direct = exact.map(n => byName.get(n)).filter((t): t is Tool => !!t)
  if (direct.length && direct.length === exact.length) return direct.slice(0, max)
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1)
  if (!words.length) return tools.slice(0, max)
  const score = (t: Tool): number => {
    const name = t.name.toLowerCase(), text = String(t.description ?? '').toLowerCase()
    return words.reduce((sum, w) => sum + (name === w ? 10 : 0) + (name.includes(w) ? 4 : 0) + (text.includes(w) ? 1 : 0), 0)
  }
  return tools.map(t => [t, score(t)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t)
}
