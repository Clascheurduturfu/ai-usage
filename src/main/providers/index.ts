import type { ProviderId } from '../../shared/types'
import { ProviderAdapter } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { geminiAdapter } from './gemini'
import { opencodeAdapter } from './opencode'
import { zcodeAdapter } from './zcode'
import { antigravityAdapter } from './antigravity'
import { copilotAdapter } from './copilot'
import { mistralAdapter } from './mistral'

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  zcode: zcodeAdapter,
  antigravity: antigravityAdapter,
  copilot: copilotAdapter,
  mistral: mistralAdapter
}

export {
  claudeAdapter,
  codexAdapter,
  geminiAdapter,
  opencodeAdapter,
  zcodeAdapter,
  antigravityAdapter,
  copilotAdapter,
  mistralAdapter
}
