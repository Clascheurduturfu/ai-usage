import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { existsFile, walkFiles } from '../paths'
import { DB, UpsertEvent, UpsertTool, upsertSnapshots } from '../db'
import { JsonlParser, SnapshotInput, decodeClaudeDirName, hashLine, n, parseJson, safeDate, scanJsonlFile } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

const STATS_CACHE = 'stats-cache.json'

export function claudeRoot(settings: Settings): string {
  return settings.paths.claude ?? path.join(os.homedir(), '.claude')
}

interface ClaudeParserState {
  lastProject?: string
  lastSessionId?: string
}

export function createClaudeParser(filePath: string, prior: ClaudeParserState | null): JsonlParser {
  const state: ClaudeParserState = prior ?? {}
  const events = new Map<string, UpsertEvent>()
  const tools: UpsertTool[] = []

  return {
    line(s: string): void {
      const obj = parseJson(s)
      if (!obj) return

      const sessionId =
        typeof obj.sessionId === 'string' ? obj.sessionId : path.basename(filePath, '.jsonl')
      if (typeof obj.cwd === 'string' && obj.cwd) state.lastProject = obj.cwd

      if (obj.type !== 'assistant') return
      const msg = obj.message
      if (!msg || typeof msg !== 'object') return
      const msgRec = msg as Record<string, unknown>
      const usage = msgRec.usage as Record<string, unknown> | undefined
      if (!usage) return

      const model = typeof msgRec.model === 'string' ? msgRec.model : null
      // "<synthetic>" marks API-error placeholder messages — not real usage
      if (!model || model === '<synthetic>') return

      const ts = safeDate(obj.timestamp)
      if (ts === null) return

      const project =
        (typeof obj.cwd === 'string' && obj.cwd) ||
        state.lastProject ||
        decodeClaudeDirName(path.dirname(path.dirname(filePath)))

      const uuid = typeof obj.uuid === 'string' ? obj.uuid : hashLine(s)
      const meta: Record<string, unknown> = {}
      if (obj.isSidechain === true || filePath.replaceAll('\\', '/').includes('/subagents/')) meta.sidechain = true
      if (typeof obj.version === 'string') meta.claudeVersion = obj.version
      if (typeof obj.entrypoint === 'string') meta.entrypoint = obj.entrypoint

      const messageId = typeof msgRec.id === 'string' && msgRec.id ? msgRec.id : null
      const requestId = typeof obj.requestId === 'string' && obj.requestId ? obj.requestId : null
      const id = messageId ? `claude:message:${messageId}` : requestId ? `claude:request:${requestId}` : `claude:${uuid}`
      if (messageId) meta.messageId = messageId
      const prompt = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens)
      if (/haiku-5[.-]5/.test(model)) meta.longContext = prompt > 100_000
      const creation = usage.cache_creation as Record<string, unknown> | undefined
      if (creation && n(creation.ephemeral_1h_input_tokens) > 0) meta.cacheWrite1h = n(creation.ephemeral_1h_input_tokens)
      const multiplier = (usage.speed === 'fast' && /opus-5/.test(model) ? 2 : 1) * (usage.inference_geo === 'us' ? 1.1 : 1)
      if (multiplier !== 1) meta.priceMultiplier = multiplier
      const event: UpsertEvent = {
        id,
        provider: 'claude',
        ts,
        session_id: sessionId,
        project,
        model,
        kind: 'tokens',
        input_tokens: n(usage.input_tokens),
        output_tokens: n(usage.output_tokens),
        cache_read_tokens: n(usage.cache_read_input_tokens),
        cache_write_tokens: n(usage.cache_creation_input_tokens),
        reasoning_tokens: 0,
        cost_usd: null,
        source_file: filePath,
        meta: JSON.stringify(meta)
      }
      const previous = events.get(id)
      if (previous) {
        for (const field of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const) event[field] = Math.max(previous[field], event[field])
        const previousMeta = JSON.parse(previous.meta ?? '{}')
        meta.cacheWrite1h = Math.max(n(previousMeta.cacheWrite1h), n(meta.cacheWrite1h))
        if (/haiku-5[.-]5/.test(model)) meta.longContext = event.input_tokens + event.cache_read_tokens + event.cache_write_tokens > 100_000
        event.meta = JSON.stringify(meta)
      }
      events.set(id, event)

      // Tool-call analytics from assistant content blocks
      const content = msgRec.content
      if (Array.isArray(content)) {
        content.forEach((block, i) => {
          if (!block || typeof block !== 'object') return
          const b = block as Record<string, unknown>
          if (b.type !== 'tool_use' || typeof b.name !== 'string') return
          tools.push({
            id: typeof b.id === 'string' ? `claude:tool:${b.id}` : `claude:${uuid}:${i}`,
            provider: 'claude',
            ts,
            name: b.name,
            session_id: sessionId,
            project,
            source_file: filePath
          })
        })
      }
    },
    state: () => state,
    events: () => [...events.values()],
    tools: () => tools,
    snapshots: () => []
  }
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  watchRoots(settings) {
    const root = claudeRoot(settings)
    return [
      { path: path.join(root, 'projects'), recursive: true },
      { path: root, recursive: false }
    ]
  },
  status(settings) {
    const projectsDir = path.join(claudeRoot(settings), 'projects')
    const has = walkFiles(projectsDir, (p) => p.endsWith('.jsonl')).length > 0
    return {
      status: has ? 'ok' : 'no-data',
      path: projectsDir,
      note: has
        ? undefined
        : 'No session transcripts found. Run Claude Code at least once, or check the data path in Settings.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const root = claudeRoot(settings)
    const projectsDir = path.join(root, 'projects')

    for (const file of walkFiles(projectsDir, (p) => p.endsWith('.jsonl'))) {
      try {
        const r = scanJsonlFile(db, 'claude', file, (prior) =>
          createClaudeParser(file, prior as ClaudeParserState | null), 2
        )
        if (!r.skipped) outcome.filesScanned++
        outcome.eventsAdded += r.added
      } catch (err) {
        outcome.errors.push(`claude: ${path.basename(file)}: ${(err as Error).message}`)
      }
    }

    // Claude Code's own daily activity stats (messages/sessions/tool calls per day)
    const statsCache = path.join(root, STATS_CACHE)
    if (existsFile(statsCache)) {
      try {
        const raw = fs.readFileSync(statsCache, 'utf8')
        const parsed = JSON.parse(raw) as {
          lastComputedDate?: string
          dailyActivity?: Array<Record<string, unknown>>
        }
        const days = Array.isArray(parsed.dailyActivity) ? parsed.dailyActivity : []
        const snapshots: SnapshotInput[] = [
          {
            key: 'claude:activity',
            provider: 'claude',
            ts: Date.now(),
            data: {
              lastComputedDate: parsed.lastComputedDate ?? null,
              days: days.map((d) => ({
                date: String(d.date ?? ''),
                messages: n(d.messageCount),
                sessions: n(d.sessionCount),
                toolCalls: n(d.toolCallCount)
              }))
            }
          }
        ]
        upsertSnapshots(db, snapshots)
      } catch (err) {
        outcome.errors.push(`claude: stats-cache.json: ${(err as Error).message}`)
      }
    }

    return outcome
  }
}
