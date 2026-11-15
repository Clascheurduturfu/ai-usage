import { createRoot } from 'react-dom/client'
import './styles.css'
import { installBridge } from './lib/bridge'

async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const isPopover = params.has('popover')
  if (isPopover) document.documentElement.dataset.popover = '1'
  if (import.meta.env.DEV && params.has('demo')) {
    const { installDemo } = await import('./lib/demo')
    installDemo()
  } else installBridge()
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('root element missing')
  const { default: Root } = isPopover ? await import('./QuotaPopover') : await import('./App')
  createRoot(rootEl).render(<Root />)
}
void bootstrap()
