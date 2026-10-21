import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createApi } from '../../../shared/api'

export function installBridge(): void {
  const bridge = createApi(
    <T>(method: string, params?: unknown) => invoke<T>('rpc', { method, params: params ?? null }),
    (event, callback) => {
      let stopped = false
      let cleanup: (() => void) | undefined
      void listen(event, callback).then((unlisten) => { if (stopped) unlisten(); else cleanup = unlisten })
      return () => { stopped = true; cleanup?.() }
    },
    { pickFolder: () => invoke('pick_folder'), pickJsonFile: () => invoke('pick_json_file'), openPath: (path) => invoke('open_path', { path }), mcpControl: (action, name) => invoke('mcp_control', { action, name }) }
  )
  Object.defineProperty(window, 'aiu', { value: bridge, configurable: false })
}
