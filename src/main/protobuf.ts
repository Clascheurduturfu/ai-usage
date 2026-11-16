/**
 * Minimal schema-less protobuf reader for local files other apps write (Antigravity).
 * Varints are decoded with arithmetic, not 32-bit shifts, so values up to 2^53 stay exact.
 */
export type PbValue = number | Uint8Array
export interface PbField { field: number; wire: number; value: PbValue }

function varint(buf: Uint8Array, start: number): [number, number] {
  let value = 0, scale = 1, i = start
  while (i < buf.length) {
    const b = buf[i++]
    value += (b & 0x7f) * scale
    if ((b & 0x80) === 0) return [value, i]
    scale *= 128
    if (scale > 2 ** 63) throw new Error('varint too long')
  }
  throw new Error('truncated varint')
}

/** Top-level fields of one message. Throws on malformed input. */
export function pbFields(buf: Uint8Array): PbField[] {
  const out: PbField[] = []
  let i = 0
  while (i < buf.length) {
    const [key, next] = varint(buf, i); i = next
    const field = Math.floor(key / 8), wire = key % 8
    if (field === 0) throw new Error('invalid field number')
    if (wire === 0) { const [v, n] = varint(buf, i); out.push({ field, wire, value: v }); i = n }
    else if (wire === 2) {
      const [len, n] = varint(buf, i); i = n
      if (i + len > buf.length) throw new Error('truncated field')
      out.push({ field, wire, value: buf.subarray(i, i + len) }); i += len
    } else if (wire === 1) { out.push({ field, wire, value: buf.subarray(i, i + 8) }); i += 8 }
    else if (wire === 5) { out.push({ field, wire, value: buf.subarray(i, i + 4) }); i += 4 }
    else throw new Error(`unsupported wire type ${wire}`)
  }
  return out
}

export const pbMessage = (fields: PbField[], field: number): Uint8Array | undefined => {
  const f = fields.find(x => x.field === field && x.value instanceof Uint8Array)
  return f?.value as Uint8Array | undefined
}
export const pbInt = (fields: PbField[], field: number): number => {
  const f = fields.find(x => x.field === field && x.wire === 0)
  return typeof f?.value === 'number' ? f.value : 0
}
export const pbString = (fields: PbField[], field: number): string | undefined => {
  const bytes = pbMessage(fields, field)
  return bytes ? Buffer.from(bytes).toString('utf8') : undefined
}
/** A repeated varint field, packed (wire 2) or not (wire 0). */
export function pbInts(fields: PbField[], field: number): number[] {
  const out: number[] = []
  for (const f of fields) {
    if (f.field !== field) continue
    if (f.wire === 0) out.push(f.value as number)
    else if (f.wire === 2) { const b = f.value as Uint8Array; let i = 0; while (i < b.length) { const [v, n] = varint(b, i); out.push(v); i = n } }
  }
  return out
}
