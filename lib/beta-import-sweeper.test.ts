// @vitest-environment node
//
// import-sweeper recovery — the continuation handoff's safety net.
//
// These run the REAL route handler against an in-memory Supabase and a fake
// import endpoint that performs the REAL compare-and-swap claim. So the
// end-to-end assertions are about DB STATE ("a new segment claimed the job"),
// not about whether a function was called. We already shipped a fix once that
// looked right at the call-spy level and did not work in production.
//
// What is pinned:
//   • IDENTIFY  — the find-query matches a CLEANLY-YIELDED job (status running,
//                 location_claim_at NULL), not just a stale claim.
//   • E2E       — a cleanly-yielded job is re-poked and a new segment claims.
//   • REGRESSION— a clean yield 40 minutes into a long import is re-poked, NOT
//                 failed out. (loc_kc: the fail-out aged jobs from started_at,
//                 turning the 15-min last resort into a hard 15-min ceiling on
//                 total import duration. 3,352 records need ~9 segments.)
//   • ORIGIN    — targets the non-SSO custom domain, never the gated
//                 req.nextUrl.origin the cron invoked us on.
//   • REDIRECT  — an opaqueredirect (redirect:'manual' → status 0) reads as a
//                 blocked failure, and is RECORDED to sync_log, not swallowed.
//   • NO_CLAIM  — a 2xx that leaves the claim unheld is the silent-failure
//                 class and must be recorded as a failure.
//   • FAIL-OUT  — still fires, but only on real evidence: a stale held claim,
//                 or a bounce run past the ceiling.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── in-memory Supabase: table-aware, applies the filters for real ──
const h = vi.hoisted(() => {
  const db: Record<string, any[]> = { import_jobs: [], sync_log: [] }
  const ops: [string, any[]][] = []
  // beforeRead fires on every maybeSingle() — the seam a test uses to make a
  // claim appear LATE, simulating a cold-starting receiver.
  const state = { touched: false, beforeRead: null as null | (() => void) }
  const reset = () => {
    db.import_jobs = []
    db.sync_log = []
    ops.length = 0
    state.touched = false
    state.beforeRead = null
  }

  // `col.op.value` terms, OR'd. Only the ops the sweeper actually emits.
  const orMatcher = (clause: string) => (r: any) =>
    clause.split(',').some((term) => {
      const [col, op, ...rest] = term.split('.')
      const val = rest.join('.')
      if (op === 'is' && val === 'null') return r[col] == null
      if (op === 'lt') return r[col] != null && String(r[col]) < val
      if (op === 'lte') return r[col] != null && String(r[col]) <= val
      return false
    })

  const from = (table: string) => {
    state.touched = true
    db[table] ??= []
    const preds: Array<(r: any) => boolean> = []
    let mode: 'select' | 'update' | 'insert' = 'select'
    let patch: any = null
    let order: { col: string; asc: boolean } | null = null
    let cap: number | null = null

    const rows = () => {
      let out = db[table].filter((r) => preds.every((p) => p(r)))
      if (order) {
        const { col, asc } = order
        out = [...out].sort((a, b) => {
          const av = a[col] ?? '', bv = b[col] ?? ''
          return (av < bv ? -1 : av > bv ? 1 : 0) * (asc ? 1 : -1)
        })
      }
      if (cap != null) out = out.slice(0, cap)
      return out
    }
    const resolve = () => {
      if (mode === 'update') {
        const hit = rows()
        hit.forEach((r) => Object.assign(r, patch))
        return { data: hit, error: null }
      }
      return { data: rows(), error: null }
    }

    const b: any = {
      select: (...a: any[]) => { ops.push(['select', a]); return b },
      insert: (row: any) => { ops.push(['insert', [row]]); mode = 'insert'; db[table].push({ ...row }); return b },
      update: (p: any) => { ops.push(['update', [p]]); mode = 'update'; patch = p; return b },
      eq: (c: string, v: any) => { ops.push(['eq', [c, v]]); preds.push((r) => r[c] === v); return b },
      in: (c: string, v: any[]) => { ops.push(['in', [c, v]]); preds.push((r) => v.includes(r[c])); return b },
      gte: (c: string, v: any) => { ops.push(['gte', [c, v]]); preds.push((r) => r[c] != null && String(r[c]) >= v); return b },
      or: (clause: string) => { ops.push(['or', [clause]]); preds.push(orMatcher(clause)); return b },
      order: (c: string, o: any = {}) => { ops.push(['order', [c, o]]); order = { col: c, asc: o.ascending !== false }; return b },
      limit: (n: number) => { ops.push(['limit', [n]]); cap = n; return Promise.resolve(resolve()) },
      maybeSingle: () => { state.beforeRead?.(); return Promise.resolve({ data: rows()[0] ?? null, error: null }) },
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    }
    return b
  }
  return { db, ops, state, reset, from }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: h.from } }))
