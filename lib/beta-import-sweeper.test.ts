// @vitest-environment node
//
// import-sweeper recovery (stalled-Scottsdale, Bug 2). The sweeper finds jobs
// stuck in status='running' with a stale location_claim_at and re-pokes the
// import route to resume them. Root cause of the real stall: the re-poke POST
// resolved its origin to the SSO-gated deployment URL, so Vercel Deployment
// Protection redirected it to a login page before the route ran — every
// re-poke bounced (prod: detection matched Scottsdale for ~58 min, zero
// recoveries). These tests pin the path that was broken:
//
//   • IDENTIFY  — filters status='running' + a stale location_claim_at.
//   • RE-POKE   — POSTs with x-import-continue-secret == CRON_SECRET so it
//                 passes the import route's internal-continue gate.
//   • ORIGIN    — targets the non-SSO custom domain, NEVER the gated
//                 req.nextUrl.origin the sweeper was invoked on. (The fix.)
//   • REDIRECT  — an opaqueredirect (redirect:'manual' → status 0) reads as a
//                 blocked failure, not a silent ok:false.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── recording supabase mock: one import_jobs query, records its filter ops ──
const h = vi.hoisted(() => {
  const state = {
    jobs: [] as any[],
    ops: [] as [string, any[]][],
    touched: false,
  }
  const reset = () => { state.jobs = []; state.ops = []; state.touched = false }
  const builder = () => {
    state.touched = true
    const b: any = {}
    for (const m of ['select', 'eq', 'or', 'order']) {
      b[m] = (...args: any[]) => { state.ops.push([m, args]); return b }
    }
    b.limit = (...args: any[]) => {
      state.ops.push(['limit', args])
      return Promise.resolve({ data: state.jobs, error: null })
    }
    b.then = (res: any, rej: any) => Promise.resolve({ data: state.jobs, error: null }).then(res, rej)
    return b
  }
  return { state, reset, builder }
})
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => h.builder() },
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/cron/import-sweeper/route'

const GATED = 'https://bee-hub-dep123.vercel.app'      // deployment origin GET is invoked on — SSO-gated
const PUBLIC = 'https://beehive.beeorganized.com'       // non-SSO custom domain the re-poke must use
const URL_BASE = `${GATED}/api/cron/import-sweeper`

// Minimal fetch Response stand-in (undici-shaped for the fields the sweeper reads).
const resp = (over: Partial<{ status: number; type: string; location: string | null }> = {}) => ({
  status: over.status ?? 200,
  type: over.type ?? 'basic',
  headers: { get: (k: string) => (k === 'location' ? over.location ?? null : null) },
})

let fetchMock: ReturnType<typeof vi.fn>

describe('GET /api/cron/import-sweeper — recovery', () => {
  beforeEach(() => {
    h.reset()
    process.env.CRON_SECRET = 'sweep-secret'
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC
    process.env.NEXT_PUBLIC_SITE_URL = PUBLIC
    delete process.env.INTERNAL_BASE_URL
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    fetchMock = vi.fn(async () => resp())
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.NEXT_PUBLIC_SITE_URL
  })

  const stalled = () => new NextRequest(URL_BASE, { headers: { authorization: 'Bearer sweep-secret' } })

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
    h.state.jobs = []
    const res = await GET(stalled())
    expect((await res.json())).toMatchObject({ resumed: 0, checked: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('IDENTIFY: filters on status=running + a stale location_claim_at', async () => {
    h.state.jobs = [{ id: 'job-1', location_id: 'loc_scottsdale', location_claim_at: '2020-01-01T00:00:00Z' }]
    await GET(stalled())
    const eqCols = h.state.ops.filter((o) => o[0] === 'eq').map((o) => o[1][0])
    expect(eqCols).toContain('status')
    expect(eqCols).toContain('type')
    const orClause = h.state.ops.find((o) => o[0] === 'or')?.[1]?.[0] ?? ''
    expect(orClause).toContain('location_claim_at')
    expect(orClause).toMatch(/location_claim_at\.lt\./) // staleness cutoff
  })

  it('RE-POKE + ORIGIN + AUTH: resumes the stalled job via the NON-gated domain with the internal secret', async () => {
    h.state.jobs = [{ id: 'job-1', location_id: 'loc_scottsdale', location_claim_at: '2020-01-01T00:00:00Z' }]
    const res = await GET(stalled())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    // Origin is the fix: the public custom domain, NOT the gated deployment URL.
    expect(url).toContain(PUBLIC)
    expect(url).not.toContain(GATED)
    expect(url).toContain('location_id=loc_scottsdale')
    expect(url).toContain('_continue=1')
    // Authenticates via the internal-continue gate the import route honors.
    expect(opts.method).toBe('POST')
    expect(opts.headers['x-import-continue-secret']).toBe('sweep-secret')
    expect(opts.redirect).toBe('manual')

    const body = await res.json()
    expect(body).toMatchObject({ resumed: 1, checked: 1 })
    expect(body.results[0]).toMatchObject({ location_id: 'loc_scottsdale', ok: true })
  })

  it('re-pokes every stalled job in the batch', async () => {
    h.state.jobs = [
      { id: 'a', location_id: 'loc_a', location_claim_at: null },
      { id: 'b', location_id: 'loc_b', location_claim_at: '2020-01-01T00:00:00Z' },
    ]
    const res = await GET(stalled())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await res.json()).resumed).toBe(2)
  })

  it('REDIRECT: an opaqueredirect (status 0) reads as a blocked re-poke, not a success', async () => {
    // Exactly what redirect:'manual' yields when the origin IS still SSO-gated.
    fetchMock.mockResolvedValue(resp({ status: 0, type: 'opaqueredirect' }))
    h.state.jobs = [{ id: 'job-1', location_id: 'loc_scottsdale', location_claim_at: '2020-01-01T00:00:00Z' }]
    const res = await GET(stalled())
    const body = await res.json()
    expect(body.resumed).toBe(0)
    expect(body.results[0].ok).toBe(false)
  })

  it('REDIRECT: a raw 302 is also counted as blocked, not resumed', async () => {
    fetchMock.mockResolvedValue(resp({ status: 302, location: 'https://vercel.com/sso' }))
    h.state.jobs = [{ id: 'job-1', location_id: 'loc_scottsdale', location_claim_at: '2020-01-01T00:00:00Z' }]
    const res = await GET(stalled())
    const body = await res.json()
    expect(body.resumed).toBe(0)
    expect(body.results[0]).toMatchObject({ ok: false, status: 302, redirected_to: 'https://vercel.com/sso' })
  })
})
