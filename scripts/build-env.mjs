import os from 'node:os'
import path from 'node:path'

export function buildEnvironment() {
  const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.split(/\s+/).filter(Boolean) ?? []
  for (const flag of [`--remap-path-prefix=${os.homedir()}=/build/user`, `--remap-path-prefix=${path.resolve('.')}=/build/ai-usage`]) if (!flags.includes(flag)) flags.push(flag)
  const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') }
  delete env.RUSTFLAGS
  return env
}
