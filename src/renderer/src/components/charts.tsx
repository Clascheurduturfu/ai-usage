import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { ProviderId, ProviderSeriesPoint, SeriesPoint } from '../../../shared/types'
import { PROVIDER_IDS, PROVIDER_NAMES } from '../../../shared/types'
import { PROVIDER_COLORS, fmtTokens, fmtUsd, shortDateKey } from '../lib/format'

function useChartColors(): { grid: string; axis: string } {
  const [colors, setColors] = useState({ grid: '#1e2532', axis: '#8d97a8' })
  useEffect(() => {
    const read = (): void => {
      const cs = getComputedStyle(document.documentElement)
      setColors({
        grid: cs.getPropertyValue('--border').trim() || '#1e2532',
        axis: cs.getPropertyValue('--muted').trim() || '#8d97a8'
      })
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', read)
    return () => { observer.disconnect(); media.removeEventListener('change', read) }
  }, [])
  return colors
}

function ChartTooltip({
  active,
  payload,
  label,
  format
}: {
  active?: boolean
  payload?: Array<{ name?: string; value?: number | string; color?: string; dataKey?: string | number }>
  label?: string
  format: (key: string, value: number, color?: string) => { label: string; value: string } | null
}) {
  if (!active || !payload || payload.length === 0) return null
  const rows = payload
    .map((p) => {
      const v = typeof p.value === 'number' ? p.value : parseFloat(String(p.value))
      if (!Number.isFinite(v)) return null
      const key = String(p.dataKey ?? p.name ?? '')
      return format(key, v, p.color)
    })
    .filter((r): r is { label: string; value: string } => r !== null)
  if (rows.length === 0) return null
  return (
    <div
      className="rounded-xl px-3 py-2 text-[11.5px] shadow-lg"
      style={{ background: 'var(--panel)', border: '1px solid var(--border)', minWidth: 150 }}
    >
      <div className="font-semibold mb-1">{label ? shortDateKey(String(label)) : ''}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex justify-between gap-4 tnum">
          <span style={{ color: 'var(--muted)' }}>{r.label}</span>
          <span className="font-medium">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

const PROVIDER_KEYS: ProviderId[] = PROVIDER_IDS
const PROVIDER_LABELS: Record<ProviderId, string> = PROVIDER_NAMES

export function StackedProviderChart({
  data,
  mode,
  height = 260
}: {
  data: SeriesPoint[]
  mode: 'tokens' | 'cost'
  height?: number
}) {
  const c = useChartColors()
  const chartData = data.map((d) => ({
    date: d.date,
    ...Object.fromEntries(PROVIDER_KEYS.map((k) => [k, d.tokens[k] ?? 0])),
    cost: d.cost
  }))

  if (mode === 'cost') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ea8ff" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#6ea8ff" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDateKey}
            tick={{ fontSize: 11, fill: c.axis }}
            tickLine={false}
            axisLine={false}
            minTickGap={30}
          />
          <YAxis
            tick={{ fontSize: 11, fill: c.axis }}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`)}
          />
          <Tooltip content={<ChartTooltip format={(k, v) => (k === 'cost' ? { label: 'Cost', value: fmtUsd(v) } : null)} />} />
          <Area type="monotone" dataKey="cost" stroke="#6ea8ff" strokeWidth={2} fill="url(#gradCost)" />
        </AreaChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDateKey}
          tick={{ fontSize: 11, fill: c.axis }}
          tickLine={false}
          axisLine={false}
          minTickGap={30}
        />
        <YAxis
          tick={{ fontSize: 11, fill: c.axis }}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => fmtTokens(v)}
        />
        <Tooltip
          content={
            <ChartTooltip
              format={(k, v) =>
                k === 'total'
                  ? { label: 'Total', value: fmtTokens(v) }
                  : PROVIDER_KEYS.includes(k as ProviderId)
                    ? { label: PROVIDER_LABELS[k as ProviderId], value: fmtTokens(v) }
                    : null
              }
            />
          }
        />
        {PROVIDER_KEYS.map((k) => (
          <Area
            key={k}
            type="monotone"
            dataKey={k}
            stackId="1"
            stroke={PROVIDER_COLORS[k]}
            fill={PROVIDER_COLORS[k]}
            fillOpacity={0.22}
            strokeWidth={1.4}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

const MIX_SERIES: Array<{ key: keyof ProviderSeriesPoint; label: string; color: string }> = [
  { key: 'input', label: 'Input', color: '#5b8cff' },
  { key: 'cacheRead', label: 'Cache read', color: '#4fbf8f' },
  { key: 'cacheWrite', label: 'Cache write', color: '#8f7bf0' },
  { key: 'output', label: 'Output', color: '#f0a850' }
]

export function ProviderMixChart({ data, height = 240 }: { data: ProviderSeriesPoint[]; height?: number }) {
  const c = useChartColors()
  const chartData = data.map((d) => ({ ...d, zero: 0 }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDateKey}
          tick={{ fontSize: 11, fill: c.axis }}
          tickLine={false}
          axisLine={false}
          minTickGap={30}
        />
        <YAxis
          yAxisId="tokens"
          tick={{ fontSize: 11, fill: c.axis }}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => fmtTokens(v)}
        />
        <YAxis yAxisId="cost" orientation="right" hide />
        <Tooltip
          content={
            <ChartTooltip
              format={(k, v) => {
                const s = MIX_SERIES.find((m) => m.key === k)
                if (s) return { label: s.label, value: fmtTokens(v) }
                if (k === 'cost') return { label: 'Cost', value: fmtUsd(v) }
                return null
              }}
            />
          }
        />
        <Line
          yAxisId="cost"
          type="monotone"
          dataKey="cost"
          stroke="var(--warn)"
          strokeWidth={1.6}
          dot={false}
          connectNulls
        />
        {MIX_SERIES.map((s) => (
          <Area
            key={s.key}
            yAxisId="tokens"
            type="monotone"
            dataKey={s.key as string}
            stackId="1"
            stroke={s.color}
            fill={s.color}
            fillOpacity={0.2}
            strokeWidth={1.3}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export function SimpleBarChart({
  data,
  color,
  height = 220,
  formatValue
}: {
  data: Array<{ date: string; value: number }>
  color: string
  height?: number
  formatValue?: (v: number) => string
}) {
  const c = useChartColors()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDateKey}
          tick={{ fontSize: 11, fill: c.axis }}
          tickLine={false}
          axisLine={false}
          minTickGap={30}
        />
        <YAxis tick={{ fontSize: 11, fill: c.axis }} tickLine={false} axisLine={false} width={44} />
        <Tooltip
          content={
            <ChartTooltip
              format={(_k, v) => ({ label: 'Requests', value: formatValue ? formatValue(v) : String(Math.round(v)) })}
            />
          }
        />
        <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function MessagesBarChart({
  data,
  height = 200
}: {
  data: Array<{ date: string; messages: number; sessions: number; toolCalls: number }>
  height?: number
}) {
  const c = useChartColors()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDateKey}
          tick={{ fontSize: 11, fill: c.axis }}
          tickLine={false}
          axisLine={false}
          minTickGap={30}
        />
        <YAxis tick={{ fontSize: 11, fill: c.axis }} tickLine={false} axisLine={false} width={40} />
        <Tooltip
          content={
            <ChartTooltip
              format={(k, v) =>
                k === 'messages'
                  ? { label: 'Messages', value: String(Math.round(v)) }
                  : k === 'toolCalls'
                    ? { label: 'Tool calls', value: String(Math.round(v)) }
                    : k === 'sessions'
                      ? { label: 'Sessions', value: String(Math.round(v)) }
                      : null
              }
            />
          }
        />
        <Bar dataKey="messages" fill="#e8825a" radius={[3, 3, 0, 0]} />
        <Bar dataKey="toolCalls" fill="#8f7bf0" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
