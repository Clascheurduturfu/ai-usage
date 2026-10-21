import { randomUUID } from 'node:crypto'
import { extractAntigravityAccessToken, extractAntigravityRefreshToken, findAntigravityClientSecret, stateDbPath } from '../src/main/antigravity-quota'
import { sse, type ChatChunk, type Json } from './protocol'

const DEFAULT_BASE = 'https://daily-cloudcode-pa.googleapis.com'
const QUOTA_CLIENT = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

export class AntigravityClient {
  private session: Promise<{ access: string; project: string }> | null = null
  private signatures = new Map<string, string>()
  constructor(private base = DEFAULT_BASE, private stored?: () => Promise<Json | null>) {}
  private async credentials(force = false): Promise<{ access: string; project: string }> {
    if (this.session && !force) return this.session
    this.session = this.connect(force).catch((e) => { this.session = null; throw e })
    return this.session
  }
  private async connect(force: boolean): Promise<{ access: string; project: string }> {
    const saved = await this.stored?.()
    const file = stateDbPath()
    let access = saved?.accessToken ?? extractAntigravityAccessToken(file)
    const refresh = saved?.refreshToken ?? extractAntigravityRefreshToken(file)
    if (!access || force || (saved?.expiresAt && saved.expiresAt < Date.now() + 60_000)) {
      if (!refresh) throw new Error('Open Antigravity and sign in, then reconnect this endpoint')
      const secret = saved?.clientSecret ?? findAntigravityClientSecret()
      if (!secret) throw new Error('Installed Antigravity OAuth metadata was not found')
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: saved?.clientId ?? QUOTA_CLIENT, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Antigravity authentication failed: HTTP ${response.status}. Reconnect the installed account.`)
      access = (await response.json() as Json).access_token
    }
    if (!access) throw new Error('Antigravity did not return an access token')
    const load = await this.post('loadCodeAssist', access, { metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } })
    if (load.status === 401 && !force) return this.connect(true)
    if (!load.ok) throw await this.error(load, 'Account discovery')
    const body = await load.json() as Json
    const project = typeof body.cloudaicompanionProject === 'string' ? body.cloudaicompanionProject : body.cloudaicompanionProject?.id
    if (!project) throw new Error('Antigravity account has no discovered project. Open the IDE and complete account setup.')
    return { access, project }
  }
  private post(method: string, token: string, body: Json, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.base}/v1internal:${method}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity', 'X-Goog-Api-Client': 'gl-node/24.14.0'
    }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) })
  }
  private async error(response: Response, action: string): Promise<Error> {
    let code = ''
    try { const body = await response.json() as Json; code = body.error?.status ?? '' } catch { /* retain HTTP category */ }
    return Object.assign(new Error(`Antigravity ${action}: HTTP ${response.status}${code ? ` (${code})` : ''}`), { status: response.status })
  }
  async models(): Promise<string[]> {
    const session = await this.credentials()
    const response = await this.post('fetchAvailableModels', session.access, { project: session.project })
    if (!response.ok) throw await this.error(response, 'model discovery')
    const body = await response.json() as Json
    const models = body.models ?? body.availableModels ?? {}
    return (Array.isArray(models) ? models.map((v: Json) => v.model?.name ?? v.name ?? v.id) : Object.keys(models)).filter(Boolean).map((s: string) => s.replace(/^models\//, ''))
  }
  async *chat(body: Json, signal: AbortSignal): AsyncGenerator<ChatChunk> {
    const session = await this.credentials()
    const names = new Map<string, string>()
    for (const msg of body.messages ?? []) for (const call of msg.tool_calls ?? []) names.set(call.id, call.function.name)
    const system: string[] = [], contents: Json[] = []
    for (const msg of body.messages ?? []) {
      if (msg.role === 'system' || msg.role === 'developer') { system.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)); continue }
      const parts: Json[] = []
      if (msg.role === 'tool') parts.push({ functionResponse: { name: names.get(msg.tool_call_id) ?? msg.name ?? 'tool', response: { result: msg.content } } })
      else {
        if (typeof msg.content === 'string' && msg.content) parts.push({ text: msg.content })
        else for (const part of msg.content ?? []) {
          if (part.type === 'text') parts.push({ text: part.text })
          else if (part.type === 'image_url') {
            const image = part.image_url?.url?.match(/^data:([^;]+);base64,(.+)$/s)
            if (!image) throw new Error('Antigravity image input requires embedded image data')
            parts.push({ inlineData: { mimeType: image[1], data: image[2] } })
          } else throw new Error(`Unsupported Antigravity input type: ${part.type}`)
        }
        for (const call of msg.tool_calls ?? []) {
          const signature = this.signatures.get(call.id) ?? call.extra_content?.google?.thought_signature
          parts.push({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments || '{}'), id: call.id }, ...(signature ? { thoughtSignature: signature } : {}) })
        }
      }
      if (parts.length) contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts })
    }
    const request: Json = { contents, generationConfig: { maxOutputTokens: body.max_tokens ?? body.max_completion_tokens ?? 4096, temperature: body.temperature },
      ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n') }] } } : {}) }
    if (body.tools?.length) request.tools = [{ functionDeclarations: body.tools.map((tool: Json) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters ?? {} })) }]
    if (body.tool_choice === 'required') request.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
    if (body.tool_choice === 'none') request.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    if (body.tool_choice?.type === 'function') request.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [body.tool_choice.function.name] } }
    const response = await this.post('streamGenerateContent?alt=sse', session.access, {
      model: body.model, project: session.project, requestId: `agent-${randomUUID()}`, userAgent: 'antigravity', requestType: 'agent', request
    }, signal)
    if (!response.ok) { if (response.status === 401) this.session = null; throw await this.error(response, 'inference') }
    const id = `chatcmpl-${randomUUID()}`
    let calls = 0, hasCalls = false
    for await (const event of sse(response)) {
      if (event.error) throw new Error(`Antigravity stream error: ${event.error.status ?? 'upstream_error'}`)
      const value = event.response ?? event
      for (const candidate of value.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) yield { id, model: body.model, choices: [{ index: candidate.index ?? 0, delta: part.thought ? { reasoning_content: part.text } : { content: part.text } }] }
          if (part.functionCall) {
            const call = part.functionCall, callId = call.id ?? `call_${randomUUID()}`
            if (part.thoughtSignature) this.signatures.set(callId, part.thoughtSignature)
            if (this.signatures.size > 4096) this.signatures.delete(this.signatures.keys().next().value!)
            hasCalls = true
            yield { id, model: body.model, choices: [{ index: candidate.index ?? 0, delta: { tool_calls: [{ index: calls++, id: callId, type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }, ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}) }] } }] }
          }
        }
        if (candidate.finishReason) yield { id, choices: [{ index: candidate.index ?? 0, delta: {}, finish_reason: hasCalls ? 'tool_calls' : candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop' }] }
      }
      if (value.usageMetadata) yield { id, usage: { prompt_tokens: value.usageMetadata.promptTokenCount, completion_tokens: value.usageMetadata.candidatesTokenCount,
        total_tokens: value.usageMetadata.totalTokenCount, completion_tokens_details: { reasoning_tokens: value.usageMetadata.thoughtsTokenCount ?? 0 } }, choices: [] }
    }
  }
}
