// @vitest-environment node
// lib/beta-create-duplicate-check.test.ts
// ─────────────────────────────────────────────────────────────
// POST /api/leads (the in-app create, a person present) — the server-side
// duplicate check added 29 Oct 2026. Before it, this door had no check of any
// kind: the create form's browser lookup was the only gate.
//
//   SOLID       — one record on email OR phone → 409 duplicate_client with
//                 that record's id + name. Nothing inserted.
//   IN QUESTION — keys hit several records / disagree → created, flagged
//                 possible_duplicate_of (an ARRAY) + a touchpoint.
//   NAME ONLY   — created, flagged.
//   NO MATCH    — created exactly as before: no flag key, no extra touchpoint.
//   CHECK FAILS — created anyway, with a warning (a lost client is worse
//                 than a duplicate).
// Email is matched case-blind on the STORED side (7,015 of 48,516 rows carry
// a capital, production 29 Oct 2026).
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'is', 'in', 'ilike', 'range', 'order', 'limit']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(async () => null) }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'owner-1' })) }))
vi.mock('@/lib/lead-assignment', () => ({
  writeLeadAssignment: vi.fn(async () => ({ junctionWritten: true, warnings: [] })),
}))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => ({})) }))
vi.mock('@/lib/drip-enrol-outcome', () => ({
  recordDripEnrolOutcome: vi.fn(async () => {}),
  dripEnrolReasonText: vi.fn(() => ''),
}))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/lead-notification-email', () => ({ notifyNewLead: vi.fn(async () => ({})) }))
vi.mock('@/lib/slack-bot', () => ({ notifyNewLeadSlack: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/notification-log', () => ({ logSlackNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/phone-note', () => ({ recordPhoneNote: vi.fn(async () => ({ ok: true })) }))

import { POST } from '@/app/api/leads/route'

const post = (body: any) =>
  POST(new Request('http://test/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_uuid: 'loc-uuid-1', assigned_to: null, startDrip: false, ...body }),
  }) as any)

const stored = (over: any = {}) => ({
  id: 'lead-A', name: 'Shirley Ann Morgan', email: 'smorganwre@yahoo.com',
  phone: '(702) 764-9862', phone_normalized: '7027649862', is_junk: false,
  location_uuid: 'loc-uuid-1', ...over,
})

// Auth + location, then the leads queue in call order: match query → (name
// query when no strong hit) → insert.
const setup = (...leadsResponses: any[]) => {
  h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })
  h.enqueue('locations', { id: 'loc-uuid-1', location_id: 'loc_centraldenver', name: 'Central Denver' })
  for (const r of leadsResponses) h.enqueue('leads', r)
}

const leadsCalls = () => h.state.calls.filter(c => c.table === 'leads')
const insertOf = (table: string) => h.state.calls
  .filter(c => c.table === table)
  .flatMap(c => c.ops.filter(([m]) => m === 'insert').map(([, a]) => a[0]))
const orFilterOfMatchQuery = () => leadsCalls()[0].ops.find(([m]) => m === 'or')?.[1][0]

beforeEach(() => h.reset())

