// @vitest-environment node
//
// GET /api/partners/[id]/referrals — the server-side reverse-referral
// lookup. Replaces Classic's client-side array scan
// (people.filter(p => p.referredBy === id)) which silently under-counted
// whenever the loaded people set was scoped/paged.
//
// Pins:
//   A) the count is the SERVER count over the real link — a lead the
//      client never loaded still counts (the exact under-count the array
//      scan produced)
//   B) revenue/converted come from the engagements join, not jsonb zeros
//   C) `total` is the FULL match count even past the page cap
//   D) location scoping: non-admin wrong-location → 403; partner 404s
//      cleanly
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabaseService mock (reopen-route pattern): chainable builder,
// per-table FIFO response queues.
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

import { GET } from '@/app/api/partners/[id]/referrals/route'

const run = async (id = 'partner-1') =>
  GET({} as any, { params: Promise.resolve({ id }) } as any)

const seedCaller = (role: string, location_id: string | null = 'loc-1') =>
  h.enqueue('hub_users', { id: 'u1', role, location_id })

const PARTNER = { id: 'partner-1', location_id: 'loc-1', name: 'Karen Martinez', type: 'partner' }

beforeEach(() => h.reset())

describe('A+B) counts + rollup from the real link', () => {
  it('returns every referred lead with joined revenue/converted', async () => {
    seedCaller('owner')
    h.enqueue('partners', PARTNER)
    // Three referred leads — including one ('L3') that a scoped client-side
    // people array would never have loaded. The server sees all three.
    h.enqueue('leads', [
      { id: 'L1', name: 'Lisa Patel', created_at: '2026-07-01T00:00:00Z' },
      { id: 'L2', name: 'Mark Johnson', created_at: '2026-06-01T00:00:00Z' },
      { id: 'L3', name: 'Unloaded Lead', created_at: '2026-05-01T00:00:00Z' },
    ], null, 3)
    h.enqueue('engagements', [
      { client_id: 'L1', stage: 'Closed Won', total_paid: 1200 },
      { client_id: 'L1', stage: 'Estimate', total_paid: 300 },
      { client_id: 'L2', stage: 'Request', total_paid: 0 },
    ])

    const res = await run()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.partner).toEqual({ id: 'partner-1', name: 'Karen Martinez', type: 'partner' })
    expect(body.referred).toHaveLength(3)
    expect(body.totals).toEqual({ count: 3, converted: 1, revenue: 1500 })
    const byId = Object.fromEntries(body.referred.map((r: any) => [r.id, r]))
    expect(byId.L1.converted).toBe(true)
    expect(byId.L1.revenue).toBe(1500)
    expect(byId.L2.status).toBe('active')
    expect(byId.L3.status).toBe('lead')
  })

  it('zero referrals → clean empty payload, no engagement fetch', async () => {
    seedCaller('owner')
    h.enqueue('partners', PARTNER)
    h.enqueue('leads', [], null, 0)
    const res = await run()
    const body = await res.json()
    expect(body.referred).toEqual([])
    expect(body.totals).toEqual({ count: 0, converted: 0, revenue: 0 })
    expect(h.state.calls.filter(c => c.table === 'engagements')).toHaveLength(0)
  })
})

describe('C) full count past the page cap', () => {
  it('total carries the TRUE match count when it exceeds the returned page', async () => {
    seedCaller('super_admin', null)
    h.enqueue('partners', PARTNER)
    const page = Array.from({ length: 200 }, (_, i) => ({
      id: `L${i}`, name: `Lead ${i}`, created_at: '2026-07-01T00:00:00Z',
    }))
    h.enqueue('leads', page, null, 231) // 31 beyond the cap
    h.enqueue('engagements', [])
    const body = await (await run()).json()
    expect(body.referred).toHaveLength(200)
    expect(body.total).toBe(231)
  })
})

describe('D) auth + scoping', () => {
  it('non-admin at another location → 403', async () => {
    seedCaller('owner', 'loc-OTHER')
    h.enqueue('partners', PARTNER)
    const res = await run()
    expect(res.status).toBe(403)
  })

  it('unknown partner → 404', async () => {
    seedCaller('owner')
    h.enqueue('partners', null)
    const res = await run('nope')
    expect(res.status).toBe(404)
  })

  it('no session → 401', async () => {
    // loadCaller finds no hub_users row → null caller.
    const res = await run()
    expect(res.status).toBe(401)
  })
})
