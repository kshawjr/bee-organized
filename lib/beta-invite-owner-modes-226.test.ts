// @vitest-environment node
//
// lib/beta-invite-owner-modes-226.test.ts — issue 226 step 6.
//
// POST /api/admin/invite-owner did three unrelated jobs: rewrite the
// location's billing config, create or reuse an owner seat, and send the
// invite. Provisioning a new franchise needs all three; adding a co-owner
// needs only the last two.
//
// VERIFIED AGAINST PRODUCTION BEFORE THIS CHANGE (read-only, 2026-08-14).
// Fort Lauderdale: lifecycle_status=active, subscription_status=active,
// paid_through_date=2027-08-14, stripe_subscription_id=
// sub_1U4KtuG6R4Z90Upn6vyN8Dgu, one claimed owner (Ana Fuquay), one OPEN owner
// seat, one open manager seat. With force:true the old route would have nulled
// its paid-through date, set it back to onboarding, blanked its checklist —
// and left that subscription billing. These tests pin that closed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route builds the invite URL from NEXT_PUBLIC_SITE_URL, falling back to
// request.nextUrl.origin — which a plain Request does not carry. Set it so the
// happy paths run to completion.
process.env.NEXT_PUBLIC_SITE_URL = 'https://test.beeorganized.com'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    updates: [] as { table: string; arg: any }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.updates = []; state.inserts = [] }
  const enqueue = (table: string, data: any, extra: Partial<Resp> = {}) =>
    state.queue.push({ table, resp: { data, error: null, ...extra } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) b[m] = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.delete = () => b
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
vi.mock('@/lib/resend', () => ({ sendEmail: vi.fn(async () => ({ id: 'em1' })) }))

import { POST } from '@/app/api/admin/invite-owner/route'

const SUPER_ADMIN = { id: 'sa1', role: 'super_admin' }

// Fort Lauderdale's real shape.
const FTL = {
  id: 'ftl-uuid',
  payment_source: 'direct',
  paid_through_date: '2027-08-14',
  subscription_status: 'active',
  lifecycle_status: 'active',
  subscription_plan: 'owner_annual',
  billing_notes: null,
  onboarding_state: {},
}
// A brand-new franchise: nothing set, nobody in it.
const FRESH = {
  id: 'fresh-uuid',
  payment_source: 'none',
  paid_through_date: null,
  subscription_status: 'deferred',
  lifecycle_status: 'onboarding',
  subscription_plan: null,
  billing_notes: null,
  onboarding_state: {},
}

const call = (body: any) =>
  POST(new Request('http://test/api/admin/invite-owner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any)

const locUpdate = () => h.state.updates.find(u => u.table === 'locations')

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'sa1' }
})

const BASE = { email: 'new@x.com', full_name: 'New Owner' }

describe('a live location cannot be re-provisioned', () => {
  it('409s on lifecycle_status=active and writes NOTHING', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('locations', FTL)
    h.enqueue('hub_users', [])          // no duplicate hub_user
    h.enqueue('subscription_seats', []) // owner-seat landscape

    const res = await call({ ...BASE, mode: 'provision', location_id: FTL.id, payment_source: 'direct', paid_through_date: '' })
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toBe('location_is_live')
    expect(locUpdate()).toBeUndefined()
    expect(h.state.inserts).toHaveLength(0)
  })

  // The change that matters most: there is no way through.
  it('force:true does NOT override it', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('locations', FTL)
    h.enqueue('hub_users', [])
    h.enqueue('subscription_seats', [])

    const res = await call({ ...BASE, mode: 'provision', force: true, location_id: FTL.id, payment_source: 'direct', paid_through_date: '' })

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('location_is_live')
    // The write that would have nulled paid_through_date and reset the
    // checklist while Stripe kept billing.
    expect(locUpdate()).toBeUndefined()
  })

  it('defaults to provision when no mode is sent, so an old client is refused too', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('locations', FTL)
    h.enqueue('hub_users', [])
    h.enqueue('subscription_seats', [])

    const res = await call({ ...BASE, force: true, location_id: FTL.id, payment_source: 'direct', paid_through_date: '' })
    expect(res.status).toBe(409)
    expect(locUpdate()).toBeUndefined()
  })
})

describe('add_co_owner never touches the location', () => {
  it('writes no locations row even on a live, paying location', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('locations', FTL)
    h.enqueue('hub_users', [])
    h.enqueue('subscription_seats', [{ id: 'own-open', user_id: null, status: 'active' }])
    h.enqueue('pending_invites', null)
    h.enqueue('pending_invites', { id: 'inv1', invite_token: 't' })

    const res = await call({ ...BASE, mode: 'add_co_owner', location_id: FTL.id })

    expect(res.status).toBeLessThan(400)
    expect(locUpdate()).toBeUndefined()
  })

  it('refuses billing fields rather than accepting and ignoring them', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)

    const res = await call({ ...BASE, mode: 'add_co_owner', location_id: FTL.id, payment_source: 'direct' })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('billing_fields_not_allowed')
    expect(locUpdate()).toBeUndefined()
  })

  it('still enforces the two-owner ceiling', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('locations', FTL)
    h.enqueue('hub_users', [])
    h.enqueue('subscription_seats', [
      { id: 'o1', user_id: 'u1', status: 'active' },
      { id: 'o2', user_id: 'u2', status: 'active' },
    ])

    const res = await call({ ...BASE, mode: 'add_co_owner', location_id: FTL.id })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('max_owners_reached')
  })
})

describe('provision still provisions', () => {
  it('writes the billing config for a location that has never launched', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('locations', FRESH)
    h.enqueue('hub_users', [])
    h.enqueue('subscription_seats', [])
    h.enqueue('pending_invites', null)
    h.enqueue('subscription_seats', { id: 'seat1' })
    h.enqueue('pending_invites', { id: 'inv1', invite_token: 't' })

    const res = await call({ ...BASE, mode: 'provision', location_id: FRESH.id, payment_source: 'direct', paid_through_date: '' })

    expect(res.status).toBeLessThan(400)
    const up = locUpdate()
    expect(up).toBeDefined()
    expect(up!.arg.lifecycle_status).toBe('onboarding')
    expect(up!.arg.subscription_status).toBe('deferred')
    expect(up!.arg.payment_source).toBe('direct')
  })
})

describe('the mode is explicit', () => {
  it('rejects an unknown mode rather than guessing', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    const res = await call({ ...BASE, mode: 'reset_everything', location_id: FTL.id })
    expect(res.status).toBe(400)
    expect(locUpdate()).toBeUndefined()
  })
})
