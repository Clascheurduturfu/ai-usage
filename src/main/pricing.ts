import type { ModelPrice, Settings, PriceCatalogEntry } from '../shared/types'

/**
 * Cost estimation for usage events whose provider does not record real cost.
 * Prices are USD per 1M tokens, best-known 2026 public list prices.
 * Every value is user-overridable in Settings (by exact model id), and the UI
 * always labels estimated costs as estimates.
 */
interface PriceRule {
  label: string
  match: RegExp
  price: ModelPrice
  sourceUrl?: string
  note?: string
  verifiedAt?: string
  after?: { date: string; price: ModelPrice }
}

const openai = 'https://developers.openai.com/api/docs/models/'
const google = 'https://ai.google.dev/gemini-api/docs/pricing'
const verifiedAt = '2026-10-13'
const rates = (input: number, output: number, cacheRead: number, cacheWrite = input): ModelPrice => ({ input, output, cacheRead, cacheWrite })
const gpt = (label: string, model: string, price: ModelPrice, note?: string): PriceRule => ({ label, match: new RegExp(`(?:^|/)${model.replaceAll('.', '\\.')}(?:$|-(?:20\\d{2}-\\d{2}-\\d{2}|low|medium|high|xhigh|max|ultra)$)`), price, sourceUrl: openai + model, note, verifiedAt })
const flashPromo = { date: '2027-01-01', price: rates(1.5, 7.5, 0.15) }
const contextNote = 'Standard text rate. Long-context, service-tier and tool surcharges are not included.'
const flashNote = 'Launch rates through Dec 31, 2026; then $1.50 input / $7.50 output. Experimental client aliases use the same family estimate.'
function effectivePrice(rule: PriceRule): ModelPrice { return rule.after && Date.now() >= Date.parse(rule.after.date + 'T00:00:00Z') ? rule.after.price : rule.price }

