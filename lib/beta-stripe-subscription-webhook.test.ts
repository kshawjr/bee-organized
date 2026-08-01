// @vitest-environment node
//
// POST /api/webhooks/stripe — subscription activation path (issue 161).
// Pins the scope's route assertions:
//   • checkout.session.completed (subscription mode) writes BOTH
//     stripe_customer_id + stripe_subscription_id (via writeLocationStripeIds)
//     and calls activateLocationSubscription EXACTLY once, anchoring
//     paid_through to the subscription's real period end (not fixed Mar 1).
//   • A replayed event (already in stripe_webhook_events) is a no-op:
//     no id write, no activation.
//
// Signature verification is exercised for real (HMAC over `${t}.${body}`);
// only the Stripe API read (retrieveSubscription) and Slack/sync-log are
// mocked. subscription-activation + stripe-billing keep their real logic,
// wrapped in spies, driven by the recording supabase mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

const SECRET = 'whsec_test_secret_for_unit_tests'
const PERIOD_UNIX = 1893456000 // 2030-01-01T00:00:00Z — the subscription's period end

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
    retrieveSubscription: vi.fn(async () => ({
      id: 'sub_1', customer: 'cus_1',
      items: { data: [{ current_period_end: PERIOD_UNIX }] },
      metadata: { location_id: 'loc-uuid' },
    })),
  }
})
vi.mock('@/lib/subscription-activation', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    activateLocationSubscription: vi.fn(actual.activateLocationSubscription),
    writeLocationStripeIds: vi.fn(actual.writeLocationStripeIds),
  }
})

import { POST } from '@/app/api/webhooks/stripe/route'
import { activateLocationSubscription, writeLocationStripeIds } from '@/lib/subscription-activation'
import { unixToDateString } from '@/lib/stripe-billing'

const LOC = (over: any = {}) => ({
  id: 'loc-uuid', name: 'New Territory', location_id: 'new-territory',
  subscription_status: 'deferred', payment_source: 'direct', paid_through_date: null,
  stripe_customer_id: null, stripe_subscription_id: null, ...over,
})

const subscriptionCheckoutEvent = () => ({
  id: 'evt_sub', type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_sub', payment_intent: null,
    client_reference_id: 'a1b2c3d4-1111-4222-8333-444455556666',
    metadata: { tier: 'owner', location_id: 'a1b2c3d4-1111-4222-8333-444455556666' },
    amount_total: 55000, currency: 'usd', payment_status: 'paid',
    subscription: 'sub_1', customer: 'cus_1',
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

describe('stripe webhook — subscription activation (issue 161)', () => {
  it('writes both stripe ids and activates once, anchored to the subscription period end', async () => {
    // Consumption order per table:
    h.enqueue('stripe_webhook_events', null)                       // replay read → not a replay
    h.enqueue('locations', LOC())                                  // map client_reference_id → location
    h.enqueue('tier_prices', { id: 'owner', price_annual: 550 })   // annualCents
    h.enqueue('locations', LOC())                                  // writeLocationStripeIds read
    h.enqueue('locations', {})                                     // writeLocationStripeIds update result
    h.enqueue('subscription_seats', [])                            // activate: owner seat read (none)
    h.enqueue('subscription_seats', { id: 'seat1', tier: 'owner' })// activate: owner seat insert
    h.enqueue('locations', LOC())                                  // activate: getLocationBilling (still deferred)
    h.enqueue('locations', LOC({ subscription_status: 'active' })) // activate: status flip
    h.enqueue('locations', LOC({ subscription_status: 'active' })) // after: landed re-read
    h.enqueue('stripe_webhook_events', {})                         // mark processed insert

    const res = await post(subscriptionCheckoutEvent())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: true, activation: true })

    // BOTH ids written, exactly once, from the session.
    expect(writeLocationStripeIds).toHaveBeenCalledTimes(1)
    expect(writeLocationStripeIds).toHaveBeenCalledWith('loc-uuid', {
      customerId: 'cus_1', subscriptionId: 'sub_1',
    })
    // The location UPDATE carried both id columns.
    const idUpdate = h.state.updates.find(u => u.table === 'locations' && u.arg?.stripe_subscription_id)
    expect(idUpdate?.arg).toMatchObject({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' })

    // Activation called EXACTLY once, anchored to the subscription's period end.
    expect(activateLocationSubscription).toHaveBeenCalledTimes(1)
    const actArg = (activateLocationSubscription as any).mock.calls[0][0]
    expect(actArg.locationId).toBe('loc-uuid')
    expect(actArg.paidThroughDate).toBe(unixToDateString(PERIOD_UNIX)) // signup-anchored, NOT fixed Mar 1
    expect(actArg.paidThroughDate).toBe('2030-01-01')

    // Owner seat minted + location flipped active.
    expect(h.state.inserts.find(i => i.table === 'subscription_seats')).toBeTruthy()
    expect(h.state.updates.find(u => u.table === 'locations' && u.arg?.subscription_status === 'active')).toBeTruthy()
  })

  it('a replayed event is a no-op: no id write, no activation', async () => {
    h.enqueue('stripe_webhook_events', { event_id: 'evt_sub' }) // replay read → already processed

    const res = await post(subscriptionCheckoutEvent())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, replay: true })

    expect(writeLocationStripeIds).not.toHaveBeenCalled()
    expect(activateLocationSubscription).not.toHaveBeenCalled()
    expect(h.state.inserts.find(i => i.table === 'subscription_seats')).toBeUndefined()
  })

  it('rejects an invalid signature with 401 and no writes', async () => {
    const rawBody = JSON.stringify(subscriptionCheckoutEvent())
    const res = await POST(new Request('http://test/api/webhooks/stripe', {
      method: 'POST', body: rawBody, headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    }) as any)
    expect(res.status).toBe(401)
    expect(activateLocationSubscription).not.toHaveBeenCalled()
  })
})
