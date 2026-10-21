import { RefreshCw } from 'lucide-react'
import type { AntigravityStatus } from '../../../shared/manager'
import { Btn } from './ui'

export function AgentConnectionDetails({ name, status, sharedNames, busy, reload }: { name: string; status: AntigravityStatus; sharedNames: string[]; busy: boolean; reload(): void }): React.ReactElement {
  const ready = status.servers.filter(s => s.state === 'READY' && sharedNames.includes(s.name)).length
  return <details className="manager-client-check"><summary>Connection details · {ready}/{status.expected ?? status.servers.length} shared MCPs connected</summary><div className="manager-client-details"><p>{status.skills} global skills. {status.detail}</p>{status.expected !== status.libraryCount && <p>The selected profile includes {status.expected} of {status.libraryCount} shared MCPs.</p>}<Btn disabled={busy} onClick={reload}><RefreshCw size={14} />Reload {name}</Btn>{status.servers.map(s => <p key={s.name}><strong>{s.name} · {s.state}</strong>{s.detail ? `: ${s.detail}` : ` · ${s.tools} tools`}</p>)}</div></details>
}
