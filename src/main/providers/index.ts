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
import { cursorAdapter } from './cursor'
import { kimiAdapter } from './kimi'
import { deepseekAdapter } from './deepseek'
import { piAdapter } from './pi'

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  zcode: zcodeAdapter,
  antigravity: antigravityAdapter,
  copilot: copilotAdapter,
  mistral: mistralAdapter,
  cursor: cursorAdapter,
  kimi: kimiAdapter,
  deepseek: deepseekAdapter,
  pi: piAdapter
}

export {
  claudeAdapter,
  codexAdapter,
  geminiAdapter,
  opencodeAdapter,
  zcodeAdapter,
  antigravityAdapter,
  copilotAdapter,
  mistralAdapter,
  cursorAdapter,
  kimiAdapter,
  deepseekAdapter,
  piAdapter
}
