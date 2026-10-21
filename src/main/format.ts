// Formatting helpers shared by tray/tooltip and any main-process strings.
// The renderer has its own formatting module; these are intentionally tiny.

export function fmtTokens(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}K`
  return `${Math.round(v)}`
}

export function fmtUsd(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(3)}`
  if (v < 100) return `$${v.toFixed(2)}`
  return `$${Math.round(v).toLocaleString('en-US')}`
}
