// @vitest-environment node
// /api/leads/intake — routing by zip when the form sends no location.
//
// Pinned through the REAL route handler:
//   • no location_slug + a zip one active location holds → that location
//   • a conflicted zip (two locations) → loc_other, candidates on the log
//   • unknown / missing / malformed zip → loc_other, never a 400
//   • a zip held only by a not-live location → loc_other, candidate named
//   • location_zips lookup error → loc_other (the lead is never lost)
//   • THE ZIP WINS (30 Sep 2026): a sent location is ignored whenever there
//     is a zip — including the 9 known reroutes — and both are logged
//   • no zip at all + a sent location → the sent location (the one fallback)
// The routing rule itself is pinned pure in beta-zip-routing.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})
const syncLog = vi.hoisted(() => ({ writeSyncLog: vi.fn(async () => {}) }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => syncLog)
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
  isPastClient: vi.fn(async () => true),
}))
vi.mock('@/lib/drip-send', () => ({
  sendDripStep: vi.fn(async () => ({ sent: true })),
}))
vi.mock('@/lib/engagements', () => ({
  findOpenEngagementForClient: vi.fn(async () => null),
  foundManualEngagement: vi.fn(async () => ({ engagement: { id: 'eng-1' }, created: true })),
}))

import { POST } from '@/app/api/leads/intake/route'

const makeReq = (body: any) => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? 'test-key' : null) },
  json: async () => body,
}) as any

// The website's global form: NO location, a zip.
const globalLead = (over: any = {}) => ({
  full_name: 'Adel Verticelli',
  email: 'adel@example.com',
  phone: '2155550100',
  zip: '19373',
  form_source: 'Global',
  ...over,
})

const PHILLY = { id: 'uuid-philly', name: 'Philadelphia Suburbs', location_id: 'loc_phillysuburbs', lifecycle_status: 'active' }
const OTHER = { id: 'uuid-other', name: 'Other', location_id: 'loc_other', lifecycle_status: 'active' }

const zipRow = (location_id: string, lifecycle_status = 'active') => ({
  zip: 'x', location: { location_id, lifecycle_status },
})

// Enqueue a fresh-insert path at whatever location the lookup lands on.
const landsAt = (loc: any, leadId = 'lead-new') => {
  h.enqueue('locations', loc)
  h.enqueue('leads', []) // strong keys
  h.enqueue('leads', []) // name
  h.enqueue('leads', { id: leadId }) // insert
}

const locationLookupSlug = () => {
  const c = h.state.calls.find(c => c.table === 'locations')
  return c?.ops.find(o => o[0] === 'eq' && o[1][0] === 'location_id')?.[1][1]
}
const zipLookups = () => h.state.calls.filter(c => c.table === 'location_zips')
const lastLog = () => {
  const calls = syncLog.writeSyncLog.mock.calls as any[]
  return calls[calls.length - 1][0] as any
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
})

