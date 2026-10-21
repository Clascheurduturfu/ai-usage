import type { ChatChunk, Json } from './protocol'
import { sse } from './protocol'

export function unsupported(feature: string): never { throw Object.assign(new Error(`Unsupported Feature: ${feature} requires a compatible native Responses endpoint`), { status: 400 }) }
export function requireStateless(body: Json): void {
  for (const key of ['previous_response_id', 'conversation']) if (body[key] !== undefined && body[key] !== null) unsupported(key)
  if (body.background === true) unsupported('background mode')
  if (body.store === true) unsupported('stored response state')
  for (const tool of body.tools ?? []) if (tool.type !== 'function') unsupported(`hosted tool ${tool.type}`)
}
export function responsesToChat(body: Json): Json {
  requireStateless(body)
  const messages: Json[] = body.instructions ? [{ role: 'system', content: body.instructions }] : []
  if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input })
  else for (const item of body.input ?? []) {
    if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output })
    else if (item.type === 'function_call') messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] })
    else if (!item.type || item.type === 'message') messages.push({ role: item.role, content: typeof item.content === 'string' ? item.content : (item.content ?? []).map((p: Json) => {
      if (['input_text', 'output_text', 'text'].includes(p.type)) return { type: 'text', text: p.text }
      if (p.type === 'input_image') return { type: 'image_url', image_url: { url: p.image_url, detail: p.detail } }
      return unsupported(`input content ${p.type}`)
    }) })
    else unsupported(`input item ${item.type}`)
  }
  return { model: body.model, messages, max_tokens: body.max_output_tokens, stream: body.stream, temperature: body.temperature, top_p: body.top_p, parallel_tool_calls: body.parallel_tool_calls,
    tools: body.tools?.map((t: Json) => { if (t.type !== 'function') unsupported(`hosted tool ${t.type}`); return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters, strict: t.strict } } }),
    tool_choice: body.tool_choice?.type === 'function' ? { type: 'function', function: { name: body.tool_choice.name } } : body.tool_choice }
}
export function chatToResponses(body: Json): Json {
  const input: Json[] = []
  for (const message of body.messages ?? []) {
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' })
    else {
      if (message.content) input.push({ type: 'message', role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map((part: Json) => {
        if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
        if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url, detail: part.image_url?.detail }
        return unsupported(`Chat content ${part.type}`)
      }) })
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
    }
  }
  return { model: body.model, input, stream: true, store: false, max_output_tokens: body.max_completion_tokens ?? body.max_tokens, temperature: body.temperature, top_p: body.top_p,
    reasoning: body.reasoning_effort ? { effort: body.reasoning_effort } : undefined,
    tools: body.tools?.map((t: Json) => { if (t.type !== 'function') unsupported(`Chat tool ${t.type}`); return { type: 'function', ...t.function } }),
    tool_choice: typeof body.tool_choice === 'object' ? { type: 'function', name: body.tool_choice.function?.name } : body.tool_choice }
}
export async function* responseChunks(response: Response): AsyncGenerator<ChatChunk> {
  const indices = new Map<string, number>(); let next = 0, id = '', model = ''
  for await (const e of sse(response)) {
    if (e.response) { id = e.response.id ?? id; model = e.response.model ?? model }
    if (['error', 'response.failed', 'response.incomplete'].includes(e.type)) throw new Error(e.error?.message ?? e.response?.error?.message ?? `Upstream ${e.type}`)
    if (e.type === 'response.output_text.delta') yield { id, model, choices: [{ index: 0, delta: { content: e.delta } }] }
    if (e.type === 'response.reasoning_summary_text.delta') yield { id, model, choices: [{ index: 0, delta: { reasoning_content: e.delta } }] }
    if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') {
      const index = next++; indices.set(e.item.id, index)
      yield { id, model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: e.item.call_id, type: 'function', function: { name: e.item.name, arguments: '' } }] } }] }
    }
    if (e.type === 'response.function_call_arguments.delta') {
      const index = indices.get(e.item_id); if (index === undefined) throw new Error('Responses tool delta precedes its function item')
      yield { id, model, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: e.delta } }] } }] }
    }
    if (e.type === 'response.completed') yield { id, model, choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: e.response?.usage?.input_tokens, completion_tokens: e.response?.usage?.output_tokens, total_tokens: e.response?.usage?.total_tokens } }
  }
}
