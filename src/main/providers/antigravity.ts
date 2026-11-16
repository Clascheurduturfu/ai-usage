import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsDir, existsFile, walkFiles } from '../paths'
import { deleteFileData, getFileIndex, kvGet, kvSet, openExternalDb, saveFileIndex, upsertEvents, upsertSnapshots } from '../db'
import { pbFields, pbInt, pbInts, pbMessage, pbString } from '../protobuf'
import type { DB, UpsertEvent } from '../db'
import { JsonlParser, hashLine, n, parseJson, safeDate, scanJsonlFile } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

export function antigravityRoot(settings: Settings): string {
  return settings.paths.antigravity ?? path.join(os.homedir(), '.gemini', 'antigravity')
}

/** '2026-09-23 19:40:21.469698+00:00' -> epoch ms */
export function parseAntigravityTime(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const t = Date.parse(v.replace(' ', 'T'))
  return Number.isFinite(t) ? t : null
}

/** '["file:///c%3A/Users/example/Documents/GitHub/foo"]' -> decoded path or null */
export function antigravityProject(workspaceUris: unknown): string | null {
  if (typeof workspaceUris !== 'string' || workspaceUris.length === 0) return null
  try {
    const parsed = JSON.parse(workspaceUris)
    const first = Array.isArray(parsed) ? parsed[0] : null
    if (typeof first !== 'string' || !first.startsWith('file:///')) return null
    const p = decodeURIComponent(first.slice('file:///'.length))
    return p.length > 0 ? p : null
  } catch {
    return null
  }
}

interface ConversationInfo {
  project: string | null
  title: string | null
  agent: string | null
}

/**
 * Session metadata from Antigravity's `conversation_summaries` table, used to
 * attribute the token-monitor's usage artifacts to projects/agents.
 */
function readConversationMap(
  dbFile: string
): { map: Map<string, ConversationInfo>; conversations: number; steps: number } {
  const map = new Map<string, ConversationInfo>()
  let conversations = 0
  let steps = 0
  let db: ReturnType<typeof openExternalDb> | null = null
  try {
    db = openExternalDb(dbFile)
    const rows = db
      .prepare(
        `SELECT conversation_id, title, agent_name, workspace_uris, step_count FROM conversation_summaries`
      )
      .all() as Array<{
      conversation_id: string
      title: string | null
      agent_name: string | null
      workspace_uris: string
      step_count: number | null
    }>
    for (const r of rows) {
      conversations++
      steps += n(r.step_count)
      map.set(r.conversation_id, {
        project: antigravityProject(r.workspace_uris),
        title: r.title ?? null,
        agent: r.agent_name && r.agent_name.length > 0 ? r.agent_name : null
      })
    }
  } catch {
    /* summaries db missing or unreadable */
  } finally {
    db?.close()
  }
  return { map, conversations, steps }
}

interface UsageRecord {
  recordType?: string
  sessionId?: string
  sequence?: number
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  raw?: {
    chatModel?: {
      chatStartMetadata?: { createdAt?: string }
      customMetadata?: Record<string, unknown>
    }
  }
}

/**
 * Antigravity Token Monitor (VS Code extension, ddarkr) continuously exports
 * per-model-call usage artifacts to
 * `~/.gemini/antigravity/.token-monitor/rpc-cache/v1/<sessionId>/usage.jsonl`.
 * Each record carries resolved model + input/output/cache-read/cache-write/
 * reasoning token counts — the same numbers the extension's dashboard shows.
 * We tail those files incrementally and turn them into token events.
 */
export function createAntigravityUsageParser(
  filePath: string,
  conversationMap: Map<string, ConversationInfo>
): JsonlParser {
  const events: UpsertEvent[] = []
  const sessionId = path.basename(path.dirname(filePath))

  return {
    line(s: string): void {
      const rec = parseJson(s) as unknown as UsageRecord | null
      if (!rec || rec.recordType !== 'usage') return
      const model = typeof rec.model === 'string' && rec.model ? rec.model : null
      const input = n(rec.inputTokens)
      const visibleOutput = n(rec.outputTokens)
      const cacheRead = n(rec.cacheReadTokens)
      const cacheWrite = n(rec.cacheWriteTokens)
      const reasoning = Math.max(0, n(rec.reasoningTokens))
      // Some Gemini exports report thinking separately from visible output;
      // other backends include it already. Follow the exported total exactly.
      const base = input + visibleOutput + cacheRead + cacheWrite
      const output = visibleOutput + (reasoning > 0 && rec.totalTokens === base + reasoning ? reasoning : 0)
      if (input + output + cacheRead + cacheWrite === 0) return

      const ts =
        safeDate(rec.raw?.chatModel?.chatStartMetadata?.createdAt) ??
        /* fallback */ null
      const info = conversationMap.get(rec.sessionId ?? sessionId)
      const sequence = typeof rec.sequence === 'number' && Number.isInteger(rec.sequence) && rec.sequence >= 0 ? rec.sequence : hashLine(s)
      const meta: Record<string, unknown> = {}
      const custom = rec.raw?.chatModel?.customMetadata
      if (custom) {
        if (custom['used_non_gemini_model'] === true) meta.nonGemini = true
        if (custom['used_claude'] === true) meta.claude = true
      }
      events.push({
        id: `antigravity:${rec.sessionId ?? sessionId}:${sequence}`,
        provider: 'antigravity',
        ts: ts ?? Date.now(),
        session_id: rec.sessionId ?? sessionId,
        project: info?.project ?? null,
        model,
        kind: 'tokens',
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        reasoning_tokens: reasoning,
        cost_usd: null,
        source_file: filePath,
        meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
      })
    },
    state: () => ({}),
    events: () => events,
    tools: () => [],
    snapshots: () => []
  }
}