// writeSyncLog builds its own Supabase client — point it at the fake DB so
// the recorded continuation trail is assertable.
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: async (row: any) => {
    h.db.sync_log.push({ ...row, created_at: new Date().toISOString() })
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/cron/import-sweeper/route'
import { CONTINUATION_LOG_PREFIX, formatContinuationLogMessage } from '@/lib/import-continuation'

const GATED = 'https://bee-hub-dep123.vercel.app'   // deployment origin the cron hits — SSO-gated
const PUBLIC = 'https://beehive.beeorganized.com'    // non-SSO custom domain the re-poke must use
const URL_BASE = `${GATED}/api/cron/import-sweeper`
const SECRET = 'sweep-secret'
const MIN = 60_000
const ago = (mins: number) => new Date(Date.now() - mins * MIN).toISOString()

// A claim stale enough to be found + re-poked, but not past the 15min ceiling.
const RESUMABLE_STALE = () => ago(4)
// Well past the ceiling → the sweeper gives up.
const HOPELESS_STALE = () => ago(20)

const resp = (over: Partial<{ status: number; type: string; location: string | null }> = {}) => ({
  status: over.status ?? 200,
  type: over.type ?? 'basic',
  headers: { get: (k: string) => (k === 'location' ? over.location ?? null : null) },
})

// A running job row. Defaults to the CLEANLY-YIELDED state — released claim,
// mid-import, long-running — because that is the state the old fail-out killed.
const job = (over: Partial<Record<string, any>> = {}) => ({
  id: 'job-1',
  location_id: 'loc_kc',
  type: 'jobber_clients',
  status: 'running',
  location_claim_at: null,
  segment_started_at: null,
  started_at: ago(40),
  phase: 'batched — 636/3352, continuing (time budget)',
  processed_records: 636,
  total_records: 3352,
  ...over,
})

// A sync_log continuation row, as recordContinuationAttempt writes it.
const attempt = (jobId: string, slug: string, outcome: any, minsAgo: number) => ({
  location_id: slug,
  entity_id: slug,
  entity_type: 'location',
  status: outcome === 'landed' ? 'success' : 'error',
  message: formatContinuationLogMessage({ source: 'sweeper', outcome, jobId }),
  created_at: ago(minsAgo),
})

// The fake import endpoint: performs the SAME compare-and-swap claim the real
// route does (tryClaim — take it if location_claim_at is null or >90s old),
// against the same in-memory DB. So "landed" means a segment really claimed.
const CLAIM_TTL_MS = 90_000
const realImportRoute = async (url: string, opts: any) => {
  if (opts?.headers?.['x-import-continue-secret'] !== SECRET) return resp({ status: 401 })
  const slug = new URL(url).searchParams.get('location_id')
  const row = h.db.import_jobs.find((j) => j.location_id === slug && j.status === 'running')
  if (!row) return resp({ status: 200 })
  const claimMs = row.location_claim_at ? Date.parse(row.location_claim_at) : NaN
  if (!Number.isFinite(claimMs) || claimMs < Date.now() - CLAIM_TTL_MS) {
    row.location_claim_at = new Date().toISOString()   // this segment claims
  }
  return resp({ status: 200 })
}

const continuationRows = () =>
  h.db.sync_log.filter((r) => String(r.message).startsWith(CONTINUATION_LOG_PREFIX))

let fetchMock: ReturnType<typeof vi.fn>

describe('GET /api/cron/import-sweeper — continuation handoff', () => {
  beforeEach(() => {
    h.reset()
    process.env.CRON_SECRET = SECRET
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC
    process.env.NEXT_PUBLIC_SITE_URL = PUBLIC
    delete process.env.INTERNAL_BASE_URL
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    fetchMock = vi.fn(realImportRoute as any)
    vi.stubGlobal('fetch', fetchMock)
    // The claim verification sleeps between polls (it must cover a cold-start
    // receiver in prod). Run those sleeps instantly so the attempt-bounded
    // loop stays deterministic and fast here. Safe against postContinuation's
    // abort timer: these fetch stubs ignore the signal.
    vi.stubGlobal('setTimeout', ((fn: any) => { fn(); return 0 }) as any)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.NEXT_PUBLIC_SITE_URL
  })

  const sweep = () => GET(new NextRequest(URL_BASE, { headers: { authorization: `Bearer ${SECRET}` } }))

  // ── auth ───────────────────────────────────────────────────────
  it('fail-closed 500 without CRON_SECRET, never touching the DB', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(new NextRequest(URL_BASE))
    expect(res.status).toBe(500)
    expect(h.state.touched).toBe(false)
  })

  it('401 on a wrong bearer token', async () => {
    const res = await GET(new NextRequest(URL_BASE, { headers: { authorization: 'Bearer nope' } }))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no stalled jobs → resumed 0, no re-pokes', async () => {
    const res = await sweep()
    expect(await res.json()).toMatchObject({ resumed: 0, checked: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── IDENTIFY ───────────────────────────────────────────────────
  it('IDENTIFY: filters on status=running + type, and matches a NULL claim as well as a stale one', async () => {
    h.db.import_jobs = [job()]
    await sweep()
    const eqCols = h.ops.filter((o) => o[0] === 'eq').map((o) => o[1][0])
    expect(eqCols).toContain('status')
    expect(eqCols).toContain('type')
    const orClause = h.ops.find((o) => o[0] === 'or')?.[1]?.[0] ?? ''
    expect(orClause).toMatch(/location_claim_at\.is\.null/)   // the clean-yield state
    expect(orClause).toMatch(/location_claim_at\.lt\./)       // the dead-segment state
  })

  it("IDENTIFY: the find-query really returns a cleanly-yielded job (null claim, status running)", async () => {
    // Runs the OR clause through the fake DB's filter, not just a string check.
    h.db.import_jobs = [
      job({ id: 'yielded', location_claim_at: null }),
      job({ id: 'fresh', location_id: 'loc_other', location_claim_at: ago(0.1) }),  // healthy — must be skipped
      job({ id: 'not-running', location_id: 'loc_done', status: 'completed', location_claim_at: null }),
    ]
    const body = await (await sweep()).json()
    expect(body.checked).toBe(1)
    expect(body.results.map((r: any) => r.job_id)).toEqual(['yielded'])
  })

  // ── END-TO-END ─────────────────────────────────────────────────
  it('E2E: a cleanly-yielded job is picked up — a new segment CLAIMS it', async () => {
    h.db.import_jobs = [job()]
    const body = await (await sweep()).json()

    // The outcome that matters is DB state, not the call count: the claim the
    // graceful yield released is now held again → a segment took over.
    const row = h.db.import_jobs[0]
    expect(row.location_claim_at).not.toBeNull()
    expect(Date.parse(row.location_claim_at)).toBeGreaterThan(Date.now() - 5000)
    expect(row.status).toBe('running')          // NOT failed out
    expect(body).toMatchObject({ resumed: 1, failed_out: 0, checked: 1 })
    expect(body.results[0]).toMatchObject({ ok: true, outcome: 'landed' })
  })

  it('E2E: the landing is recorded to sync_log so Kevin can see the handoff worked', async () => {
    h.db.import_jobs = [job()]
    await sweep()
    const rows = continuationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ location_id: 'loc_kc', entity_type: 'location', status: 'success' })
    expect(rows[0].message).toContain('outcome=landed')
    expect(rows[0].message).toContain('source=sweeper')
    expect(rows[0].message).toContain('job=job-1')
  })

  it('REGRESSION (loc_kc): a clean yield 40 minutes into a long import is RE-POKED, not failed out', async () => {
    // The exact prod row: 636/3352, claim released by the graceful yield,
    // started_at 40 min ago. The old fail-out aged this from started_at and
    // marked it failed WITHOUT re-poking. A 3,352-record import needs ~9
    // segments — killing it at 15 min made completion impossible.
    h.db.import_jobs = [job({ started_at: ago(40) })]
    const body = await (await sweep()).json()
    expect(body.failed_out).toBe(0)
    expect(body.resumed).toBe(1)
    expect(h.db.import_jobs[0].status).toBe('running')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('REGRESSION: even a 4-hour-old job is re-poked while it keeps making progress', async () => {
    h.db.import_jobs = [job({ started_at: ago(240), processed_records: 2067 })]
    const body = await (await sweep()).json()
    expect(body).toMatchObject({ failed_out: 0, resumed: 1 })
  })

  it('re-pokes every candidate in the batch', async () => {
    h.db.import_jobs = [
      job({ id: 'a', location_id: 'loc_a', location_claim_at: null }),
      job({ id: 'b', location_id: 'loc_b', location_claim_at: RESUMABLE_STALE() }),
    ]
    const body = await (await sweep()).json()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body.resumed).toBe(2)
    expect(h.db.import_jobs.every((j) => j.location_claim_at != null)).toBe(true)
  })

  // ── ORIGIN ─────────────────────────────────────────────────────
  it('ORIGIN + AUTH: re-pokes via the NON-gated domain with the internal secret', async () => {
    h.db.import_jobs = [job()]
    await sweep()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain(PUBLIC)
    expect(url).not.toContain(GATED)
    expect(url).toContain('location_id=loc_kc')
    expect(url).toContain('_continue=1')
    expect(opts.method).toBe('POST')
    expect(opts.headers['x-import-continue-secret']).toBe(SECRET)
    expect(opts.redirect).toBe('manual')
  })

  // ── bounces are LOUD ───────────────────────────────────────────
  it('REDIRECT: an opaqueredirect (status 0) is a blocked re-poke, RECORDED, and does not claim', async () => {
    fetchMock.mockResolvedValue(resp({ status: 0, type: 'opaqueredirect', location: 'https://vercel.com/sso' }))
    h.db.import_jobs = [job()]
    const body = await (await sweep()).json()

    expect(body.resumed).toBe(0)
    expect(body.results[0]).toMatchObject({ ok: false, outcome: 'bounced', status: 0 })
    expect(h.db.import_jobs[0].location_claim_at).toBeNull()   // nobody took it

    const rows = continuationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('error')                        // surfaces as a problem
    expect(rows[0].message).toContain('outcome=bounced')
    expect(rows[0].message).toMatch(/SSO-gated/)
  })

  it('REDIRECT: a raw 302 is also counted as blocked and recorded', async () => {
    fetchMock.mockResolvedValue(resp({ status: 302, location: 'https://vercel.com/sso' }))
    h.db.import_jobs = [job()]
    const body = await (await sweep()).json()
    expect(body.results[0]).toMatchObject({ ok: false, outcome: 'bounced', status: 302, redirected_to: 'https://vercel.com/sso' })
    expect(continuationRows()[0].status).toBe('error')
  })

  it('a thrown fetch is recorded as errored, never an unhandled rejection', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    h.db.import_jobs = [job()]
    const body = await (await sweep()).json()
    expect(body.results[0]).toMatchObject({ ok: false, outcome: 'errored' })
    expect(continuationRows()[0].message).toContain('outcome=errored')
  })

  it('NO_CLAIM: a 2xx that leaves the claim unheld is recorded as a failure, not a phantom success', async () => {
    // The silent-failure class: the route answered 200 but no segment took the
    // job. HTTP status alone would have called this a success.
    fetchMock.mockResolvedValue(resp({ status: 200 }))   // no claim side-effect
    h.db.import_jobs = [job()]
    const body = await (await sweep()).json()
    expect(body.resumed).toBe(0)
    expect(body.results[0]).toMatchObject({ ok: false, outcome: 'no_claim' })
    expect(continuationRows()[0].status).toBe('error')
    expect(continuationRows()[0].message).toContain('outcome=no_claim')
  })

  it('NO_CLAIM: a slow (cold-starting) receiver that claims late still reads as landed', async () => {
    // Prod, 2026-07-22: the receiver took >9s between handler entry and its
    // claim write, and a single immediate re-read called that "no segment
    // claimed". The verification must POLL, not peek. Here the claim appears
    // only on the 3rd verification read.
    fetchMock.mockResolvedValue(resp({ status: 200 }))   // no synchronous claim
    h.db.import_jobs = [job()]
    let reads = 0
    h.state.beforeRead = () => {
      if (++reads === 3) h.db.import_jobs[0].location_claim_at = new Date().toISOString()
    }
    const body = await (await sweep()).json()
    expect(reads).toBeGreaterThanOrEqual(3)              // it kept looking
    expect(body.results[0]).toMatchObject({ ok: true, outcome: 'landed' })
    expect(continuationRows()[0].message).toContain('outcome=landed')
  })

  it('an ambiguous no_claim run NEVER fails a job out (only hard bounces do)', async () => {
    // The safety property. A racy signal must not become a second way to kill
    // a healthy import — that is the bug this whole change removes.
    fetchMock.mockResolvedValue(resp({ status: 200 }))   // never claims
    h.db.import_jobs = [job({ id: 'job-racy' })]
    h.db.sync_log = [
      attempt('job-racy', 'loc_kc', 'no_claim', 2),
      attempt('job-racy', 'loc_kc', 'no_claim', 18),
      attempt('job-racy', 'loc_kc', 'errored', 30),
    ]
    const body = await (await sweep()).json()
    expect(body.failed_out).toBe(0)
    expect(h.db.import_jobs[0].status).toBe('running')
  })

  it('CHAIN CAP: a 508 from the self-chain is recorded but never fails a job out', async () => {
    // Vercel's recursion guard, hit on the real loc_kc import at ~3,340/3,352.
    // The sweeper runs on its own invocation chain, so a 508 is a handoff TO
    // it, not evidence that recovery is broken.
    h.db.import_jobs = [job({ id: 'job-capped' })]
    h.db.sync_log = [
      attempt('job-capped', 'loc_kc', 'chain_capped', 2),
      attempt('job-capped', 'loc_kc', 'chain_capped', 19),
      attempt('job-capped', 'loc_kc', 'chain_capped', 31),
    ]
    const body = await (await sweep()).json()
    expect(body.failed_out).toBe(0)
    expect(body.resumed).toBe(1)                       // sweeper still picks it up
    expect(h.db.import_jobs[0].location_claim_at).not.toBeNull()
  })

  it('a timeout run also never fails a job out', async () => {
    h.db.import_jobs = [job({ id: 'job-slow' })]
    h.db.sync_log = [
      attempt('job-slow', 'loc_kc', 'errored', 1),
      attempt('job-slow', 'loc_kc', 'errored', 25),
    ]
    const body = await (await sweep()).json()
    expect(body.failed_out).toBe(0)
  })

  it('a job that FINISHED during the re-poke counts as landed, not no_claim', async () => {
    fetchMock.mockImplementation(async () => {
      h.db.import_jobs[0].status = 'completed'
      return resp({ status: 200 })
    })
    h.db.import_jobs = [job()]
    const body = await (await sweep()).json()
    expect(body.results[0]).toMatchObject({ ok: true, outcome: 'landed' })
  })

  // ── FAIL-OUT: last resort, on real evidence only ───────────────
  it('FAIL-OUT: a claim held and stale past the ceiling is marked failed, NOT re-poked', async () => {
    h.db.import_jobs = [job({ id: 'job-dead', location_claim_at: HOPELESS_STALE(), phase: 'writing', processed_records: 607, total_records: 709 })]
    const body = await (await sweep()).json()

    expect(fetchMock).not.toHaveBeenCalled()
    const row = h.db.import_jobs[0]
    expect(row.status).toBe('failed')
    expect(row.segment_started_at).toBeNull()
    expect(row.location_claim_at).toBeNull()
    expect(row.error_message).toMatch(/died without releasing/)
    expect(row.error_message).toContain('607/709')
    expect(body).toMatchObject({ resumed: 0, failed_out: 1, checked: 1 })
    expect(body.results.find((r: any) => r.job_id === 'job-dead')).toMatchObject({ failed_out: true, reason: 'stale_claim' })
  })

  it('FAIL-OUT is guarded on status=running (never clobbers a natural transition)', async () => {
    h.db.import_jobs = [job({ id: 'job-dead', location_claim_at: HOPELESS_STALE() })]
    await sweep()
    const eqCols = h.ops.filter((o) => o[0] === 'eq').map((o) => o[1])
    expect(eqCols).toEqual(expect.arrayContaining([['id', 'job-dead'], ['status', 'running']]))
  })

  it('FAIL-OUT: a null-claim job whose re-pokes have all bounced past the ceiling gives up', async () => {
    // The only way a cleanly-yielded job can be failed out: recorded evidence
    // that the handoff itself is broken, for longer than the ceiling.
    h.db.import_jobs = [job({ id: 'job-bouncy' })]
    h.db.sync_log = [
      attempt('job-bouncy', 'loc_kc', 'bounced', 1),
      attempt('job-bouncy', 'loc_kc', 'bounced', 8),
      attempt('job-bouncy', 'loc_kc', 'bounced', 17),
    ]
    const body = await (await sweep()).json()
    expect(body).toMatchObject({ failed_out: 1, resumed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.db.import_jobs[0].error_message).toMatch(/re-poke has failed to land/)
    expect(h.db.import_jobs[0].error_message).toContain(CONTINUATION_LOG_PREFIX)
  })

  it('a bounce run that already RECOVERED does not fail the job out', async () => {
    h.db.import_jobs = [job({ id: 'job-ok' })]
    h.db.sync_log = [
      attempt('job-ok', 'loc_kc', 'landed', 2),    // newest — the run ended here
      attempt('job-ok', 'loc_kc', 'bounced', 20),
      attempt('job-ok', 'loc_kc', 'bounced', 30),
    ]
    const body = await (await sweep()).json()
    expect(body).toMatchObject({ failed_out: 0, resumed: 1 })
  })

  it("another job's bounce history never ages this job", async () => {
    h.db.import_jobs = [job({ id: 'job-mine' })]
    h.db.sync_log = [attempt('job-someone-else', 'loc_kc', 'bounced', 40)]
    const body = await (await sweep()).json()
    expect(body).toMatchObject({ failed_out: 0, resumed: 1 })
  })

  it('MIXED batch: a clean yield resumes while a dead-claim job fails out', async () => {
    h.db.import_jobs = [
      job({ id: 'yielded', location_id: 'loc_young', location_claim_at: null, started_at: ago(90) }),
      job({ id: 'dead', location_id: 'loc_old', location_claim_at: HOPELESS_STALE(), phase: 'writing' }),
    ]
    const body = await (await sweep()).json()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('loc_young')
    expect(body).toMatchObject({ resumed: 1, failed_out: 1, checked: 2 })
  })

  // ── PARKED (sample-now / bulk-later) — LEAK 3a ─────────────────
  // A sample import parks its job: status stays 'running', claim released,
  // resume_after in the future, phase 'parked — …'. To the pre-park sweeper
  // that is indistinguishable from a cleanly-yielded job — which gets
  // re-poked within ~60s. The resume_after filter is what makes the park
  // hold until the off-hours window.
  const parked = (over: Partial<Record<string, any>> = {}) =>
    job({
      id: 'job-parked',
      location_claim_at: null,
      phase: 'parked — sample of 75 imported, 3277 resume overnight',
      processed_records: 75,
      resume_after: new Date(Date.now() + 6 * 60 * MIN).toISOString(),  // tonight
      ...over,
    })

  it('PARKED: a future resume_after is SKIPPED — not re-poked, not failed out, claim stays released', async () => {
    h.db.import_jobs = [parked()]
    const body = await (await sweep()).json()
    // checked 0 = the parked job never even entered the candidate set (the
    // zero-candidate early return carries no failed_out field).
    expect(body).toMatchObject({ resumed: 0, checked: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    const row = h.db.import_jobs[0]
    expect(row.status).toBe('running')            // still parked, still blocking rival imports
    expect(row.location_claim_at).toBeNull()      // nobody claimed it
    expect(row.resume_after).not.toBeNull()       // the park survived the sweep
  })

  it('PARKED: stays parked across many sweeps (the every-minute cron cannot erode it)', async () => {
    h.db.import_jobs = [parked()]
    for (let i = 0; i < 5; i++) await sweep()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.db.import_jobs[0].status).toBe('running')
  })

  it('RESUME: a PAST resume_after is picked up like any cleanly-yielded job — a segment claims', async () => {
    h.db.import_jobs = [parked({ resume_after: ago(1) })]   // the window opened a minute ago
    const body = await (await sweep()).json()
    expect(body).toMatchObject({ resumed: 1, checked: 1, failed_out: 0 })
    expect(h.db.import_jobs[0].location_claim_at).not.toBeNull()   // the overnight run took it
  })

  it('PARKED filter shape: resume_after gates alongside the claim filter, and NULL matches as before', async () => {
    // A normal job (no resume_after) must still be found — the new filter's
    // null arm is what keeps every pre-existing import behaving identically.
    h.db.import_jobs = [job()]
    const body = await (await sweep()).json()
    expect(body).toMatchObject({ resumed: 1, checked: 1 })
    const orClauses = h.ops.filter((o) => o[0] === 'or').map((o) => o[1][0])
    const parkClause = orClauses.find((c: string) => c.includes('resume_after'))
    expect(parkClause).toMatch(/resume_after\.is\.null/)
    expect(parkClause).toMatch(/resume_after\.lte\./)
  })

  it('MIXED batch: a parked job is invisible while its neighbors resume/fail normally', async () => {
    h.db.import_jobs = [
      parked({ location_id: 'loc_parked' }),
      job({ id: 'yielded', location_id: 'loc_young', location_claim_at: null }),
      job({ id: 'dead', location_id: 'loc_old', location_claim_at: HOPELESS_STALE(), phase: 'writing' }),
    ]
    const body = await (await sweep()).json()
    expect(body).toMatchObject({ resumed: 1, failed_out: 1, checked: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('loc_young')
    const parkedRow = h.db.import_jobs.find((j) => j.id === 'job-parked')!
    expect(parkedRow.status).toBe('running')
    expect(parkedRow.location_claim_at).toBeNull()
  })
})
