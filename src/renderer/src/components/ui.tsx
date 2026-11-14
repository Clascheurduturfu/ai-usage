import type { ReactNode, ButtonHTMLAttributes } from 'react'

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`panel ${className}`}>{children}</div>
}

export function SectionTitle({
  icon,
  title,
  right,
  sub
}: {
  icon?: ReactNode
  title: string
  sub?: string
  right?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2 min-w-0">
        {icon}
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate">{title}</div>
          {sub && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{sub}</div>}
        </div>
      </div>
      {right}
    </div>
  )
}

export function Kpi({
  label,
  value,
  sub,
  icon,
  accent
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  accent?: string
}) {
  return (
    <Panel className="p-4 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {icon &&
          (accent ? (
            <span style={{ color: accent }} className="flex items-center">
              {icon}
            </span>
          ) : (
            icon
          ))}
        {label}
      </div>
      <div className="text-[24px] font-semibold tnum leading-tight">{value}</div>
      {sub && (
        <div className="text-[11.5px] tnum" style={{ color: 'var(--muted)' }}>
          {sub}
        </div>
      )}
    </Panel>
  )
}

export function StatusDot({ status }: { status: 'ok' | 'no-data' | 'error' }) {
  const color = status === 'ok' ? 'var(--good)' : status === 'error' ? 'var(--bad)' : 'var(--faint)'
  return (
    <span
      className="inline-block w-[8px] h-[8px] rounded-full shrink-0"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  )
}

export function Badge({
  children,
  color,
  title
}: {
  children: ReactNode
  color?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 px-2 py-[2px] rounded-full text-[10.5px] font-medium"
      style={{
        background: color ? `color-mix(in srgb, ${color} 8%, transparent)` : 'var(--panel-2)',
        color: color ?? 'var(--muted)',
        border: `1px solid ${color ? `color-mix(in srgb, ${color} 22%, transparent)` : 'var(--border)'}`
      }}
    >
      {children}
    </span>
  )
}

export function ProgressBar({
  percent,
  color,
  height = 8,
  showOver = true
}: {
  percent: number
  color?: string
  height?: number
  showOver?: boolean
}) {
  const p = Math.max(0, Math.min(100, percent))
  const over = showOver && percent > 100
  const c = color ?? (over ? 'var(--bad)' : 'var(--accent)')
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p}
      aria-label="Remaining or used capacity"
      className="w-full rounded-full overflow-hidden"
      style={{ height, background: 'var(--panel-2)', border: '1px solid var(--border-soft)' }}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${p}%`, background: c, transition: 'width 240ms ease', minWidth: percent > 0 ? 4 : 0 }}
      />
    </div>
  )
}

export function Btn({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' }) {
  return (
    <button
      type="button"
      {...props}
      className={`btn btn-${variant} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

export function Toggle({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      className="w-[36px] h-[20px] rounded-full relative shrink-0 clickable"
      style={{ background: checked ? 'var(--accent)' : 'var(--border)', border: 'none' }}
      onClick={() => onChange(!checked)}
    >
      <span
        className="absolute top-[2px] w-[16px] h-[16px] rounded-full bg-white transition-all"
        style={{ left: checked ? 18 : 2 }}
      />
    </button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium">{label}</span>
      {children}
      {hint && (
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {hint}
        </span>
      )}
    </label>
  )
}

export interface Column<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  align?: 'left' | 'right'
  width?: string
}

export function Table<T>({ columns, rows, empty }: { columns: Column<T>[]; rows: T[]; empty?: string }) {
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-[12px]" style={{ color: 'var(--faint)' }}>
        {empty ?? 'No data'}
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className="py-2 px-2 font-medium text-[11px] uppercase tracking-wide whitespace-nowrap"
                style={{
                  color: 'var(--muted)',
                  textAlign: c.align ?? 'left',
                  borderBottom: '1px solid var(--border)',
                  width: c.width
                }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className="py-[7px] px-2 tnum align-middle"
                  style={{ textAlign: c.align ?? 'left', borderBottom: '1px solid var(--border-soft)' }}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function BarList({
  items,
  formatValue,
  empty
}: {
  items: Array<{ label: string; value: number; sub?: ReactNode; color?: string }>
  formatValue: (v: number) => string
  empty?: string
}) {
  if (items.length === 0) {
    return (
      <div className="py-8 text-center text-[12px]" style={{ color: 'var(--faint)' }}>
        {empty ?? 'No data'}
      </div>
    )
  }
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="flex flex-col">
      {items.map((it, idx) => (
        <div key={idx} className="py-[7px]">
          <div className="flex items-baseline justify-between gap-3 mb-[5px]">
            <span className="text-[12px] truncate min-w-0" title={it.label}>
              {it.label}
            </span>
            <span className="text-[12px] tnum font-medium shrink-0">
              {formatValue(it.value)}
              {it.sub && (
                <span className="ml-2 font-normal" style={{ color: 'var(--muted)' }}>
                  {it.sub}
                </span>
              )}
            </span>
          </div>
          <ProgressBar
            percent={(it.value / max) * 100}
            color={it.color ?? 'var(--accent)'}
            height={5}
            showOver={false}
          />
        </div>
      ))}
    </div>
  )
}

export function Sparkline({
  data,
  color,
  width = 120,
  height = 30
}: {
  data: number[]
  color: string
  width?: number
  height?: number
}) {
  if (data.length === 0 || data.every((d) => d === 0)) {
    return (
      <svg width={width} height={height}>
        <line x1={0} y1={height - 4} x2={width} y2={height - 4} stroke="var(--border)" strokeWidth={1} />
      </svg>
    )
  }
  const max = Math.max(...data, 1)
  const step = data.length > 1 ? width / (data.length - 1) : width
  const points = data
    .map((d, i) => `${(i * step).toFixed(1)},${(height - 3 - ((d / max) * (height - 6))).toFixed(1)}`)
    .join(' ')
  const areaPoints = `0,${height} ${points} ${width},${height}`
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polygon points={areaPoints} fill={color} opacity={0.12} />
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-8">
      {icon && (
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>
          {icon}
        </div>
      )}
      <div className="text-[14px] font-semibold">{title}</div>
      {hint && (
        <div className="text-[12px] max-w-[420px]" style={{ color: 'var(--muted)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-[34px]" />
      ))}
    </div>
  )
}
