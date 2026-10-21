import fs from 'node:fs'
import path from 'node:path'
import {
  DB,
  UpsertEvent,
  UpsertTool,
  deleteFileData,
  getFileIndex,
  saveFileIndex,
  upsertEvents,
  upsertSnapshots,
  upsertTools
} from '../db'
import type { ProviderId } from '../../shared/types'

export interface SnapshotInput {
  key: string
  provider: string
  ts: number
  data: unknown
}

export interface JsonlParser {
  line(s: string): void
  /** JSON-serializable parser state carried across incremental scans of the same file */
  state(): unknown
  events(): UpsertEvent[]
  tools(): UpsertTool[]
  snapshots(): SnapshotInput[]
}

export interface ScanFileResult {
  skipped: boolean
  added: number
  reindexed: boolean
}

/** Keep reindex memory bounded to a chunk plus the current JSON record. */
function* completeBatches(filePath: string, offset: number, size: number): Generator<{ lines: string[]; bytes: number }> {
  const fd = fs.openSync(filePath, 'r'), chunk = Buffer.alloc(512 * 1024)
  let position = offset, pending = Buffer.alloc(0)
  try {
    while (position < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position)
      if (!read) break
      position += read
      pending = Buffer.concat([pending, chunk.subarray(0, read)])
      const end = pending.lastIndexOf(0x0a) + 1
      if (end) {
        const complete = pending.subarray(0, end)
        yield { lines: complete.toString('utf8').split('\n').slice(0, -1), bytes: end }
        pending = Buffer.from(pending.subarray(end))
      }
    }
  } finally { fs.closeSync(fd) }
}

/** Read from `offset` and return only fully-terminated lines plus their byte length. */
export function readCompleteLines(filePath: string, offset: number): { lines: string[]; bytes: number } {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    const len = size - offset
    if (len <= 0) return { lines: [], bytes: 0 }
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, offset)
    let end = len
    while (end > 0 && buf[end - 1] !== 0x0a) end--
    if (end === 0) return { lines: [], bytes: 0 } // no complete line yet
    const text = buf.subarray(0, end).toString('utf8')
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return { lines, bytes: end }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Incrementally ingest one JSONL transcript file into the app DB.
 * - New files are parsed from byte 0.
 * - Appended files are parsed from the last stored byte offset.
 * - Files that shrank or changed unexpectedly are fully re-parsed (previous rows deleted first).
 */
export function scanJsonlFile(
  db: DB,
  provider: ProviderId,
  rawFilePath: string,
  createParser: (state: unknown) => JsonlParser,
  parserVersion = 1
): ScanFileResult {
  const filePath = rawFilePath.replaceAll('\\', '/')
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { skipped: true, added: 0, reindexed: false }
  }
  if (!stat.isFile()) return { skipped: true, added: 0, reindexed: false }

  const row = getFileIndex(db, filePath)
  let offset = 0
  let priorState: unknown = null
  let reindexed = false
  let prevCount = 0

  const savedState = row?.parser_state ? JSON.parse(row.parser_state) : null
  const versionChanged = row && (savedState?.__parserVersion ?? 1) !== parserVersion
  if (versionChanged) { deleteFileData(db, filePath); reindexed = true }
  if (row && !versionChanged) {
    if (row.size === stat.size && row.mtime === Math.trunc(stat.mtimeMs)) {
      return { skipped: true, added: 0, reindexed: false }
    }
    if (stat.size >= row.size && stat.size > row.byte_offset) {
      offset = row.byte_offset
      priorState = savedState
      prevCount = row.event_count
    } else {
      deleteFileData(db, filePath)
      reindexed = true
    }
  }

  let bytes = 0
  const parser = createParser(priorState)
  for (const batch of completeBatches(filePath, offset, stat.size)) {
    bytes += batch.bytes
    for (const l of batch.lines) if (l.trim().length > 0) parser.line(l)
  }

  // source_file is always the normalized path so re-index deletes match
  const events = parser.events().map((e) => ({ ...e, source_file: filePath }))
  const tools = parser.tools().map((t) => ({ ...t, source_file: filePath }))
  const snapshots = parser.snapshots()
  upsertEvents(db, events)
  upsertTools(db, tools)
  upsertSnapshots(db, snapshots)

  const state = parser.state()
  saveFileIndex(db, {
    path: filePath,
    provider,
    size: stat.size,
    mtime: Math.trunc(stat.mtimeMs),
    byte_offset: offset + bytes,
    event_count: prevCount + events.length,
    parser_state: JSON.stringify({ ...(state && typeof state === 'object' ? state : {}), __parserVersion: parserVersion }),
    added: events.length
  })

  return { skipped: false, added: events.length, reindexed }
}

/** FNV-1a for stable ids when a source line has none. */
export function hashLine(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function safeDate(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

export function decodeClaudeDirName(dir: string): string {
  const base = path.basename(dir)
  // Claude encodes `C:\Users\example` as `C--Users-example`
  return base.replace(/--/g, ':').replace(/-/g, path.sep).replace(/_/g, ' ')
}
