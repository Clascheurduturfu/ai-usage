import os from 'node:os'
import path from 'node:path'
import { ManagerStore, atomicWrite } from './storage'
import { SyncEngine } from './sync'
import { userDataPath } from '../paths'
const store = new ManagerStore(process.env.AIU_POOL || path.join(os.homedir(), '.agents'), userDataPath())
await store.load()
const engine = new SyncEngine(store, process.env.AIU_HOME || os.homedir())
try {
  const restore = process.argv.find(a => a.startsWith('--restore='))?.slice(10)
  const result = restore ? await engine.restore(restore) : process.argv.includes('--preview') ? await engine.preview() : await engine.sync()
  if ('changed' in result && result.changed > 0) await atomicWrite(path.join(store.data, 'last-sync.json'), JSON.stringify(result))
  console.log(JSON.stringify(result, null, 2))
  if ('conflicts' in result && result.conflicts.length) process.exitCode = 2
} catch (error) { console.error((error as Error).message); process.exitCode = 1 }
