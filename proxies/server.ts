import http from 'node:http'
import { once } from 'node:events'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { EndpointRecord, ProxyRecord, ProxyStatus } from '../src/shared/manager'
import { Vault } from '../src/main/manager/storage'
import { EndpointEngine, openaiBase, redact } from './endpoints'
import { anthropicToChat, chatResultToAnthropic, collectChat, sse, type ChatChunk, type Json } from './protocol'
import { APP_VERSION } from '../src/shared/version'
import { responsesToChat } from './responses'

async function write(res: http.ServerResponse, value: string): Promise<void> {
  if (res.destroyed) throw new Error('Client disconnected')
  if (!res.write(value)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { res.off('drain', drain); res.off('close', close); res.off('error', error) }
      const drain = (): void => { cleanup(); resolve() }
      const close = (): void => { cleanup(); reject(new Error('Client disconnected')) }
      const error = (e: Error): void => { cleanup(); reject(e) }
      res.once('drain', drain); res.once('close', close); res.once('error', error)
    })
  }
}
const event = (type: string, data: Json): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
async function bodyOf(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) throw Object.assign(new Error('Request exceeds 16 MiB'), { status: 413 })
    chunks.push(chunk)
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value }
  catch { throw Object.assign(new Error('Request must be a JSON object'), { status: 400 }) }
}
const sameKey = (a: string, b: string): boolean => !!b && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

async function streamAnthropic(chunks: AsyncIterable<ChatChunk>, res: http.ServerResponse, model: string): Promise<void> {
  const id = `msg_${randomUUID()}`
  await write(res, event('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }))
  const tools = new Map<number, { id: string; name: string; args: string }>()
  let next = 0, active = -1, activeKind = '', reason = 'end_turn', usage: Json = {}, size = 0
  const stop = async (): Promise<void> => { if (active !== -1) await write(res, event('content_block_stop', { index: active })); active = -1 }
  async function text(kind: string, value: string): Promise<void> {
    if (activeKind !== kind || active === -1) { await stop(); active = next++; activeKind = kind; await write(res, event('content_block_start', { index: active, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } })) }
    await write(res, event('content_block_delta', { index: active, delta: kind === 'text' ? { type: 'text_delta', text: value } : { type: 'thinking_delta', thinking: value } }))
  }
  for await (const chunk of chunks) {
    if (chunk.usage) usage = { ...usage, ...chunk.usage }
    for (const choice of chunk.choices ?? []) {
      if (choice.index !== 0) continue
      const delta = choice.delta ?? {}
      if (delta.reasoning_content) await text('thinking', delta.reasoning_content)
      if (delta.content) await text('text', delta.content)
      for (const call of delta.tool_calls ?? []) {
        const slot = call.index ?? 0
        if (!Number.isInteger(slot) || slot < 0 || slot > 1024) throw new Error('Invalid upstream tool index')
        let tool = tools.get(slot)
        if (!tool) { tool = { id: call.id ?? `toolu_${randomUUID()}`, name: '', args: '' }; tools.set(slot, tool) }
        if (call.id) tool.id = call.id
        tool.name += call.function?.name ?? ''; tool.args += call.function?.arguments ?? ''
        size += (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0)
        if (size > 16 * 1024 * 1024) throw new Error('Upstream tool arguments are too large')
      }
      if (choice.finish_reason) reason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
    }
  }
  await stop()
  // OpenAI may interleave parallel tool fragments. Emit each complete tool in one contiguous Anthropic block.
  for (const tool of tools.values()) {
    const index = next++
    if (!tool.name) throw new Error('Upstream tool has no name')
    await write(res, event('content_block_start', { index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }))
    await write(res, event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: tool.args || '{}' } }))
    await write(res, event('content_block_stop', { index }))
  }
  await write(res, event('message_delta', { delta: { stop_reason: tools.size ? 'tool_use' : reason, stop_sequence: null }, usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 } }))
  await write(res, event('message_stop', {}))
}

