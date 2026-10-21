import path from 'node:path'
import type { EndpointRecord, EndpointTest } from '../src/shared/manager'
import { Vault } from '../src/main/manager/storage'
import { ClineCredentials } from './cline'
import { AntigravityClient } from './antigravity'
import { anthropicChunks, chatToAnthropic, collectChat, sse, type ChatChunk, type Json } from './protocol'
import { chatToResponses, responseChunks, requireStateless } from './responses'

export function redact(value: string): string {
  return value.replace(/(?:sk-[\w-]+|ya29\.[\w.-]+|1\/\/[\w.-]+|GOCSPX-[\w-]+)/g, '[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
}
export function openaiBase(endpoint: EndpointRecord): string {
  const base = endpoint.baseUrl.replace(/\/$/, '')
  return base
}
export class EndpointEngine {
  private cline = new Map<string, ClineCredentials>()
  private agy = new Map<string, AntigravityClient>()
  constructor(private vault: Vault, private home: string) {}
  reset(id: string): void { this.cline.delete(id); this.agy.delete(id) }
  private agyClient(endpoint: EndpointRecord): AntigravityClient {
    let client = this.agy.get(endpoint.id)
    if (!client) {
      client = new AntigravityClient(endpoint.baseUrl, async () => endpoint.secretRef ? JSON.parse(await this.vault.get(endpoint.secretRef)) : null)
      this.agy.set(endpoint.id, client)
    }
    return client
  }
  private async token(endpoint: EndpointRecord, force = false): Promise<string> {
    if (endpoint.credentialKind !== 'cline') return this.vault.get(endpoint.secretRef)
    let client = this.cline.get(endpoint.id)
    if (!client) { client = new ClineCredentials(path.join(this.home, '.cline/data/settings/providers.json'), endpoint.baseUrl, {
      read: async () => endpoint.secretRef ? JSON.parse(await this.vault.get(endpoint.secretRef)) : null,
      write: async auth => { if (!endpoint.secretRef) throw new Error('No portable credential reference'); await this.vault.set(endpoint.secretRef, JSON.stringify(auth)) }
    }); this.cline.set(endpoint.id, client) }
    return client.token(force)
  }
  async headers(endpoint: EndpointRecord, force = false): Promise<Record<string, string>> {
    const token = await this.token(endpoint, force)
    return endpoint.protocol === 'anthropic'
      ? { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(token ? { 'x-api-key': token } : {}) }
      : { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(endpoint.credentialKind === 'cline' ? { 'HTTP-Referer': 'http://localhost', 'X-Title': 'AI Usage' } : {}) }
  }
  async checkError(response: Response): Promise<void> {
    if (response.ok) return
    let detail = ''
    try { const payload = await response.json() as Json; detail = String(payload.error?.message ?? payload.message ?? payload.error?.type ?? '') } catch { /* no JSON detail */ }
    throw Object.assign(new Error(`Upstream HTTP ${response.status}${detail ? `: ${redact(detail).slice(0, 500)}` : ''}`), { status: response.status })
  }
  async models(endpoint: EndpointRecord): Promise<string[]> {
    if (endpoint.draft || !endpoint.baseUrl) throw new Error('Configure this endpoint URL first')
    if (endpoint.credentialKind === 'antigravity') return this.agyClient(endpoint).models()
    const base = endpoint.baseUrl.replace(/\/$/, '')
    const url = endpoint.protocol === 'anthropic' ? `${base.replace(/\/v1$/, '')}/v1/models` : `${base}/models`
    const response = await fetch(url, { headers: await this.headers(endpoint), signal: AbortSignal.timeout(30_000) })
    await this.checkError(response)
    const result = await response.json() as Json
    return (result.data ?? result.models ?? []).map((m: Json) => m.id ?? m.name ?? m.model).filter((id: unknown) => typeof id === 'string')
  }
  async test(endpoint: EndpointRecord): Promise<EndpointTest> {
    const start = Date.now()
    try { const models = await this.models(endpoint); return { ok: true, latencyMs: Date.now() - start, models } }
    catch (error) { return { ok: false, latencyMs: Date.now() - start, models: [], error: redact((error as Error).message) } }
  }
  async *chat(endpoint: EndpointRecord, body: Json, signal: AbortSignal): AsyncGenerator<ChatChunk> {
    if (endpoint.protocol === 'openai-responses') { yield* responseChunks(await this.responses(endpoint, chatToResponses(body), signal)); return }
    if (endpoint.credentialKind === 'antigravity') { yield* this.agyClient(endpoint).chat(body, signal); return }
    const url = endpoint.protocol === 'anthropic' ? `${endpoint.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/messages` : `${openaiBase(endpoint)}/chat/completions`
    const payload = endpoint.protocol === 'anthropic' ? chatToAnthropic(body) : { ...body, stream: true }
    let response = await fetch(url, { method: 'POST', headers: await this.headers(endpoint), body: JSON.stringify(payload), signal })
    if (response.status === 401 && endpoint.credentialKind === 'cline') {
      await response.body?.cancel()
      response = await fetch(url, { method: 'POST', headers: await this.headers(endpoint, true), body: JSON.stringify(payload), signal })
    }
    await this.checkError(response)
    if (endpoint.protocol === 'anthropic') yield* anthropicChunks(response)
    else if (response.headers.get('content-type')?.includes('text/event-stream')) yield* sse(response)
    else {
      const value = await response.json() as Json
      yield { id: value.id, model: value.model, usage: value.usage, choices: value.choices?.map((choice: Json) => ({ index: choice.index, delta: choice.message, finish_reason: choice.finish_reason })) }
    }
  }
  async responses(endpoint: EndpointRecord, body: Json, signal: AbortSignal): Promise<Response> {
    if (endpoint.protocol !== 'openai-responses') throw Object.assign(new Error('Select a native Responses endpoint'), { status: 400 })
    if (!endpoint.responsesState) requireStateless(body)
    const response = await fetch(`${openaiBase(endpoint)}/responses`, { method: 'POST', headers: await this.headers(endpoint), body: JSON.stringify(body), signal })
    await this.checkError(response); return response
  }
  async testChat(endpoint: EndpointRecord, model: string, prompt: string): Promise<{ text: string; latencyMs: number }> {
    const start = Date.now()
    const result = await collectChat(this.chat(endpoint, { model, messages: [{ role: 'user', content: prompt }], max_tokens: 128 }, AbortSignal.timeout(90_000)), model)
    return { text: result.choices[0]?.message?.content ?? '', latencyMs: Date.now() - start }
  }
}
