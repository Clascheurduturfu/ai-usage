import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const vitestCli = resolve('node_modules/vitest/vitest.mjs')

const child = spawn(process.execPath, [vitestCli, 'run', ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
  cwd: fileURLToPath(new URL('..', import.meta.url))
})
child.on('exit', (code) => process.exit(code ?? 1))
