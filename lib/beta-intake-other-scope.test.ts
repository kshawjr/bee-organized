// @vitest-environment node
// lib/beta-intake-other-scope.test.ts
// ─────────────────────────────────────────────────────────────
// The website door's duplicate check looks beyond where the lead lands
// (30 Oct 2026). Shirley Ann Morgan, 12 Oct: her zip was not live, so the
// lead was parked in Other and the check searched Other only — while she was
// already a client at Central Denver, the location the website sent. A second
// record was made.
//
//   landed in Other       → Other + the sent location; a solid match in either
//                           merges (at the sent location, into her own record)
//   landed at a location  → that location merges as always; Other and the sent
//                           location only FLAG (a client waiting in Other is
//                           never merged into: the enquiry goes to the owner it
//                           was routed to, and the later move joins them)
//   a third location      → never searched, never flagged
//   one in each place     → in_question: created, flagged, never merged
// Also pinned in clientMatch: a single-uuid caller still gets .eq.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { queryLeadMatches } from '@/components/hive/shared/clientMatch'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
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
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => ({ sent: true })) }))
vi.mock('@/lib/engagements', () => ({
  findOpenEngagementForClient: vi.fn(async () => null),
  foundManualEngagement: vi.fn(async () => ({ engagement: { id: 'eng-1' }, created: true })),
}))

import { POST } from '@/app/api/leads/intake/route'

const makeReq = (body: any) => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? 'test-key' : null) },
  json: async () => body,
}) as any

const OTHER = { id: 'uuid-other', name: 'Other', location_id: 'loc_other', lifecycle_status: 'active' }
const CENTRAL = { id: 'uuid-central', name: 'Central Denver', location_id: 'loc_centraldenver', lifecycle_status: 'active' }
const PHILLY = { id: 'uuid-philly', name: 'Philadelphia Suburbs', location_id: 'loc_phillysuburbs', lifecycle_status: 'active' }
const zipRow = (location_id: string, lifecycle_status = 'active') => ({ zip: 'x', location: { location_id, lifecycle_status } })

const row = (id: string, location_uuid: string, over: any = {}) => ({
  id, name: 'Shirley Ann Morgan', email: 'smorganwre@yahoo.com', phone: null, phone_normalized: '',
  is_junk: false, location_uuid, created_at: '2026-07-14T00:00:00Z', stage: 'New', ...over,
})

// Shirley's submission: the website sent Central Denver; her zip is claimed
// by a location that is not live, so the zip parks her in Other.
const shirley = (over: any = {}) => ({
  location_slug: 'loc_centraldenver', full_name: 'Shirley Ann Morgan',
  email: 'smorganwre@yahoo.com', zip: '80231', ...over,
})
const parkedInOther = () => {
  h.enqueue('location_zips', [zipRow('loc_denver', 'paused')])
  h.enqueue('locations', OTHER)   // landing
  h.enqueue('locations', CENTRAL) // the sent location, for the search
}

const leadCalls = () => h.state.calls.filter(c => c.table === 'leads')
const matchQuery = () => leadCalls()[0]
const inScope = () => matchQuery().ops.find(o => o[0] === 'in')?.[1]
const inserts = () => leadCalls().flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))
const lastLog = () => {
  const calls = syncLog.writeSyncLog.mock.calls as any[]
  return calls[calls.length - 1][0] as any
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
})

describe('parked in Other — the sent location is searched too', () => {
  it("Shirley's case: one record at the sent location is found and merged into, at that location", async () => {
    parkedInOther()
    h.enqueue('leads', [row('real-072e', 'uuid-central')])
    const res = await POST(makeReq(shirley()))
    const body = await res.json()
    expect(inScope()).toEqual(['location_uuid', ['uuid-other', 'uuid-central']])
    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('real-072e')
    expect(body.location.slug).toBe('loc_centraldenver')
    expect(inserts()).toHaveLength(0)
    expect(lastLog().message).toContain('matched_loc=loc_centraldenver')
    expect(lastLog().message).toContain('dedup_scope=loc_other,loc_centraldenver')
  })

  it('one record in Other is found and merged into, exactly as before', async () => {
    parkedInOther()
    h.enqueue('leads', [row('waiting-1', 'uuid-other')])
    const body = await (await POST(makeReq(shirley()))).json()
    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('waiting-1')
    expect(body.location.slug).toBe('loc_other')
    expect(lastLog().message).not.toContain('matched_loc=')
  })

  it('one record in Other AND one at the sent location: merges into neither, creates flagged against both', async () => {
    parkedInOther()
    h.enqueue('leads', [row('waiting-1', 'uuid-other'), row('real-072e', 'uuid-central')])
    h.enqueue('leads', { id: 'lead-new' })
    const body = await (await POST(makeReq(shirley()))).json()
    expect(body.merged).toBeUndefined()
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0].location_uuid).toBe('uuid-other')
    expect(new Set(inserts()[0].possible_duplicate_of)).toEqual(new Set(['waiting-1', 'real-072e']))
  })

  it('a paused sent location is searched but never merged into — it only flags', async () => {
    h.enqueue('location_zips', [zipRow('loc_denver', 'paused')])
    h.enqueue('locations', OTHER)
    h.enqueue('locations', { ...CENTRAL, lifecycle_status: 'paused' })
    h.enqueue('leads', [row('real-072e', 'uuid-central')])
    h.enqueue('leads', { id: 'lead-new' })
    const body = await (await POST(makeReq(shirley()))).json()
    expect(body.merged).toBeUndefined()
    expect(inserts()[0].possible_duplicate_of).toEqual(['real-072e'])
  })
})

