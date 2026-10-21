import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsDir, existsFile, walkFiles } from '../paths'
import { kvGet, kvSet, openExternalDb, upsertSnapshots } from '../db'
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

export const antigravityAdapter: ProviderAdapter = {
  id: 'antigravity',
  watchRoots(settings) {
    const root = antigravityRoot(settings)
    return [
      { path: path.join(root, '.token-monitor', 'rpc-cache'), recursive: true },
      { path: root, recursive: false }
    ]
  },
  status(settings) {
    const root = antigravityRoot(settings)
    const summaries = path.join(root, 'conversation_summaries.db')
    const artifacts = path.join(root, '.token-monitor', 'rpc-cache', 'v1')
    const hasArtifacts = existsDir(artifacts)
    const hasSummaries = existsFile(summaries)
    const detected = hasArtifacts || hasSummaries || existsDir(root)
    return {
      status: detected ? 'ok' : 'no-data',
      path: root,
      note:
        hasArtifacts
          ? undefined
          : detected ? 'Antigravity detected. Conversation metadata and account quotas are separate from token usage; token counts need Antigravity Token Monitor exports.'
          : 'No Antigravity data found. Install Google Antigravity (and the Antigravity Token Monitor extension for token-level usage).'
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

    // Token usage artifacts exported by the Antigravity Token Monitor extension
    const cacheRoot = path.join(root, '.token-monitor', 'rpc-cache')
    for (const file of walkFiles(cacheRoot, (p) => p.endsWith('usage.jsonl'))) {
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
