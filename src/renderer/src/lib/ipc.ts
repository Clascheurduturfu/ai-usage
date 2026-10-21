import type { AiuApi } from '../../../shared/api'

export function api(): AiuApi {
  const w = window as unknown as { aiu?: AiuApi }
  if (!w.aiu) throw new Error('Desktop connection is unavailable')
  return w.aiu
}
