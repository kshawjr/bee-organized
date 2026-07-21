// @vitest-environment node
//
// Write-phase wall-clock guard + idempotent resume (stalled-Scottsdale, 1a/1b).
//
// The bug: the fetch phase self-continues before the 800s Vercel wall, but the
// write phase's only brake was WRITE_BATCH_CAP=400. 400 heavy client-writes
// (each = lead + requests/quotes/jobs/invoices + engagement founding) can
// exceed 800s, so the loop got hard-killed mid-record — skipping the
// finally/releaseMutex and stranding the job with a frozen mutex (Scottsdale
// died at ~600/709). The fix adds the SAME timeLow() guard the fetch phase
// uses, and the graceful stop RELEASES the mutex + persists progress +
// self-continues.
//
// The idempotency half: a resumed write re-loads the same staged clients but
// must skip whatever a prior segment already landed (the 600 rows Scottsdale
// already wrote must never double-write). selectUnwrittenClients is that gate.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// jobber-import instantiates supabaseService (and neighbours) at module load;
// the pure helpers under test touch none of it, so stub the side-effecting
// deps to keep import-time from reaching createClient without env.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('unused in this suite') } } }))

import {
  writeLoopShouldYield,
  selectUnwrittenClients,
  encodeJobberId,
} from '@/lib/jobber-import'

describe('writeLoopShouldYield — two brakes before every record', () => {
  it('does NOT yield when under the cap and time is fine', () => {
    expect(writeLoopShouldYield(10, 400, false)).toEqual({ stop: false, reason: '' })
  })

  it('yields on batch cap (count >= cap), even with time to spare', () => {
    expect(writeLoopShouldYield(400, 400, false)).toEqual({ stop: true, reason: 'batch cap' })
  })

  it('yields on low wall-clock time BEFORE hitting the cap — the new brake', () => {
    // The exact Scottsdale shape: only 207 records into the batch (< 400) but
    // the clock is nearly at the wall. Old code plowed on and got killed.
    expect(writeLoopShouldYield(207, 400, true)).toEqual({ stop: true, reason: 'time budget' })
  })

  it('batch cap takes precedence in its reason when both trip', () => {
    expect(writeLoopShouldYield(400, 400, true)).toEqual({ stop: true, reason: 'batch cap' })
  })
})

describe('selectUnwrittenClients — idempotent resume, no double-write', () => {
  const client = (jobberNumeric: string) => ({ id: encodeJobberId('Client', jobberNumeric) })

  it('excludes clients whose jobber id is already written (the resumed prefix)', () => {
    const clients = [client('100'), client('200'), client('300')]
    const alreadyWritten = new Set(['100', '200']) // a prior segment landed these
    const out = selectUnwrittenClients(clients, alreadyWritten)
    expect(out.map((c) => c.id)).toEqual([client('300').id])
  })

  it('a full resume over an entirely-landed set writes NOTHING', () => {
    const clients = [client('1'), client('2')]
    const alreadyWritten = new Set(['1', '2'])
    expect(selectUnwrittenClients(clients, alreadyWritten)).toEqual([])
  })

  it('the first-segment case (nothing written yet) keeps every client', () => {
    const clients = [client('1'), client('2'), client('3')]
    expect(selectUnwrittenClients(clients, new Set())).toHaveLength(3)
  })

  it('clients with no extractable jobber id are always processed (upsert dedupes)', () => {
    const clients = [{ id: null }, { id: '' }, { id: 'not-a-gid' }]
    // none can be matched against alreadyWritten → all pass through
    expect(selectUnwrittenClients(clients as any, new Set(['1']))).toHaveLength(3)
  })

  it('matches on the numeric tail even when alreadyWritten holds bare numerics', () => {
    // leads.jobber_client_id stores the numeric tail; staged client.id is the
    // encoded gid. The extract must bridge them or the resume re-writes forever
    // (the Portland stuck-at-1400 failure mode).
    const clients = [client('555')]
    expect(selectUnwrittenClients(clients, new Set(['555']))).toEqual([])
  })
})

// ── Route wiring source-pin ────────────────────────────────────
// The giant 800s handler can't be executed in a unit test, so pin the
// load-bearing wiring textually: the write loop consults the guard with the
// live clock, and the graceful stop releases the mutex + persists progress +
// schedules a continue. If any of these regress, the mid-write-kill bug is back.
describe('jobber-clients route — write-guard wiring', () => {
  const src = readFileSync(
    join(process.cwd(), 'app/api/import/jobber-clients/route.ts'),
    'utf8',
  )

  it('the write loop calls writeLoopShouldYield with the live timeLow() clock', () => {
    expect(src).toMatch(/writeLoopShouldYield\(\s*wroteThisRun\s*,\s*WRITE_BATCH_CAP\s*,\s*timeLow\(\)\s*\)/)
  })

  it('a truthy yield breaks the loop and records the reason', () => {
    expect(src).toMatch(/if\s*\(\s*yieldNow\.stop\s*\)\s*\{\s*hitCap\s*=\s*true;\s*yieldReason\s*=\s*yieldNow\.reason;\s*break/)
  })

  it('the graceful stop persists processed_records, releases the mutex, then self-continues (in that order)', () => {
    const block = src.slice(src.indexOf('if (hitCap) {'))
    const persistAt = block.indexOf('processed_records: processed')
    const releaseAt = block.indexOf('await releaseMutex()')
    const continueAt = block.indexOf('selfContinue()')
    expect(persistAt).toBeGreaterThanOrEqual(0)
    expect(releaseAt).toBeGreaterThan(persistAt)
    expect(continueAt).toBeGreaterThan(releaseAt)
  })

  it('releaseMutex nulls BOTH the segment mutex and the location claim', () => {
    expect(src).toMatch(/segment_started_at:\s*null,\s*location_claim_at:\s*null/)
  })

  it('self-continue routes through the non-SSO origin helper, not the raw deployment URL', () => {
    expect(src).toMatch(/resolveInternalOrigin\(url\.origin\)/)
  })
})
