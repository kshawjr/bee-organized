// @vitest-environment node
//
// TEAM AND SEATS OPENED TO MANAGERS (2026-11-12) — WHAT MUST NOT FOLLOW THEM IN.
//
// Settings › Team and Seats was owner-only as a whole. It is one screen with
// two halves now, and a manager gets the Bees half. The screen hides the
// Seats half from them (lib/beta-settings-access.test.tsx) — but a hidden
// button is not a gate. These are the gate: a MANAGER OF THE SAME LOCATION,
// signed in, calling every seats / invite / billing route directly with a
// well-formed request an owner's screen would send.
//
// Every one must answer 403, write nothing, email nobody and never reach
// Stripe. Nothing in this change touched these routes; this file exists so
// that stays true the day someone "tidies" a role check to match the screen.
//
// Each case is run for the owner too, and must NOT be 403 — otherwise a route
// that refused everyone (or a request that never reached the role check)
// would pass for the wrong reason.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    inserts: [] as { table: string; arg: any }[],
    updates: [] as { table: string; arg: any }[],
    deletes: [] as { table: string }[],
  }
  const reset = () => { state.queue = []; state.inserts = []; state.updates = []; state.deletes = [] }
  const enqueue = (table: string, data: any) => state.queue.push({ table, resp: { data, error: null } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'like', 'ilike', 'order', 'limit', 'gte', 'lte', 'gt', 'lt']) b[m] = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.upsert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.delete = () => { state.deletes.push({ table }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const side = vi.hoisted(() => ({
  email: vi.fn(async () => ({ ok: true })),
  stripeAdjust: vi.fn(async () => ({ quantity: 1, itemId: 'si_1', created: true, removed: false })),
  portal: vi.fn(async () => ({ url: 'https://stripe.test/portal' })),
}))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'caller-1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: side.email }))
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => true }))
vi.mock('@/lib/stripe-billing', () => ({ adjustSubscriptionSeatQuantity: side.stripeAdjust, createBillingPortalSession: side.portal }))

import { POST as SEATS_POST, PATCH as SEATS_PATCH, DELETE as SEATS_DELETE } from '@/app/api/seats/route'
import { PATCH as SEAT_SCHEDULE } from '@/app/api/seats/[id]/route'
import { GET as SEATS_QUOTE } from '@/app/api/seats/quote/route'
import { POST as BUY_AND_INVITE } from '@/app/api/seats/buy-and-invite/route'
import { POST as INVITE } from '@/app/api/hub_users/invite/route'
import { POST as BILLING_PORTAL } from '@/app/api/locations/[id]/billing-portal/route'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FUTURE = '2099-01-01'

const req = (method: string, path: string, body?: any) => {
  const url = new URL(`http://test${path}`)
  const r = new Request(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }) as any
  Object.defineProperty(r, 'nextUrl', { value: url })
  return r
}

// One well-formed request per route — the request an owner's screen sends.
const CALLS: { name: string; run: () => Promise<Response> }[] = [
  { name: 'POST /api/seats (buy a seat)',
    run: () => SEATS_POST(req('POST', '/api/seats', { location_id: LOC, tier: 'manager', quantity: 1 })) },
  { name: 'PATCH /api/seats (assign a seat)',
    run: () => SEATS_PATCH(req('PATCH', '/api/seats', { id: SEAT, user_id: null })) },
  { name: 'PATCH /api/seats/[id] (schedule a seat for removal)',
    run: () => SEAT_SCHEDULE(req('PATCH', `/api/seats/${SEAT}`, { scheduled_removal_at: FUTURE }), { params: { id: SEAT } }) },
  { name: 'GET /api/seats/quote (what a seat would cost)',
    run: () => SEATS_QUOTE(req('GET', `/api/seats/quote?location_id=${LOC}&tier=manager&quantity=1`)) },
  { name: 'POST /api/seats/buy-and-invite (buy a seat and invite into it)',
    run: () => BUY_AND_INVITE(req('POST', '/api/seats/buy-and-invite', { location_id: LOC, tier: 'manager', email: 'new@bee.test', full_name: 'New Person' })) },
  { name: 'POST /api/hub_users/invite (invite a teammate)',
    run: () => INVITE(req('POST', '/api/hub_users/invite', { location_id: LOC, tier: 'manager', email: 'new@bee.test', full_name: 'New Person' })) },
  { name: 'POST /api/locations/[id]/billing-portal (open Stripe billing)',
    run: () => BILLING_PORTAL(req('POST', `/api/locations/${LOC}/billing-portal`), { params: { id: LOC } }) },
]

// What each route reads before it decides: the caller, and (for the two
// routes that authorize against the SEAT's location) the seat.
const seed = (role: string, callerLocation: string | null = LOC) => {
  h.reset()
  side.email.mockClear(); side.stripeAdjust.mockClear(); side.portal.mockClear()
  h.enqueue('hub_users', { id: 'caller-1', role, location_id: callerLocation })
  h.enqueue('subscription_seats', { id: SEAT, location_id: LOC, tier: 'manager', status: 'active', is_primary: false, user_id: null })
}

const untouched = () => {
  expect(h.state.inserts, 'inserts').toEqual([])
  expect(h.state.updates, 'updates').toEqual([])
  expect(h.state.deletes, 'deletes').toEqual([])
  expect(side.email, 'emails sent').not.toHaveBeenCalled()
  expect(side.stripeAdjust, 'Stripe seat change').not.toHaveBeenCalled()
  expect(side.portal, 'Stripe portal session').not.toHaveBeenCalled()
}

beforeEach(() => { h.reset() })

describe('a manager of the location, calling the seats routes directly', () => {
  for (const c of CALLS) {
    it(`${c.name} → 403, nothing written, nobody emailed, Stripe never called`, async () => {
      seed('manager')
      const res = await c.run()
      expect(res.status).toBe(403)
      untouched()
    })
  }

  it('DELETE /api/seats (remove a seat) → 403: that one is admin-only, so a manager AND an owner are refused', async () => {
    for (const role of ['manager', 'owner']) {
      seed(role)
      const res = await SEATS_DELETE(req('DELETE', `/api/seats?id=${SEAT}`))
      expect(res.status, role).toBe(403)
      untouched()
    }
  })
})

describe('the same requests from the owner are NOT refused (so the 403s above are the role check, not a broken request)', () => {
  for (const c of CALLS) {
    it(`${c.name} → not 403 for the owner`, async () => {
      seed('owner')
      // This harness answers every database read with one thin row, so past
      // the role check some routes run out of data and throw. That is still
      // the answer wanted here: the owner got PAST the check the manager
      // stopped at. A 403 or 401 is the only failure.
      const status = await c.run().then(r => r.status, () => 'ran past the role check')
      expect(status).not.toBe(403)
      expect(status).not.toBe(401)
    })
  }
})

describe('the other roles that have no business with seats are refused the same way', () => {
  for (const role of ['lite_user', 'readonly', 'light', 'viewer', 'some-future-role']) {
    it(`${role} → 403 on every route`, async () => {
      for (const c of CALLS) {
        seed(role)
        const res = await c.run()
        expect(res.status, c.name).toBe(403)
        untouched()
      }
    })
  }

  it('an OWNER OF ANOTHER LOCATION is refused too — being an owner somewhere is not enough', async () => {
    for (const c of CALLS) {
      seed('owner', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
      const res = await c.run()
      expect(res.status, c.name).toBe(403)
      untouched()
    }
  })
})
