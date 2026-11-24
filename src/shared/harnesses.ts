/**
 * A harness is one coding-agent product. Its CLI, its desktop app and its editor extension share one
 * configuration and one usage log, so AI Usage shows them as one tool and syncs them once.
 */
export type SurfaceKind = 'cli' | 'desktop' | 'editor'
export interface SurfaceState { kind: SurfaceKind; label: string; detected: boolean }
export const SURFACE_LABELS: Record<SurfaceKind, string> = { cli: 'CLI', desktop: 'Desktop app', editor: 'Editor' }

/** One line for a card: "CLI + Desktop app", listing what this device has first. */
export function surfaceSummary(surfaces: SurfaceState[] | undefined): string {
  if (!surfaces?.length) return ''
  return [...surfaces].sort((a, b) => Number(b.detected) - Number(a.detected)).map(s => s.label).join(' + ')
}
