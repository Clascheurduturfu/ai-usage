import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { buildEnvironment } from './build-env.mjs'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'))
// The running Node becomes the bundled runtime. The backend uses built-in node:sqlite
// (no native addon), which needs Node 24 or later.
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 24) throw new Error(`Build with Node 24 or later; this is Node ${process.versions.node}.`)
const output = path.resolve('out/backend')
await fs.mkdir(output, { recursive: true })
await build({ entryPoints: ['src/main/broker.ts'], outfile: path.join(output, 'broker.mjs'),
  bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], target: 'node24',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
await build({ entryPoints: ['src/main/manager/sync-cli.ts'], outfile: path.join(output, 'sync.mjs'), bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], target: 'node24', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
await build({ entryPoints: ['src/main/manager/manager-cli.ts'], outfile: path.join(output, 'manager.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
await build({ entryPoints: ['src/main/manager/prepare-cli.ts'], outfile: path.join(output, 'prepare.mjs'), bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], target: 'node24', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
// Native modules from builds before the move to node:sqlite must not ship.
await fs.rm(path.join(output, 'node_modules'), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
await fs.mkdir(path.join(output, 'licenses'), { recursive: true })
for (const name of ['LICENSE', 'NOTICE']) await fs.copyFile(`src/main/manager/vendor/${name}`, path.join(output, 'licenses', `agents-${name}`))
await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({ type: 'module', version: manifest.version }))
await fs.mkdir('src-tauri/binaries', { recursive: true })
const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc.exe'
  : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
const nodeTarget = `src-tauri/binaries/aiu-node-${target}`

function nonSystemDylibs(binaryPath) {
  const output = execFileSync('otool', ['-L', binaryPath], { encoding: 'utf8' })
  return output
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(' (')[0])
    .filter(lib => lib && !lib.startsWith('/System/Library/') && !lib.startsWith('/usr/lib/'))
}

async function bundleMacNode(destination) {
  if (nonSystemDylibs(process.execPath).length === 0) {
    await fs.copyFile(process.execPath, destination)
    await fs.chmod(destination, 0o755)
    return
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const distName = `node-${process.version}-darwin-${arch}`
  const tarName = `${distName}.tar.gz`
  const baseUrl = `https://nodejs.org/dist/${process.version}`
  const sumsText = await (await fetch(`${baseUrl}/SHASUMS256.txt`)).text()
  const expectedLine = sumsText.split(/\r?\n/).find(line => line.endsWith(`  ${tarName}`))
  const expectedSha = expectedLine?.split(/\s+/)[0]
  if (!expectedSha) throw new Error(`Missing official SHA-256 entry for ${tarName} (${baseUrl})`)

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiu-node-'))
  try {
    const archivePath = path.join(tmpDir, tarName)
    const response = await fetch(`${baseUrl}/${tarName}`)
    if (!response.ok) throw new Error(`Failed to download ${tarName}: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actualSha = createHash('sha256').update(bytes).digest('hex')
    if (actualSha !== expectedSha) throw new Error(`SHA-256 mismatch for ${tarName}: expected ${expectedSha}, got ${actualSha}`)
    await fs.writeFile(archivePath, bytes)
    execFileSync('tar', ['-xzf', archivePath, '-C', tmpDir, `${distName}/bin/node`])
    await fs.copyFile(path.join(tmpDir, distName, 'bin', 'node'), destination)
    await fs.chmod(destination, 0o755)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }

  const remaining = nonSystemDylibs(destination)
  if (remaining.length) throw new Error(`Bundled macOS node still depends on non-system libraries: ${remaining.join(', ')}`)
}

if (process.platform === 'darwin') await bundleMacNode(nodeTarget)
else await fs.copyFile(process.execPath, nodeTarget)
// Device preparation works even when Node and npm are absent from the user's PATH.
const npmCandidates = process.platform === 'darwin'
  ? [
      path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm'),
      '/opt/homebrew/lib/node_modules/npm',
      '/usr/local/lib/node_modules/npm'
    ]
  : [path.resolve(path.dirname(process.execPath), 'node_modules/npm')]
let npmRoot = ''
for (const candidate of npmCandidates) {
  try { if ((await fs.stat(path.join(candidate, 'package.json'))).isFile()) { npmRoot = candidate; break } } catch { /* try next */ }
}
if (!npmRoot && process.platform === 'darwin') {
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const viaNpm = path.join(globalRoot, 'npm')
    if ((await fs.stat(path.join(viaNpm, 'package.json'))).isFile()) npmRoot = viaNpm
  } catch { /* ignore */ }
}
if (!npmRoot) throw new Error(`Could not locate bundled npm directory (checked: ${npmCandidates.join(', ')})`)
await fs.cp(npmRoot, path.join(output, 'npm'), { recursive: true })

// Compile the lightweight relay/supervisor before Tauri resolves sidecar resources.
execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--bin', 'aiu-mcp'], { stdio: 'inherit', env: { ...buildEnvironment(), AIU_BUILD_MCP: '1' } })
const cargoTarget = process.env.CARGO_TARGET_DIR || path.resolve('src-tauri/target')
await fs.copyFile(path.join(cargoTarget, 'release', process.platform === 'win32' ? 'aiu-mcp.exe' : 'aiu-mcp'), `src-tauri/binaries/aiu-mcp-${target}`)
