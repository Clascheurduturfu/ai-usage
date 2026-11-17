import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  antigravityBinaryCandidates,
  carryOverBuckets,
  extractAntigravityRefreshToken,
  geminiWindowsFromHosts,
  findAntigravityClientSecret,
  geminiBucketsFromModels,
  resetClientSecretCache
} from '../src/main/antigravity-quota'
import { findOpenRouterKey } from '../src/main/openrouter-quota'
import { buildSyncSnapshot } from '../src/main/quota'
import { readMistralWhoamiCache } from '../src/main/providers/mistral'

const tmpDirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-quota-'))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs.length = 0
  resetClientSecretCache()
})

// --- helpers to build the nested protobuf blob the IDE stores ---

function pbString(field: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  const head = Buffer.from([field << 3 | 2, body.length])
  return Buffer.concat([head, body])
}

function pbMessage(field: number, body: Buffer): Buffer {
  const head = Buffer.from([field << 3 | 2, body.length])
  return Buffer.concat([head, body])
}

/** Replicates the storage shape: base64(pb{ f1: {1: key, 2: json}, f1: {1: key, 2: pb{1: base64(pb{1: access, 2: "Bearer", 3: refresh})}} }) */
function buildOauthBlob(refreshToken: string): string {
  const inner = Buffer.concat([pbString(1, 'ya29.fake-access-token'), pbString(2, 'Bearer'), pbString(3, refreshToken)])
  const wrapped = pbString(1, inner.toString('base64'))
  const top = Buffer.concat([
    pbMessage(1, Buffer.concat([pbString(1, 'authStateWithContextSentinelKey'), pbMessage(2, Buffer.from('{"state":"loggedIn"}', 'utf8'))])),
    pbMessage(1, Buffer.concat([pbString(1, 'oauthTokenInfoSentinelKey'), pbMessage(2, wrapped)]))
  ])
  return top.toString('base64')
}

function seedStateDb(dir: string, blob: string): string {
  const dbPath = path.join(dir, 'state.vscdb')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('antigravityUnifiedStateSync.oauthToken', blob)
  db.close()
  return dbPath
}

describe('Antigravity credential extraction', () => {
  it('extracts the refresh token from a state.vscdb blob', () => {
    const dir = tmp()
    const dbPath = seedStateDb(dir, buildOauthBlob('1//03fake-refresh-token-abc'))
    expect(extractAntigravityRefreshToken(dbPath)).toBe('1//03fake-refresh-token-abc')
  })

  it('returns null when the key is missing or the blob is garbage', () => {
    const dir = tmp()
    const dbPath = path.join(dir, 'state.vscdb')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('other.key', 'notbase64!')
    db.close()
    expect(extractAntigravityRefreshToken(dbPath)).toBeNull()
    expect(extractAntigravityRefreshToken(path.join(dir, 'missing.db'))).toBeNull()
  })

  it('finds a GOCSPX client secret embedded in a fake binary and caches it', () => {
    const dir = tmp()
    const binPath = path.join(dir, 'agy.exe')
    fs.writeFileSync(binPath, Buffer.concat([Buffer.alloc(64, 0x41), Buffer.from('GOCSPX-fakeSecret1234567890abcdefgh'), Buffer.alloc(32)]))
    const secret = findAntigravityClientSecret(binPath)
    expect(secret).toBe('GOCSPX-fakeSecret1234567890abcdefgh')
    // cached: removing the file still returns the secret
    fs.rmSync(binPath)
    expect(findAntigravityClientSecret(binPath)).toBe('GOCSPX-fakeSecret1234567890abcdefgh')
  })

  it('returns null when no binary/secret exists', () => {
    expect(findAntigravityClientSecret(path.join(tmp(), 'nope.exe'))).toBeNull()
  })
})

describe('OpenRouter key discovery (ZCode config)', () => {
  it('finds the first sk-or- key and reports its location', () => {
    const dir = tmp()
    const cfg = path.join(dir, 'config.json')
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        provider: {
          'some-uuid': { provider: 'zai', options: { apiKey: 'other-key' } },
          'or-uuid': { provider: 'openrouter', options: { apiKey: 'sk-or-v1-abc123' } }
        }
      })
    )
    const found = findOpenRouterKey(cfg)
    expect(found?.key).toBe('sk-or-v1-abc123')
    expect(found?.at).toBe('provider/or-uuid/options/apiKey')
  })

  it('returns null for missing or keyless configs', () => {
    expect(findOpenRouterKey(path.join(tmp(), 'missing.json'))).toBeNull()
    const dir = tmp()
    const cfg = path.join(dir, 'config.json')
    fs.writeFileSync(cfg, JSON.stringify({ provider: { a: { options: { apiKey: 'nope' } } } }))
    expect(findOpenRouterKey(cfg)).toBeNull()
  })
})

