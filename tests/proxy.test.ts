import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Vault } from '../src/main/manager/storage'
import { EndpointEngine } from '../proxies/endpoints'
import { ProxySupervisor } from '../proxies/server'
import { collectChat, sse } from '../proxies/protocol'
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-proxy-')); closers.push(() => fs.rm(root, { recursive: true, force: true }))
  const requests: any[] = []
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"real-model"}]}'); return }
    let body = ''; for await (const chunk of req) body += chunk; const value = JSON.parse(body); requests.push(value)
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event: response.output_text.delta\nid: 42\nretry: 1500\ndata: {"type":"response.output_text.delta","delta":"Example"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_example","status":"completed"}}\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (value.tools?.length) {
      res.write('data: '+JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'calculate', arguments: '{"a":' } }] } }] })+'\n\n')
      res.write('data: '+JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' }] })+'\n\n')
    } else res.write('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })+'\n\n')
    res.end('data: '+JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })+'\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve)); closers.push(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const vault = new Vault(path.join(root, 'vault.json'), async (_m, v) => v); await vault.load(); await vault.set('client', 'test-client-key-long')
  const engine = new EndpointEngine(vault, root), port = (upstream.address() as any).port
  const endpoint: any = { id: 'test', name: 'Test', protocol: 'openai-chat', credentialKind: 'api-key', baseUrl: `http://127.0.0.1:${port}/v1`, models: [] }
  const supervisor = new ProxySupervisor(vault, engine, () => [endpoint], () => undefined, () => undefined); closers.push(() => supervisor.stopAll())
  const proxy: any = { id: 'test', name: 'Test', port: 0, clientSecretRef: 'client', routes: [{ alias: 'claude-sonnet-4-6', endpointId: 'test', model: 'real-model', family: 'sonnet' }] }
  // Select an ephemeral port before starting; production validates configured ports separately.
  const selector = http.createServer(); await new Promise<void>(r => selector.listen(0, '127.0.0.1', r)); proxy.port = (selector.address() as any).port; await new Promise<void>(r => selector.close(() => r()))
  await supervisor.start(proxy)
  const base = `http://127.0.0.1:${proxy.port}`, headers = { 'x-api-key': 'test-client-key-long', 'content-type': 'application/json' }
  return { base, headers, requests, supervisor, proxy, engine, endpoint }
}
describe('managed proxy contracts', () => {
  it('passes native Responses SSE event/id/retry fields through byte-for-byte', async () => {
    const { base, headers, endpoint, requests } = await setup(); endpoint.protocol = 'openai-responses'; endpoint.responsesState = true
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-sonnet-4-6', input: 'Example', stream: true, previous_response_id: 'resp_previous', store: true }) })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('event: response.output_text.delta\nid: 42\nretry: 1500\ndata: {"type":"response.output_text.delta","delta":"Example"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_example","status":"completed"}}\n\n')
    expect(requests[0]).toMatchObject({ model: 'real-model', previous_response_id: 'resp_previous', store: true })
  })
  it('returns 400 for stateful and hosted Responses features on conversion routes', async () => {
    const { base, headers, requests } = await setup()
    for (const unsupported of [{ previous_response_id: 'resp_previous' }, { store: true }, { background: true }, { tools: [{ type: 'file_search' }] }]) {
      const response = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-sonnet-4-6', input: 'Example', ...unsupported }) })
      expect(response.status).toBe(400); expect((await response.json() as any).error.message).toContain('Unsupported Feature')
    }
    expect(requests).toHaveLength(0)
  })
  it('requires authentication even for health and exposes Claude-compatible aliases', async () => {
    const { base, headers } = await setup(); expect((await fetch(base + '/health')).status).toBe(401)
    const models: any = await (await fetch(base + '/v1/models', { headers })).json(); expect(models.data[0].anthropic_family_tier).toBe('sonnet'); expect(models.data[0].id).toBe('claude-sonnet-4-6')
  })
  it('translates Anthropic requests, preserves fragmented tool calls and usage', async () => {
    const { base, headers, requests } = await setup()
    const response = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: 'Calculate' }], tools: [{ name: 'calculate', input_schema: { type: 'object' } }] }) })
    expect(response.status).toBe(200); const body: any = await response.json(); expect(body.stop_reason).toBe('tool_use'); expect(body.content[0].input).toEqual({ a: 2 }); expect(body.usage.input_tokens).toBe(7); expect(requests[0].model).toBe('real-model')
  })
  it('streams valid Anthropic text lifecycle and rejects malformed requests', async () => {
    const { base, headers } = await setup()
    const response = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Hello' }], stream: true }) })
    const events: any[] = []; for await (const value of sse(response)) events.push(value)
    expect(events.map(e => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(events[2].delta.text).toBe('OK')
    expect((await fetch(base + '/v1/messages', { method: 'POST', headers, body: '{' })).status).toBe(400)
  })
  it('does not steal occupied ports and stops only its own listener', async () => {
    const { supervisor, proxy, base, headers } = await setup()
    await expect(supervisor.start({ ...proxy, id: 'other' })).rejects.toThrow('occupied')
    expect((await fetch(base + '/health', { headers })).status).toBe(200); await supervisor.stop(proxy.id); await expect(fetch(base + '/health', { headers })).rejects.toThrow()
  })
  it('parses CRLF, split UTF-8 and multiline SSE', async () => {
    const bytes = new TextEncoder().encode('data: {"choices":[],\r\ndata: "text":"é"}\r\n\r\ndata: [DONE]\r\n\r\n')
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1)); c.close() } })
    const values: any[] = []; for await (const value of sse(new Response(stream))) values.push(value); expect(values).toEqual([{ choices: [], text: 'é' }])
  })
  it('keeps Responses item IDs and content lifecycle consistent', async () => {
    const { base, headers, endpoint } = await setup(); endpoint.protocol = 'openai-chat'
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-sonnet-4-6', input: 'Hello', stream: true }) })
    const events: any[] = []; for await (const value of sse(response)) events.push(value)
    const added = events.find(e => e.type === 'response.output_item.added'), done = events.find(e => e.type === 'response.output_item.done'), completed = events.at(-1)
    expect(done.item.id).toBe(added.item.id); expect(completed.response.output).toEqual([done.item]); expect(done.item.content[0].text).toBe('OK')
    expect(events.some(e => e.type === 'response.output_text.done')).toBe(true); expect(events.some(e => e.type === 'response.content_part.done')).toBe(true)
    expect(events.map(e => e.sequence_number)).toEqual(events.map((_, i) => i))
  })
  it('emits contiguous Anthropic blocks for interleaved parallel tool calls', async () => {
    const { base, headers, engine } = await setup()
    engine.chat = async function* () {
      yield { choices: [{ index: 0, delta: { reasoning_content: 'Think' } }] }
      yield { choices: [{ index: 0, delta: { content: 'Calling tools', tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{"x":' } }, { index: 1, id: 'b', function: { name: 'second', arguments: '{"y":' } }] } }] }
      yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }
    }
    const response = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [], stream: true }) })
    let active: number | null = null; const inputs: Record<number, string> = {}
    for await (const e of sse(response)) {
      if (e.type === 'content_block_start') { expect(active).toBeNull(); active = e.index }
      if (e.type === 'content_block_delta') { expect(e.index).toBe(active); if (e.delta.partial_json) inputs[e.index] = (inputs[e.index] ?? '') + e.delta.partial_json }
      if (e.type === 'content_block_stop') { expect(e.index).toBe(active); active = null }
    }
    expect(active).toBeNull(); expect(Object.values(inputs).map(v => JSON.parse(v))).toEqual([{ x: 1 }, { y: 2 }])
  })
})
