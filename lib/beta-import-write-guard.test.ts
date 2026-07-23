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
  withResumeOverlap,
  RESUME_REWRITE_OVERLAP,
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

describe('withResumeOverlap — mid-client partial-write guard (item 5)', () => {
  it('removes the most-recently-written ids so they get re-processed', () => {
    const already = new Set(['1', '2', '3', '4', '5'])
    // recent (jobber_synced_at desc) = the last segment touched 5,4,3
    const kept = withResumeOverlap(already, ['5', '4', '3'], 3)
    expect([...kept].sort()).toEqual(['1', '2'])
  })

  it('the boundary client (lead written, children maybe not) falls back into unwritten', () => {
    const client = (n: string) => ({ id: encodeJobberId('Client', n) })
    const clients = [client('10'), client('20'), client('30')]
    // 10 + 20 fully landed; 30 was the in-flight client when the segment died.
    const already = new Set(['10', '20', '30'])
    const kept = withResumeOverlap(already, ['30'], 1) // 30 is the freshest jobber_synced_at
    const unwritten = selectUnwrittenClients(clients, kept)
    expect(unwritten.map((c) => c.id)).toEqual([client('30').id]) // 30 re-processed
  })

  it('re-processing is bounded — never re-scans the whole done prefix', () => {
    const already = new Set(Array.from({ length: 500 }, (_, i) => String(i)))
    const recent = ['499', '498', '497', '496', '495']
    const kept = withResumeOverlap(already, recent, RESUME_REWRITE_OVERLAP)
    expect(kept.size).toBe(500 - RESUME_REWRITE_OVERLAP) // only the overlap re-runs
  })

  it('tolerates null/undefined ids in the recent list', () => {
    const already = new Set(['1', '2'])
    const kept = withResumeOverlap(already, [null, undefined, '2'] as any, 5)
    expect([...kept]).toEqual(['1'])
  })

  it('a fresh import (nothing already written) is a no-op', () => {
    expect(withResumeOverlap(new Set(), [], 5).size).toBe(0)
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
    const continueAt = block.indexOf('await selfContinue(')
    expect(persistAt).toBeGreaterThanOrEqual(0)
    expect(releaseAt).toBeGreaterThan(persistAt)
    expect(continueAt).toBeGreaterThan(releaseAt)
  })

  // ── the continuation handoff must be AWAITED, never fire-and-forget ──
  // A nested waitUntil() here is a SILENT NO-OP: @vercel/functions resolves it
  // as `getContext().waitUntil?.(p)`, and by the time a segment yields the HTTP
  // response is long gone, so there is no request context to register with —
  // the promise is dropped and the function is not held open for it. Awaiting
  // inside the outer waitUntil(runImport()) is what keeps the lambda alive for
  // the handoff. This is the loc_kc fast-path regression; pin it.
  it('EVERY self-continue call site is awaited', () => {
    const calls = src.match(/^[^\n]*selfContinue\(jobId\)/gm) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)   // fetch-phase + write-phase yields
    for (const line of calls) expect(line).toMatch(/await\s+selfContinue\(jobId\)/)
  })

  it('self-continue never wraps its POST in a nested waitUntil', () => {
    const decl = src.slice(src.indexOf('const selfContinue ='), src.indexOf('// Run the import detached'))
    expect(decl).not.toContain('waitUntil')
    expect(decl).toContain('await postContinuation(')
  })

  it('self-continue records its outcome so a bounce is not silently swallowed', () => {
    const decl = src.slice(src.indexOf('const selfContinue ='), src.indexOf('// Run the import detached'))
    expect(decl).toContain('recordContinuationAttempt(')
    expect(decl).toMatch(/source:\s*'self_chain'/)
    // The old code ended in `.catch(() => {})` — every failure vanished.
    expect(decl).not.toMatch(/catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/)
  })

  it('releaseMutex nulls BOTH the segment mutex and the location claim', () => {
    expect(src).toMatch(/segment_started_at:\s*null,\s*location_claim_at:\s*null/)
  })

  it('self-continue routes through the non-SSO origin helper, not the raw deployment URL', () => {
    expect(src).toMatch(/resolveInternalOrigin\(url\.origin\)/)
  })

  // ── item 5: resume overlap re-processes the boundary client ──
  it('the resume re-processes a bounded overlap of recently-written clients', () => {
    // Orders leads by jobber_synced_at desc, caps at the overlap, and feeds
    // them to withResumeOverlap so the mid-client boundary is re-processed.
    expect(src).toMatch(/order\(\s*['"]jobber_synced_at['"]\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/)
    expect(src).toContain('withResumeOverlap(alreadyWritten, recentIds, RESUME_REWRITE_OVERLAP)')
    expect(src).toContain('.limit(RESUME_REWRITE_OVERLAP)')
  })

  // ── item 1a: cooperative cancellation ──
  it('the write-loop checkpoint is guarded on status=running and bails on cancel', () => {
    // The periodic progress update only matches a still-running job; zero rows
    // means /api/import/cancel flipped it to failed → stop without completing.
    expect(src).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]running['"]\s*\)\s*\.select\(\s*['"]id['"]\s*\)/)
    expect(src).toMatch(/if\s*\(!stillRunning\s*\|\|\s*stillRunning\.length\s*===\s*0\)/)
  })

  it('the completion write is guarded on status=running so a cancel is not resurrected', () => {
    const block = src.slice(src.indexOf("status: 'completed'"))
    expect(block).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]running['"]\s*\)/)
    expect(src).toMatch(/if\s*\(!completedRow\s*\|\|\s*completedRow\.length\s*===\s*0\)/)
  })
})

// ── Cancel route source-pin ────────────────────────────────────
describe('import cancel route', () => {
  const src = readFileSync(
    join(process.cwd(), 'app/api/import/cancel/route.ts'),
    'utf8',
  )
  it('marks the job failed and releases BOTH mutexes, guarded on status=running', () => {
    expect(src).toMatch(/status:\s*'failed'/)
    expect(src).toMatch(/segment_started_at:\s*null,\s*location_claim_at:\s*null/)
    expect(src).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]running['"]\s*\)/)
  })
  it('enforces the owner ownership check (slug resolved from the owner location)', () => {
    expect(src).toContain("hubUser.role === 'owner'")
    expect(src).toMatch(/forbidden/)
  })
  it('is idempotent on an already-terminal job', () => {
    expect(src).toContain('already_terminal')
  })
})

// ── Sweeper max-lifetime fail-out source-pin (item 1b) ─────────
describe('import-sweeper max-lifetime fail-out', () => {
  const src = readFileSync(
    join(process.cwd(), 'app/api/cron/import-sweeper/route.ts'),
    'utf8',
  )
  it('has a fail-out threshold comfortably past the 600s write budget', () => {
    expect(src).toContain('FAIL_AFTER_MS = 15 * 60 * 1000')
  })
  it('splits hopeless jobs from resumable ones and only re-pokes the resumable', () => {
    expect(src).toMatch(/const hopeless = jobs\.filter/)
    expect(src).toMatch(/const resumable = jobs\.filter/)
    expect(src).toMatch(/resumable\.map\(async/)
  })
  it('marks a hopeless job failed with both mutexes released, guarded on running', () => {
    const block = src.slice(src.indexOf('hopeless.map'))
    expect(block).toMatch(/status:\s*'failed'/)
    expect(block).toMatch(/segment_started_at:\s*null,\s*location_claim_at:\s*null/)
    expect(block).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]running['"]\s*\)/)
  })
})
