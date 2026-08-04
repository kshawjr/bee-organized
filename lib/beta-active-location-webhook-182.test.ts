// @vitest-environment node
//
// issue 182 — webhook completion for the "checkout link for an active
// location". When the owner finishes the anchored, $0-today checkout, the
// checkout.session.completed webhook must:
//   • write BOTH stripe_customer_id and stripe_subscription_id, and
//   • NOT re-run activation (the location is already active with seats) and
//     NOT mint any seat.
// The old code would have fallen into the seat-purchase branch (owner tier +
// already active), minting a duplicate owner ghost seat and NEVER writing the
// ids — this pins the new branch that fixes that.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

const SECRET = 'whsec_test_secret_for_unit_tests'

// Recording supabase mock: per-table FIFO queue + captured inserts/updates.
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
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit', 'like']) b[m] = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
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
vi.mock('@/lib/slack', () => ({ postSlackMessage: vi.fn(async () => {}) }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own1', email: 'o@x.com', full_name: 'O', phone: null })),
}))
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => true, getStripe: vi.fn() }))
vi.mock('@/lib/stripe-billing', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    // Not exercised on this path (the session carries the customer id), but
    // stubbed so an accidental call can't hit the network.
    retrieveSubscription: vi.fn(async () => ({ id: 'sub_182', customer: 'cus_182', items: { data: [] } })),
  }
})
vi.mock('@/lib/subscription-activation', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    activateLocationSubscription: vi.fn(actual.activateLocationSubscription),
    writeLocationStripeIds: vi.fn(async () => {}),
  }
})

import { POST } from '@/app/api/webhooks/stripe/route'
import { activateLocationSubscription, writeLocationStripeIds } from '@/lib/subscription-activation'

const LOC_UUID = 'a1b2c3d4-1111-4222-8333-444455556666'
const ACTIVE_LOC = (over: any = {}) => ({
  id: LOC_UUID, name: 'Kansas City', location_id: 'loc_kc',
  subscription_status: 'active', payment_source: 'direct',
  paid_through_date: '2027-05-01',
  stripe_customer_id: null, stripe_subscription_id: null, ...over,
})

const activeLinkEvent = () => ({
  id: 'evt_182', type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_182', payment_intent: null,
    client_reference_id: LOC_UUID,
    metadata: { tier: 'owner', location_id: LOC_UUID },
    amount_total: 0, currency: 'usd', payment_status: 'no_payment_required',
    subscription: 'sub_182', customer: 'cus_182',
  } },
})

function post(event: any) {
  const rawBody = JSON.stringify(event)
  const t = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', SECRET).update(`${t}.${rawBody}`, 'utf8').digest('hex')
  return POST(new Request('http://test/api/webhooks/stripe', {
    method: 'POST', body: rawBody, headers: { 'stripe-signature': `t=${t},v1=${sig}` },
  }) as any)
}

beforeEach(() => { h.reset(); vi.clearAllMocks(); process.env.STRIPE_WEBHOOK_SECRET = SECRET })
afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET })

describe('issue 182 — active-location subscription link completion', () => {
  it('writes both stripe ids and does NOT re-activate or add a seat', async () => {
    h.enqueue('stripe_webhook_events', null)                                   // replay read → not a replay
    h.enqueue('locations', ACTIVE_LOC())                                        // map client_reference_id → location (active)
    h.enqueue('tier_prices', { id: 'owner', price_annual: 550 })               // deriveSeatQuantity read
    h.enqueue('locations', ACTIVE_LOC({ stripe_subscription_id: 'sub_182' }))   // after: landed re-read (ids present)
    h.enqueue('stripe_webhook_events', {})                                     // mark processed insert

    const res = await post(activeLinkEvent())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: true })

    // BOTH ids written, from the session, exactly once.
    expect(writeLocationStripeIds).toHaveBeenCalledTimes(1)
    expect(writeLocationStripeIds).toHaveBeenCalledWith(LOC_UUID, {
      customerId: 'cus_182', subscriptionId: 'sub_182',
    })

    // NO re-activation (the location was already active with seats)...
    expect(activateLocationSubscription).not.toHaveBeenCalled()
    // ...and NO seat minted (the old owner-tier seat-purchase branch would have).
    expect(h.state.inserts.find(i => i.table === 'subscription_seats')).toBeUndefined()
    // ...and paid_through_date is left untouched (the anchor invoice advances it later).
    expect(h.state.updates.find(u => u.table === 'locations' && 'paid_through_date' in (u.arg || {}))).toBeUndefined()
  })

  it('a replayed event is a no-op: no id write', async () => {
    h.enqueue('stripe_webhook_events', { event_id: 'evt_182' }) // already processed

    const res = await post(activeLinkEvent())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, replay: true })
    expect(writeLocationStripeIds).not.toHaveBeenCalled()
    expect(activateLocationSubscription).not.toHaveBeenCalled()
  })
})