describe('Mistral whoami cache parsing', () => {
  it('picks the most recently stored plan', () => {
    const dir = tmp()
    fs.writeFileSync(
      path.join(dir, 'whoami_cache.json'),
      JSON.stringify({
        oldhash: { stored_at_timestamp: 1000, payload: { plan_type: 'api', plan_name: 'PAYG' } },
        newhash: { stored_at_timestamp: 2000, payload: { plan_type: 'chat', plan_name: 'INDIVIDUAL' } }
      })
    )
    const cached = readMistralWhoamiCache(dir)
    expect(cached).toMatchObject({ planType: 'chat', planName: 'INDIVIDUAL', storedAt: 2_000_000 })
  })

  it('returns null for a missing or broken cache', () => {
    const dir = tmp()
    expect(readMistralWhoamiCache(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, 'whoami_cache.json'), 'not json')
    expect(readMistralWhoamiCache(dir)).toBeNull()
  })
})

describe('Android sync snapshot builder', () => {
  it('builds the frozen contract from a quota snapshot', () => {
    const snapshot = buildSyncSnapshot(
      {
        chatgpt: {
          availableCredits: 0,
          totalEarnedCredits: 0,
          immediateResetEligible: false,
          planType: 'plus',
          email: 'user@example.com',
          primaryWindow: { usedPercent: 7, windowSeconds: 18000, resetAt: 1790519003000 },
          secondaryWindow: { usedPercent: 42, windowSeconds: 604800, resetAt: 1791049505000 },
          fetchedAt: 1
        },
        mistral: null,
        antigravity: {
          plan: 'Google AI Pro',
          availablePromptCredits: null,
          monthlyPromptCredits: null,
          fetchedAt: 1,
          buckets: [
            { id: 'gemini-weekly', group: 'Gemini Models', label: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.42, resetTime: 1791049505000, description: null },
            { id: '3p-weekly', group: 'Claude and GPT models', label: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.93, resetTime: 1790519003000, description: null }
          ]
        },
        openrouter: {
          usageDaily: 21,
          usageWeekly: 30,
          usageMonthly: 73.1,
          byokUsageDaily: 21,
          byokUsageMonthly: 73.1,
          totalCredits: 0,
          totalUsage: 0.06,
          limit: null,
          isFreeTier: true,
          fetchedAt: 1
        }
      },
      '1.2.0'
    )
    expect(snapshot['v']).toBe(1)
    const cards = snapshot['cards'] as Array<Record<string, unknown>>
    expect(cards).toHaveLength(3)

    const chatgpt = cards.find((c) => c['id'] === 'chatgpt')
    expect(chatgpt).toMatchObject({ plan: 'plus', email: 'user@example.com' })
    const windows = chatgpt!['windows'] as Array<Record<string, unknown>>
    expect(windows[0]).toMatchObject({ id: 'weekly', leftPct: 58 }) // 100 - 42 used
    expect(windows[1]).toMatchObject({ id: '5h', leftPct: 93 })

    const agy = cards.find((c) => c['id'] === 'antigravity')!
    const groups = agy['groups'] as Array<Record<string, unknown>>
    expect(groups).toHaveLength(2)
    expect((groups[1]['windows'] as Array<Record<string, unknown>>)[0]).toMatchObject({ leftPct: 93 })

    const or = cards.find((c) => c['id'] === 'openrouter')!
    expect(or).toMatchObject({ byokMonthUsd: 73.1, byokTodayUsd: 21 })
  })

  it('omits missing cards', () => {
    const snapshot = buildSyncSnapshot({ chatgpt: null, mistral: null, antigravity: null, openrouter: null }, '1.2.0')
    expect(snapshot['cards']).toEqual([])
  })
})