/**
 * Antigravity 2.x keeps each conversation in `~/.gemini/antigravity/conversations/<cascadeId>.db`.
 * Its `gen_metadata` table holds one protobuf row per model call (the same generator metadata the
 * Antigravity Token Monitor extension used to fetch over the local RPC, which no longer returns
 * conversations). Layout, verified on 28,944 rows:
 *   .1 chatModel { .4 usage { 2 input, 3 output (= 9 thinking + 10 response), 5 cache read },
 *                  .19 model id, .21 model label, .20 repeated { 1 key, 2 value } custom metadata }
 *   .2 packed step indices this call produced; `steps.metadata` .1 { 1 seconds, 2 nanos } is when.
 */
export function readConversationUsage(file: string, afterIdx: number, info: ConversationInfo | undefined): { events: UpsertEvent[]; lastIdx: number } {
  const cascadeId = path.basename(file, '.db'), events: UpsertEvent[] = []
  let lastIdx = afterIdx
  const db = openExternalDb(file)
  try {
    const stepStmt = db.prepare('SELECT metadata FROM steps WHERE idx = ?')
    const stepTime = (idx: number): number | null => {
      const row = stepStmt.get(idx) as { metadata: Uint8Array | null } | undefined
      if (!row?.metadata) return null
      try { const at = pbMessage(pbFields(row.metadata), 1); if (!at) return null; const f = pbFields(at), s = pbInt(f, 1); return s > 0 ? s * 1000 + Math.floor(pbInt(f, 2) / 1e6) : null } catch { return null }
    }
    const fallback = Math.trunc(fs.statSync(file).mtimeMs)
    let previous: number | null = null
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx').iterate(afterIdx) as Iterable<{ idx: number; data: Uint8Array | null }>) {
      lastIdx = Math.max(lastIdx, row.idx)
      if (!row.data) continue
      let top, chat, usage
      try { top = pbFields(row.data); const cm = pbMessage(top, 1); if (!cm) continue; chat = pbFields(cm); const u = pbMessage(chat, 4); if (!u) continue; usage = pbFields(u) } catch { continue }
      const input = pbInt(usage, 2), output = pbInt(usage, 3), cacheRead = pbInt(usage, 5), reasoning = pbInt(usage, 9)
      if (input + output + cacheRead === 0) continue
      const step = pbInts(top, 2)[0]
      const ts: number = (step !== undefined ? stepTime(step) : null) ?? previous ?? fallback
      previous = ts
      const meta: Record<string, unknown> = {}
      for (const entry of chat.filter(f => f.field === 20 && f.value instanceof Uint8Array)) {
        try { const kv = pbFields(entry.value as Uint8Array), key = pbString(kv, 1), value = pbString(kv, 2); if (value === 'true' && key === 'used_non_gemini_model') meta.nonGemini = true; if (value === 'true' && key === 'used_claude') meta.claude = true } catch { /* nested key */ }
      }
      const label = pbString(chat, 21)
      if (label) meta.label = label
      events.push({
        id: `antigravity:${cascadeId}:g${row.idx}`, provider: 'antigravity', ts, session_id: cascadeId, project: info?.project ?? null,
        model: pbString(chat, 19) ?? label ?? null, kind: 'tokens', input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead,
        cache_write_tokens: 0, reasoning_tokens: reasoning, cost_usd: null, source_file: null, meta: Object.keys(meta).length ? JSON.stringify(meta) : null
      })
    }
  } finally { db.close() }
  return { events, lastIdx }
}

