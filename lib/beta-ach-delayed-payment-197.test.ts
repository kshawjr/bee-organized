// @vitest-environment node
//
// issue 197 — ACH / delayed-notification payments.
//
// ACH fires checkout.session.completed with the payment still UNPAID, then
// checkout.session.async_payment_succeeded (cleared) or
// checkout.session.async_payment_failed (bounced) days later. This pins the
// webhook's handling of the delayed events:
//
//   • async_payment_succeeded on an ALREADY-active location (Kevin
//     force-activated it while the ACH was pending) fills in the missing
//     stripe_subscription_id, adds NO second seat, and does NOT re-activate.
//     The billing_invoices row for that money is recorded by the invoice.paid
//     handler (subscription_create) — pinned separately below — never twice.
//   • async_payment_succeeded on a NEVER-activated location activates fully
//     through the ONE activation path (activateLocationSubscription).
//   • async_payment_failed alerts with the location's current state. Issue 313
//     ADDED a state transition here (active → past_due, 14-day grace, access
//     retained) now that every ACH payer is activated up front; see the
//     rewritten test below for why that is not a reversal of 197's decision.
//   • every path is idempotent: a replayed event is a no-op.
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
    // The ACH subscription carries a real period end; the session already
    // carries the customer id, so this is only hit on the never-activated
    // activation path (to read the period end).
    retrieveSubscription: vi.fn(async () => ({
      id: 'sub_ach', customer: 'cus_ach',
      items: { data: [{ current_period_end: 1893456000 }] }, // 2030-01-01
    })),
  }
})
vi.mock('@/lib/subscription-activation', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    // getLocationBilling / getLocationByStripeSubscriptionId stay REAL so they
    // hit the mocked supabase queue; only the write helpers are stubbed.
    activateLocationSubscription: vi.fn(async () => ({
      alreadyActive: false, seat: { id: 'seat1' },
      location: { id: 'x', name: 'X', subscription_status: 'active', subscription_started_at: 't' },
    })),
    writeLocationStripeIds: vi.fn(async () => {}),
    recordStripeInvoice: vi.fn(async () => 'inserted'),
    advancePaidThroughDate: vi.fn(async () => true),
  }
})

import { POST } from '@/app/api/webhooks/stripe/route'
import {
  activateLocationSubscription,
  writeLocationStripeIds,
  recordStripeInvoice,
} from '@/lib/subscription-activation'
import { postSlackMessage } from '@/lib/slack'

const LOC_UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

// Boston/West Raleigh shape: force-activated while the ACH was pending, so
// active + owner seat exist but stripe_subscription_id is still null.
const FORCED_ACTIVE = (over: any = {}) => ({
  id: LOC_UUID, name: 'Boston', location_id: 'loc_bostonsuburbs',
  subscription_status: 'active', payment_source: 'direct',
  paid_through_date: '2027-05-01',
  stripe_customer_id: 'cus_ach', stripe_subscription_id: null, ...over,
})
// An ACH payer we did NOT rescue by hand — still deferred until the money clears.
const DEFERRED = (over: any = {}) => ({
  id: LOC_UUID, name: 'West Raleigh', location_id: 'loc_westraleigh',
  subscription_status: 'deferred', payment_source: 'direct',
  paid_through_date: null,
  stripe_customer_id: 'cus_ach', stripe_subscription_id: null, ...over,
})

const checkoutEvent = (type: string, over: any = {}) => ({
  id: `evt_${type}`, type,
  data: { object: {
    id: 'cs_ach', payment_intent: null, // subscription session → session PI is null
    client_reference_id: LOC_UUID,
    metadata: { tier: 'owner', location_id: LOC_UUID },
    amount_total: 55000, currency: 'usd', payment_status: 'paid',
    subscription: 'sub_ach', customer: 'cus_ach', ...over,
  } },
})

