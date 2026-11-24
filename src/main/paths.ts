import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderId, Settings } from '../shared/types'

/**
 * Default on-disk data locations for each supported AI coding tool (Windows).
 * All can be overridden in Settings.
 */
export function defaultRoots(): Record<ProviderId, string> {
  const home = os.homedir()
  const appData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  return {
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex'),
    gemini: path.join(home, '.gemini', 'tmp'),
    opencode: path.join(home, '.local', 'share', 'opencode'),
    zcode: path.join(home, '.zcode', 'cli'),
    antigravity: path.join(home, '.gemini', 'antigravity'),
    copilot: path.join(appData, 'Code', 'User', 'globalStorage', 'github.copilot-chat'),
    mistral: path.join(home, '.vibe'),
    cursor: path.join(appData, 'Cursor'),
    kimi: process.env.KIMI_CODE_HOME?.trim() || path.join(home, '.kimi-code'),
    deepseek: process.env.DSH_HOME?.trim() || path.join(home, '.dsh'),
    pi: process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || path.join(process.env.PI_CODING_AGENT_DIR?.trim() || path.join(home, '.pi', 'agent'), 'sessions')
  }
}

export function rootFor(id: ProviderId, settings: Pick<Settings, 'paths'>): string {
  return settings.paths[id]?.trim() || defaultRoots()[id]
}

export function appDbPath(): string {
  return path.join(userDataPath(), 'usage.db')
}

export function userDataPath(): string {
  if (process.env.AIU_PROFILE) return path.resolve(process.env.AIU_PROFILE)
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(base, process.platform === 'darwin' ? 'AI Usage' : 'AI Usage for Windows')
}

export function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Recursively list files matching a predicate under a root. */
export function walkFiles(root: string, matches: (p: string) => boolean, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      walkFiles(full, matches, out)
    } else if (e.isFile() && matches(full)) {
      out.push(full)
    }
  }
  return out
}
