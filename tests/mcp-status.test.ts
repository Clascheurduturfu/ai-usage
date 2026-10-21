import { describe, expect, it } from 'vitest'
import { mcpStatus } from '../src/renderer/src/lib/mcp-status'
import type { ManagerSnapshot } from '../src/shared/manager'

const snapshot = (patch: Partial<ManagerSnapshot>): ManagerSnapshot => ({
  config: { schema: 2, revision: 'r', autoSync: false, endpoints: [], proxies: [], profiles: [], activeProfiles: {}, mcpAuth: { remote: { enabled: true, secretRef: 'remote-auth' } } },
  agents: [], skills: [], mcp: [], proxies: [], sharing: { folder: '', enabled: false, unlocked: false, pending: 0 }, secrets: [], logs: [], instructions: '',
  runtime: { paused: [], workers: [], sessions: [] }, ...patch
})
const remote = { name: 'remote', transport: 'http' as const, url: 'https://mcp.example/mcp' }
const docs = { name: 'docs', transport: 'http' as const, url: 'https://docs.mcp.cloudflare.com/mcp' }

describe('MCP status', () => {
  it('asks for a reconnect when the grant was rejected', () => {
    expect(mcpStatus(remote, snapshot({ auth: { remote: 'Token refresh failed: HTTP 400 (invalid_grant) · Reconnect required' } }))).toMatchObject({ tone: 'error', label: 'Reconnect needed', primary: 'reconnect' })
  })
  it('treats a token-service outage as temporary', () => {
    expect(mcpStatus(remote, snapshot({ auth: { remote: 'Token refresh failed: HTTP 502 (server_error) · Sign-in kept, retry shortly' } }))).toMatchObject({ tone: 'warn', label: 'Provider issue', primary: 'check' })
  })
  it('never offers sign-in for a public server', () => {
    const status = mcpStatus(docs, snapshot({ config: { ...snapshot({}).config, mcpAuth: { docs: { enabled: true, secretRef: 'x' } } }, auth: { docs: 'Public server · no sign-in needed' } }))
    expect(status).toMatchObject({ tone: 'idle', label: 'Ready', primary: 'check' }); expect(status.detail).toContain('no sign-in needed')
  })
  it('shows clients connected directly when the app does not manage the server', () => {
    expect(mcpStatus(remote, snapshot({ config: { ...snapshot({}).config, mcpAuth: {} } }))).toMatchObject({ tone: 'off', label: 'Direct', primary: 'manage' })
  })
  it('lets a stopped server resume before anything else', () => {
    expect(mcpStatus(remote, snapshot({ runtime: { paused: ['remote'], workers: [], sessions: [] }, auth: { remote: 'Sign-in required' } }))).toMatchObject({ label: 'Stopped', primary: 'resume' })
  })
  it('derives Running, Connected and Ready from live counts', () => {
    const local = { name: 'files', transport: 'stdio' as const, command: 'node' }, worker = { id: 'w', name: 'files', kind: 'stateful', pid: 1, memoryBytes: 0, processes: 1 }
    expect(mcpStatus(local, snapshot({ deviceMcp: { files: { state: 'Running', detail: '', clients: 1, workers: 1, canPrepare: false } }, runtime: { paused: [], workers: [worker], sessions: [] } }))).toMatchObject({ tone: 'ok', label: 'Running' })
    expect(mcpStatus(local, snapshot({ deviceMcp: { files: { state: 'Connected', detail: '', clients: 2, workers: 0, canPrepare: false } } }))).toMatchObject({ tone: 'ok', label: 'Connected' })
    expect(mcpStatus(local, snapshot({ deviceMcp: { files: { state: 'Ready to launch', detail: '', canPrepare: true } } }))).toMatchObject({ tone: 'idle', label: 'Ready' })
    const workspace = mcpStatus({ name: 'google-workspace', transport: 'stdio', command: '@device' }, snapshot({ deviceMcp: { 'google-workspace': { state: 'Connected', detail: '', clients: 1, workers: 0, canPrepare: true } } }))
    expect(workspace.label).toBe('Connected'); expect(workspace.detail).toContain('short command')
    expect(mcpStatus(local, snapshot({ deviceMcp: { files: { state: 'Needs setup', detail: 'Install', canPrepare: true } } }))).toMatchObject({ tone: 'warn', primary: 'prepare' })
  })
})