describe('intake — zip routing (no location sent)', () => {
  it('a zip one active location holds → the lead lands at that location', async () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    landsAt(PHILLY)
    const res = await POST(makeReq(globalLead()))
    expect(res.status).toBe(200)
    expect(zipLookups()).toHaveLength(1)
    expect(zipLookups()[0].ops).toContainEqual(['eq', ['zip', '19373']])
    expect(locationLookupSlug()).toBe('loc_phillysuburbs')
    const body = await res.json()
    expect(body.location.slug).toBe('loc_phillysuburbs')
    expect(body.zip_route).toMatchObject({ reason: 'matched', slug: 'loc_phillysuburbs' })
    expect(lastLog()).toMatchObject({ status: 'success', location_id: 'loc_phillysuburbs' })
    expect(lastLog().message).toContain('routed_by=zip zip_route=matched')
  })

  it('ZIP+4 routes on its first five digits', async () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    landsAt(PHILLY)
    await POST(makeReq(globalLead({ zip: '19373-1234' })))
    expect(zipLookups()[0].ops).toContainEqual(['eq', ['zip', '19373']])
    expect(locationLookupSlug()).toBe('loc_phillysuburbs')
  })

  it('a conflicted zip (two locations) → loc_other; both candidates on the log', async () => {
    h.enqueue('location_zips', [zipRow('loc_denver', 'active'), zipRow('loc_centraldenver', 'active')])
    landsAt(OTHER)
    const res = await POST(makeReq(globalLead({ zip: '80203' })))
    expect(res.status).toBe(200)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=conflict')
    expect(lastLog().message).toContain('zip_candidates=loc_centraldenver,loc_denver')
  })

  it('an unknown zip → loc_other', async () => {
    h.enqueue('location_zips', [])
    landsAt(OTHER)
    const res = await POST(makeReq(globalLead({ zip: '99999' })))
    expect(res.status).toBe(200)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=unmatched')
  })

  it('a MISSING zip → loc_other, no zip lookup, never a 400', async () => {
    landsAt(OTHER)
    const res = await POST(makeReq(globalLead({ zip: undefined })))
    expect(res.status).toBe(200)
    expect(zipLookups()).toHaveLength(0)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=missing')
  })

  it('a blank location_slug is treated as none — the zip routes it', async () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    landsAt(PHILLY)
    const res = await POST(makeReq(globalLead({ location_slug: '  ' })))
    expect(res.status).toBe(200)
    expect(locationLookupSlug()).toBe('loc_phillysuburbs')
  })

  it.each([['1937'], ['19373*'], ['abcde'], ['193733']])('a MALFORMED zip %s → loc_other, no zip lookup', async (bad) => {
    landsAt(OTHER)
    const res = await POST(makeReq(globalLead({ zip: bad })))
    expect(res.status).toBe(200)
    expect(zipLookups()).toHaveLength(0)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=malformed')
  })

  it('a zip held only by a NOT-LIVE location → loc_other, that location named', async () => {
    h.enqueue('location_zips', [zipRow('loc_reno', 'onboarding')])
    landsAt(OTHER)
    const res = await POST(makeReq(globalLead({ zip: '89506' })))
    expect(res.status).toBe(200)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=not_live')
    expect(lastLog().message).toContain('zip_candidates=loc_reno')
  })

  it('the zip lookup ERRORS → loc_other; the lead is still captured', async () => {
    h.enqueue('location_zips', null, { message: 'relation "location_zips" does not exist' })
    landsAt(OTHER)
    const res = await POST(makeReq(globalLead()))
    expect(res.status).toBe(200)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=lookup_failed')
  })

  it('form_source is a contract key — not flagged as drift', async () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    landsAt(PHILLY)
    await POST(makeReq(globalLead()))
    expect(lastLog().message).not.toContain('unknown_keys=')
  })
})

