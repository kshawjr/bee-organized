// @vitest-environment node
//
// THE IMPORT HANDOFF — the detached work never started.
//
// app/api/import/jobber-clients/route.ts ended with:
//
//     waitUntil(runImport())
//     return NextResponse.json({ job_id: jobId, started: true })
//
// and runImport never ran. Proof from production (251b44e): in the six
// minutes after that deploy went READY, sync_log held six [continuation]
// rows — each carrying this route's own reply, {"job_id":"f385d31d...",
// "started":true} — and ZERO [import-entry] rows. The ENTERED write is the
// FIRST statement inside runImport and goes to the same table, through the
// same helper, that was delivering a row a minute beside it. The route ran,
// replied, and the work was discarded. Philadelphia Suburbs sat at 1,606 of
// 18,883 for six days.
//
// These tests are written so that the OLD code fails them. Every one of them
// drives the REAL route handler with waitUntil stubbed to a NO-OP — which is
// exactly what production was doing — so "it works on my machine because
// waitUntil happened to run" cannot make them pass.
//
// What is pinned:
//   · the segment is AWAITED — the response must not exist before the work
//   · a dropped/no-op waitUntil can no longer produce a silent success
//   · the reply reports real work (entered / mutex / records), not acceptance
//   · the mutex still refuses a second concurrent segment
//   · releaseMutex still runs on every exit path, including a throw
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── in-memory Supabase: table-aware, applies the filters that matter ──
const h = vi.hoisted(() => {
  const db: Record<string, any[]> = { locations: [], import_jobs: [] }
  // Ordered trace of everything that happened, so ORDERING can be asserted —
  // "did the work run before the response resolved" is the whole bug.
  const trace: string[] = []
  const state = {
    // Set true to make the segment mutex claim come back empty (BUSY branch).
    mutexBusy: false,
    // Set true to make the staging write throw, for the releaseMutex test.
    throwAfterMutex: false,
  }
  const reset = () => {
    db.locations = []
    db.import_jobs = []
    trace.length = 0
    state.mutexBusy = false
    state.throwAfterMutex = false
  }

  const from = (table: string) => {
    const preds: Array<(r: any) => boolean> = []
    let mode: 'select' | 'update' | 'insert' = 'select'
    let patch: any = null
    db[table] ??= []

    const rows = () => db[table].filter((r) => preds.every((p) => p(r)))
    const resolve = () => {
      if (mode === 'update') {
        // The segment mutex claim: an UPDATE of segment_started_at on
        // import_jobs. Simulate "another segment holds it" by matching zero
        // rows, which is exactly how the real compare-and-swap loses.
        if (table === 'import_jobs' && patch && 'segment_started_at' in patch && patch.segment_started_at !== null) {
          trace.push('mutex:attempt')
          if (state.mutexBusy) return { data: [], error: null }
        }
        if (table === 'import_jobs' && patch && patch.segment_started_at === null) {
          trace.push('mutex:released')
        }
        const hit = rows()
        hit.forEach((r) => Object.assign(r, patch))
        return { data: hit, error: null }
      }
      return { data: rows(), error: null }
    }

    const b: any = {
      select: () => b,
      insert: (row: any) => { mode = 'insert'; db[table].push({ ...row, id: row.id ?? 'job-new' }); return b },
      // Deterministic mid-segment explosion for the releaseMutex-on-throw
      // test: the staging write is the first thing the segment does after it
      // wins the mutex, so throwing here lands squarely inside runImport's try.
      upsert: () => {
        if (h.state.throwAfterMutex) throw new Error('staging exploded mid-segment')
        return b
      },
      delete: () => b,
      update: (p: any) => { mode = 'update'; patch = p; return b },
      eq: (c: string, v: any) => { preds.push((r) => r[c] === v); return b },
      or: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    }
    return b
  }
  return { db, trace, state, reset, from }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: h.from } }))

// The diagnostic writes from 251b44e go through here. They are the instrument
// that proves the work ran, so they are recorded, not silenced.
vi.mock('@/lib/sync-log', () => ({
  // The await here is LOad-BEARING. A promise dropped by a no-op waitUntil
  // still runs its MICROtasks under vitest, so a purely synchronous mock lets
  // the buggy code fill the trace anyway and the ordering assertions pass for
  // the wrong reason. A real macrotask reproduces the production truth: the
  // lambda freezes at the first suspension point once the response is
  // returned, so a detached segment has recorded NOTHING by then.
  writeSyncLog: vi.fn(async (row: any) => {
    await new Promise((r) => setTimeout(r, 5))
    h.trace.push(`synclog:${row.message}`)
  }),
}))

// waitUntil STUBBED TO A NO-OP — reproducing production exactly. If the route
// still relies on it, the work is dropped and every assertion below fails.
const vercelFns = vi.hoisted(() => ({ waitUntil: vi.fn((_p: any) => { /* dropped, as in prod */ }) }))
vi.mock('@vercel/functions', () => vercelFns)