const invoicePaidEvent = () => ({
  id: 'evt_invoice_ach', type: 'invoice.paid',
  data: { object: {
    id: 'in_ach', customer: 'cus_ach', payment_intent: 'pi_ach',
    amount_paid: 55000, currency: 'usd', period_end: 1893456000,
    billing_reason: 'subscription_create',
    parent: { subscription_details: { subscription: 'sub_ach' } },
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

describe('issue 197 — ACH async_payment_succeeded', () => {
  it('already-active location: fills in the subscription id, NO second seat, NO re-activation', async () => {
    h.enqueue('stripe_webhook_events', null)                                    // layer-1 replay read → not a replay
    h.enqueue('locations', FORCED_ACTIVE())                                     // map client_reference_id → location (active, no sub id yet)
    h.enqueue('tier_prices', { id: 'owner', price_annual: 550 })               // deriveSeatQuantity read
    h.enqueue('locations', FORCED_ACTIVE({ stripe_subscription_id: 'sub_ach' })) // after: landed re-read (sub id present)
    h.enqueue('stripe_webhook_events', {})                                     // mark processed insert

    const res = await post(checkoutEvent('checkout.session.async_payment_succeeded'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: true })

    // Subscription id filled in, once, from the session.
    expect(writeLocationStripeIds).toHaveBeenCalledTimes(1)
    expect(writeLocationStripeIds).toHaveBeenCalledWith(LOC_UUID, {
      customerId: 'cus_ach', subscriptionId: 'sub_ach',
    })
    // NOT re-activated, and NO seat minted (the seat already exists).
    expect(activateLocationSubscription).not.toHaveBeenCalled()
    expect(h.state.inserts.find(i => i.table === 'subscription_seats')).toBeUndefined()
    // The invoice is NOT recorded here (invoice.paid owns it — see next test);
    // recording it here would double the row against invoice.paid.
    expect(recordStripeInvoice).not.toHaveBeenCalled()
    // Slack reflects that money actually arrived — not "no charge today".
    const msg = (postSlackMessage as any).mock.calls.at(-1)?.[0] as string
    expect(msg).toMatch(/ACH payment cleared/i)
  })

  it('the invoice for that ACH clears via invoice.paid (subscription_create), mapped by the sub id', async () => {
    h.enqueue('stripe_webhook_events', null)                     // replay read
    h.enqueue('locations', FORCED_ACTIVE({ stripe_subscription_id: 'sub_ach' })) // getLocationByStripeSubscriptionId
    h.enqueue('stripe_webhook_events', {})                       // mark processed

    const res = await post(invoicePaidEvent())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: true })

    expect(recordStripeInvoice).toHaveBeenCalledTimes(1)
    expect(recordStripeInvoice).toHaveBeenCalledWith(expect.objectContaining({
      locationId: LOC_UUID, amountCents: 55000, invoiceId: 'in_ach',
    }))
  })

  it('never-activated location: activates FULLY through the one activation path', async () => {
    h.enqueue('stripe_webhook_events', null)                    // replay read
    h.enqueue('locations', DEFERRED())                          // map client_reference_id → location (deferred)
    h.enqueue('tier_prices', { id: 'owner', price_annual: 550 })
    h.enqueue('locations', DEFERRED({ subscription_status: 'active' })) // after: landed re-read
    h.enqueue('stripe_webhook_events', {})                     // mark processed

    const res = await post(checkoutEvent('checkout.session.async_payment_succeeded'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: true, activation: true })

    // Activated through the shared path, and the subscription id was written.
    expect(activateLocationSubscription).toHaveBeenCalledTimes(1)
    expect((activateLocationSubscription as any).mock.calls[0][0]).toMatchObject({ locationId: LOC_UUID })
    expect(writeLocationStripeIds).toHaveBeenCalledWith(LOC_UUID, expect.objectContaining({ subscriptionId: 'sub_ach' }))
    // Subscription payment defers its invoice to invoice.paid — not recorded here.
    expect(recordStripeInvoice).not.toHaveBeenCalled()
  })
})

describe('issue 197 — ACH async_payment_failed', () => {
  // SUPERSEDED BY ISSUE 313, deliberately, and rewritten rather than deleted.
  //
  // Issue 197 asserted `processed: false` and NO subscription_status write:
  // "never auto-deactivate". That was right for its inputs — a location
  // reaching this handler had been let in by hand, if at all, and revoking
  // access over a retryable bounce would have punished a working customer.
  //
  // Issue 313 activates EVERY ACH payer up front, so the same event now finds
  // a location with a full year of access and no money behind it. Leaving it
  // untouched would be the hole, not the kindness. The transition is past_due,
  // which is the gentlest state the machine offers: FULL access continues
  // through the 14-day grace window, so 197's actual concern — don't strand a
  // working customer over a bounce — is still honoured. What changed is that
  // the location now MOVES somewhere a human and the billing screen can see.
  it('moves an active location to past_due and keeps its access (issue 313)', async () => {
    h.enqueue('stripe_webhook_events', null)   // replay read → not a replay
    h.enqueue('locations', FORCED_ACTIVE())    // map client_reference_id → location (active)
    h.enqueue('locations', FORCED_ACTIVE({ subscription_status: 'past_due' })) // read-back
    h.enqueue('stripe_webhook_events', {})     // mark processed insert

    const res = await post(checkoutEvent('checkout.session.async_payment_failed', { payment_status: 'unpaid' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: true, failure: 'async_payment_failed' })
    expect(json.moved_to).toBe('past_due')

    // Loud alert that names the risky state (was active, no money collected).
    const msg = (postSlackMessage as any).mock.calls.at(-1)?.[0] as string
    expect(msg).toMatch(/FAILED/)
    expect(msg).toMatch(/past_due/)

    // 197's real guarantee, intact: access is not revoked. past_due keeps full
    // write access (lib/read-only-access), and nothing touches lifecycle_status
    // — where 'paused', the read-only state, actually lives.
    const lifecycleFlip = h.state.updates.find(
      u => u.table === 'locations' && u.arg && 'lifecycle_status' in u.arg,
    )
    expect(lifecycleFlip).toBeUndefined()
    // The event is recorded so a redelivery short-circuits.
    expect(h.state.inserts.find(i => i.table === 'stripe_webhook_events')).toBeDefined()
  })

  it('a replayed failure is a silent no-op (no second alert)', async () => {
    h.enqueue('stripe_webhook_events', { event_id: 'evt_checkout.session.async_payment_failed' }) // already processed

    const res = await post(checkoutEvent('checkout.session.async_payment_failed', { payment_status: 'unpaid' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, replay: true })
    expect(postSlackMessage).not.toHaveBeenCalled()
    expect(h.state.inserts.find(i => i.table === 'stripe_webhook_events')).toBeUndefined()
  })
})

describe('issue 197 — replay safety on the success path', () => {
  it('a replayed async_payment_succeeded is a no-op: no id write, no activation', async () => {
    h.enqueue('stripe_webhook_events', { event_id: 'evt_checkout.session.async_payment_succeeded' }) // already processed

    const res = await post(checkoutEvent('checkout.session.async_payment_succeeded'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, replay: true })
    expect(writeLocationStripeIds).not.toHaveBeenCalled()
    expect(activateLocationSubscription).not.toHaveBeenCalled()
    expect(recordStripeInvoice).not.toHaveBeenCalled()
  })
})