const PRICE_RULES: PriceRule[] = [
  // Explicit free routes must precede provider-family rules.
  { label: 'Free model routes', match: /(?:-|:)free$/, price: rates(0, 0, 0, 0), note: 'Only model IDs explicitly marked free.' },
  // Anthropic — Claude
  { label: 'Claude Fable 5.2', match: /fable-5[.-]2|mythos-5[.-]2/, price: rates(8, 40, 0.2, 10), sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-11-16', note: 'Same rates for Claude Mythos 5.2. Fast mode is 2x.' },
  { label: 'Claude Fable 5 / 5.1', match: /fable-5|mythos-5/, price: rates(10, 50, 1, 12.5), sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-11-16', note: 'Cache rates assume the usual 0.1x read / 1.25x write.' },
  { label: 'Claude Opus 5.5', match: /opus-5[.-]5/, price: rates(4, 20, 0.2, 5), sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-10-16' },
  { label: 'Claude Sonnet 5.5', match: /sonnet-5[.-]5/, price: rates(2, 10, 0.1, 2.5), sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-10-16' },
  { label: 'Claude Haiku 5.5', match: /haiku-5[.-]5/, price: rates(0.1, 0.5, 0.01, 0.125), sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-10-16', note: 'Prompts over 100K tokens use 5x rates, including cached input. Estimated per request, not from the session total. 1h writes use 2x input pricing.' },
  { label: 'Claude Opus 5', match: /opus-5/, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { label: 'Claude Opus 4.5 – 4.8', match: /opus-4[.-][5-8]/, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-11-16' },
  { label: 'Claude Opus 4 / 4.1', match: /opus-4(?![.-]?[5-8])/, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { label: 'Claude Sonnet 5', match: /sonnet-5/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { label: 'Claude Sonnet 4.5+', match: /sonnet-4-(5|6)|sonnet-4\.(5|6)/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { label: 'Claude Sonnet 4', match: /sonnet-4(?!-)/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { label: 'Claude 3.7 Sonnet', match: /claude-3-7-sonnet|claude-3\.7-sonnet/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { label: 'Claude 3.5 Sonnet', match: /claude-3-5-sonnet|claude-3\.5-sonnet/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { label: 'Claude Haiku 5', match: /haiku-5/, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { label: 'Claude Haiku 4.5', match: /haiku-4-5|haiku-4\.5/, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { label: 'Claude 3.5 Haiku', match: /haiku-3-5|haiku-3\.5/, price: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  // OpenAI — Codex / GPT
  gpt('GPT-6.1 Sol', 'gpt-6.1-sol', rates(2, 10, 0.1, 2.5), contextNote),
  { ...gpt('GPT-6.1 Terra', 'gpt-6.1-terra', rates(1, 5, 0.05, 1.25), contextNote + ' Prompts over 272K input: 2x input and cache, 1.5x output.'), verifiedAt: '2026-11-16' },
  gpt('GPT-6 Astra', 'gpt-6-astra', rates(10, 50, 1, 12.5), contextNote),
  gpt('GPT-6 Sol', 'gpt-6-sol', rates(2, 10, 0.2, 2.5), contextNote),
  gpt('GPT-6 Luna', 'gpt-6-luna', rates(0.1, 0.5, 0.01, 0.125), contextNote),
  gpt('GPT-5.6 Sol', 'gpt-5.6-sol', rates(4, 20, 0.4, 5), contextNote + ' Promotional rate guaranteed at least through Nov 21, 2026; no subsequent rate announced.'),
  gpt('GPT-5.6 Terra', 'gpt-5.6-terra', rates(2, 12, 0.2, 2.5), contextNote),
  gpt('GPT-5.6 Luna', 'gpt-5.6-luna', rates(0.2, 1.2, 0.02, 0.25), contextNote),
  gpt('GPT-5.5', 'gpt-5.5', rates(5, 30, 0.5), contextNote),
  gpt('GPT-5.4', 'gpt-5.4', rates(2.5, 15, 0.25), contextNote),
  gpt('GPT-5.4 Mini', 'gpt-5.4-mini', rates(0.75, 4.5, 0.075), contextNote),
  gpt('GPT-5.3 Codex', 'gpt-5.3-codex', rates(1.75, 14, 0.175)),
  gpt('GPT-5.2 Codex', 'gpt-5.2-codex', rates(1.75, 14, 0.175)),
  gpt('GPT-5.1 Codex Mini', 'gpt-5.1-codex-mini', rates(0.25, 2, 0.025)),
  gpt('GPT-5.1 Codex', 'gpt-5.1-codex', rates(1.25, 10, 0.125)),
  gpt('GPT-5 Codex', 'gpt-5-codex', rates(1.25, 10, 0.125)),
  gpt('GPT-5 Mini', 'gpt-5-mini', rates(0.25, 2, 0.025)),
  gpt('GPT-5 Nano', 'gpt-5-nano', rates(0.05, 0.4, 0.005)),
  gpt('GPT-5', 'gpt-5', rates(1.25, 10, 0.125)),
  gpt('o4-mini', 'o4-mini', rates(1.1, 4.4, 0.275)),
  gpt('GPT-4o Mini', 'gpt-4o-mini', rates(0.15, 0.6, 0.075)),
  gpt('GPT-4o', 'gpt-4o', rates(2.5, 10, 1.25)),
  // Google — Gemini
  { label: 'Gemini 4 Carbon', match: /gemini-4-carbon(?:$|-preview$)/, price: rates(4, 20, 0.4), sourceUrl: 'https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-carbon/', verifiedAt: '2026-11-16', note: 'Rates after the introductory period; any launch discount is not applied.' },
  { label: 'Gemini 4 Hydrogen', match: /gemini-4-hydrogen(?:$|-preview$)/, price: rates(1.5, 7.5, 0.075), sourceUrl: 'https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/', verifiedAt: '2026-11-16', note: 'Flat across the 1M context. Global endpoint; other regions are about 10% higher.' },
  { label: 'Gemini 4 Argon', match: /gemini-4-argon(?:$|-(?:preview|trial)$)/, price: rates(2, 10, 0.1), after: { date: '2026-12-01', price: rates(4, 20, 0.2) }, sourceUrl: google, verifiedAt, note: 'Launch rates through Nov 30, 2026; then $4 input / $20 output. Implicit caching only.' },
  { label: 'Gemini 3.8 Flash', match: /gemini-3[.p-]8-flash(?:$|-(?:tiered|preview|exp-[a-z]|[a-z])$)/, price: rates(0.75, 3.75, 0.075), after: flashPromo, sourceUrl: google, verifiedAt, note: flashNote },
  { label: 'Gemini 3.7 Flash', match: /gemini-3[.p-]7-flash(?:$|-(?:tiered|preview|exp-[a-z]|[a-z])$)/, price: rates(0.75, 3.75, 0.075), after: flashPromo, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing', verifiedAt, note: flashNote },
  { label: 'Gemini 3.6 Flash', match: /gemini-3[.p-]6-flash(?:$|-(?:tiered|preview|exp-[a-z]|[a-z])$)/, price: rates(0.75, 3.75, 0.075), after: flashPromo, sourceUrl: google, verifiedAt, note: flashNote },
  { label: 'Gemini 3.5 Flash', match: /gemini-3[.p-]5-flash(?:$|-(?:preview|[a-z])$)/, price: rates(1.5, 9, 0.15), sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing', verifiedAt: '2026-11-16', note: 'Thinking tokens bill at the output rate. Global endpoint.' },
  { label: 'Gemini 3.5 Flash-Lite', match: /gemini-3[.p-]5-flash-lite(?:$|-preview$)/, price: rates(0.3, 2.5, 0.03), sourceUrl: google, verifiedAt },
  { label: 'Gemini 3.1 Pro', match: /gemini-3[.p-]1-pro(?:$|-(?:high|low|preview|preview-customtools)$)/, price: rates(2, 12, 0.2), sourceUrl: google, verifiedAt, note: 'Prompts over 200K: $4 input / $18 output / $0.40 cached input. Estimates use the base tier.' },
  { label: 'Gemini 3.1 Flash-Lite', match: /gemini-3[.p-]1-flash-lite(?:$|-preview$)/, price: rates(0.25, 1.5, 0.025), sourceUrl: google, verifiedAt, note: 'Text rates; audio input has a separate price.' },
  { label: 'Gemini 3 Pro', match: /gemini-3-pro(?:$|-preview$)/, price: rates(2, 12, 0.2), sourceUrl: google, verifiedAt, note: 'Legacy model. Base prompt tier.' },
  { label: 'Gemini 3 Flash', match: /gemini-3-flash(?:$|-(?:preview|[a-z])$)/, price: rates(0.5, 3, 0.05), sourceUrl: 'https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-3-flash/', verifiedAt, note: 'Legacy model. Text rates.' },
  { label: 'Gemini 2.5 Pro', match: /gemini-2\.5-pro(?:$|-preview.*$)/, price: rates(1.25, 10, 0.125), sourceUrl: google, verifiedAt, note: 'Prompts over 200K: $2.50 input / $15 output / $0.25 cached input. Estimates use the base tier.' },
  { label: 'Gemini 2.5 Flash-Lite', match: /gemini-2\.5-flash-lite(?:$|-preview.*$)/, price: rates(0.1, 0.4, 0.01), sourceUrl: google, verifiedAt },
  { label: 'Gemini 2.5 Flash', match: /gemini-2\.5-flash(?:$|-preview.*$)/, price: rates(0.3, 2.5, 0.03), sourceUrl: google, verifiedAt, note: 'Text rates; audio input has a separate price.' },
  // Zhipu — GLM
  { label: 'GLM 5.3 Flash', match: /glm-5\.3-flash/, price: { input: 0.11, output: 0.51, cacheRead: 0.022, cacheWrite: 0.14 } },
  { label: 'GLM 5.3', match: /glm-5\.3/, price: { input: 0.55, output: 2.1, cacheRead: 0.11, cacheWrite: 0.69 } },
  { label: 'GLM 4.x', match: /glm-4/, price: { input: 0.6, output: 2.2, cacheRead: 0.12, cacheWrite: 0.75 } },
  // Moonshot — Kimi
  { label: 'Kimi K2.x', match: /kimi-k2/, price: { input: 0.6, output: 2.5, cacheRead: 0.12, cacheWrite: 0.75 } },
  // DeepSeek
  { label: 'DeepSeek', match: /deepseek/, price: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 } },
  // Qwen
  { label: 'Qwen', match: /qwen/, price: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.5 } },
]

export function priceFor(model: string | null | undefined, overrides: Settings['pricingOverrides'], longContext = false): ModelPrice | null {
  if (!model) return null
  const lower = model.toLowerCase()
  const rule = PRICE_RULES.find(r => r.match.test(lower))
  let base = rule ? effectivePrice(rule) : null
  if (base && longContext && /haiku-5[.-]5/.test(lower)) base = { input: base.input * 5, output: base.output * 5, cacheRead: base.cacheRead * 5, cacheWrite: base.cacheWrite * 5 }
  const ov = overrides[model]
  if (ov) {
    return {
      input: ov.input ?? base?.input ?? 0,
      output: ov.output ?? base?.output ?? 0,
      cacheRead: ov.cacheRead ?? base?.cacheRead ?? (ov.input != null ? ov.input * 0.1 : 0),
      cacheWrite: ov.cacheWrite ?? base?.cacheWrite ?? ov.input ?? 0
    }
  }
  return base
}

export interface TokenMix {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  longContext?: boolean
  priceMultiplier?: number
}

/** Estimated USD cost of a token mix, or null when the model has no known price. */
export function estimateCost(model: string | null | undefined, mix: TokenMix, overrides: Settings['pricingOverrides']): number | null {
  const p = priceFor(model, overrides, mix.longContext)
  if (!p) return null
  const m = 1_000_000
  const write1h = Math.min(mix.cacheWrite, Math.max(0, mix.cacheWrite1h ?? 0))
  return (
    (mix.input / m) * p.input +
    (mix.output / m) * p.output +
    (mix.cacheRead / m) * p.cacheRead +
    ((mix.cacheWrite - write1h) / m) * p.cacheWrite +
    (write1h / m) * (model && overrides[model]?.cacheWrite !== undefined ? p.cacheWrite : p.input * 2)
  ) * (mix.priceMultiplier ?? 1)
}

/** All catalog entries (for the Settings pricing table). */
export function priceCatalog(observedModels: string[] = []): PriceCatalogEntry[] {
  return [...PRICE_RULES.map((r) => ({
    label: r.label,
    matchSource: r.match.source,
    price: effectivePrice(r), sourceUrl: r.sourceUrl, verifiedAt: r.verifiedAt, note: r.note
  })), ...observedModels.filter(model => !PRICE_RULES.some(r => r.match.test(model.toLowerCase()))).sort().map(model => ({ label: model, matchSource: '', price: null, note: 'No verified price for this model ID. Add an exact override if you know its rate.' }))]
}
