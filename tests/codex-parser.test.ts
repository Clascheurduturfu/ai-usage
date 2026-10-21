import { describe, expect, it } from 'vitest'
import { createCodexParser } from '../src/main/providers/codex'

const file = 'C:/Users/example/.codex/sessions/2026/03/14/rollout-x.jsonl'

function parse(lines: string[]): ReturnType<typeof createCodexParser> {
  const parser = createCodexParser(file, null)
  for (const l of lines) parser.line(l)
  return parser
}

const SESSION_META = JSON.stringify({
  timestamp: '2026-03-14T00:01:26.194Z',
  ordinal: 0,
  type: 'session_meta',
  payload: { id: 'sess-1', cwd: 'C:\\proj', cli_version: '0.115.0' }
})

const TURN_CONTEXT = JSON.stringify({
  timestamp: '2026-03-14T00:01:30.000Z',
  ordinal: 3,
  type: 'turn_context',
  payload: { model: 'gpt-5.2-codex' }
})

const TOKEN_COUNT = JSON.stringify({
  timestamp: '2026-03-14T00:01:38.526Z',
  ordinal: 9,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 100, output_tokens: 50 },
      last_token_usage: {
        input_tokens: 80,
        cached_input_tokens: 10,
        cache_write_input_tokens: 5,
        output_tokens: 7,
        reasoning_output_tokens: 3,
        total_tokens: 102
      }
    },
    rate_limits: {
      primary: { used_percent: 10.5, window_minutes: 10080, resets_at: 1774002551 },
      plan_type: 'free'
    }
  }
})

const FUNCTION_CALL = JSON.stringify({
  timestamp: '2026-03-14T00:01:41.000Z',
  ordinal: 12,
  type: 'response_item',
  payload: { type: 'function_call', name: 'shell', arguments: '{}' }
})

describe('Codex rollout parser', () => {
  it('maps token_count to a per-turn usage event with model tracking', () => {
    const parser = parse([SESSION_META, TURN_CONTEXT, TOKEN_COUNT])
    const events = parser.events()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: 'codex:sess-1:9',
      provider: 'codex',
      ts: Date.parse('2026-03-14T00:01:38.526Z'),
      session_id: 'sess-1',
      project: 'C:\\proj',
      model: 'gpt-5.2-codex',
      input_tokens: 65,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      output_tokens: 7,
      reasoning_tokens: 3
    })
  })

  it('records the rate-limit snapshot per session', () => {
    const parser = parse([SESSION_META, TOKEN_COUNT])
    const snaps = parser.snapshots()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].key).toBe('codex:limit:sess-1')
    const data = snaps[0].data as Record<string, number | string>
    expect(data.usedPercent).toBe(10.5)
    expect(data.windowMinutes).toBe(10080)
    expect(data.resetsAt).toBe(1774002551000)
    expect(data.planType).toBe('free')
  })

  it('captures function calls as tool events', () => {
    const parser = parse([SESSION_META, FUNCTION_CALL])
    const tools = parser.tools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: 'codex:sess-1:12', name: 'shell', session_id: 'sess-1', project: 'C:\\proj' })
  })

  it('skips zero-token events (e.g. the very first heartbeat)', () => {
    const zero = JSON.stringify({
      timestamp: '2026-03-14T00:01:31.000Z',
      ordinal: 8,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } }
      }
    })
    const parser = parse([SESSION_META, zero])
    expect(parser.events()).toHaveLength(0)
  })

  it('restores parser state across incremental scans', () => {
    const prior = { sessionId: 'sess-1', project: 'C:\\proj', lastModel: 'gpt-5.2-codex' }
    const parser = createCodexParser(file, prior)
    parser.line(TOKEN_COUNT)
    expect(parser.events()[0].model).toBe('gpt-5.2-codex')
    expect(parser.events()[0].session_id).toBe('sess-1')
    expect(parser.state()).toMatchObject({ lastModel: 'gpt-5.2-codex' })
  })

  it('tolerates garbage lines', () => {
    const parser = parse(['{', SESSION_META, 'random text'])
    expect(parser.events()).toHaveLength(0)
  })
})
