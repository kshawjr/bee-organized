// @vitest-environment node
//
// issue 216 E — POST /api/admin/process-scheduled-removals used to run one
// bare UPDATE with no location filter and no row filter:
//
//   UPDATE subscription_seats SET status='inactive'
//   WHERE scheduled_removal_at <= today AND status='active'
//
// One click deactivated every due seat across every location, and every
// affected seat holding a user_id logs that person out. The operator could
// not decline a single row, and the set actually written was re-derived at
// write time — so anything scheduled between loading the preview and pressing
// the button was swept in unseen.
//
// The request must now state its scope. These pin that: no scope is a 400
// (fail closed — a malformed body must never mean "everything"), seat_ids
// narrows the UPDATE to exactly the rows the operator confirmed, and the
// due-and-active predicate still applies in every branch so naming a seat id
// can never retire one that isn't actually due.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { role: 'super_admin', calls: [] as any[], updateResult: { data: [], error: null } }
  const reset = () => {
    state.role = 'super_admin'
    state.calls = []
    state.updateResult = { data: [], error: null }
  }
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select', filters: {}, in: null, payload: null }
    const b: any = {}
    b.select = () => b
    b.update = (payload: any) => { ctx.op = 'update'; ctx.payload = payload; return b }
    b.eq = (col: string, val: any) => { ctx.filters[col] = val; return b }
    b.lte = (col: string, val: any) => { ctx.filters[`lte:${col}`] = val; return b }
    b.in = (col: string, vals: any[]) => { ctx.in = { col, vals }; return b }
    b.single = async () => {
      state.calls.push({ ...ctx })
      if (table === 'hub_users') return { data: { role: state.role }, error: null }
      return { data: null, error: null }
    }
    // issue 222 — the route now credits Stripe after the UPDATE, which reads
    // the location through getLocationBilling(). Nothing here has a
    // subscription, so every credit stops at 'no_subscription' and these stay
    // tests about SCOPE. The credit itself is pinned in the issue 222 file.
    b.maybeSingle = async () => {
      state.calls.push({ ...ctx })
      return { data: null, error: null }
    }
    // terminal for the UPDATE …select('id')
    b.then = (resolve: any) => {
      state.calls.push({ ...ctx })
      return Promise.resolve(state.updateResult).then(resolve)
    }
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'admin1' } } }) },
    from: (t: string) => h.makeBuilder(t),
  }),
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

import { POST } from '@/app/api/admin/process-scheduled-removals/route'

const req = (body: any) =>
  ({ json: async () => body } as any)

const updateCall = () => h.state.calls.find((c: any) => c.op === 'update')

// issue 222 — the UPDATE now returns the columns the credit needs, so the rows
// these tests hand back carry them too.
const SEAT_ROW = (id: string) => ({ id, location_id: 'loc-ftl', tier: 'manager', notes: null })

beforeEach(() => { h.reset() })

describe('issue 216 E — the removals processor is scoped', () => {
  it('refuses a request with no scope — fail closed', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('scope_required')
    // and nothing was written
    expect(updateCall()).toBeUndefined()
  })

  it('refuses an unparseable body rather than treating it as fleet-wide', async () => {
    const res = await POST({ json: async () => { throw new Error('bad json') } } as any)
    expect(res.status).toBe(400)
    expect(updateCall()).toBeUndefined()
  })

  it('scopes the UPDATE to exactly the confirmed seat ids', async () => {
    h.state.updateResult = {
      data: [SEAT_ROW('s1'), SEAT_ROW('s2')],
      error: null,
    }
    const res = await POST(req({ seat_ids: ['s1', 's2'] }))
    expect(res.status).toBe(200)
    const c = updateCall()
    expect(c.in).toEqual({ col: 'id', vals: ['s1', 's2'] })
    expect(c.payload.status).toBe('inactive')
    expect((await res.json()).removed_count).toBe(2)
  })

  it('still applies the due-and-active predicate, so a named seat cannot be forced', async () => {
    await POST(req({ seat_ids: ['s1'] }))
    const c = updateCall()
    expect(c.filters['status']).toBe('active')
    expect(c.filters['lte:scheduled_removal_at']).toBeTruthy()
  })

  it('reports seats that were requested but not eligible', async () => {
    // asked for three, only one was actually due
    h.state.updateResult = { data: [SEAT_ROW('s1')], error: null }
    const res = await POST(req({ seat_ids: ['s1', 's2', 's3'] }))
    const j = await res.json()
    expect(j.removed_count).toBe(1)
    expect(j.skipped_ids).toEqual(['s2', 's3'])
  })

  it('scopes to one location when given location_id', async () => {
    await POST(req({ location_id: 'loc-ftl' }))
    const c = updateCall()
    expect(c.filters['location_id']).toBe('loc-ftl')
    expect(c.in).toBeNull()
  })

  it('fleet-wide requires an explicit opt-in', async () => {
    await POST(req({ scope: 'all' }))
    const c = updateCall()
    expect(c.in).toBeNull()
    expect(c.filters['location_id']).toBeUndefined()
    // still only due, active seats
    expect(c.filters['status']).toBe('active')
  })

  it('rejects two scopes at once rather than guessing', async () => {
    const res = await POST(req({ seat_ids: ['s1'], scope: 'all' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('ambiguous_scope')
    expect(updateCall()).toBeUndefined()
  })

  it('rejects an empty selection', async () => {
    const res = await POST(req({ seat_ids: [] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('no_seats_selected')
    expect(updateCall()).toBeUndefined()
  })

  it('rejects malformed seat ids', async () => {
    const res = await POST(req({ seat_ids: ['ok', 42] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_seat_ids')
    expect(updateCall()).toBeUndefined()
  })

  it('is still super_admin only', async () => {
    h.state.role = 'owner'
    const res = await POST(req({ seat_ids: ['s1'] }))
    expect(res.status).toBe(403)
    expect(updateCall()).toBeUndefined()
  })
})
