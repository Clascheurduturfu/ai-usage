import type { AiuApi } from '../../../shared/api'
import type { ManagerSnapshot } from '../../../shared/manager'

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
      mcpAuth: { 'cloud-tools': { enabled: true, secretRef: 'mcp-cloud-tools-auth' }, 'cloud-logs': { enabled: true, secretRef: 'mcp-cloud-logs-auth' }, 'cloud-docs': { enabled: true, secretRef: 'mcp-cloud-docs-auth' }, 'cloud-builds': { enabled: true, secretRef: 'mcp-cloud-builds-auth' } }
    },
    agents: [], skills: [], proxies: [], logs: [], instructions: '',
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
export function demoManagerApi(): Partial<AiuApi> {
  const done = async (): Promise<void> => undefined
  return {
    getManager: async () => demoManager(), onManagerUpdated: () => () => undefined,
    sharingSettings: async () => ({ folder: 'C:/Sample/Shared', passphrase: '' }), sharingFileExists: async () => true,
    checkMcp: async name => ({ state: 'Connection verified', detail: `${name}: 4 tools listed.`, tools: 4, checkedAt: Date.now(), canPrepare: false }),
    loginMcp: done, logoutMcp: done, stopMcp: done, resumeMcp: done, deleteMcp: done
  } as Partial<AiuApi>
}
