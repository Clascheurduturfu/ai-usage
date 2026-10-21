import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/types'
import { walkFiles } from '../paths'
import type { DB, UpsertEvent } from '../db'
import { JsonlParser, hashLine, parseJson, safeDate, scanJsonlFile } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

export function geminiRoot(settings: Settings): string {
  return settings.paths.gemini ?? path.join(os.homedir(), '.gemini', 'tmp')
}

interface GeminiParserState {
  sessionId?: string
  lastModel?: string
}

/**
 * Gemini CLI stores chat transcripts under `~/.gemini/tmp/<project>/chats/session-*.jsonl`.
 * Transcripts contain message records but no token counts, so we record
 * one request-kind event per user message (a good proxy for API calls).
 */
export function createGeminiParser(filePath: string, prior: GeminiParserState | null): JsonlParser {
  const state: GeminiParserState = prior ?? {}
  const events: UpsertEvent[] = []

  // `.../tmp/<project-slug>/chats/session-xxx.jsonl`
  const segments = filePath.replaceAll('\\', '/').split('/')
  const chatsIdx = segments.lastIndexOf('chats')
  const project =
    chatsIdx >= 1 ? segments[chatsIdx - 1] : segments.length > 1 ? segments[segments.length - 2] : 'unknown'

  return {
    line(s: string): void {
      const obj = parseJson(s)
      if (!obj) return

      if (typeof obj.sessionId === 'string' && obj.sessionId) state.sessionId = obj.sessionId
      if (typeof obj.model === 'string' && obj.model) state.lastModel = obj.model

      if (obj.type !== 'user') return
      const ts = safeDate(obj.timestamp)
      if (ts === null) return

      const id = typeof obj.id === 'string' && obj.id ? obj.id : hashLine(s)
      const sessionId = state.sessionId ?? path.basename(filePath, '.jsonl')

      events.push({
        id: `gemini:${sessionId}:${id}`,
        provider: 'gemini',
        ts,
        session_id: sessionId,
        project,
        model: state.lastModel ?? null,
        kind: 'request',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: null,
        source_file: filePath,
        meta: null
      })
    },
    state: () => state,
    events: () => events,
    tools: () => [],
    snapshots: () => []
  }
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  watchRoots(settings) {
    return [{ path: geminiRoot(settings), recursive: true }]
  },
  status(settings) {
    const root = geminiRoot(settings)
    const files = walkFiles(root, (p) => p.includes(`${path.sep}chats${path.sep}`) && p.endsWith('.jsonl'))
    return {
      status: files.length > 0 ? 'ok' : 'no-data',
      path: root,
      note:
        files.length > 0
          ? undefined
          : 'No Gemini CLI chat transcripts found. Note: Gemini does not record token counts locally, so requests are counted instead.'
    }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    const root = geminiRoot(settings)
    for (const file of walkFiles(root, (p) => p.includes(`${path.sep}chats${path.sep}`) && p.endsWith('.jsonl'))) {
      try {
        const r = scanJsonlFile(db, 'gemini', file, (prior) =>
          createGeminiParser(file, prior as GeminiParserState | null)
        )
        if (!r.skipped) outcome.filesScanned++
        outcome.eventsAdded += r.added
      } catch (err) {
        outcome.errors.push(`gemini: ${path.basename(file)}: ${(err as Error).message}`)
      }
    }
    return outcome
  }
}
