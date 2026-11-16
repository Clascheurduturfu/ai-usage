import type { AiuApi } from '../../../shared/api'
import type { ManagerSnapshot, SyncChange, SyncPreview } from '../../../shared/manager'

// Fictional shared-library state covering each MCP status the card can show.
const now = Date.now()
export function demoManager(): ManagerSnapshot {
  return {
    runtime: {
      paused: ['computer-use'],
      workers: [{ id: 'w1', name: 'blender', kind: 'isolated', pid: 4120, memoryBytes: 96 * 1048576, processes: 2 }],
      sessions: [{ name: 'blender', clientPid: 3001, workerId: 'w1', lastActivity: now - 40_000, pending: 0, active: 1 }, { name: 'sample-files', clientPid: 3001, lastActivity: now - 600_000, pending: 0, active: 0 }]
    },
    config: {
      schema: 2, revision: 'demo', autoSync: true, endpoints: [], proxies: [], profiles: [], activeProfiles: {},
      disabledMcp: ['cloud-cli'], compactMcp: ['sample-files'], disabledSkills: ['legacy-notes'],
      skillFolders: [
        { id: 'folder-workflow', name: 'Engineering', skills: ['code-review', 'release-notes'] }
      ],
      contextBudget: 30_000,
      mcpAuth: { 'cloud-tools': { enabled: true, secretRef: 'mcp-cloud-tools-auth' }, 'cloud-logs': { enabled: true, secretRef: 'mcp-cloud-logs-auth' }, 'cloud-docs': { enabled: true, secretRef: 'mcp-cloud-docs-auth' }, 'cloud-builds': { enabled: true, secretRef: 'mcp-cloud-builds-auth' } }
    },
    agents: [
      { id: 'claude', name: 'Claude Code', installed: true, configPath: '~/.claude.json', skillControl: 'native', endpointSupport: true, restartRequired: true },
      { id: 'codex', name: 'Codex', installed: true, configPath: '~/.codex/config.toml', skillControl: 'native', endpointSupport: true, restartRequired: true },
      { id: 'zcode', name: 'ZCode', installed: true, configPath: '~/.zcode/cli/config.json', skillControl: 'shared', endpointSupport: false, restartRequired: true },
      { id: 'antigravity', name: 'Antigravity', installed: true, configPath: '~/.gemini/config/mcp_config.json', skillControl: 'native', endpointSupport: false, restartRequired: true },
      { id: 'cursor', name: 'Cursor', installed: false, configPath: '~/.cursor/mcp.json', skillControl: 'shared', endpointSupport: false, restartRequired: true }
    ],
    skills: [
      { name: 'code-review', description: 'Review a diff for correctness, security and style issues before merging.', path: 'skills/code-review/SKILL.md', valid: true },
      { name: 'release-notes', description: 'Draft release notes from merged pull requests and conventional commits.', path: 'skills/release-notes/SKILL.md', valid: true },
      { name: 'sql-helper', description: 'Explain, optimize and safely migrate SQL queries and schemas.', path: 'skills/sql-helper/SKILL.md', valid: true },
      { name: 'ui-audit', description: 'Audit a page for accessibility, contrast and layout regressions.', path: 'skills/ui-audit/SKILL.md', valid: true },
      { name: 'legacy-notes', description: 'Old note-taking workflow kept for reference.', path: 'skills/legacy-notes/SKILL.md', valid: true },
      { name: 'broken-skill', description: '', path: 'skills/broken-skill/SKILL.md', valid: false, issue: 'Missing name or description' }
    ],
    proxies: [], logs: [], instructions: 'Shared instructions for every agent. '.repeat(260),
    mcpMetrics: {
      'sample-files': { tools: 168, schemaBytes: 431_000, measuredAt: now - 3_600_000, calls: 42, errors: 3, lastCall: now - 7_200_000, byTool: { inspect_artifact: 14, decompile_function: 11, list_strings: 9, search_symbols: 5, read_bytes: 3 } },
      blender: { tools: 24, schemaBytes: 38_000, measuredAt: now - 86_400_000, calls: 7, errors: 0, lastCall: now - 40_000, byTool: { get_scene: 4, run_script: 3 } },
      'cloud-logs': { tools: 8, schemaBytes: 22_800, measuredAt: now - 600_000, calls: 3, errors: 0, byTool: { query_logs: 3 } },
      'cloud-docs': { tools: 2, schemaBytes: 1_000, measuredAt: now - 90_000, calls: 0, errors: 0, byTool: {} },
      'cloud-tools': { tools: 4, schemaBytes: 7_600, measuredAt: now - 86_400_000, calls: 12, errors: 1, byTool: { search: 8, execute: 4 } },
      browser: { tools: 31, schemaBytes: 52_000, measuredAt: now - 3 * 86_400_000, calls: 2, errors: 0, lastCall: now - 41 * 86_400_000, trackedSince: now - 60 * 86_400_000, byTool: { open_page: 2 } }
    },
    mcp: [
      { name: 'cloud-tools', transport: 'http', url: 'https://tools.example.com/mcp' },
      { name: 'cloud-logs', transport: 'http', url: 'https://logs.example.com/mcp' },
      { name: 'cloud-builds', transport: 'http', url: 'https://builds.example.com/mcp' },
      { name: 'cloud-docs', transport: 'http', url: 'https://docs.example.com/mcp' },
      { name: 'partner-api', transport: 'http', url: 'https://partner.example.com/mcp' },
      { name: 'blender', transport: 'stdio', command: 'uv', args: ['run', 'blender-mcp'], aiUsage: { source: { kind: 'blender', version: '1.0.3' } } },
      { name: 'sample-files', transport: 'stdio', command: 'node', args: ['server.mjs'], aiUsage: { source: { kind: 'npm', package: 'sample-files-mcp', version: '2.1.0' } } },
      { name: 'browser', transport: 'stdio', command: 'npx', args: ['browser-mcp'], aiUsage: { source: { kind: 'npm', package: 'browser-mcp', version: '0.0.83' } } },
      { name: 'computer-use', transport: 'stdio', command: 'npx', args: ['computer-use-mcp'], aiUsage: { source: { kind: 'npm', package: 'computer-use-mcp', version: '1.8.0' } } },
      { name: 'cloud-cli', transport: 'stdio', command: 'uvx', args: ['cloud-cli-mcp'], aiUsage: { source: { kind: 'aws', version: '1.7.0' } } }
    ],
    secrets: ['mcp-cloud-tools-auth', 'mcp-cloud-logs-auth', 'mcp-cloud-builds-auth'],
    sharing: { folder: 'C:/Sample/Shared', enabled: true, unlocked: true, pending: 0 },
    lastSync: { changed: 0, conflicts: ['C:/Sample/AppData/Roaming/Claude/claude_desktop_config.json'], warnings: [] },
    auth: { 'cloud-tools': 'Token refresh failed: HTTP 400 (invalid_grant) · Reconnect required', 'cloud-logs': 'Saved sign-in', 'cloud-builds': 'Token refresh failed: HTTP 502 (server_error) · Sign-in kept, retry shortly', 'cloud-docs': 'Public server · no sign-in needed', 'partner-api': 'Sign-in required' },
    remoteMcp: { 'cloud-logs': { state: 'Connected', detail: '2 clients connected', clients: 2, workers: 0, canPrepare: false }, 'cloud-docs': { state: 'Connection verified', detail: '2 tools listed.', tools: 2, checkedAt: now - 90_000, canPrepare: false } },
    deviceMcp: {
      blender: { state: 'Running', detail: '1 client · 1 process running', clients: 1, workers: 1, canPrepare: false },
      'sample-files': { state: 'Connected', detail: '1 client connected', clients: 1, workers: 0, canPrepare: false },
      browser: { state: 'Needs setup', detail: 'Install the pinned browser-mcp 0.0.83 on this device.', canPrepare: true },
      'computer-use': { state: 'Ready to launch', detail: 'Starts when a coding client uses it.', canPrepare: true },
      'cloud-cli': { state: 'Needs sign-in', detail: 'Sign in with the provider CLI on this device.', canPrepare: false }
    }
  }
}
const syncPreview = (conflict: boolean): SyncPreview => ({ id: 'sample', createdAt: Date.now(), warnings: [], changes: ([
  { target: 'Claude Code', path: 'C:/Sample/.claude.json', action: 'update', kind: 'settings', planned: ['Adds MCP server “kanzo”', 'Updates MCP server “memory”: now launched through AI Usage'] },
  { target: 'Claude Code instructions', path: 'C:/Sample/.claude/CLAUDE.md', action: 'update', kind: 'instructions', planned: ['2 lines added, 1 removed', 'Added: Use Kanzo for project memory.', 'Removed: Old rule'] },
  { target: 'Claude Desktop', path: 'C:/Sample/AppData/Roaming/Claude/claude_desktop_config.json', conflict, action: 'update', kind: 'settings', details: conflict ? ['MCP server “browser”: command changed from "npx" to "node"; args changed (2 → 3 items)', 'MCP server “memory” was removed from the file'] : undefined, planned: ['Updates MCP server “browser”: no longer launched through AI Usage', 'Adds MCP server “memory”'] },
  ...['Claude Code', 'Antigravity'].flatMap(client => Array.from({ length: 160 }, (_, i) => ({ target: `${client} skills`, path: `C:/Sample/${client === 'Claude Code' ? '.claude' : '.gemini/config'}/skills/cloudflare/references/doc-${i}.md`, action: 'remove' as const, kind: 'skill' as const, skill: 'cloudflare' }))),
  ...Array.from({ length: 12 }, (_, i) => ({ target: 'Claude Code skills', path: `C:/Sample/.claude/skills/brag/assets/file-${i}.md`, action: (i < 10 ? 'add' : 'update') as 'add' | 'update', kind: 'skill' as const, skill: 'brag' }))
] as Array<Partial<SyncChange> & { target: string; path: string }>).map(c => ({ conflict: false, ...c, beforeHash: 'a', afterHash: 'b', changed: true, summary: '' })) })
export function demoManagerApi(): Partial<AiuApi> {
  const done = async (): Promise<void> => undefined
  // Toggles change this in-memory copy so the preview responds like the real app.
  const state = demoManager(), synced = { changed: 0, conflicts: [], warnings: [] }
  const toggle = (key: 'disabledMcp' | 'compactMcp' | 'disabledSkills', name: string, listed: boolean) => { const values = new Set(state.config[key] ?? []); if (listed) values.add(name); else values.delete(name); state.config[key] = [...values]; return Promise.resolve(synced) }
  return {
    getManager: async () => structuredClone(state), onManagerUpdated: () => () => undefined,
    setMcpEnabled: async (name: string, enabled: boolean) => toggle('disabledMcp', name, !enabled),
    setMcpCompact: async (name: string, enabled: boolean) => toggle('compactMcp', name, enabled),
    setSkillEnabled: async (name: string, enabled: boolean) => toggle('disabledSkills', name, !enabled),
    setSkillsEnabled: async (names: string[], enabled: boolean) => { const values = new Set(state.config.disabledSkills ?? []); for (const n of names) if (enabled) values.delete(n); else values.add(n); state.config.disabledSkills = [...values]; return synced },
    saveSkillFolders: async folders => { state.config.skillFolders = structuredClone(folders) },
    deleteSkill: async name => {
      state.skills = state.skills.filter(s => s.name !== name)
      state.config.disabledSkills = state.config.disabledSkills?.filter(n => n !== name)
      state.config.skillFolders = state.config.skillFolders?.map(f => ({ ...f, skills: f.skills.filter(n => n !== name) }))
    },
    setContextBudget: async (tokens: number) => { state.config.contextBudget = tokens },
    sharingSettings: async () => ({ folder: 'C:/Sample/Shared', passphrase: '' }), sharingFileExists: async () => true,
    checkMcp: async name => ({ state: 'Connection verified', detail: `${name}: 4 tools listed.`, tools: 4, checkedAt: Date.now(), canPrepare: false }),
    // Sample sync flow: one file edited outside the app, then adopted, then applied.
    previewSync: async () => syncPreview(!!state.lastSync?.conflicts.length),
    adoptSyncEdits: async () => { state.lastSync = { changed: 0, conflicts: [], warnings: [] }; return syncPreview(false) },
    applySync: async () => (state.lastSync = { changed: 4, conflicts: [], backupId: 'sample', warnings: [] }),
    restoreSync: async () => (state.lastSync = { changed: 0, conflicts: [], warnings: [] }),
    setAutoSync: async (enabled: boolean) => { state.config.autoSync = enabled },
    setSyncNotifications: async (enabled: boolean) => { state.config.syncNotifications = enabled },
    loginMcp: done, logoutMcp: done, stopMcp: done, resumeMcp: done, deleteMcp: done
  } as Partial<AiuApi>
}
