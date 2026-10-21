import os from 'node:os'
import { antigravityRpc } from '../antigravity-rpc'
import type { AntigravityStatus } from '../../shared/manager'

const cleanError = (value: string): string => value.replace(/Bearer\s+\S+|(?:access_token|refresh_token|client_secret|csrf_token)["\s:=]+[^\s",}]+/gi, '[redacted]').slice(0, 400)
export class AntigravityClient {
  private cached?: AntigravityStatus
  private pending?: Promise<AntigravityStatus>
  constructor(private home: string) {}
  async inspect(refresh = false): Promise<AntigravityStatus | undefined> {
    if (process.platform !== 'darwin' || this.home !== os.homedir() || process.env.AIU_PROFILE || process.env.AIU_HOME) return undefined
    if (this.pending) { const result = await this.pending; if (!refresh) return result }
    if (!refresh && this.cached && Date.now() - this.cached.checkedAt < 15_000) return this.cached
    const operation = this.read(refresh); this.pending = operation
    try { return this.cached = await operation } finally { if (this.pending === operation) this.pending = undefined }
  }
  private async read(refresh: boolean): Promise<AntigravityStatus> {
    if (refresh) await antigravityRpc('RefreshMcpServers')
    const mcp = await antigravityRpc('GetMcpServerStates'), skills = await antigravityRpc('GetAllSkills')
    if (!mcp || !skills) return { state: 'Unavailable', detail: 'Open or restart Antigravity to read its connection details.', skills: 0, servers: [], checkedAt: Date.now() }
    const servers = (mcp.states ?? []).map((server: any) => ({ name: String(server.spec?.serverName ?? ''), state: String(server.status ?? '').replace('MCP_SERVER_STATUS_', ''), tools: server.tools?.length ?? 0,
      ...(server.error ? { detail: /Unauthorized|401|oauth/i.test(server.error) ? 'Shared sign-in is unavailable or rejected. Check app authentication.' : /ProfileNotFound|config profile|AWS CLI/i.test(server.error) ? 'Select an authenticated AWS profile on this Mac.' : cleanError(String(server.error)) } : {}) }))
    return { state: 'Loaded', skills: (skills.skills ?? []).filter((skill: any) => String(skill.path ?? '').startsWith(this.home + '/.gemini/config/skills/')).length, servers, checkedAt: Date.now(), detail: refresh ? 'Configuration reloaded. Existing chats may retain their earlier tool context.' : 'Read from the running Antigravity client.' }
  }
}
