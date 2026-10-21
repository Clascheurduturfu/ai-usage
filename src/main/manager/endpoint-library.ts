import type { EndpointRecord } from '../../shared/manager'
import { defaultEndpoints, migrateEndpoint } from '../../shared/endpoint-catalog'
export interface EndpointLibrary { schema: 1; custom: EndpointRecord[]; overrides: Record<string, Partial<EndpointRecord>>; hidden: string[] }
export const legacyLibrary = (endpoints: EndpointRecord[]): EndpointLibrary => ({ schema: 1, custom: endpoints.map(e => { const v = migrateEndpoint(e); delete v.catalogId; return v }), overrides: {}, hidden: [] })
export function composeEndpoints(library: EndpointLibrary): EndpointRecord[] {
  if (library.schema !== 1 || !Array.isArray(library.custom) || !Array.isArray(library.hidden) || !library.overrides || typeof library.overrides !== 'object') throw new Error('Invalid endpoint library')
  const defaults = defaultEndpoints().filter(e => !library.hidden.includes(e.catalogId!)).map(e => ({ ...e, ...library.overrides[e.catalogId!], id: e.id, catalogId: e.catalogId }))
  const ids = new Set(defaults.map(e => e.id))
  for (const e of library.custom) { if (ids.has(e.id)) throw new Error('Duplicate endpoint identifier'); ids.add(e.id) }
  return [...defaults, ...library.custom.map(migrateEndpoint)]
}
export function partitionEndpoints(endpoints: EndpointRecord[], previous?: EndpointLibrary): EndpointLibrary {
  const base = defaultEndpoints(), known = new Set(base.map(e => e.catalogId!))
  const overrides: EndpointLibrary['overrides'] = Object.fromEntries(Object.entries(previous?.overrides ?? {}).filter(([id]) => !known.has(id)))
  const fields = ['name', 'baseUrl', 'protocol', 'secretRef', 'models', 'note', 'credentialKind', 'responsesState'] as const
  for (const e of endpoints.filter(e => e.catalogId && known.has(e.catalogId))) {
    const standard = base.find(b => b.catalogId === e.catalogId)!, patch: Record<string, unknown> = {}
    for (const field of fields) if (JSON.stringify(e[field]) !== JSON.stringify(standard[field]) && e[field] !== undefined) patch[field] = e[field]
    if (Object.keys(patch).length) overrides[e.catalogId!] = patch
  }
  return { schema: 1, custom: endpoints.filter(e => !e.catalogId).map(migrateEndpoint), overrides,
    hidden: [...base.filter(e => !endpoints.some(v => v.catalogId === e.catalogId)).map(e => e.catalogId!), ...(previous?.hidden ?? []).filter(id => !known.has(id))] }
}
