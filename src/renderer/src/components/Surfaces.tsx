import { Check } from 'lucide-react'
import type { SurfaceState } from '../../../shared/harnesses'

/** The CLI, desktop app and editor parts of one tool, marked when this device has them. */
export function Surfaces({ surfaces }: { surfaces?: SurfaceState[] }): React.ReactElement | null {
  if (!surfaces?.length) return null
  return <div className="surface-row" role="list" aria-label="Parts of this tool">
    {surfaces.map(s => <span role="listitem" key={s.label} className={`chip ${s.detected ? 'chip-on' : 'chip-off'}`} title={s.detected ? `${s.label}: on this device` : `${s.label}: not on this device`}>
      {s.detected && <Check size={10} aria-hidden />}{s.label}<span className="sr-only">{s.detected ? ' (on this device)' : ' (not on this device)'}</span>
    </span>)}
  </div>
}
