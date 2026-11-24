import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SURFACE_LABELS, type SurfaceKind, type SurfaceState } from '../shared/harnesses'

/**
 * Where each harness's CLI, desktop app and editor extension live on Windows and macOS.
 * `~` is the home folder, `%LOCALAPPDATA%` / `%APPDATA%` the Windows folders; a last path
 * segment ending in `*` matches by prefix (MSIX package folders). `bin` is also looked up on PATH.
 */
type Probe = { kind: SurfaceKind; label?: string; bin?: string; win?: string[]; mac?: string[]; any?: string[] }
const app = (...names: string[]): string[] => names.flatMap(name => [`/Applications/${name}.app`, `~/Applications/${name}.app`])
const MAC_SUPPORT = '~/Library/Application Support'

export const SURFACE_PROBES: Record<string, Probe[]> = {
  claude: [
    { kind: 'cli', bin: 'claude', any: ['~/.claude/local/claude'] },
    { kind: 'desktop', label: 'Claude Desktop · Code', win: ['%LOCALAPPDATA%/AnthropicClaude', '%LOCALAPPDATA%/Packages/Claude_*'], mac: app('Claude') }
  ],
  'claude-desktop': [{ kind: 'desktop', label: 'Claude Desktop · Chat and Cowork', win: ['%LOCALAPPDATA%/AnthropicClaude', '%LOCALAPPDATA%/Packages/Claude_*'], mac: app('Claude') }],
  codex: [
    { kind: 'cli', bin: 'codex' },
    { kind: 'desktop', win: ['%LOCALAPPDATA%/Packages/OpenAI.Codex_*', '%LOCALAPPDATA%/Programs/OpenAI/Codex'], mac: app('Codex') }
  ],
  gemini: [{ kind: 'cli', bin: 'gemini' }],
  antigravity: [
    { kind: 'desktop', win: ['%LOCALAPPDATA%/Programs/Antigravity'], mac: app('Antigravity', 'Antigravity IDE') },
    { kind: 'cli', bin: 'agy', win: ['%LOCALAPPDATA%/agy/bin/agy.exe'], mac: ['~/.gemini/antigravity-cli'] }
  ],
  opencode: [
    { kind: 'cli', bin: 'opencode', any: ['~/.opencode/bin'] },
    { kind: 'desktop', win: ['%LOCALAPPDATA%/Programs/ai.opencode.desktop'], mac: app('OpenCode') }
  ],
  zcode: [
    { kind: 'desktop', win: ['%LOCALAPPDATA%/Programs/ZCode'], mac: app('ZCode') },
    { kind: 'cli', any: ['~/.zcode/cli'] }
  ],
  copilot: [
    { kind: 'editor', label: 'VS Code · Copilot Chat', win: ['%APPDATA%/Code/User/globalStorage/github.copilot-chat'], mac: [`${MAC_SUPPORT}/Code/User/globalStorage/github.copilot-chat`] },
    // VS Code ships a `copilot` shim on PATH, so the CLI counts only once it has its own folder.
    { kind: 'cli', any: ['~/.copilot'] }
  ],
  cline: [
    { kind: 'editor', label: 'VS Code extension', win: ['%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev'], mac: [`${MAC_SUPPORT}/Code/User/globalStorage/saoudrizwan.claude-dev`] },
    { kind: 'cli', bin: 'cline' }
  ],
  cursor: [
    { kind: 'editor', label: 'Cursor editor', win: ['%LOCALAPPDATA%/Programs/cursor', '%APPDATA%/Cursor'], mac: [...app('Cursor'), `${MAC_SUPPORT}/Cursor`] },
    { kind: 'cli', bin: 'cursor-agent', any: ['~/.local/bin/cursor-agent', '~/.local/bin/agent'] }
  ],
  mistral: [
    { kind: 'cli', bin: 'vibe' },
    { kind: 'desktop', win: ['%LOCALAPPDATA%/Programs/le-chat-desktop/Vibe.exe'], mac: app('Vibe') }
  ],
  kimi: [
    { kind: 'cli', bin: 'kimi', any: ['~/.kimi-code/bin'] },
    { kind: 'desktop', win: ['%LOCALAPPDATA%/Programs/kimi-code-app', '%LOCALAPPDATA%/Programs/KimiCode'], mac: app('Kimi Code', 'KimiCode') },
    { kind: 'editor', label: 'VS Code extension', any: ['~/.vscode/extensions/moonshot-ai.kimi-code-*'] }
  ],
  deepseek: [
    { kind: 'cli', bin: 'dsh' },
    // The desktop app keeps its window settings in Electron's folder (sessions stay in ~/.dsh).
    { kind: 'desktop', win: ['%APPDATA%/@deepseek-ai/dsh-desktop'], mac: [...app('DeepSeek Harness', 'DeepSeek'), `${MAC_SUPPORT}/@deepseek-ai/dsh-desktop`] }
  ],
  pi: [{ kind: 'cli', bin: 'pi', any: ['~/.pi/agent'] }]
}

function expand(pattern: string, home: string): string {
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  return pattern.replace(/^~(?=\/|$)/, home).replace('%LOCALAPPDATA%', local).replace('%APPDATA%', roaming)
}
function exists(pattern: string, home: string): boolean {
  const file = expand(pattern, home)
  if (!file.endsWith('*')) return fs.existsSync(file)
  const dir = path.dirname(file), prefix = path.basename(file).slice(0, -1)
  try { return fs.readdirSync(dir).some(name => name.startsWith(prefix)) } catch { return false }
}
/** PATH plus the folders installers use, which a GUI app launched from the Dock or Start menu may not have on PATH. */
function binDirs(home: string): string[] {
  const extra = process.platform === 'win32'
    ? [expand('%APPDATA%/npm', home), path.join(home, 'scoop', 'shims'), path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.cargo', 'bin')]
    : [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.cargo', 'bin')]
  return [...new Set([...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extra])]
}
function onPath(bin: string, home: string): boolean {
  const names = process.platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin]
  return binDirs(home).some(dir => names.some(name => { try { return fs.statSync(path.join(dir, name)).isFile() } catch { return false } }))
}

let cache: { at: number; home: string; value: Map<string, SurfaceState[]> } | null = null
/** What this device has of a harness. Cheap file checks, cached for a minute. */
export function detectSurfaces(key: string, home = os.homedir()): SurfaceState[] {
  if (!cache || cache.home !== home || Date.now() - cache.at > 60_000) cache = { at: Date.now(), home, value: new Map() }
  const known = cache.value.get(key)
  if (known) return known
  const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : null
  const states = (SURFACE_PROBES[key] ?? []).map(probe => {
    const files = [...(probe.any ?? []), ...(platform ? probe[platform] ?? [] : [])]
    return { kind: probe.kind, label: probe.label ?? SURFACE_LABELS[probe.kind], detected: files.some(file => exists(file, home)) || (!!probe.bin && onPath(probe.bin, home)) }
  })
  cache.value.set(key, states)
  return states
}
/** Test hook. */
export function resetSurfaceCache(): void { cache = null }
