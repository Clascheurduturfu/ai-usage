export type EndpointProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'
export type CredentialKind = 'api-key' | 'cline' | 'antigravity'
export interface EndpointRecord {
  id: string; name: string; provider: string; protocol: EndpointProtocol; baseUrl: string
  secretRef?: string; credentialKind: CredentialKind; models: string[]; note?: string; catalogId?: string; draft?: boolean; responsesState?: boolean
}
export interface ProxyRoute {
  alias: string; endpointId: string; model: string; rpm?: number; tpm?: number
  family?: 'sonnet' | 'opus' | 'haiku'; maxInputTokens?: number
}
export interface ProxyRecord {
  id: string; name: string; port: number; autostart: boolean; clientSecretRef?: string; routes: ProxyRoute[]; authMode?: 'none' | 'key'; managedEndpointId?: string
}
export type AgentId = 'claude' | 'claude-desktop' | 'codex' | 'gemini' | 'antigravity' | 'cursor' | 'cline' | 'opencode' | 'zcode' | 'copilot'
export interface AgentProfile {
  id: string; name: string; agentId: AgentId; mcpNames: string[]; disabledSkills: string[]
  instructions: boolean; endpointId?: string; proxyId?: string; model?: string; claudeCompatibility?: boolean
}
export interface ManagerConfig {
  schema: 1 | 2; revision: string; autoSync: boolean; endpoints: EndpointRecord[]; proxies: ProxyRecord[]
  profiles: AgentProfile[]; activeProfiles: Partial<Record<AgentId, string>>
  syncNotifications?: boolean; mcpAuth?: Record<string, { enabled: boolean; secretRef: string }>
  workspaceAccounts?: Record<string, { secretRef: string; projectId?: string; email?: string }>
  workspaceOAuth?: { secretRef: string; projectId: string }
  /** Library entries kept but synced to no agent. */
  disabledMcp?: string[]; disabledSkills?: string[]
  /** UI-only folder groupings for skills (disk layout remains flat in ~/.agents/skills). */
  skillFolders?: SkillFolder[]
  /** MCPs whose relayed tool list is replaced by a search + call pair for eager clients. */
  compactMcp?: string[]
  /** Warn when an agent's estimated customization context exceeds this many tokens. */
  contextBudget?: number
}

export interface SkillFolder {
  id: string
  name: string
  skills: string[]
}
/** Agents that load MCP tool schemas on demand themselves; compact mode and eager cost do not apply. */
export const LAZY_TOOL_AGENTS: readonly AgentId[] = ['claude', 'antigravity']
export const COMPACT_SUFFIX = '@compact'
export interface McpMetrics {
  /** Tool count and serialized schema size from the last tools/list seen. */
  tools?: number; schemaBytes?: number; measuredAt?: number
  calls: number; errors: number; lastCall?: number; byTool: Record<string, number>
  /** When counting started; idle suggestions wait until a full window has been observed. */
  trackedSince?: number
}
export interface ProxyStatus { id: string; state: 'stopped' | 'running' | 'error'; port: number; requests: number; error?: string }
export interface AgentInfo { id: AgentId; name: string; installed: boolean; configPath: string; skillControl: 'native' | 'shared' | 'none'; endpointSupport: boolean; restartRequired: boolean; note?: string }
export interface AntigravityStatus { state: string; detail: string; skills: number; expected?: number; libraryCount?: number; servers: Array<{ name: string; state: string; tools: number; detail?: string }>; checkedAt: number }
export interface SkillInfo { name: string; description: string; path: string; valid: boolean; issue?: string }
export interface McpSource { kind: 'npm' | 'blender' | 'workspace' | 'workspace-gws' | 'aws'; version: string; package?: string; revision?: string; args?: string[] }
export interface McpRecord { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string>; aiUsage?: { source: McpSource } }
export interface McpDeviceStatus { state: string; detail: string; canPrepare: boolean; tools?: number; checkedAt?: number; clients?: number; workers?: number }
export interface McpSetupPreview { id: string; createdAt: number; platform: string; entries: Array<{ name: string; source: McpSource; action: string; note?: string }> }
export interface SyncChange { target: string; path: string; beforeHash: string; afterHash: string; changed: boolean; conflict: boolean; summary: string; warning?: string; /** For a conflict: what changed in the file since the last sync, in plain words. */ details?: string[] }
export interface SyncPreview { id: string; changes: SyncChange[]; warnings: string[]; createdAt: number }
export interface SyncResult { changed: number; conflicts: string[]; backupId?: string; warnings: string[] }
export interface MigrationPreview { providers: number; protectedKeys: number; gateways: number; routes: number; profiles: number; sources: string[]; alreadyImported: boolean }
export interface SharingStatus { folder: string; enabled: boolean; unlocked: boolean; revision?: string; pending: number; error?: string }
export interface WorkspaceStatus { oauthConfigured: boolean; projectId?: string; accounts: Array<{ account: string; email?: string; state: string; detail?: string }> }
export interface ManagerSnapshot {
  runtime?: { paused: string[]; workers: Array<{ id: string; name: string; kind: string; pid: number; memoryBytes: number; processes: number }>; sessions: Array<{ name: string; clientPid?: number; workerId?: string; lastActivity: number; pending: number; active: number }> }
  config: ManagerConfig; agents: AgentInfo[]; skills: SkillInfo[]; mcp: McpRecord[]; proxies: ProxyStatus[]
  sharing: SharingStatus; lastSync?: SyncResult; secrets: string[]; logs: string[]; instructions: string; antigravity?: AntigravityStatus
  auth?: Record<string, string>; appliedProfiles?: Record<string, string>; instructionSource?: string; deviceMcp?: Record<string, McpDeviceStatus>; remoteMcp?: Record<string, McpDeviceStatus>; workspace?: WorkspaceStatus
  install?: { sandboxed: boolean; path?: string }
  mcpMetrics?: Record<string, McpMetrics>
}
export interface InstallPreview { id: string; kind: 'skill' | 'mcp'; source: string; name: string; description: string; files: string[]; command?: string; args?: string[]; choices?: string[] }
export interface EndpointTest { ok: boolean; latencyMs: number; models: string[]; error?: string }
export interface LaunchSelection { profileId: string; cwd?: string; extraArgs?: string[] }
