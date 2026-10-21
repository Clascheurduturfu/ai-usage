import { randomUUID } from 'node:crypto'

export type Json = Record<string, any>
export interface ChatChunk { id?: string; model?: string; choices?: Array<{ index: number; delta?: Json; finish_reason?: string | null }>; usage?: Json }

export async function* sse(response: Response): AsyncGenerator<Json> {
  if (!response.body) throw new Error('Upstream returned an empty stream')
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let frameSize = 0
  function parse(lines: string[]): Json | null {
    const text = lines.join('\n').trim()
    if (!text || text === '[DONE]') return null
    return JSON.parse(text)
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    if (buffer.length > 8 * 1024 * 1024) throw new Error('Upstream stream frame is too large')
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.startsWith('data:')) { frameSize += line.length; if (frameSize > 8 * 1024 * 1024) throw new Error('Upstream stream frame is too large'); data.push(line.slice(5).trimStart()) }
      else if (!line && data.length) { const event = parse(data); data = []; frameSize = 0; if (event) yield event }
    }
  }
  buffer += decoder.decode()
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim())
  if (data.length) { const event = parse(data); if (event) yield event }
}

export function anthropicToChat(body: Json): Json {
  const messages: Json[] = []
  if (body.system) messages.push({ role: 'system', content: typeof body.system === 'string' ? body.system : body.system.filter((v: Json) => v.type === 'text').map((v: Json) => v.text).join('\n') })
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') { messages.push(message); continue }
    const content: Json[] = [], tools: Json[] = [], results: Json[] = []
    for (const part of message.content ?? []) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text })
      else if (part.type === 'image' && part.source?.type === 'base64') content.push({ type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } })
      else if (part.type === 'image' && part.source?.type === 'url') content.push({ type: 'image_url', image_url: { url: part.source.url } })
      else if (part.type === 'tool_use') tools.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } })
      else if (part.type === 'tool_result') results.push({ role: 'tool', tool_call_id: part.tool_use_id, content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '') })
      else if (part.type !== 'thinking' && part.type !== 'redacted_thinking') throw new Error(`Unsupported Anthropic content type: ${part.type}`)
    }
    if (content.length || tools.length) messages.push({ role: message.role, content, ...(tools.length ? { tool_calls: tools } : {}) })
    messages.push(...results)
  }
  const result: Json = { model: body.model, messages, stream: true, max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stop: body.stop_sequences }
  if (body.tools) result.tools = body.tools.map((tool: Json) => {
    if (tool.type && !['custom', 'function'].includes(tool.type)) throw new Error(`Hosted tool ${tool.type} is unsupported by this endpoint`)
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema ?? {} } }
  })
  if (body.tool_choice) {
    result.tool_choice = body.tool_choice.type === 'tool' ? { type: 'function', function: { name: body.tool_choice.name } }
      : body.tool_choice.type === 'any' ? 'required' : body.tool_choice.type === 'none' ? 'none' : 'auto'
  }
  return result
}

export function chatToAnthropic(body: Json): Json {
  const toolNames = new Map<string, string>()
  for (const msg of body.messages ?? []) for (const call of msg.tool_calls ?? []) toolNames.set(call.id, call.function.name)
  const messages: Json[] = []
  const system: string[] = []
  for (const msg of body.messages ?? []) {
    if (msg.role === 'system' || msg.role === 'developer') { system.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)); continue }
    if (msg.role === 'tool') { messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content ?? '' }] }); continue }
    const parts: Json[] = []
    if (typeof msg.content === 'string' && msg.content) parts.push({ type: 'text', text: msg.content })
    else for (const part of msg.content ?? []) {
      if (part.type === 'text') parts.push(part)
      else if (part.type === 'image_url') {
        const url = part.image_url?.url ?? ''
        const image = url.match(/^data:([^;]+);base64,(.+)$/s)
        parts.push({ type: 'image', source: image ? { type: 'base64', media_type: image[1], data: image[2] } : { type: 'url', url } })
      } else throw new Error(`Unsupported OpenAI content type: ${part.type}`)
    }
    for (const call of msg.tool_calls ?? []) parts.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') })
    if (parts.length) messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: parts })
  }
  return { model: body.model, messages, system: system.join('\n'), stream: true,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096, temperature: body.temperature,
    tools: body.tools?.map((t: Json) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? {} })),
    tool_choice: body.tool_choice === 'required' ? { type: 'any' } : body.tool_choice === 'none' ? { type: 'none' } : typeof body.tool_choice === 'object' ? { type: 'tool', name: body.tool_choice.function.name } : { type: 'auto' } }
}

