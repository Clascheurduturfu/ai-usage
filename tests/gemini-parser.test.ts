import { describe, expect, it } from 'vitest'
import { createGeminiParser } from '../src/main/providers/gemini'

const file = 'C:/Users/example/.gemini/tmp/awesome-project/chats/session-2026-04-30T23-55-abc.jsonl'

describe('Gemini CLI transcript parser', () => {
  it('counts user messages as request events and tracks the model', () => {
    const parser = createGeminiParser(file, null)
    parser.line(JSON.stringify({ sessionId: 'abc-123', startTime: '2026-04-30T23:55:45.548Z', kind: 'main' }))
    parser.line(JSON.stringify({ id: 'm1', timestamp: '2026-04-30T23:55:59.830Z', type: 'info', content: 'x' }))
    parser.line(JSON.stringify({ id: 'm2', timestamp: '2026-04-30T23:56:00.000Z', type: 'user', content: [{ text: 'hi' }] }))
    parser.line(JSON.stringify({ id: 'm3', timestamp: '2026-04-30T23:56:41.000Z', type: 'gemini', model: 'gemini-3-flash-preview' }))
    parser.line(JSON.stringify({ id: 'm4', timestamp: '2026-04-30T23:57:00.000Z', type: 'user', content: [{ text: 'again' }] }))

    const events = parser.events()
    expect(events).toHaveLength(2)
    // m2 arrives before any model was mentioned -> model unknown yet
    expect(events[0]).toMatchObject({
      provider: 'gemini',
      kind: 'request',
      session_id: 'abc-123',
      project: 'awesome-project',
      model: null,
      ts: Date.parse('2026-04-30T23:56:00.000Z')
    })
    // m4 arrives after the gemini response carried the model
    expect(events[1]).toMatchObject({
      id: 'gemini:abc-123:m4',
      model: 'gemini-3-flash-preview'
    })
    expect(events[0].id).toBe('gemini:abc-123:m2')
    expect(events[0].input_tokens).toBe(0)
  })

  it('derives project from the chats folder slug and session id from the filename', () => {
    const parser = createGeminiParser(file, null)
    parser.line(JSON.stringify({ id: 'mx', timestamp: '2026-04-30T23:58:00.000Z', type: 'user', content: [{ text: 'x' }] }))
    const e = parser.events()
    expect(e[0].project).toBe('awesome-project')
    expect(e[0].session_id).toContain('session-2026-04-30T23-55-abc')
  })

  it('restores model + session state across incremental scans', () => {
    const parser = createGeminiParser(file, { sessionId: 'prev', lastModel: 'gemini-3-pro-preview' })
    parser.line(JSON.stringify({ id: 'm9', timestamp: '2026-04-30T23:59:00.000Z', type: 'user', content: [] }))
    const e = parser.events()
    expect(e[0].session_id).toBe('prev')
    expect(e[0].model).toBe('gemini-3-pro-preview')
  })
})
