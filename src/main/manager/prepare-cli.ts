import os from 'node:os'
import path from 'node:path'
import { ManagerStore, atomicWrite } from './storage'
import { McpPreparation, portableMcp } from './mcp-preparation'
import { userDataPath } from '../paths'
const store = new ManagerStore(process.env.AIU_POOL ?? path.join(os.homedir(), '.agents'), userDataPath())
await store.load()
const preparation = new McpPreparation(store, process.env.AIU_HOME ?? os.homedir())
const [action, ...args] = process.argv.slice(2)
try {
  const result = action === 'export' ? await atomicWrite(path.resolve(args[0]), JSON.stringify({ mcpServers: portableMcp(await store.mcpRaw()) }, null, 2)) : action === 'preview' ? await preparation.preview(args.length ? args : undefined) : action === 'confirm' ? await preparation.confirm(args[0]) : action === 'check' ? await preparation.probe(args[0]) : action === 'aws-profile' ? await preparation.setAwsProfile(args[0], args[1]) : action === 'status' ? await preparation.statuses() : (() => { throw new Error('Usage: prepare preview [NAME...], confirm ID, check NAME, aws-profile NAME PROFILE, status, export FILE') })()
  console.log(JSON.stringify(result ?? { saved: true }, null, 2))
  if (result && 'failed' in result && Object.keys(result.failed).length) process.exitCode = 1
} catch (e) { console.error((e as Error).message.split('\n')[0]); process.exitCode = 1 }
