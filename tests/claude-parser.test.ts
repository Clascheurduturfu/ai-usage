import { describe, expect, it } from 'vitest'
import { createClaudeParser } from '../src/main/providers/claude'

const file = 'C:/Users/example/.claude/projects/C--proj/s1.jsonl'

function parse(lines: string[]): ReturnType<typeof createClaudeParser> {
  const parser = createClaudeParser(file, null)
  for (const l of lines) parser.line(l)
  return parser
}

describe('Claude Code transcript parser', () => {
  it('extracts usage, model, project and tool calls from assistant lines', () => {
    const parser = parse([
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        cwd: 'C:\\Users\\example\\proj',
        sessionId: 's1',
        timestamp: '2026-09-19T10:00:00.000Z',
        message: { role: 'user', content: 'hello' }
      }),
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        uuid: 'u-1',
        timestamp: '2026-09-19T10:00:05.000Z',
        cwd: 'C:\\Users\\example\\proj',
        sessionId: 's1',
        message: {
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 1000
          },
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash' },
            { type: 'tool_use', id: 't2', name: 'mcp__github__create_issue' }
          ]
        }
      })
    ])

    const events = parser.events()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: 'claude:u-1',
      provider: 'claude',
      ts: Date.parse('2026-09-19T10:00:05.000Z'),
      session_id: 's1',
      project: 'C:\\Users\\example\\proj',
      model: 'claude-sonnet-4-5',
      input_tokens: 100,
      output_tokens: 50,
      cache_write_tokens: 10,
      cache_read_tokens: 1000
    })

    const tools = parser.tools()
    expect(tools.map((t) => t.name)).toEqual(['Bash', 'mcp__github__create_issue'])
    expect(tools[0].id).toBe('claude:tool:t1')
  })

  it('skips <synthetic> error placeholders', () => {
    const parser = parse([
      JSON.stringify({
        type: 'assistant',
        uuid: 'u-2',
        timestamp: '2026-09-19T10:00:06.000Z',
        message: {
          model: '<synthetic>',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: 'text', text: 'API Error: Connection refused' }]
        }
      })
    ])
    expect(parser.events()).toHaveLength(0)
  })

  it('ignores non-assistant lines and malformed JSON', () => {
    const parser = parse([
      '{"type":"summary","summary":"foo"}',
      'not json at all{',
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-19T10:00:07.000Z', message: { model: 'x' } }) // no usage
    ])
    expect(parser.events()).toHaveLength(0)
  })

  it('falls back to project from prior cwd state and session from filename', () => {
    const parser = createClaudeParser('C:/x/projects/C--Users-example-free-claude-code/abc.jsonl', {
      lastProject: 'C:\\fallback\\proj'
    })
    parser.line(
      JSON.stringify({
        type: 'assistant',
        uuid: 'u-3',
        timestamp: '2026-09-19T11:00:00.000Z',
        message: {
          model: 'claude-opus-4-5',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: []
        }
      })
    )
    const e = parser.events()
    expect(e[0].project).toBe('C:\\fallback\\proj')
    expect(e[0].session_id).toBe('abc')
    expect(JSON.parse(e[0].meta as string)).toEqual({})
  })

  it('tags sidechain (subagent) usage in meta', () => {
    const parser = parse([
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        uuid: 'u-4',
        timestamp: '2026-09-19T12:00:00.000Z',
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 5, output_tokens: 5 }, content: [] }
      })
    ])
    expect(JSON.parse(parser.events()[0].meta as string).sidechain).toBe(true)
  })
})
