import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

/** Enforce the frame budget while reading, before allocating a complete JSON line. */
export class FrameReader extends EventEmitter {
  private chunks: Buffer[] = []
  private size = 0
  private read = (value: Buffer): void => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let offset = 0
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset), part = bytes.subarray(offset, end < 0 ? bytes.length : end)
      if (this.size + part.length > this.limit) { this.close(); this.input.destroy(new Error('MCP frame exceeds the 16 MiB budget')); return }
      this.chunks.push(part); this.size += part.length
      if (end < 0) return
      const text = Buffer.concat(this.chunks, this.size).toString('utf8')
      this.chunks = []; this.size = 0; this.emit('line', text)
      offset = end + 1
    }
  }
  constructor(private input: Readable, private limit = 16 * 1024 * 1024) { super(); input.on('data', this.read) }
  close(): void { this.input.off('data', this.read); this.chunks = []; this.size = 0 }
}
