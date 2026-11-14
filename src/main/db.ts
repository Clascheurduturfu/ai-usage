import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { userDataPath } from './paths'

export type DB = DatabaseSync
type Params = Record<string, import('node:sqlite').SQLInputValue>

// Built-in SQLite needs no native module, so the bundled runtime and the build
// machine's Node can differ. Node 24 flags it experimental on first load; that
// notice is not actionable for users, so it alone is filtered.
const { DatabaseSync: Database } = ((): typeof import('node:sqlite') => {
  const emit = process.emitWarning
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    if (String(typeof warning === 'string' ? warning : warning?.message).startsWith('SQLite is an experimental')) return
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try { return createRequire(import.meta.url)('node:sqlite') } finally { process.emitWarning = emit }
})()

/** Runs fn in one transaction (joins one that is already open). */
export function transaction<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN')
  try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  ts INTEGER NOT NULL,
  session_id TEXT,
  project TEXT,
  model TEXT,
  kind TEXT NOT NULL DEFAULT 'tokens',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  source_file TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON usage_events (ts);
CREATE INDEX IF NOT EXISTS idx_events_provider_ts ON usage_events (provider, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON usage_events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_file ON usage_events (source_file);

CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_ts ON tool_events (ts);
CREATE INDEX IF NOT EXISTS idx_tool_provider ON tool_events (provider);

CREATE TABLE IF NOT EXISTS file_index (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  parser_state TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  // Callers pass whole row objects; extra fields are ignored, as before.
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => { const statement = prepare(sql); statement.setAllowUnknownNamedParameters(true); return statement }) as DB['prepare']
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  return db
}

/** Open a foreign tool database read-only (WAL-safe: coexists with a live writer). */
export function openExternalDb(file: string): DB {
  let db: DB | undefined
  try {
    db = new Database(file, { readOnly: true })
    db.prepare('PRAGMA schema_version').get()
    return db
  } catch (error) {
    db?.close()
    // Some native Mac stores remain in WAL mode after removing their sidecars.
    // Don't create sidecars in another app's directory or ignore a live WAL.
    const walSize = (): number => { try { return fs.statSync(file + '-wal').size } catch { return 0 } }
    const before = fs.statSync(file)
    if ((error as { errcode?: number }).errcode !== 14 /* SQLITE_CANTOPEN */ || walSize() > 0 || before.size > 64 * 1024 * 1024) throw error
    const root = path.join(userDataPath(), 'external-db-snapshots')
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const directory = fs.mkdtempSync(path.join(root, 'read-')), snapshot = path.join(directory, 'source.sqlite')
    try {
      fs.copyFileSync(file, snapshot); fs.chmodSync(snapshot, 0o600)
      const after = fs.statSync(file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || walSize() > 0) throw new Error('Source database changed during collection; scan again')
      const copy = new Database(snapshot)
      try { copy.exec('PRAGMA query_only = ON'); copy.prepare('PRAGMA schema_version').get() }
      catch (error) { copy.close(); throw error }
      const close = copy.close.bind(copy)
      copy.close = () => { try { return close() } finally { fs.rmSync(directory, { recursive: true, force: true }) } }
      return copy
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error }
  }
}

export interface UpsertEvent {
  id: string
  provider: string
  ts: number
  session_id: string | null
  project: string | null
  model: string | null
  kind: 'tokens' | 'request'
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  cost_usd: number | null
  source_file: string | null
  meta: string | null
}

export interface UpsertTool {
  id: string
  provider: string
  ts: number
  name: string
  session_id: string | null
  project: string | null
  source_file: string | null
}