/** Incremental scan of one conversation DB; a live WAL counts toward the change signature. */
function scanConversation(db: DB, rawFile: string, info: ConversationInfo | undefined): number {
  const file = rawFile.replaceAll('\\', '/')
  const stat = fs.statSync(file), wal = (() => { try { return fs.statSync(file + '-wal') } catch { return null } })()
  const size = stat.size + (wal?.size ?? 0), mtime = Math.trunc(Math.max(stat.mtimeMs, wal?.mtimeMs ?? 0))
  const row = getFileIndex(db, file), state = row?.parser_state ? JSON.parse(row.parser_state) as { lastIdx?: number; __parserVersion?: number } : null
  if (row && state?.__parserVersion === CONVERSATION_PARSER && row.size === size && row.mtime === mtime) return 0
  const fresh = !row || state?.__parserVersion !== CONVERSATION_PARSER
  if (fresh) deleteFileData(db, file)
  const { events, lastIdx } = readConversationUsage(file, fresh ? -1 : state?.lastIdx ?? -1, info)
  upsertEvents(db, events.map(e => ({ ...e, source_file: file })))
  saveFileIndex(db, { path: file, provider: 'antigravity', size, mtime, byte_offset: 0, event_count: (fresh ? 0 : row?.event_count ?? 0) + events.length, parser_state: JSON.stringify({ lastIdx, __parserVersion: CONVERSATION_PARSER }), added: events.length })
  return events.length
}
const CONVERSATION_PARSER = 1

export const antigravityAdapter: ProviderAdapter = {
  id: 'antigravity',
  watchRoots(settings) {
    const root = antigravityRoot(settings)
    return [
      { path: path.join(root, 'conversations'), recursive: false },
      { path: path.join(root, '.token-monitor', 'rpc-cache'), recursive: true },
      { path: root, recursive: false }
    ]
  },
  status(settings) {
    const root = antigravityRoot(settings)
    const summaries = path.join(root, 'conversation_summaries.db')
    const artifacts = path.join(root, '.token-monitor', 'rpc-cache', 'v1')
    const hasArtifacts = existsDir(artifacts) || existsDir(path.join(root, 'conversations'))
    const hasSummaries = existsFile(summaries)
    const detected = hasArtifacts || hasSummaries || existsDir(root)
    return {
      status: detected ? 'ok' : 'no-data',
      path: root,
      note:
        hasArtifacts
          ? undefined
          : detected ? 'Antigravity detected, but no conversation database was found yet. Start a conversation in Antigravity, then rescan.'
          : 'No Antigravity data found. Install Google Antigravity.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    let scanConversations = new Map<string, ConversationInfo>()
    const root = antigravityRoot(settings)
    const summariesDb = path.join(root, 'conversation_summaries.db')

    // v1.1.x stored conversations as request-kind events; the token-monitor
    // artifacts replace them with real token events. One-time purge.
    if (!kvGet<boolean>(db, 'antigravity:legacyPurged')) {
      db.prepare("DELETE FROM usage_events WHERE provider = 'antigravity' AND kind = 'request'").run()
      kvSet(db, 'antigravity:legacyPurged', true)
    }

    // Conversation metadata (projects/agents) for attribution + step totals
    if (existsFile(summariesDb)) {
      const { map: conversations, conversations: count, steps } = readConversationMap(summariesDb)
      try {
        upsertSnapshots(db, [
          {
            key: 'antigravity:summary',
            provider: 'antigravity',
            ts: Date.now(),
            data: { conversations: count, steps }
          }
        ])
      } catch {
        /* optional */
      }
      scanConversations = conversations
    }

    // Antigravity 2.x: token usage straight from each conversation's own database.
    const conversationsDir = path.join(root, 'conversations'), covered = new Set<string>()
    if (existsDir(conversationsDir)) {
      for (const name of fs.readdirSync(conversationsDir)) {
        if (!name.endsWith('.db')) continue
        const id = name.slice(0, -3); covered.add(id)
        try { const added = scanConversation(db, path.join(conversationsDir, name), scanConversations.get(id)); outcome.filesScanned++; outcome.eventsAdded += added }
        catch (err) { outcome.errors.push(`antigravity: ${id}: ${(err as Error).message}`) }
      }
    }

    // Older setups: artifacts exported by the Antigravity Token Monitor extension, only for
    // sessions without their own conversation database (otherwise they would count twice).
    const cacheRoot = path.join(root, '.token-monitor', 'rpc-cache')
    for (const file of walkFiles(cacheRoot, (p) => p.endsWith('usage.jsonl'))) {
      if (covered.has(path.basename(path.dirname(file)))) continue
      try {
        const r = scanJsonlFile(db, 'antigravity', file, () =>
          createAntigravityUsageParser(file, scanConversations), 2
        )
        if (!r.skipped) outcome.filesScanned++
        outcome.eventsAdded += r.added
      } catch (err) {
        outcome.errors.push(`antigravity: ${path.basename(path.dirname(file))}: ${(err as Error).message}`)
      }
    }
    return outcome
  }
}
