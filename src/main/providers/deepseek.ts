import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type { Settings } from '../../shared/types'
import { existsDir } from '../paths'
import { deleteFileData, getFileIndex, saveFileIndex, upsertEvents, type DB, type UpsertEvent } from '../db'
import { n, parseJson } from './jsonl'
import { ProviderAdapter, ScanOutcome } from './types'

/** DeepSeek Harness's home, shared by the `dsh` CLI and the desktop app: `DSH_HOME`, else `~/.dsh`. */
export function dshHome(settings?: Pick<Settings, 'paths'>): string {
  return settings?.paths.deepseek?.trim() || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/**
 * Session logs are JSONL compressed as independent zstd frames (one for the header, one per append).
 * A crash can leave the last frame cut short: decode frame by frame and keep what is complete.
 */
export function decodeZstdFrames(data: Buffer): string {
  const decompress = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
  if (!decompress) throw new Error('this runtime cannot read zstd session logs')
  try { return decompress(data).toString('utf8') } catch { /* a cut-off tail: split it into frames */ }
  const starts: number[] = []
  for (let i = data.indexOf(ZSTD_MAGIC); i >= 0; i = data.indexOf(ZSTD_MAGIC, i + 4)) starts.push(i)
  let text = '', i = 0
  while (i < starts.length) {
    // A magic number can also occur inside compressed data: grow the frame until it decodes.
    let next = -1
    for (let j = i + 1; j <= starts.length && next < 0; j++) {
      try { text += decompress(data.subarray(starts[i], j < starts.length ? starts[j] : data.length)).toString('utf8'); next = j }
      catch { /* not a frame boundary yet */ }
    }
    if (next < 0) break // the cut-off last frame
    i = next
  }
  return text
}

/** The newest log generation of a session folder: `session.v4.jsonl.zstd` beats v3, v2 and the unversioned file. */
export function latestSessionLog(dir: string): string | null {
  let best: { file: string; version: number } | null = null
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const name of names) {
    const m = name.match(/^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/)
    if (!m) continue
    const version = m[1] ? Number(m[1]) : 0
    if (!best || version > best.version || (version === best.version && name.endsWith('.zstd'))) best = { file: path.join(dir, name), version }
  }
  return best?.file ?? null
}

type DshUsage = { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown; reasoningTokens?: unknown }

/**
 * DeepSeek Harness (deepseek-ai/deepseek-harness) logs each model call as an `assistant/message`
 * event with disjoint counts (uncached input, output, cache reads, cache writes) and the
 * message's provider and model; `compaction/summary` events carry the summarising call's usage.
 * A forked or seeded session first copies its parent's events, ending with a `session/end-seed`
 * marker (`data.inherited`): those are the parent's spend and are skipped. Assistant messages are
 * also keyed by their message id, which a copy keeps. No cost is logged.
 */
export function parseDshSession(text: string, file: string): UpsertEvent[] {
  const lines = text.split('\n').map(line => parseJson(line)).filter((v): v is Record<string, any> => !!v)
  const header = lines.find(l => l.type === 'session')
  const sessionId = typeof header?.id === 'string' ? header.id : path.basename(path.dirname(file))
  const cwd = typeof header?.cwd === 'string' ? header.cwd : null
  let start = 0
  lines.forEach((l, i) => { if (l.type === 'session/end-seed' && l.data?.inherited === true) start = i + 1 })
  const events: UpsertEvent[] = []
  let model: string | null = null, provider: string | null = null
  for (const l of lines.slice(start)) {
    const data = l.data ?? {}
    if (l.type === 'request/header') { model = data.header?.config?.model ?? model; provider = data.header?.config?.provider ?? provider }
    const usage: DshUsage | undefined = l.type === 'assistant/message' || l.type === 'compaction/summary' ? data.usage : undefined
    if (!usage || typeof usage !== 'object') continue
    const input = n(usage.inputTokens), output = n(usage.outputTokens), cacheRead = n(usage.cacheReadTokens), cacheWrite = n(usage.cacheWriteTokens)
    if (input + output + cacheRead + cacheWrite <= 0) continue
    const source = data.message?.source ?? {}
    const callModel = typeof source.model === 'string' ? source.model : typeof data.model === 'string' ? data.model : model
    const callProvider = typeof source.provider === 'string' ? source.provider : typeof data.provider === 'string' ? data.provider : provider
    const ts = n(l.time)
    if (ts <= 0) continue
    events.push({
      id: l.type === 'assistant/message' && typeof data.message?.id === 'string' ? `deepseek:${data.message.id}` : `deepseek:${sessionId}:${String(l.seq ?? ts)}`,
      provider: 'deepseek', ts, session_id: sessionId, project: cwd, model: callModel ?? null, kind: 'tokens',
      input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite,
      reasoning_tokens: Math.min(output, n(usage.reasoningTokens)), cost_usd: null, source_file: file.replaceAll('\\', '/'),
      meta: JSON.stringify({ upstream: callProvider ?? null, entry: l.type })
    })
  }
  return events
}

function sessionDirs(root: string): string[] {
  // <home>/sessions/--<cwd-slug>--/<session-id>/
  const out: string[] = []
  for (const group of (() => { try { return fs.readdirSync(root, { withFileTypes: true }) } catch { return [] } })()) {
    if (!group.isDirectory()) continue
    for (const session of (() => { try { return fs.readdirSync(path.join(root, group.name), { withFileTypes: true }) } catch { return [] } })()) if (session.isDirectory()) out.push(path.join(root, group.name, session.name))
  }
  return out
}

export const deepseekAdapter: ProviderAdapter = {
  id: 'deepseek',
  watchRoots(settings) { return [{ path: path.join(dshHome(settings), 'sessions'), recursive: true }] },
  status(settings) {
    const dir = path.join(dshHome(settings), 'sessions')
    return { status: existsDir(dir) ? 'ok' : 'no-data', path: dir, note: existsDir(dir) ? undefined : 'No DeepSeek Harness sessions yet. Install it (deepseek.com/harness) or its desktop app, run it once, and this page will light up.' }
  },
  scan(settings, db: DB): ScanOutcome {
    const outcome: ScanOutcome = { filesScanned: 0, eventsAdded: 0, errors: [] }
    for (const dir of sessionDirs(path.join(dshHome(settings), 'sessions'))) {
      const log = latestSessionLog(dir)
      if (!log) continue
      try {
        // Compressed frames cannot be tailed by byte offset: re-read a log whenever it changes.
        const stat = fs.statSync(log), key = log.replaceAll('\\', '/'), row = getFileIndex(db, key)
        if (row && row.size === stat.size && row.mtime === Math.trunc(stat.mtimeMs)) continue
        const raw = fs.readFileSync(log)
        const events = parseDshSession(log.endsWith('.zstd') ? decodeZstdFrames(raw) : raw.toString('utf8'), log)
        deleteFileData(db, key)
        upsertEvents(db, events)
        saveFileIndex(db, { path: key, provider: 'deepseek', size: stat.size, mtime: Math.trunc(stat.mtimeMs), byte_offset: stat.size, event_count: events.length, parser_state: null, added: events.length })
        outcome.filesScanned++; outcome.eventsAdded += Math.max(0, events.length - (row?.event_count ?? 0))
      } catch (err) { outcome.errors.push(`deepseek: ${path.basename(dir)}: ${(err as Error).message}`) }
    }
    return outcome
  }
}
