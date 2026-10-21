import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { zcodeAdapter } from '../src/main/providers/zcode'
import type { Settings } from '../src/shared/types'

describe('zcode scan perf (real ledger, copied app db)', () => {
  it('watermarked scans are cheap after the first pass', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-zperf-'))
    try {
      const db = openDb(path.join(tmp, 'usage.db'))
      const settings = { paths: {} } as unknown as Settings

      // First scan against the real 2.6k-row ledger (no watermark -> grace window)
      const t0 = performance.now()
      zcodeAdapter.scan(settings, db)
      const first = performance.now() - t0

      // Steady-state: nothing new
      const t1 = performance.now()
      zcodeAdapter.scan(settings, db)
      const steady = performance.now() - t1

      console.log(`zcode scan: first(grace-window)=${first.toFixed(1)}ms steady=${steady.toFixed(1)}ms`)
      expect(steady).toBeLessThan(150)
      db.close()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