export async function* anthropicChunks(response: Response): AsyncGenerator<ChatChunk> {
  let id = '', model = ''
  const calls = new Map<number, number>()
  let toolIndex = 0
  for await (const event of sse(response)) {
    if (event.type === 'error') throw new Error(event.error?.message ?? 'Anthropic stream failed')
    if (event.type === 'message_start') {
      id = event.message.id; model = event.message.model
      yield { id, model, choices: [{ index: 0, delta: { role: 'assistant' } }], usage: { prompt_tokens: event.message.usage?.input_tokens } }
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const index = toolIndex++; calls.set(event.index, index)
      yield { id, model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }] } }] }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta
      const part = delta.type === 'text_delta' ? { content: delta.text } : delta.type === 'thinking_delta' ? { reasoning_content: delta.thinking }
        : delta.type === 'input_json_delta' ? { tool_calls: [{ index: calls.get(event.index), function: { arguments: delta.partial_json } }] } : {}
      yield { id, model, choices: [{ index: 0, delta: part }] }
    } else if (event.type === 'message_delta') yield { id, model, choices: [{ index: 0, delta: {}, finish_reason: event.delta.stop_reason === 'tool_use' ? 'tool_calls' : event.delta.stop_reason === 'max_tokens' ? 'length' : 'stop' }], usage: { completion_tokens: event.usage?.output_tokens } }
  }
}

export async function collectChat(chunks: AsyncIterable<ChatChunk>, model: string): Promise<Json> {
  const choices = new Map<number, Json>()
  let id = `chatcmpl-${randomUUID()}`, usage: Json = {}
  let size = 0
  for await (const chunk of chunks) {
    if (chunk.id) id = chunk.id
    if (chunk.usage) usage = { ...usage, ...Object.fromEntries(Object.entries(chunk.usage).filter(([, v]) => v !== undefined)) }
    for (const choice of chunk.choices ?? []) {
      let item = choices.get(choice.index)
      if (!item) { item = { index: choice.index, message: { role: 'assistant', content: '' }, finish_reason: null }; choices.set(choice.index, item) }
      const delta = choice.delta ?? {}
      for (const key of ['content', 'reasoning_content']) if (delta[key]) { item.message[key] = (item.message[key] ?? '') + delta[key]; size += delta[key].length }
      for (const tc of delta.tool_calls ?? []) {
        item.message.tool_calls ??= []
        const index = tc.index ?? 0
        const stored = item.message.tool_calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) stored.id = tc.id
        if (tc.function?.name) stored.function.name += tc.function.name
        if (tc.function?.arguments) { stored.function.arguments += tc.function.arguments; size += tc.function.arguments.length }
        if (tc.extra_content) stored.extra_content = tc.extra_content
      }
      if (choice.finish_reason) item.finish_reason = choice.finish_reason
    }
    if (size > 16 * 1024 * 1024) throw new Error('Buffered response exceeds 16 MiB')
  }
  return { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [...choices.values()].map((c) => ({ ...c, finish_reason: c.finish_reason ?? 'stop' })), usage }
}

export function chatResultToAnthropic(result: Json): Json {
  const msg = result.choices[0]?.message ?? {}
  const content: Json[] = []
  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content })
  if (msg.content) content.push({ type: 'text', text: msg.content })
  for (const call of msg.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') })
  return { id: result.id.replace(/^chatcmpl-/, 'msg_'), type: 'message', role: 'assistant', model: result.model, content,
    stop_reason: msg.tool_calls?.length ? 'tool_use' : result.choices[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: result.usage?.prompt_tokens ?? 0, output_tokens: result.usage?.completion_tokens ?? 0 } }
}
