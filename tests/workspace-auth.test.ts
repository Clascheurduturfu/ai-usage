import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ManagerStore, Vault } from '../src/main/manager/storage'
import { WorkspaceAdapter, describeGwsError } from '../src/main/manager/workspace'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

const ALL = ['gmail.modify', 'gmail.send', 'calendar', 'drive', 'documents', 'spreadsheets', 'contacts.readonly'].map(s => `https://www.googleapis.com/auth/${s}`)

async function adapter() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-workspace-')); roots.push(home)
  const store = new ManagerStore(path.join(home, '.agents'), path.join(home, 'data')); await store.load()
  const vault = new Vault(path.join(store.data, 'vault.json'), async (_method, value) => value); await vault.load()
  const credential = (refresh: string) => JSON.stringify({ type: 'authorized_user', client_id: 'client', client_secret: 'secret', refresh_token: refresh, token_uri: 'https://oauth2.googleapis.com/token', signedInAt: Date.now() - 3 * 86_400_000 })
  await vault.set('workspace-main', credential('good-refresh')); await vault.set('workspace-school', credential('revoked-refresh')); await vault.set('workspace-narrow', credential('narrow-refresh'))
  store.config.workspaceAccounts = { main: { secretRef: 'workspace-main', email: 'main@example.com' }, school: { secretRef: 'workspace-school', email: 'school@example.com' }, narrow: { secretRef: 'workspace-narrow', email: 'narrow@example.com' } }
  const workspace = new WorkspaceAdapter(store, vault, async () => ({ command: 'gws', args: [] }), async () => '', () => undefined, async () => undefined, {} as any)
  return { workspace, vault }
}

describe('Google account sign-in check', () => {
  it('reports renewed, revoked and under-permissioned sign-ins separately', async () => {
    const { workspace, vault } = await adapter()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: URLSearchParams }) => {
      const body = new URLSearchParams(init.body)
      if (url === 'https://oauth2.googleapis.com/token') {
        const refresh = body.get('refresh_token')
        if (refresh === 'revoked-refresh') return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 })
        return new Response(JSON.stringify({ access_token: `access-for-${refresh}`, expires_in: 3599 }))
      }
      if (url === 'https://oauth2.googleapis.com/tokeninfo') {
        const narrow = body.get('access_token') === 'access-for-narrow-refresh'
        return new Response(JSON.stringify({ scope: (narrow ? ALL.filter(s => !s.endsWith('gmail.modify')) : ALL).join(' '), expires_in: 3599 }))
      }
      throw new Error(`unexpected ${url}`)
    }))
    const accounts = Object.fromEntries((await workspace.checkAccounts()).map(a => [a.account, a]))
    expect(accounts.main.state).toBe('Signed in'); expect(accounts.main.detail).toMatch(/all 7 permissions.*signed in 3 days ago/)
    expect(accounts.school.state).toBe('Needs reconnect'); expect(accounts.school.detail).toMatch(/revoked or expired.*7 days/)
    expect(accounts.narrow.state).toBe('Missing permissions'); expect(accounts.narrow.detail).toMatch(/Not granted: Gmail \(read and organize\)/)
    // The forced refresh is saved, so the next call reuses the renewed token.
    expect(JSON.parse(await vault.get('workspace-main')).token).toBe('access-for-good-refresh')
  })
})

describe('gws error messages', () => {
  it('explains Google API refusals instead of a bare "gws failed"', () => {
    const json = (code: number, message: string, reason?: string) => ({ message: 'google-workspace exited with status 1', stdout: JSON.stringify({ error: { code, message, reason } }), stderr: `error[api]: ${message}` })
    expect(describeGwsError(json(401, 'Request had invalid authentication credentials.'), 'school')).toMatch(/rejected the school account's sign-in \(HTTP 401\).*Reconnect/)
    expect(describeGwsError(json(403, 'Request had insufficient authentication scopes.', 'insufficientPermissions'), 'school')).toMatch(/^The school account did not grant the permission.*HTTP 403/)
    expect(describeGwsError(json(404, 'Requested entity was not found.', 'notFound'))).toBe('Google refused the request (HTTP 404, notFound): Requested entity was not found.')
    expect(describeGwsError({ message: 'google-workspace exited with status 2', stdout: '', stderr: 'warning: x\nerror[validation]: unknown method' })).toBe('gws: error[validation]: unknown method')
    expect(describeGwsError({ message: 'google-workspace exited with status 1', stdout: '', stderr: '' })).toMatch(/exited with status 1\. gws printed nothing/)
  })
})
