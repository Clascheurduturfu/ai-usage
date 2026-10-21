import { createRoot } from 'react-dom/client'
import './styles.css'
import { installBridge } from './lib/bridge'

async function bootstrap(): Promise<void> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const { installDemo } = await import('./lib/demo')
    installDemo()
  } else installBridge()
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('root element missing')
  const { default: Root } = new URLSearchParams(location.search).has('popover') ? await import('./QuotaPopover') : await import('./App')
  createRoot(rootEl).render(<Root />)
}
void bootstrap()
