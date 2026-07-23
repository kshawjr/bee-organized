// @vitest-environment node
//
// GET /api/companies/[id]/referrals — the ROUND TRIP for company-as-referrer.
//
// The picker writes { referred_by_kind:'company', referred_by_id:<company> }
// (UI half pinned in beta-referrer-fab-companies); this route queries exactly
// that shape into its DIRECT bucket. Pins:
//   A) a picker-written referral lands in the DIRECT bucket — via reads
//      { kind:'company', id:<company> }, and the leads query filters on
//      referred_by_kind='company' + referred_by_id=<company> (the same two
//      columns the PATCH writes — the wire is one piece)
//   B) direct and via-person rows stay DISJOINT: a lead referred by one of
//      the company's people is attributed to the person, never double-
//      bucketed as company-direct
//   C) location scoping holds: non-admin at another location → 403
//
// Queue-mock harness from network-reverse-referrals (per-table FIFO).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null, count: number | null = null) =>
    state.queue.push({ table, resp: { data, error, count } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null, count: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'or', 'not', 'range', 'is', 'limit', 'order', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { GET } from '@/app/api/companies/[id]/referrals/route'

const run = async (id = 'co-1') =>
  GET({} as any, { params: Promise.resolve({ id }) } as any)

const seedCaller = (role: string, location_id: string | null = 'loc-1') =>
  h.enqueue('hub_users', { id: 'u1', role, location_id })

const COMPANY = { id: 'co-1', location_id: 'loc-1', name: 'Acme Restoration', industry: 'Restoration' }

beforeEach(() => h.reset())

describe('A) picker-written referral → the DIRECT bucket', () => {
  it('a company-referred lead comes back attributed to the company itself', async () => {
    seedCaller('super_admin', null)
    h.enqueue('companies', COMPANY)
    // The row the picker flow produces: referred_by_kind='company',
    // referred_by_id='co-1' — returned by the DIRECT query.
    h.enqueue('leads', [{ id: 'lead-9', name: 'Fresh Person', created_at: '2026-07-23T00:00:00Z' }], null, 1)
    h.enqueue('partners', [])       // no people → no via fetch
    h.enqueue('engagements', [])

    const res = await run()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.referred).toHaveLength(1)
    expect(json.referred[0]).toMatchObject({
      id: 'lead-9',
      via: { kind: 'company', id: 'co-1', name: 'Acme Restoration' },   // DIRECT
    })
    expect(json.total).toBe(1)

    // The wire is one piece: the direct query filters on the SAME two
    // columns the picker's PATCH/POST writes.
    const leadsCall = h.state.calls.find(c => c.table === 'leads')!
    const eqs = leadsCall.ops.filter(o => o[0] === 'eq').map(o => o[1])
    expect(eqs).toEqual(expect.arrayContaining([
      ['referred_by_kind', 'company'],
      ['referred_by_id', 'co-1'],
    ]))
  })
})

describe('B) direct vs via-person stay disjoint', () => {
  it('a person-referred lead is attributed to the person, not the company', async () => {
    seedCaller('super_admin', null)
    h.enqueue('companies', COMPANY)
    h.enqueue('leads', [{ id: 'lead-9', name: 'Direct Dana', created_at: '2026-07-23T00:00:00Z' }], null, 1)   // direct
    h.enqueue('partners', [{ id: 'per-1', name: 'Karen Martinez', type: 'partner', title: '', stage: 'Active Partner', tier: null }])
    h.enqueue('leads', [{ id: 'lead-10', name: 'Via Vince', created_at: '2026-07-22T00:00:00Z', referred_by_id: 'per-1' }])  // via
    h.enqueue('engagements', [])

    const json = await (await run()).json()
    expect(json.referred).toHaveLength(2)
    const byId = Object.fromEntries(json.referred.map((r: any) => [r.id, r]))
    expect(byId['lead-9'].via).toMatchObject({ kind: 'company', id: 'co-1' })
    expect(byId['lead-10'].via).toMatchObject({ kind: 'partner', id: 'per-1', name: 'Karen Martinez' })
    expect(json.total).toBe(2)
    // The person's own count rides along, still attributed to them.
    expect(json.people[0]).toMatchObject({ id: 'per-1', referral_count: 1 })
  })
})

describe('C) scoping', () => {
  it('non-admin at another location → 403', async () => {
    seedCaller('owner', 'loc-OTHER')
    h.enqueue('companies', COMPANY)
    const res = await run()
    expect(res.status).toBe(403)
  })

  it('unknown company → 404', async () => {
    seedCaller('super_admin', null)
    h.enqueue('companies', null)
    expect((await run()).status).toBe(404)
  })
})