describe('Gemini limits while Antigravity is closed', () => {
  const now = Date.parse('2026-11-17T14:15:00Z')
  // Live shapes from 2026-11-17: one host answers with the weekly window, the other with the 5-hour one.
  const weekly = [{ modelId: 'claude-opus-5-5-high', remainingFraction: 0.89, resetTime: '2026-11-17T14:31:27Z' }, { modelId: 'gemini-3.8-flash-tiered', resetTime: '2026-11-21T09:35:25Z' }, { modelId: 'gemini-4-hydrogen-sonar', resetTime: '2026-11-21T09:35:25Z' }, { modelId: 'tab_flash_lite_preview', remainingFraction: 1 }]
  const fiveHour = [{ modelId: 'gemini-3.8-flash-tiered', remainingFraction: 1, resetTime: '2026-11-17T19:15:03Z' }, { modelId: 'gemini-2.5-pro', remainingFraction: 1, resetTime: '2026-11-17T19:15:03Z' }]

  it('reads the weekly and 5-hour Gemini windows from per-model quotas, whichever host answers', () => {
    for (const hosts of [[weekly, fiveHour], [fiveHour, weekly]]) {
      expect(geminiWindowsFromHosts(hosts, now).map(b => [b.id, b.window, b.remainingFraction, b.resetTime])).toEqual([
        ['gemini-weekly', 'weekly', 0, Date.parse('2026-11-21T09:35:25Z')],
        ['gemini-5h', '5h', 1, Date.parse('2026-11-17T19:15:03Z')]
      ])
    }
  })

  it('places a lone answer by how soon it resets', () => {
    expect(geminiWindowsFromHosts([fiveHour], now).map(b => b.window)).toEqual(['5h'])
    expect(geminiWindowsFromHosts([weekly], now).map(b => b.window)).toEqual(['weekly'])
    expect(geminiWindowsFromHosts([[{ modelId: 'claude-opus-5-5-high', remainingFraction: 1, resetTime: '2026-11-17T19:00:00Z' }]], now)).toEqual([])
  })

  it('keeps the last Argon value from Antigravity, with when it was seen, until it resets', () => {
    const argon = { id: 'gemini-argon-wtu-weekly', group: 'Gemini 4 Argon', label: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remainingFraction: 0.33, resetTime: Date.parse('2026-11-21T13:13:28Z'), description: null }
    const local = { plan: 'Google AI Pro', availablePromptCredits: null, monthlyPromptCredits: null, source: 'antigravity' as const, fetchedAt: now - 3 * 3_600_000, buckets: [{ ...argon, id: 'gemini-weekly', group: 'Gemini Models', label: 'Weekly Limit Remaining', remainingFraction: 0.5 }, argon] }
    const closed = { plan: 'Google AI Pro', availablePromptCredits: null, monthlyPromptCredits: null, source: 'google' as const, fetchedAt: now, buckets: geminiWindowsFromHosts([weekly, fiveHour], now) }
    const merged = carryOverBuckets(local, closed, now)
    expect(merged.buckets.map(b => b.id)).toEqual(['gemini-weekly', 'gemini-5h', 'gemini-argon-wtu-weekly'])
    expect(merged.buckets.find(b => b.id === 'gemini-weekly')!.remainingFraction).toBe(0) // live, not the old 50%
    expect(merged.buckets.at(-1)!.observedAt).toBe(now - 3 * 3_600_000)
    // A second closed refresh keeps the original sighting time; after the reset the value is dropped.
    expect(carryOverBuckets(merged, closed, now + 3_600_000).buckets.at(-1)!.observedAt).toBe(now - 3 * 3_600_000)
    expect(carryOverBuckets(merged, closed, Date.parse('2026-11-21T14:00:00Z')).buckets.map(b => b.id)).not.toContain('gemini-argon-wtu-weekly')
    // Once Antigravity reports again, its own reading replaces everything.
    expect(carryOverBuckets(merged, local, now)).toBe(local)
  })
})

describe('geminiBucketsFromModels', () => {
  it('reads an exhausted model (proto3 omits remainingFraction 0) as 0%, not as missing', () => {
    // Live response shape, 2026-11-16: Gemini entries carry only a resetTime.
    const buckets = geminiBucketsFromModels([
      { id: 'claude-opus-5-5-high', remainingFraction: 0.95, resetTime: '2026-11-16T22:43:08Z' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', resetTime: '2026-11-21T09:35:25Z' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', resetTime: '2026-11-21T09:35:25Z' },
      { id: 'tab_flash_lite_preview', remainingFraction: 1 },
      { id: 'gemini-unknown' }
    ])
    expect(buckets).toEqual([expect.objectContaining({ id: 'gemini', remainingFraction: 0, resetTime: Date.parse('2026-11-21T09:35:25Z') })])
  })

  it('combines matching Pro and Flash quotas and ignores non-Gemini models', () => {
    const buckets = geminiBucketsFromModels([
      { id: 'claude-sonnet-4-6', remainingFraction: 0.2 },
      { id: 'gemini-3.1-pro-high', remainingFraction: 0.4, resetTime: '2026-11-15T22:50:00Z' },
      { id: 'gemini-3-flash', remainingFraction: 0.4, resetTime: '2026-11-15T22:50:00Z' }
    ])
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ id: 'gemini', label: 'Gemini models', remainingFraction: 0.4 })
  })

  it('splits Gemini Pro and Flash when quotas differ, including RPC enum models with labels', () => {
    const buckets = geminiBucketsFromModels([
      { id: 'MODEL_PLACEHOLDER_M37', label: 'Gemini 3.1 Pro (High)', remainingFraction: 0.25, resetTime: '2026-11-15T23:00:00Z' },
      { id: 'MODEL_PLACEHOLDER_M18', label: 'Gemini 3 Flash', remainingFraction: 0.85, resetTime: '2026-11-15T22:30:00Z' }
    ])
    expect(buckets.map((b) => [b.id, b.remainingFraction])).toEqual([
      ['gemini-pro', 0.25],
      ['gemini-flash', 0.85]
    ])
  })

  it('includes installed Antigravity language_server binary candidates', () => {
    expect(antigravityBinaryCandidates().some((p) => p.includes('language_server'))).toBe(true)
  })
})