describe('intake — the ZIP WINS over the location the website sends (30 Sep 2026)', () => {
  // The website form keeps sending location_slug exactly as today; Bee Hub
  // just stops routing by it whenever there is a zip.
  const localLead = (location_slug: string, zip: any) =>
    globalLead({ location_slug, form_source: 'Local', zip })

  it('a zip one location holds beats a DIFFERENT sent location — both recorded', async () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    landsAt(PHILLY)
    const res = await POST(makeReq(localLead('loc_portland', '19373')))
    expect(res.status).toBe(200)
    expect(zipLookups()).toHaveLength(1)
    expect(locationLookupSlug()).toBe('loc_phillysuburbs')
    const msg = lastLog().message
    expect(msg).toContain('routed_by=zip zip_route=matched')
    expect(msg).toContain('zip_loc=loc_phillysuburbs sent_loc=loc_portland sent_overridden=true')
  })

  it('when the zip and the sent location agree, both are recorded and nothing is flagged', async () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    landsAt(PHILLY)
    await POST(makeReq(localLead('loc_phillysuburbs', '19373')))
    const msg = lastLog().message
    expect(msg).toContain('zip_loc=loc_phillysuburbs sent_loc=loc_phillysuburbs')
    expect(msg).not.toContain('sent_overridden')
  })

  // The 9 website leads of the last 30 days (to 2026-09-30) whose zip one
  // live location holds but the form sent elsewhere. Pinned by zip: each goes
  // where the territory list says.
  it.each([
    ['78746', 'loc_centralaustin', 'loc_swaustin'],
    ['77433', 'loc_northhouston', 'loc_katy'],
    ['77433', 'loc_northhouston', 'loc_katy'],
    ['32757', 'loc_peoria', 'loc_orlando'],
    ['85050', 'loc_peoria', 'loc_scottsdale'],
    ['78109', 'loc_sanantonio', 'loc_newbraunfels'],
    ['78109', 'loc_sanantonio', 'loc_newbraunfels'],
    ['80216', 'loc_westdenver', 'loc_centraldenver'],
    ['06371', 'loc_westraleigh', 'loc_ctshoreline'],
  ])('known reroute: zip %s sent to %s lands at %s', async (zip, sent, held) => {
    h.enqueue('location_zips', [zipRow(held)])
    landsAt({ id: `uuid-${held}`, name: held, location_id: held, lifecycle_status: 'active' })
    const res = await POST(makeReq(localLead(sent, zip)))
    expect(res.status).toBe(200)
    expect(zipLookups()[0].ops).toContainEqual(['eq', ['zip', zip]])
    expect(locationLookupSlug()).toBe(held)
    expect(lastLog().message).toContain(`zip_loc=${held} sent_loc=${sent} sent_overridden=true`)
  })

  it('a zip NOBODY holds → loc_other, even though a real location was sent', async () => {
    h.enqueue('location_zips', [])
    landsAt(OTHER)
    const res = await POST(makeReq(localLead('loc_portland', '99999')))
    expect(res.status).toBe(200)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=unmatched zip_loc=loc_other sent_loc=loc_portland sent_overridden=true')
  })

  it('a CONFLICTED zip → loc_other, even when the sent location is one of the two', async () => {
    h.enqueue('location_zips', [zipRow('loc_westdenver'), zipRow('loc_centraldenver')])
    landsAt(OTHER)
    await POST(makeReq(localLead('loc_westdenver', '80203')))
    expect(locationLookupSlug()).toBe('loc_other')
    const msg = lastLog().message
    expect(msg).toContain('zip_route=conflict zip_candidates=loc_centraldenver,loc_westdenver')
    expect(msg).toContain('sent_loc=loc_westdenver sent_overridden=true')
  })

  it('a zip held only by a NOT-LIVE location → loc_other, whatever was sent', async () => {
    h.enqueue('location_zips', [zipRow('loc_centralar', 'onboarding')])
    landsAt(OTHER)
    await POST(makeReq(localLead('loc_nwarkansas', '72201')))
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=not_live')
  })

  it('a MALFORMED zip still decides → loc_other, the sent location is not used', async () => {
    landsAt(OTHER)
    await POST(makeReq(localLead('loc_portland', '9720')))
    expect(zipLookups()).toHaveLength(0)
    expect(locationLookupSlug()).toBe('loc_other')
    expect(lastLog().message).toContain('zip_route=malformed zip_loc=loc_other sent_loc=loc_portland')
  })

  it('a bad sent slug no longer matters when there is a zip', async () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    landsAt(PHILLY)
    const res = await POST(makeReq(localLead('typo-slug', '19373')))
    expect(res.status).toBe(200)
    expect(locationLookupSlug()).toBe('loc_phillysuburbs')
  })
})

describe('intake — NO ZIP: the sent location decides (the one fallback)', () => {
  it.each([[undefined], [null], [''], ['   ']])('no zip (%s) + a sent location → that location, zip never looked up', async (zip) => {
    landsAt(PHILLY)
    const res = await POST(makeReq(globalLead({ location_slug: 'loc_phillysuburbs', form_source: 'Local', zip })))
    expect(res.status).toBe(200)
    expect(zipLookups()).toHaveLength(0)
    expect(locationLookupSlug()).toBe('loc_phillysuburbs')
    const msg = lastLog().message
    expect(msg).toContain('routed_by=sent_no_zip sent_loc=loc_phillysuburbs')
    expect(msg).not.toContain('routed_by=zip')
    const body = await res.json()
    expect(body.zip_route).toBeUndefined()
  })

  it('no zip + an unknown sent slug → 400 location_not_found (unchanged)', async () => {
    const res = await POST(makeReq(globalLead({ location_slug: 'typo-slug', zip: undefined })))
    expect(res.status).toBe(400)
    expect(zipLookups()).toHaveLength(0)
    expect(lastLog().message).toContain('error=location_not_found')
    expect(lastLog().message).toContain('slug=typo-slug')
  })
})