describe('in-app create — SOLID match is refused, the existing record returned', () => {
  it('refuses a solid EMAIL match and returns the existing record', async () => {
    setup([stored({ phone: null, phone_normalized: '' })])
    const res = await post({ name: 'Shirley Morgan', email: 'smorganwre@yahoo.com' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({
      error: 'duplicate_client',
      existing: { id: 'lead-A', name: 'Shirley Ann Morgan' },
      matched_on: 'email',
    })
    expect(insertOf('leads')).toHaveLength(0)
    expect(insertOf('touchpoints')).toHaveLength(0)
  })

  it('refuses a solid PHONE match and returns the existing record', async () => {
    setup([stored({ email: null })])
    const res = await post({ name: 'S Morgan', phone: '702.764.9862' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.existing).toEqual({ id: 'lead-A', name: 'Shirley Ann Morgan' })
    expect(body.matched_on).toBe('phone')
    expect(insertOf('leads')).toHaveLength(0)
  })

  it('the email match is case-blind on the STORED side', async () => {
    // The stored row carries capitals; the typed address is mixed case too.
    setup([stored({ email: 'SMorganWRE@Yahoo.com', phone: null, phone_normalized: '' })])
    const res = await post({ name: 'Shirley', email: 'smorganwre@YAHOO.com' })
    expect(res.status).toBe(409)
    // The DB filter is ilike on the lowercased key — eq would never find a
    // stored capital. (`_` escaping is pinned in the clientMatch tests.)
    expect(orFilterOfMatchQuery()).toBe('email.ilike."smorganwre@yahoo.com"')
  })

  it('is scoped to the location the create targets, junk excluded', async () => {
    setup([stored()])
    await post({ name: 'Shirley', email: 'smorganwre@yahoo.com' })
    const ops = leadsCalls()[0].ops
    expect(ops).toContainEqual(['eq', ['location_uuid', 'loc-uuid-1']])
    expect(ops).toContainEqual(['not', ['is_junk', 'is', true]])
  })
})

describe('in-app create — weaker matches still create, flagged', () => {
  it('an IN-QUESTION match (email and phone point at different records) creates and sets possible_duplicate_of', async () => {
    setup(
      [stored({ id: 'lead-A', phone: null, phone_normalized: '' }), stored({ id: 'lead-B', email: 'other@x.com' })],
      { id: 'lead-new', name: 'Shirley' },
    )
    const res = await post({ name: 'Shirley', email: 'smorganwre@yahoo.com', phone: '(702) 764-9862' })
    expect(res.status).toBe(201)
    const payload = insertOf('leads')[0]
    expect(payload.possible_duplicate_of).toEqual(['lead-A', 'lead-B'])
    const tps = insertOf('touchpoints').map(t => t.label)
    expect(tps).toContain('Possible duplicate — matched an existing client when created')
  })

  it('a NAME-ONLY match creates and sets possible_duplicate_of', async () => {
    setup([], [{ id: 'lead-N', name: 'shirley ann morgan' }], { id: 'lead-new', name: 'Shirley Ann Morgan' })
    const res = await post({ name: 'Shirley Ann Morgan', email: 'new@x.com' })
    expect(res.status).toBe(201)
    expect(insertOf('leads')[0].possible_duplicate_of).toEqual(['lead-N'])
    // the name query is a case-blind exact match at this location
    const nameOps = leadsCalls()[1].ops
    expect(nameOps).toContainEqual(['ilike', ['name', 'Shirley Ann Morgan']])
    expect(nameOps).toContainEqual(['eq', ['location_uuid', 'loc-uuid-1']])
  })
})

describe('in-app create — no match, or a failed check', () => {
  it('a create with NO match works exactly as before: no flag, no extra touchpoint', async () => {
    setup([], [], { id: 'lead-new', name: 'Brand New' })
    const res = await post({ name: 'Brand New', email: 'brand@new.com' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.lead.id).toBe('lead-new')
    expect(body.warnings).toBeUndefined()
    expect(insertOf('leads')[0]).not.toHaveProperty('possible_duplicate_of')
    expect(insertOf('leads')[0].email).toBe('brand@new.com')
    expect(insertOf('touchpoints').map(t => t.label)).toEqual(['Client created'])
  })

  it('a FAILED check still creates, with a warning', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })
    h.enqueue('locations', { id: 'loc-uuid-1', location_id: 'loc_centraldenver', name: 'Central Denver' })
    h.enqueue('leads', null, { message: 'statement timeout' })
    h.enqueue('leads', { id: 'lead-new', name: 'Brand New' })
    const res = await post({ name: 'Brand New', email: 'brand@new.com' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.warnings).toEqual(['dedup_match_failed: statement timeout'])
    expect(insertOf('leads')[0]).not.toHaveProperty('possible_duplicate_of')
  })
})