export function upsertEvents(db: DB, events: UpsertEvent[]): void {
  if (events.length === 0) return
  const stmt = db.prepare(`
    INSERT INTO usage_events (id, provider, ts, session_id, project, model, kind,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      cost_usd, source_file, meta)
    VALUES (@id, @provider, @ts, @session_id, @project, @model, @kind,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @reasoning_tokens,
      @cost_usd, @source_file, @meta)
    ON CONFLICT(id) DO UPDATE SET
      ts=excluded.ts, session_id=excluded.session_id, project=excluded.project,
      model=excluded.model, kind=excluded.kind,
      input_tokens=CASE WHEN excluded.provider='claude' THEN MAX(usage_events.input_tokens,excluded.input_tokens) ELSE excluded.input_tokens END,
      output_tokens=CASE WHEN excluded.provider='claude' THEN MAX(usage_events.output_tokens,excluded.output_tokens) ELSE excluded.output_tokens END,
      cache_read_tokens=CASE WHEN excluded.provider='claude' THEN MAX(usage_events.cache_read_tokens,excluded.cache_read_tokens) ELSE excluded.cache_read_tokens END,
      cache_write_tokens=CASE WHEN excluded.provider='claude' THEN MAX(usage_events.cache_write_tokens,excluded.cache_write_tokens) ELSE excluded.cache_write_tokens END,
      reasoning_tokens=excluded.reasoning_tokens, cost_usd=excluded.cost_usd,
      meta=CASE WHEN excluded.provider='claude' AND
        excluded.input_tokens+excluded.output_tokens+excluded.cache_read_tokens+excluded.cache_write_tokens <
        usage_events.input_tokens+usage_events.output_tokens+usage_events.cache_read_tokens+usage_events.cache_write_tokens
        THEN usage_events.meta ELSE excluded.meta END, source_file=excluded.source_file
  `)
  transaction(db, () => {
    for (const row of events) stmt.run(row as unknown as Params)
  })
}

export function upsertTools(db: DB, tools: UpsertTool[]): void {
  if (tools.length === 0) return
  const stmt = db.prepare(`
    INSERT INTO tool_events (id, provider, ts, name, session_id, project, source_file)
    VALUES (@id, @provider, @ts, @name, @session_id, @project, @source_file)
    ON CONFLICT(id) DO UPDATE SET
      ts=excluded.ts, name=excluded.name, session_id=excluded.session_id,
      project=excluded.project, source_file=excluded.source_file
  `)
  transaction(db, () => {
    for (const row of tools) stmt.run(row as unknown as Params)
  })
}

export function upsertSnapshots(db: DB, rows: { key: string; provider: string; ts: number; data: unknown }[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT INTO snapshots (key, provider, ts, data) VALUES (@key, @provider, @ts, @data)
    ON CONFLICT(key) DO UPDATE SET ts=excluded.ts, data=excluded.data
  `)
  transaction(db, () => {
    for (const row of rows) stmt.run({ ...row, data: JSON.stringify(row.data) })
  })
}

export function deleteFileData(db: DB, sourceFile: string): void {
  db.prepare('DELETE FROM usage_events WHERE source_file = ?').run(sourceFile)
  db.prepare('DELETE FROM tool_events WHERE source_file = ?').run(sourceFile)
}

export interface FileIndexRow {
  path: string
  provider: string
  size: number
  mtime: number
  byte_offset: number
  event_count: number
  parser_state: string | null
}

export function getFileIndex(db: DB, p: string): FileIndexRow | undefined {
  return db
    .prepare(
      'SELECT path, provider, size, mtime, byte_offset, event_count, parser_state FROM file_index WHERE path = ?'
    )
    .get(p) as FileIndexRow | undefined
}

export function saveFileIndex(
  db: DB,
  row: { path: string; provider: string; size: number; mtime: number; byte_offset: number; event_count: number; parser_state: string | null; added: number }
): void {
  db.prepare(
    `INSERT INTO file_index (path, provider, size, mtime, byte_offset, event_count, parser_state, updated_at)
     VALUES (@path, @provider, @size, @mtime, @byte_offset, @event_count, @parser_state, @updated_at)
     ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
       byte_offset=excluded.byte_offset, parser_state=excluded.parser_state,
       event_count=excluded.event_count, updated_at=excluded.updated_at`
  ).run({ ...row, updated_at: Date.now() })
}

export function kvGet<T>(db: DB, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return undefined
  try {
    return JSON.parse(row.value) as T
  } catch {
    return undefined
  }
}

export function kvSet(db: DB, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, JSON.stringify(value))
}

/** Purge everything derived from scanning (used by "full re-index" in settings). */
export function purgeScanData(db: DB): void {
  db.exec('DELETE FROM usage_events; DELETE FROM tool_events; DELETE FROM file_index;')
  // incremental-scan watermarks must reset too, or the next scan would skip everything
  db.prepare(`DELETE FROM snapshots WHERE key LIKE 'zcode:watermark:%'`).run()
}