describe('landed at a real location — Other and the sent location only flag', () => {
  const routedToPhilly = () => {
    h.enqueue('location_zips', [zipRow('loc_phillysuburbs')])
    h.enqueue('locations', PHILLY) // landing
    h.enqueue('locations', OTHER)  // for the search
  }
  const globalLead = { full_name: 'Adel Verticelli', email: 'adel@example.com', zip: '19373', form_source: 'Global' }

  it('one record waiting in Other is FOUND: the lead lands here, flagged against it, not merged', async () => {
    routedToPhilly()
    h.enqueue('leads', [row('waiting-1', 'uuid-other', { email: 'adel@example.com' })])
    h.enqueue('leads', { id: 'lead-new' })
    const body = await (await POST(makeReq(globalLead))).json()
    expect(inScope()).toEqual(['location_uuid', ['uuid-philly', 'uuid-other']])
    expect(body.merged).toBeUndefined()
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0].location_uuid).toBe('uuid-philly')
    expect(inserts()[0].possible_duplicate_of).toEqual(['waiting-1'])
  })

  it('one record here still merges, a stale copy in Other notwithstanding', async () => {
    routedToPhilly()
    h.enqueue('leads', [row('here-1', 'uuid-philly', { email: 'adel@example.com' }), row('waiting-1', 'uuid-other', { email: 'adel@example.com' })])
    const body = await (await POST(makeReq(globalLead))).json()
    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('here-1')
  })

  it('a record at a third, unrelated location is not searched and not found', async () => {
    routedToPhilly()
    // even if a row from elsewhere came back, it is ignored — not merged, not flagged
    h.enqueue('leads', [row('far-1', 'uuid-reno', { email: 'adel@example.com' })])
    h.enqueue('leads', []) // name check
    h.enqueue('leads', { id: 'lead-new' })
    const body = await (await POST(makeReq(globalLead))).json()
    expect(inScope()![1]).not.toContain('uuid-reno')
    expect(body.merged).toBeUndefined()
    expect(inserts()[0]).not.toHaveProperty('possible_duplicate_of')
  })
})

describe('the sent location as the landing — exactly as today', () => {
  it('no zip: lands where the website sent it, and one record there is found and merged', async () => {
    h.enqueue('locations', CENTRAL) // landing (no zip → sent decides)
    h.enqueue('locations', OTHER)
    h.enqueue('leads', [row('real-072e', 'uuid-central')])
    const body = await (await POST(makeReq(shirley({ zip: undefined })))).json()
    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('real-072e')
    expect(body.location.slug).toBe('loc_centraldenver')
  })

  it('if the extra lookups fail, it searches the landing location alone with the old single-location query', async () => {
    h.enqueue('locations', CENTRAL)
    h.enqueue('locations', null, { message: 'boom' }) // Other lookup fails
    h.enqueue('leads', [row('real-072e', 'uuid-central')])
    const body = await (await POST(makeReq(shirley({ zip: undefined })))).json()
    expect(matchQuery().ops).toContainEqual(['eq', ['location_uuid', 'uuid-central']])
    expect(body.merged).toBe(true)
  })
})

describe('queryLeadMatches — the other callers keep their single-location query', () => {
  const chain = () => {
    const ops: any[] = []
    const b: any = {}
    for (const m of ['from', 'select', 'or', 'not', 'range', 'eq', 'in']) b[m] = (...a: any[]) => { ops.push([m, a]); return b }
    b.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res)
    return { b, ops }
  }
  it('a uuid string → .eq on that location, never .in (the in-app create and the Jobber import)', async () => {
    const { b, ops } = chain()
    await queryLeadMatches(b, { email: 'a@b.com', locationUuid: 'loc-1' })
    expect(ops).toContainEqual(['eq', ['location_uuid', 'loc-1']])
    expect(ops.some(o => o[0] === 'in')).toBe(false)
  })
  it("'all' → no location filter at all, as before", async () => {
    const { b, ops } = chain()
    await queryLeadMatches(b, { email: 'a@b.com', locationUuid: 'all' })
    expect(ops.some(o => o[0] === 'eq' || o[0] === 'in')).toBe(false)
  })
  it('an array → .in on exactly those locations', async () => {
    const { b, ops } = chain()
    await queryLeadMatches(b, { email: 'a@b.com', locationUuid: ['loc-1', 'loc-1', 'loc-2'] })
    expect(ops).toContainEqual(['in', ['location_uuid', ['loc-1', 'loc-2']]])
  })
  it('an empty array finds nothing and never runs unscoped', async () => {
    const { b, ops } = chain()
    expect(await queryLeadMatches(b, { email: 'a@b.com', locationUuid: [] })).toEqual([])
    expect(ops).toHaveLength(0)
  })
})
