import { describe, expect, it } from 'vitest'
import { describeOwnedEdits, describeTextEdits } from '../src/main/manager/sync-diff'

const owned = (mcp: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ mcp, skillOverrides: {}, disabled: [], skillConfig: [], permission: {}, ...extra })

describe('conflict explanations', () => {
  it('names the managed server and field that changed without showing secret-bearing values', () => {
    const lines = describeOwnedEdits(
      owned({ a: { command: 'npx', args: ['x'], env: { TOKEN: 'secret-one' } }, gone: { command: 'node' } }),
      owned({ a: { command: 'node', args: ['x', '--flag'], env: { TOKEN: 'secret-two' } }, fresh: { url: 'https://example.test/?key=abc' } }))
    expect(lines).toEqual([
      'MCP server “a”: command changed from npx to node; args changed (1 → 2 items); env changed (TOKEN)',
      'MCP server “fresh” was added to the file',
      'MCP server “gone” was removed from the file'])
    expect(lines.join(' ')).not.toMatch(/secret|key=abc/)
  })
  it('reports skills switched in the client', () => {
    expect(describeOwnedEdits(owned({}, { disabled: ['pdf'] }), owned({}, { disabled: ['docx'] }))).toEqual(['Skill “docx” was disabled in the client', 'Skill “pdf” was enabled again in the client'])
  })
  it('says which argument changed when the count is the same', () => {
    expect(describeOwnedEdits(owned({ a: { args: ['x', 'y'] } }), owned({ a: { args: ['x', 'z'] } }))).toEqual(['MCP server “a”: args changed (item 2 of 2)'])
  })
  it('summarizes instruction edits by line and caps long lists', () => {
    expect(describeTextEdits('one\ntwo\n', 'one\nthree\n')).toEqual(['1 line added, 1 removed since the last sync', 'Added: three', 'Removed: two'])
    expect(describeTextEdits('a\n\nb', 'b\na')).toEqual(['Only spacing or line order changed'])
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${String(i).padStart(2, '0')}`, { command: 'x' }]))
    const lines = describeOwnedEdits(owned(many), owned({}))
    expect(lines).toHaveLength(9); expect(lines[8]).toBe('and 4 more changes')
  })
})