// A logged-in owner of the location, for the BROWSER path (no secret header,
// so the route's normal user auth runs).
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'hub-1' } } })) },
    from: () => {
      const b: any = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.single = async () => ({ data: { id: 'hub-1', role: 'super_admin', location_id: 'loc-uuid-1' }, error: null })
      b.maybeSingle = b.single
      return b
    },
  })),
}))
vi.mock('@/lib/import-continuation', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/import-continuation')>()
  return {
    ...mod,
    postContinuation: vi.fn(async () => ({ outcome: 'dispatched' as const })),
    recordContinuationAttempt: vi.fn(async () => {}),
  }
})

// The Jobber fetch phase. Made to throw only when a test asks for it.
vi.mock('@/lib/jobber', () => ({
  jobberQueryThrottled: vi.fn(async () => ({
    data: { clients: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    errors: undefined,
  })),
  jobberGraphQL: vi.fn(async () => ({ data: {}, errors: undefined })),
  jobberMutation: vi.fn(async () => ({ data: {}, errors: undefined })),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/import/jobber-clients/route'

const SECRET = 'cron-secret'
const LOC = 'loc_phillysuburbs'
const JOB = 'f385d31d-e7cc-46af-9a3f-db9ca3429056'

const seed = () => {
  h.db.locations = [{
    id: 'loc-uuid-1',
    location_id: LOC,
    name: 'Philadelphia Suburbs',
    jobber_access_token: 'tok',
  }]
  h.db.import_jobs = [{
    id: JOB,
    location_id: LOC,
    type: 'jobber_clients',
    status: 'running',
    location_claim_at: null,
    segment_started_at: null,
    resume_after: null,
    started_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    processed_records: 1606,
    total_records: 18883,
  }]
}

// THE INTERNAL CONTINUATION — the sweeper and the self-chain. Carries the
// secret, so isInternalContinue is true and the segment is AWAITED. This is
// the path the six-day stall lived on, and every awaited-path test below
// drives it.
const post = () =>
  POST(new NextRequest(`https://beehive.beeorganized.com/api/import/jobber-clients?location_id=${LOC}`, {
    method: 'POST',
    headers: { 'x-import-continue-secret': SECRET },
  }) as any)

// THE BROWSER — onboarding's startImport(). No secret, so normal user auth
// runs and the segment stays detached, exactly as production does today.
const postAsBrowser = () =>
  POST(new NextRequest(`https://beehive.beeorganized.com/api/import/jobber-clients?location_id=${LOC}`, {
    method: 'POST',
  }) as any)

beforeEach(() => {
  h.reset()
  vercelFns.waitUntil.mockClear()
  process.env.CRON_SECRET = SECRET
  process.env.NEXT_PUBLIC_APP_URL = 'https://beehive.beeorganized.com'
  seed()
})

describe('the segment runs inside the request', () => {
  it('THE BUG: the work has already run by the time the response exists', async () => {
    h.state.mutexBusy = true   // shortest path through runImport
    let atResolve: string[] = []
    const res = await post().then((r: any) => { atResolve = [...h.trace]; return r })

    // If runImport were still detached through a no-op waitUntil, the trace
    // would hold no [import-entry] rows AT THE MOMENT THE RESPONSE EXISTS —
    // which is precisely what production showed for six days.
    const entered = atResolve.filter((t) => t.includes('[import-entry] runImport ENTERED'))
    expect(entered).toHaveLength(1)
    expect(res.status).toBe(200)
  })

  it('waitUntil is not used for the segment — a no-op waitUntil cannot drop it', async () => {
    h.state.mutexBusy = true
    await post()
    // The stub is a no-op. The work still ran (asserted above and below), so
    // the segment cannot be riding on it.
    expect(vercelFns.waitUntil).not.toHaveBeenCalled()
  })

  it('ORDERING: the work is recorded BEFORE the response resolves', async () => {
    h.state.mutexBusy = true
    // Snapshot the trace at the instant the POST promise settles. With the
    // segment awaited this already holds ENTERED and BUSY; detached, it is
    // empty, because the segment is parked in its first macrotask.
    let atResolve: string[] = []
    await post().then((r: any) => { atResolve = [...h.trace]; return r })

    expect(atResolve.some((t) => t.includes('runImport ENTERED'))).toBe(true)
    expect(atResolve.some((t) => t.includes('mutex BUSY'))).toBe(true)
  })
})

describe('the reply reports the run, not the acceptance', () => {
  it('a segment that won the mutex says so', async () => {
    const body = await (await post()).json()
    expect(body.job_id).toBe(JOB)
    expect(body.entered).toBe(true)
    expect(body.mutex).toBe('won')
    expect(body.ran_segment).toBe(true)
    expect(body).toHaveProperty('records_written')
    // the legacy key survives for the browser, but it now means "it ran"
    expect(body.started).toBe(true)
  })

  it('a segment that lost the mutex is distinguishable from one that ran', async () => {
    h.state.mutexBusy = true
    const body = await (await post()).json()
    expect(body.entered).toBe(true)      // it DID enter
    expect(body.mutex).toBe('busy')      // ...and bounced
    expect(body.ran_segment).toBe(false)
    expect(body.records_written).toBe(0)
  })

  it('the reply can no longer say started:true without the work having run', async () => {
    h.state.mutexBusy = true
    let atResolve: string[] = []
    const res = await post().then((r: any) => { atResolve = [...h.trace]; return r })
    const body = await res.json()
    // `started` is now derived from segment.entered, which is only set INSIDE
    // runImport. Under the old code this was hardcoded true while nothing had
    // happened — so it must agree with the trace as it stood at reply time.
    const enteredRows = atResolve.filter((t) => t.includes('runImport ENTERED')).length
    expect(body.started).toBe(true)
    expect(enteredRows).toBe(1)
  })
})

describe('nothing downstream was disturbed', () => {
  it('the mutex still refuses a second concurrent segment', async () => {
    h.state.mutexBusy = true
    const body = await (await post()).json()
    expect(body.mutex).toBe('busy')
    expect(h.trace).toContain('mutex:attempt')
    // BUSY exits before the write phase — no release, nothing to release.
    expect(h.trace.filter((t) => t.includes('mutex BUSY'))).toHaveLength(1)
  })

  it('releaseMutex still runs when the segment THROWS', async () => {
    h.state.throwAfterMutex = true
    const res = await post()
    expect(res.status).toBe(200)               // the route still answers
    expect(h.trace).toContain('mutex:released') // and the mutex is not stranded
    const body = await res.json()
    expect(body.segment_error).toContain('staging exploded mid-segment')
  })

  it('releaseMutex runs on the ordinary completion path too', async () => {
    await post()
    expect(h.trace).toContain('mutex:released')
  })
})

// ─── the split: which caller waits ───────────────────────────────
//
// Kevin's call. Awaiting on EVERY caller fixes the stall but breaks the
// onboarding UI: startImport() reads job_id out of this reply and only then
// starts its status poller, so a reply meaning "the segment finished" would
// leave an owner watching a dead spinner for up to 600s. The six-day failure
// lives entirely in the retry path, so only that path changes.
//
// The signal is the x-import-continue-secret check that already exists and is
// already the security boundary — deliberately not a new flag.
describe('the browser path stays fast; the retry path waits', () => {
  it('A BROWSER POST RESOLVES WITHOUT WAITING FOR THE SEGMENT', async () => {
    // This is the whole point of the split and what protects the onboarding
    // UI. The diagnostic write crosses a real macrotask, so a segment that had
    // been awaited would have recorded ENTERED by the time the reply exists.
    let atResolve: string[] = []
    const res = await postAsBrowser().then((r: any) => { atResolve = [...h.trace]; return r })

    expect(res.status).toBe(200)
    expect(atResolve.some((t) => t.includes('runImport ENTERED'))).toBe(false)

    const body = await res.json()
    expect(body.job_id).toBe(JOB)
    // `started` on this path means ACCEPTED, and now says so out loud.
    expect(body.started).toBe(true)
    expect(body.accepted).toBe(true)
    // ...and it must NOT claim to report work it did not wait for.
    expect(body.records_written).toBeUndefined()
    expect(body.mutex).toBeUndefined()
    expect(body.ran_segment).toBeUndefined()
  })

  it('the browser path still launches the segment (detached, via waitUntil)', async () => {
    await postAsBrowser()
    expect(vercelFns.waitUntil).toHaveBeenCalledTimes(1)
  })

  it('AN INTERNAL CONTINUATION DOES NOT RESOLVE UNTIL THE SEGMENT COMPLETES', async () => {
    let atResolve: string[] = []
    const res = await post().then((r: any) => { atResolve = [...h.trace]; return r })

    // The mirror of the browser assertion above: same route, same job, the
    // secret is the only difference, and here the work is already done.
    expect(atResolve.some((t) => t.includes('runImport ENTERED'))).toBe(true)
    expect(atResolve).toContain('mutex:released')
    expect(vercelFns.waitUntil).not.toHaveBeenCalled()

    const body = await res.json()
    expect(body.ran_segment).toBe(true)
    expect(body.accepted).toBeUndefined()
  })

  it('the two paths differ ONLY by the secret header', async () => {
    const internal = await (await post()).json()
    h.reset(); seed(); vercelFns.waitUntil.mockClear()
    const browser = await (await postAsBrowser()).json()

    expect(internal.job_id).toBe(browser.job_id)     // same job
    expect(internal.entered).toBe(true)              // one waited
    expect(browser.entered).toBeUndefined()          // the other did not
  })

  it('the browser path releases the mutex too — once its segment finishes', async () => {
    await postAsBrowser()
    // Detached, so let the dropped-but-still-scheduled work drain. In a real
    // lambda this is exactly what is NOT guaranteed — which is the accepted
    // hole: the sweeper re-pokes within 60s and its path is the fixed one.
    await new Promise((r) => setTimeout(r, 60))
    expect(h.trace).toContain('mutex:released')
  })

  it('a THROW on the browser path still releases the mutex', async () => {
    h.state.throwAfterMutex = true
    await postAsBrowser()
    await new Promise((r) => setTimeout(r, 60))
    expect(h.trace).toContain('mutex:released')
  })
})
