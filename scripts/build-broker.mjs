import { execFileSync } from 'node:child_process'
import { buildEnvironment } from './build-env.mjs'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'))
const output = path.resolve('out/backend')
await fs.mkdir(output, { recursive: true })
await build({ entryPoints: ['src/main/broker.ts'], outfile: path.join(output, 'broker.mjs'),
  bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], target: 'node24', external: ['better-sqlite3'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
await build({ entryPoints: ['src/main/manager/sync-cli.ts'], outfile: path.join(output, 'sync.mjs'), bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], target: 'node24', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
await build({ entryPoints: ['src/main/manager/manager-cli.ts'], outfile: path.join(output, 'manager.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
await build({ entryPoints: ['src/main/manager/prepare-cli.ts'], outfile: path.join(output, 'prepare.mjs'), bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], target: 'node24', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
for (const module of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  const root = path.dirname(require.resolve(`${module}/package.json`))
  const target = path.resolve(output, 'node_modules', module)
  if (!target.startsWith(output + path.sep)) throw new Error('Unsafe backend resource path')
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  if (module === 'better-sqlite3') {
    await fs.cp(path.join(root, 'lib'), path.join(target, 'lib'), { recursive: true })
    await fs.mkdir(path.join(target, 'build/Release'), { recursive: true })
    await fs.copyFile(path.join(root, 'build/Release/better_sqlite3.node'), path.join(target, 'build/Release/better_sqlite3.node'))
    await fs.copyFile(path.join(root, 'package.json'), path.join(target, 'package.json'))
    await fs.copyFile(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'))
  } else await fs.cp(root, target, { recursive: true })
}
await fs.mkdir(path.join(output, 'licenses'), { recursive: true })
for (const name of ['LICENSE', 'NOTICE']) await fs.copyFile(`src/main/manager/vendor/${name}`, path.join(output, 'licenses', `agents-${name}`))
await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({ type: 'module', version: manifest.version }))
await fs.mkdir('src-tauri/binaries', { recursive: true })
const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc.exe'
  : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
await fs.copyFile(process.execPath, `src-tauri/binaries/aiu-node-${target}`)
if (process.platform === 'darwin') {
  await fs.chmod(`src-tauri/binaries/aiu-node-${target}`, 0o755)
}
// Device preparation works even when Node and npm are absent from the user's PATH.
const npmRoot = process.platform === 'darwin' ? path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm') : path.resolve(path.dirname(process.execPath), 'node_modules/npm')
await fs.cp(npmRoot, path.join(output, 'npm'), { recursive: true })

// Compile the lightweight relay/supervisor before Tauri resolves sidecar resources.
execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--bin', 'aiu-mcp'], { stdio: 'inherit', env: { ...buildEnvironment(), AIU_BUILD_MCP: '1' } })
const cargoTarget = process.env.CARGO_TARGET_DIR || path.resolve('src-tauri/target')
await fs.copyFile(path.join(cargoTarget, 'release', process.platform === 'win32' ? 'aiu-mcp.exe' : 'aiu-mcp'), `src-tauri/binaries/aiu-mcp-${target}`)
