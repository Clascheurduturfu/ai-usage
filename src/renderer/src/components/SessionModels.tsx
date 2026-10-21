import type { SessionRow } from '../../../shared/types'
import { fmtCount, fmtTokens, fmtUsd } from '../lib/format'

export function SessionModels({ session, className = '' }: { session: SessionRow; className?: string }): React.ReactElement {
  const entries = session.modelBreakdown ?? []
  const models = entries.length ? entries.map(entry => entry.model) : session.models ?? [session.model]
  if (models.length < 2) return <span className={`block max-w-[220px] truncate muted ${className}`} title={session.model}>{session.model}</span>
  return <details className={`max-w-[320px] muted ${className}`}>
    <summary className="cursor-pointer select-none rounded focus-visible:outline-2 focus-visible:outline-offset-4" title="Usage by model">{session.model}</summary>
    <ul className="mt-3 space-y-3" aria-label="Usage by model">
      {models.map(model => {
        const usage = entries.find(entry => entry.model === model)
        return <li key={model} className="border-l-2 pl-3" style={{ borderColor: 'var(--border)' }}>
          <span className="block break-words font-medium" style={{ color: 'var(--text)' }}>{model}</span>
          {usage && <>
            <span className="block mt-1">{fmtTokens(usage.tokens)} tokens · {usage.unpriced ? usage.cost ? `${fmtUsd(usage.cost)}+` : 'Cost unknown' : fmtUsd(usage.cost)}</span>
            <span className="block mt-1">{fmtCount(usage.requests)} requests{!!usage.subagentTokens && ` · ${fmtTokens(usage.subagentTokens)} agent tokens`}</span>
          </>}
        </li>
      })}
    </ul>
  </details>
}
