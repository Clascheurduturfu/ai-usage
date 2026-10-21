import type { EndpointRecord } from './manager'
export interface EndpointPreset { provider: string; name: string; baseUrl: string; protocol: EndpointRecord['protocol']; category: 'Local' | 'Providers' | 'Gateways'; responsesState?: boolean }
// Public definitions only. Credentials and model caches are never packaged.
const definitions: Array<[string, string, string, EndpointPreset['category']]> = [
  ['ollama', 'Ollama Local', 'http://127.0.0.1:11434/v1', 'Local'],
  ['lmstudio', 'LM Studio', 'http://127.0.0.1:1234/v1', 'Local'],
  ['openai', 'OpenAI', 'https://api.openai.com/v1', 'Providers'],
  ['anthropic', 'Anthropic', 'https://api.anthropic.com', 'Providers'],
  ['gemini', 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'Providers'],
  ['mistral', 'Mistral', 'https://api.mistral.ai/v1', 'Providers'],
  ['deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'Providers'],
  ['groq', 'Groq', 'https://api.groq.com/openai/v1', 'Providers'],
  ['cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', 'Providers'],
  ['nvidia', 'NVIDIA', 'https://integrate.api.nvidia.com/v1', 'Providers'],
  ['xai', 'xAI', 'https://api.x.ai/v1', 'Providers'],
  ['together', 'Together', 'https://api.together.ai/v1', 'Providers'],
  ['fireworks', 'Fireworks', 'https://api.fireworks.ai/inference/v1', 'Providers'],
  ['inception', 'Inception / Mercury', 'https://api.inceptionlabs.ai/v1', 'Providers'],
  ['ollama-cloud', 'Ollama Cloud', 'https://ollama.com/v1', 'Providers'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'Gateways'],
  ['huggingface', 'Hugging Face', 'https://router.huggingface.co/v1', 'Gateways'],
  ['digitalocean', 'DigitalOcean Serverless', 'https://inference.do-ai.run/v1', 'Gateways'],
  ['vercel', 'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'Gateways'],
  ['opencode', 'OpenCode', 'https://opencode.ai/inference/v1', 'Gateways']
]
export const ENDPOINT_PRESETS: EndpointPreset[] = definitions.map(([provider, name, baseUrl, category]) => ({ provider, name, baseUrl, category,
  protocol: provider === 'anthropic' ? 'anthropic' : ['openai', 'xai', 'opencode'].includes(provider) ? 'openai-responses' : 'openai-chat', responsesState: ['openai', 'xai'].includes(provider) }))
export const defaultEndpoints = (): EndpointRecord[] => ENDPOINT_PRESETS.map(p => ({ ...p, id: `default-${p.provider}`, credentialKind: 'api-key', models: [], catalogId: p.provider }))
export function migrateEndpoint(endpoint: EndpointRecord): EndpointRecord {
  const legacy = endpoint.protocol as string
  let nativeResponses = false
  try { nativeResponses = legacy === 'openai' && ['api.openai.com', 'api.x.ai'].includes(new URL(endpoint.baseUrl).hostname) } catch { /* Preserve incomplete entries as drafts. */ }
  return { ...endpoint, protocol: nativeResponses ? 'openai-responses' : legacy === 'openai' || legacy === 'ollama' ? 'openai-chat' : endpoint.protocol,
    ...(nativeResponses ? { responsesState: true } : {}),
    baseUrl: legacy === 'ollama' && endpoint.baseUrl && !endpoint.baseUrl.replace(/\/$/, '').endsWith('/v1') ? endpoint.baseUrl.replace(/\/$/, '') + '/v1' : endpoint.baseUrl,
    ...(endpoint.baseUrl ? {} : { draft: true }) }
}
