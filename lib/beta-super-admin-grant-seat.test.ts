// @vitest-environment node
//
// POST /api/admin/grant-seat — the super_admin-only comp lever that turns on a
// seat WITHOUT payment, before the Stripe path is live. Pins:
//   • Gate: super_admin ONLY. owner → 403, admin/corp → 403, anon → 401.
//     (This is a comp lever, not a purchase path — stricter than /api/seats.)
//   • Owner-tier on an inactive location ACTIVATES via the SAME shared
//     function the Stripe webhook uses (activateLocationSubscription): the
//     owner seat is minted, the location flips to 'active'.
//   • Every grant is MARKED MANUAL and distinguishable from a paid one: the
//     seat's `notes` carry the comp_grant marker (never a stripe_session),
//     prorated_cost is 0, and NO billing_invoices row is written.
//   • Non-owner tiers mint pool seats (the manual sibling of the webhook's
//     addStripePurchasedSeats) — same comp marker.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabase mock: chainable builder + per-table FIFO queue, plus
// captured insert/update payloads. Same shape as the no-coverage endpoint test.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    updates: [] as { table: string; arg: any }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.updates = []; state.inserts = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) {
      b[m] = () => b
    }
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'sa1' } as any }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { POST } from '@/app/api/admin/grant-seat/route'
import { MANUAL_GRANT_MARKER } from '@/lib/subscription-activation'

const OWNER = (over: any = {}) => ({ id: 'own1', role: 'owner', location_id: 'loc-uuid', full_name: 'Tess Tester', ...over })
const LOC = (over: any = {}) => ({ id: 'loc-uuid', name: 'Test Territory', location_id: 'test-territory', subscription_status: 'deferred', payment_source: 'direct', paid_through_date: null, ...over })

const call = (body: any) =>
  POST(new Request('http://test/api/admin/grant-seat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any)

const seatInsert = () => h.state.inserts.find(i => i.table === 'subscription_seats')
const locUpdate  = () => h.state.updates.find(u => u.table === 'locations')

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'sa1' }
})

describe('grant-seat — gate: super_admin ONLY', () => {
  it('401 when unauthenticated', async () => {
    authUser.current = null
    const res = await call({ owner_user_id: 'own1', tier: 'owner' })
    expect(res.status).toBe(401)
    expect(seatInsert()).toBeUndefined()
  })

  it('403 for an owner (cannot comp themselves a seat)', async () => {
    h.enqueue('hub_users', { role: 'owner' }) // loadSuperAdmin
    const res = await call({ owner_user_id: 'own1', tier: 'owner' })
    expect(res.status).toBe(403)
    expect(seatInsert()).toBeUndefined()
  })

  it('403 for admin / corp (comp lever, not a purchase path)', async () => {
    h.enqueue('hub_users', { role: 'admin' })
    const res = await call({ owner_user_id: 'own1', tier: 'owner' })
    expect(res.status).toBe(403)
    expect(seatInsert()).toBeUndefined()
  })
})

describe('grant-seat — owner activation through the SHARED function', () => {
  it('mints the owner seat, flips the location active, and marks it comp', async () => {
    h.enqueue('hub_users', { role: 'super_admin' })            // loadSuperAdmin
    h.enqueue('hub_users', OWNER())                            // owner resolve
    h.enqueue('locations', LOC())                              // route getLocationBilling
    h.enqueue('subscription_seats', [])                        // activate: owner seat read (none)
    h.enqueue('subscription_seats', { id: 'seat1', tier: 'owner' }) // activate: owner seat insert
    h.enqueue('locations', LOC())                              // activate: getLocationBilling (still inactive)
    h.enqueue('locations', LOC({ subscription_status: 'active' })) // activate: status flip update

    const res = await call({ owner_user_id: 'own1', tier: 'owner', reason: 'Beta tester' })
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.activated).toBe(true)
    expect(json.comp).toBe(true)

    // Owner seat minted, marked comp (NOT paid), $0 cost.
    const seat = seatInsert()
    expect(seat).toBeTruthy()
    expect(seat!.arg.tier).toBe('owner')
    expect(seat!.arg.user_id).toBe('own1')
    expect(seat!.arg.notes).toContain(MANUAL_GRANT_MARKER)
    expect(seat!.arg.notes).not.toContain('stripe_session')
    expect(seat!.arg.prorated_cost).toBe(0)

    // Location flipped active through the shared activation path.
    const flip = locUpdate()
    expect(flip).toBeTruthy()
    expect(flip!.arg.subscription_status).toBe('active')

    // Distinguishable from a payment: no invoice row was written.
    expect(h.state.inserts.find(i => i.table === 'billing_invoices')).toBeUndefined()
  })
})

describe('grant-seat — non-owner tier mints a comp pool seat', () => {
  it('grants a manager seat with the comp marker, no activation, no invoice', async () => {
    h.enqueue('hub_users', { role: 'super_admin' })            // loadSuperAdmin
    h.enqueue('hub_users', OWNER())                            // owner resolve
    h.enqueue('locations', LOC({ subscription_status: 'active' })) // getLocationBilling
    h.enqueue('subscription_seats', [{ id: 'seat2', tier: 'manager' }]) // manual seat insert

    const res = await call({ owner_user_id: 'own1', tier: 'manager', quantity: 2 })
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.activated).toBe(false)
    expect(json.comp).toBe(true)

    const seat = seatInsert()
    expect(seat).toBeTruthy()
    // addManuallyGrantedSeats inserts an array of rows.
    const row = Array.isArray(seat!.arg) ? seat!.arg[0] : seat!.arg
    expect(Array.isArray(seat!.arg) ? seat!.arg.length : 1).toBe(2)
    expect(row.tier).toBe('manager')
    expect(row.user_id).toBeNull()
    expect(row.notes).toContain(MANUAL_GRANT_MARKER)
    expect(row.prorated_cost).toBe(0)

    // No activation, no payment record.
    expect(locUpdate()).toBeUndefined()
    expect(h.state.inserts.find(i => i.table === 'billing_invoices')).toBeUndefined()
  })
})

describe('grant-seat — validation', () => {
  it('rejects a non-owner target user', async () => {
    h.enqueue('hub_users', { role: 'super_admin' })
    h.enqueue('hub_users', OWNER({ role: 'manager' }))
    const res = await call({ owner_user_id: 'own1', tier: 'owner' })
    expect(res.status).toBe(400)
    expect(seatInsert()).toBeUndefined()
  })

  it('rejects an invalid tier', async () => {
    h.enqueue('hub_users', { role: 'super_admin' })
    const res = await call({ owner_user_id: 'own1', tier: 'wizard' })
    expect(res.status).toBe(400)
  })
})