function chatToResponse(chat: Json): Json {
  const msg = chat.choices[0]?.message ?? {}, output: Json[] = []
  if (msg.reasoning_content) output.push({ id: `rs_${randomUUID()}`, type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] })
  if (msg.content) output.push({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content, annotations: [] }] })
  for (const call of msg.tool_calls ?? []) output.push({ id: `fc_${randomUUID()}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
  return { id: `resp_${randomUUID()}`, object: 'response', status: 'completed', model: chat.model, output, usage: { input_tokens: chat.usage?.prompt_tokens ?? 0, output_tokens: chat.usage?.completion_tokens ?? 0, total_tokens: chat.usage?.total_tokens ?? 0 } }
}

export class ProxySupervisor {
  private servers = new Map<string, http.Server>()
  private statuses = new Map<string, ProxyStatus>()
  private limits = new Map<string, { start: number; requests: number; tokens: number }>()
  constructor(private vault: Vault, private engine: EndpointEngine, private endpoints: () => EndpointRecord[], private notify: () => void, private log: (message: string) => void) {}
  status(proxies: ProxyRecord[]): ProxyStatus[] { return proxies.map((p) => this.statuses.get(p.id) ?? { id: p.id, state: 'stopped', port: p.port, requests: 0 }) }
  async start(proxy: ProxyRecord): Promise<void> {
    if (this.servers.has(proxy.id)) return
    if (!proxy.routes.length) throw new Error('Add at least one route before starting this proxy')
    const key = proxy.authMode === 'none' ? '' : await this.vault.get(proxy.clientSecretRef)
    if (proxy.authMode !== 'none' && !key) throw new Error('Choose No key or configure a client key for this endpoint')
    const status: ProxyStatus = { id: proxy.id, state: 'stopped', port: proxy.port, requests: 0 }
    this.statuses.set(proxy.id, status)
    const server = http.createServer((req, res) => { void this.handle(proxy, key, req, res).catch((error) => {
      this.log(`${proxy.name}: ${this.vault.redact(redact((error as Error).message))}`)
      if (res.headersSent) { void write(res, event('error', { error: { type: 'upstream_error', message: this.vault.redact(redact((error as Error).message)) } })).catch(() => undefined).finally(() => res.end()) }
      else { const statusCode = (error as { status?: number }).status ?? 502; res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: statusCode === 401 || statusCode === 403 ? 'upstream_authentication_error' : 'gateway_error', message: this.vault.redact(redact((error as Error).message)) } })) }
    }) })
    server.requestTimeout = 600_000; server.headersTimeout = 30_000
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(proxy.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
      server.on('error', (error) => { status.state = 'error'; status.error = error.message; this.notify() })
      this.servers.set(proxy.id, server); status.state = 'running'; this.log(`${proxy.name} listening on 127.0.0.1:${proxy.port}`); this.notify()
    } catch (error) { status.state = 'error'; status.error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${proxy.port} is occupied` : (error as Error).message; this.notify(); throw new Error(status.error) }
  }
  async stop(id: string): Promise<void> {
    const server = this.servers.get(id)
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); this.servers.delete(id) }
    const status = this.statuses.get(id); if (status) status.state = 'stopped'
    this.notify()
  }
  async stopAll(): Promise<void> { await Promise.all([...this.servers.keys()].map((id) => this.stop(id))) }
  private async handle(proxy: ProxyRecord, key: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const supplied = String(req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '')
    if (proxy.authMode !== 'none' && !sameKey(supplied, key)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"type":"local_authentication_error","message":"AI Usage rejected the local client key. Re-apply the agent profile or update its key. Provider credentials were not contacted."}}'); return }
    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, version: APP_VERSION, proxy: proxy.id })); return }
    if (req.method === 'GET' && ['/v1/models', '/models'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: proxy.routes.map((route) => ({ id: route.alias, object: 'model', owned_by: 'ai-usage', display_name: route.alias,
        ...(route.family ? { anthropic_family_tier: route.family, is_family_default: true, supports_1m: (route.maxInputTokens ?? 0) >= 1_000_000, max_input_tokens: route.maxInputTokens ?? 128_000 } : {}) })) })); return
    }
    const mode = url.pathname.endsWith('/messages') ? 'anthropic' : url.pathname.endsWith('/responses') ? 'responses' : url.pathname.endsWith('/chat/completions') ? 'chat' : null
    if (req.method !== 'POST' || !mode) { res.writeHead(404); res.end(); return }
    const original = await bodyOf(req)
    if (typeof original.model !== 'string' || (mode !== 'responses' && !Array.isArray(original.messages))) throw Object.assign(new Error('Provide a model and messages array'), { status: 400 })
    const route = proxy.routes.find((r) => r.alias === original.model || r.model === original.model)
    if (!route) throw Object.assign(new Error('Unknown model alias; choose one listed by /v1/models'), { status: 404 })
    const endpoint = this.endpoints().find((e) => e.id === route.endpointId)
    if (!endpoint) throw new Error('This route has no saved endpoint')
    const limiterId = `${proxy.id}:${route.alias}`, now = Date.now()
    let limit = this.limits.get(limiterId)
    if (!limit || now - limit.start >= 60_000) { limit = { start: now, requests: 0, tokens: 0 }; this.limits.set(limiterId, limit) }
    const outputLimit = Number(original.max_tokens ?? original.max_output_tokens ?? original.max_completion_tokens ?? 4096)
    if (!Number.isFinite(outputLimit) || outputLimit <= 0) throw Object.assign(new Error('The output token limit must be positive'), { status: 400 })
    const estimate = Math.ceil(JSON.stringify(original).length / 4) + outputLimit
    if ((route.rpm && limit.requests >= route.rpm) || (route.tpm && limit.tokens + estimate > route.tpm)) throw Object.assign(new Error('Local route rate limit reached'), { status: 429 })
    limit.requests++; limit.tokens += estimate
    const abort = new AbortController()
    req.on('aborted', () => abort.abort()); res.on('close', () => { if (!res.writableEnded) abort.abort() })
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(600_000)])
    const status = this.statuses.get(proxy.id)!; status.requests++
    if (mode === 'responses' && endpoint.credentialKind === 'api-key' && endpoint.protocol === 'openai-responses') {
      const response = await this.engine.responses(endpoint, { ...original, model: route.model }, signal)
      res.writeHead(200, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' })
      // Native Responses streams are passed byte-for-byte, including event/id/retry lines.
      if (original.stream && response.body) for await (const bytes of response.body) {
        if (!res.write(Buffer.from(bytes))) await new Promise<void>((resolve, reject) => { const done = (): void => { res.off('drain', drain); res.off('close', close) }; const drain = (): void => { done(); resolve() }; const close = (): void => { done(); reject(new Error('Client disconnected')) }; res.once('drain', drain); res.once('close', close) })
      }
      else { const value = await response.json() as Json; value.model = original.model; await write(res, JSON.stringify(value)) }
      res.end(); return
    }
    const chat = mode === 'anthropic' ? anthropicToChat(original) : mode === 'responses' ? responsesToChat(original) : original
    chat.model = route.model
    const chunks = this.engine.chat(endpoint, chat, signal)
    if (!original.stream) {
      const result = await collectChat(chunks, original.model)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(mode === 'anthropic' ? chatResultToAnthropic(result) : mode === 'responses' ? chatToResponse(result) : result)); return
    }
    // Delay sending headers until the first upstream chunk so errors retain their HTTP category.
    const iterator = chunks[Symbol.asyncIterator](), first = await iterator.next()
    async function* replay(): AsyncGenerator<ChatChunk> { if (!first.done) yield first.value; for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    if (mode === 'anthropic') await streamAnthropic(replay(), res, original.model)
    else if (mode === 'chat') {
      for await (const chunk of replay()) await write(res, `data: ${JSON.stringify({ ...chunk, object: 'chat.completion.chunk', model: original.model, created: Math.floor(Date.now() / 1000) })}\n\n`)
      await write(res, 'data: [DONE]\n\n')
    } else {
      const id = `resp_${randomUUID()}`
      let sequence = 0
      const output: Json[] = [], tools = new Map<number, number>()
      let messageIndex = -1, reasoningIndex = -1
      const emit = (type: string, data: Json): Promise<void> => write(res, event(type, { sequence_number: sequence++, ...data }))
      await emit('response.created', { response: { id, object: 'response', status: 'in_progress', model: original.model, output: [] } })
      await emit('response.in_progress', { response: { id, object: 'response', status: 'in_progress', model: original.model, output: [] } })
      async function* forward(): AsyncGenerator<ChatChunk> {
        for await (const chunk of replay()) {
          for (const choice of chunk.choices ?? []) {
            if (choice.index !== 0) continue
            const delta = choice.delta ?? {}
            if (delta.reasoning_content) {
              if (reasoningIndex === -1) { reasoningIndex = output.length; const item = { id: `rs_${randomUUID()}`, type: 'reasoning', summary: [{ type: 'summary_text', text: '' }] }; output.push(item); await emit('response.output_item.added', { output_index: reasoningIndex, item: { ...item, summary: [] } }); await emit('response.reasoning_summary_part.added', { item_id: item.id, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } }) }
              const item = output[reasoningIndex]; item.summary[0].text += delta.reasoning_content
              await emit('response.reasoning_summary_text.delta', { item_id: item.id, output_index: reasoningIndex, summary_index: 0, delta: delta.reasoning_content })
            }
            if (delta.content) {
              if (messageIndex === -1) { messageIndex = output.length; const item = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }], status: 'in_progress' }; output.push(item); await emit('response.output_item.added', { output_index: messageIndex, item: { ...item, content: [] } }); await emit('response.content_part.added', { item_id: item.id, output_index: messageIndex, content_index: 0, part: item.content[0] }) }
              const item = output[messageIndex]; item.content[0].text += delta.content
              await emit('response.output_text.delta', { item_id: item.id, output_index: messageIndex, content_index: 0, delta: delta.content })
            }
            for (const call of delta.tool_calls ?? []) {
              const slot = call.index ?? 0
              if (!Number.isInteger(slot) || slot < 0 || slot > 1024) throw new Error('Invalid upstream tool index')
              let index = tools.get(slot)
              if (index === undefined) { index = output.length; tools.set(slot, index); const item = { id: `fc_${randomUUID()}`, type: 'function_call', status: 'in_progress', call_id: call.id ?? `call_${randomUUID()}`, name: call.function?.name ?? '', arguments: '' }; output.push(item); await emit('response.output_item.added', { output_index: index, item: { ...item } }) }
              else if (call.function?.name) output[index].name += call.function.name
              const item = output[index]
              if (call.id) item.call_id = call.id
              if (call.function?.arguments) { item.arguments += call.function.arguments; await emit('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: call.function.arguments }) }
            }
          }
          yield chunk
        }
      }
      const result = chatToResponse(await collectChat(forward(), original.model)); result.id = id; result.output = output
      for (let index = 0; index < output.length; index++) {
        const item = output[index]
        if (item.type === 'message') { item.status = 'completed'; await emit('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text }); await emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] }) }
        else if (item.type === 'function_call') { item.status = 'completed'; await emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, name: item.name, arguments: item.arguments }) }
        else { await emit('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: item.summary[0].text }); await emit('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: item.summary[0] }) }
        await emit('response.output_item.done', { output_index: index, item })
      }
      await emit('response.completed', { response: result })
    }
    res.end()
  }
}
