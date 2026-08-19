// @vitest-environment node
//
// issue 313 — an ACH checkout activates immediately, and a failed debit is caught.
//
// An ACH bank debit fires checkout.session.completed with payment_status
// 'unpaid'. The receiver used to return there, above every write, so the
// location stayed deferred until async_payment_succeeded arrived — measured at
// six calendar days, twice. Four locations needed a hand-written UPDATE.
//
// Kevin's decision: they get in immediately. This pins both halves of that —
// the activation AND the exposure it creates:
//
//   • an UNPAID checkout runs the full activation (the same one the card path
//     runs), and records that the money is still in flight;
//   • a PAID card checkout is byte-for-byte unchanged — no in-flight note;
//   • async_payment_failed moves the location to past_due and alerts ONCE;
//   • async_payment_succeeded on the now-already-active location is a
//     confirmation, not a second activation;
//   • the in-flight fact is visible where a human looks, and closes when the
//     money lands.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

const SECRET = 'whsec_test_secret_for_unit_tests'

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
      id: 'sub_ach', customer: 'cus_ach',
      items: { data: [{ current_period_end: 1893456000 }] }, // 2030-01-01
    })),
  }
})
vi.mock('@/lib/subscription-activation', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    activateLocationSubscription: vi.fn(async () => ({
      alreadyActive: false, seat: { id: 'seat1' },
      location: { id: 'x', name: 'X', subscription_status: 'active', subscription_started_at: 't' },
    })),
    addSeatsForPlan: vi.fn(async () => ({ seats: [{ id: 'seat2' }], deduped: false, ownerCapHit: false })),
    writeLocationStripeIds: vi.fn(async () => {}),
    recordStripeInvoice: vi.fn(async () => 'inserted'),
    advancePaidThroughDate: vi.fn(async () => true),
    setLocationSubscriptionStatus: vi.fn(async () => {}),
  }
})
// The in-flight audit module is real EXCEPT for its two DB writers, so the
// pure marker logic (lastAchMarker / isAchMoneyInFlight) is the thing under
// test rather than a stub of itself.
vi.mock('@/lib/ach-in-flight', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    appendBillingNote: vi.fn(async () => {}),
    clearAchInFlight: vi.fn(async () => true),
  }
})

import { POST } from '@/app/api/webhooks/stripe/route'
import {
  activateLocationSubscription,
  addSeatsForPlan,
  setLocationSubscriptionStatus,
  recordStripeInvoice,
} from '@/lib/subscription-activation'
import { appendBillingNote, clearAchInFlight, isAchMoneyInFlight, lastAchMarker } from '@/lib/ach-in-flight'
import { postSlackMessage } from '@/lib/slack'
import { isPaidThroughFuture, isPrepaidTermCovering } from '@/lib/subscription-math'

const LOC_UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

// The shape every ACH payer arrives in: onboarding finished, never paid, so
// still deferred. This is Chattanooga and Katy at 14:12 and 19:27 on 08-19.
const DEFERRED = (over: any = {}) => ({
  id: LOC_UUID, name: 'Chattanooga', location_id: 'loc_chattanooga',
  subscription_status: 'deferred', payment_source: 'direct',
  paid_through_date: null, billing_notes: null,
  stripe_customer_id: 'cus_ach', stripe_subscription_id: null, ...over,
})
const ACTIVE = (over: any = {}) => ({
  id: LOC_UUID, name: 'Chattanooga', location_id: 'loc_chattanooga',
  subscription_status: 'active', payment_source: 'direct',
  paid_through_date: '2027-08-19', billing_notes: null,
  stripe_customer_id: 'cus_ach', stripe_subscription_id: 'sub_ach', ...over,
})

const checkoutEvent = (type: string, over: any = {}) => ({
  id: `evt_${type}_${over.id || 'x'}`, type,
  data: { object: {
    id: 'cs_ach', payment_intent: null,
    client_reference_id: LOC_UUID,
    metadata: { tier: 'owner', location_id: LOC_UUID },
    amount_total: 55000, currency: 'usd', payment_status: 'unpaid',
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

// The queue an activating checkout consumes, in order. `inFlight` adds the
// one extra locations read the issue-312 breadcrumb does before activation.
function primeActivation(loc: any, opts: { inFlight?: boolean } = {}) {
  const inFlight = opts.inFlight !== false
  h.enqueue('stripe_webhook_events', null)   // replay read → not a replay
  if (inFlight) h.enqueue('locations', loc)  // breadcrumb's getLocationBilling
  h.enqueue('locations', loc)                // getLocationBilling
  h.enqueue('tier_prices', { id: 'owner', price_annual: 550 })
  h.enqueue('locations', { ...loc, subscription_status: 'active' }) // read-back landed check
}

beforeEach(() => { h.reset(); vi.clearAllMocks(); process.env.STRIPE_WEBHOOK_SECRET = SECRET })
afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET })

describe('issue 313 — an UNPAID ACH checkout activates immediately', () => {
  it('runs the full activation instead of returning "awaiting async payment"', async () => {
    primeActivation(DEFERRED())
    const res = await post(checkoutEvent('checkout.session.completed'))
    const body = await res.json()

    // The old behavior — the whole bug — was this exact response.
    expect(body.pending).toBeUndefined()
    expect(body.processed).toBe(true)
    expect(body.activation).toBe(true)
    expect(activateLocationSubscription).toHaveBeenCalledTimes(1)

    // paid_through_date comes from the subscription's real period end, and
    // subscription_started_at is stamped inside activateLocationSubscription —
    // the two fields the hand-patches on Chattanooga and Katy never wrote.
    const call = (activateLocationSubscription as any).mock.calls[0][0]
    expect(call.locationId).toBe(LOC_UUID)
    expect(call.paidThroughDate).toBe('2030-01-01')
  })

  it('creates the seats the session billed, exactly as a paid checkout would', async () => {
    primeActivation(DEFERRED())
    h.enqueue('tier_prices', [{ id: 'owner', price_annual: 550 }, { id: 'manager', price_annual: 400 }])
    await post(checkoutEvent('checkout.session.completed', {
      metadata: { tier: 'owner', location_id: LOC_UUID, seat_plan: 'owner:1,manager:2' },
    }))
    expect(addSeatsForPlan).toHaveBeenCalledTimes(1)
    expect((addSeatsForPlan as any).mock.calls[0][0].plan).toEqual(
      expect.arrayContaining([{ tier: 'manager', count: 2 }]),
    )
  })

  it('does NOT fabricate a paid billing_invoices row for money that has not arrived', async () => {
    primeActivation(DEFERRED())
    await post(checkoutEvent('checkout.session.completed'))
    // billing_invoices.paid_at is NOT NULL DEFAULT now(), so a row written here
    // would assert the money arrived today. The subscription path has always
    // deferred the row to invoice.paid — for card too — and that is what keeps
    // the ledger honest when the bank takes six days.
    expect(recordStripeInvoice).not.toHaveBeenCalled()
  })

  it('the invoice row lands later, on invoice.paid, when the bank actually settles', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE())       // getLocationByStripeSubscriptionId
    h.enqueue('locations', ACTIVE())       // advancePaidThroughDate's current read
    const res = await post(invoicePaidEvent())
    expect((await res.json()).processed).toBe(true)
    expect(recordStripeInvoice).toHaveBeenCalledTimes(1)
    expect((recordStripeInvoice as any).mock.calls[0][0].amountCents).toBe(55000)
  })
})

describe('issue 313 — a PAID card checkout is unchanged', () => {
  it('activates with no in-flight note and no money-in-flight wording', async () => {
    primeActivation(DEFERRED(), { inFlight: false })
    const res = await post(checkoutEvent('checkout.session.completed', { payment_status: 'paid' }))
    const body = await res.json()

    expect(body.processed).toBe(true)
    expect(activateLocationSubscription).toHaveBeenCalledTimes(1)
    // The card path never touches the ACH audit trail.
    expect(appendBillingNote).not.toHaveBeenCalled()
    const slack = (postSlackMessage as any).mock.calls.map((c: any[]) => c[0]).join('\n')
    expect(slack).toContain('subscription activated')
    expect(slack).not.toContain('has NOT settled')
  })

  it('a $0 no_payment_required checkout is likewise untouched', async () => {
    primeActivation(DEFERRED(), { inFlight: false })
    await post(checkoutEvent('checkout.session.completed', {
      payment_status: 'no_payment_required', amount_total: 0,
    }))
    expect(activateLocationSubscription).toHaveBeenCalledTimes(1)
    expect(appendBillingNote).not.toHaveBeenCalled()
  })
})

describe('issue 313 — the money-in-flight state is visible to a human', () => {
  it('stamps an ACH_IN_FLIGHT audit line on the location billing notes', async () => {
    primeActivation(DEFERRED())
    await post(checkoutEvent('checkout.session.completed'))

    expect(appendBillingNote).toHaveBeenCalledTimes(1)
    const [locId, line] = (appendBillingNote as any).mock.calls[0]
    expect(locId).toBe(LOC_UUID)
    // billing_notes is the admin billing card's audit trail — the place a
    // human already looks to answer "has this location paid?".
    expect(line).toContain('[ACH_IN_FLIGHT')
    expect(line).toContain('$550.00')
    expect(line).toContain('cs_ach')
    expect(isAchMoneyInFlight(line)).toBe(true)
  })

  it('says so in Slack and in the sync_log row, rather than reporting a clean sale', async () => {
    primeActivation(DEFERRED())
    await post(checkoutEvent('checkout.session.completed'))
    const slack = (postSlackMessage as any).mock.calls.map((c: any[]) => c[0]).join('\n')
    expect(slack).toContain('has NOT settled')
    expect(slack).toContain('activated NOW')
  })

  it('the marker reader tracks the latest state, so a settled ACH stops reading in-flight', () => {
    const notes =
      '2026-08-19 — [ACH_IN_FLIGHT session=cs_ach] activated on an unpaid checkout\n' +
      '2026-08-25 — [ACH_CLEARED sub=sub_ach] the delayed payment settled'
    expect(lastAchMarker(notes)).toBe('ACH_CLEARED')
    expect(isAchMoneyInFlight(notes)).toBe(false)
    // …and a location that never used a bank transfer has no marker at all.
    expect(lastAchMarker('Corporate sponsorship through 2027.')).toBeNull()
    expect(isAchMoneyInFlight(null)).toBe(false)
  })
})

describe('issue 313 — a FAILED debit moves the location and alerts once', () => {
  it('moves an active location to past_due and raises exactly one alert', async () => {
    h.enqueue('stripe_webhook_events', null)  // replay read
    h.enqueue('locations', ACTIVE())          // getLocationBilling
    h.enqueue('locations', ACTIVE({ subscription_status: 'past_due' })) // read-back
    const res = await post(checkoutEvent('checkout.session.async_payment_failed'))
    const body = await res.json()

    expect(body.moved_to).toBe('past_due')
    expect(setLocationSubscriptionStatus).toHaveBeenCalledTimes(1)
    expect((setLocationSubscriptionStatus as any).mock.calls[0][1]).toBe('past_due')

    // EXACTLY one, on the ops rail. The replay guard is what guarantees the
    // "exactly" — see the redelivery test below.
    expect(postSlackMessage).toHaveBeenCalledTimes(1)
    const msg = (postSlackMessage as any).mock.calls[0][0]
    expect(msg).toContain('past_due')
    expect(msg).toContain('14-day grace')
  })

  it('closes the in-flight audit line with the reason it closed', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE())
    h.enqueue('locations', ACTIVE({ subscription_status: 'past_due' }))
    await post(checkoutEvent('checkout.session.async_payment_failed'))
    const line = (appendBillingNote as any).mock.calls[0][1]
    expect(line).toContain('[ACH_FAILED')
    expect(line).toContain('past_due')
    expect(isAchMoneyInFlight(line)).toBe(false)
  })

  it('keeps FULL access — it does not pause, deactivate or cancel', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE())
    h.enqueue('locations', ACTIVE({ subscription_status: 'past_due' }))
    await post(checkoutEvent('checkout.session.async_payment_failed'))
    const written = (setLocationSubscriptionStatus as any).mock.calls.map((c: any[]) => c[1])
    expect(written).toEqual(['past_due'])
    expect(written).not.toContain('canceled')
    // lifecycle_status (where 'paused' lives) is never touched by this handler.
    const lifecycleWrites = h.state.updates.filter(u => 'lifecycle_status' in (u.arg || {}))
    expect(lifecycleWrites).toEqual([])
  })

  it('does NOT re-write a location that is already past_due, canceled or deferred', async () => {
    for (const status of ['past_due', 'canceled', 'deferred']) {
      h.reset(); vi.clearAllMocks()
      h.enqueue('stripe_webhook_events', null)
      h.enqueue('locations', ACTIVE({ subscription_status: status }))
      const res = await post(checkoutEvent('checkout.session.async_payment_failed', { id: status }))
      expect((await res.json()).moved_to).toBeNull()
      expect(setLocationSubscriptionStatus).not.toHaveBeenCalled()
      // Still exactly one alert — a human is told, nothing is changed.
      expect(postSlackMessage).toHaveBeenCalledTimes(1)
    }
  })

  it('a Stripe redelivery is silent — no second move, no second alert', async () => {
    h.enqueue('stripe_webhook_events', { event_id: 'evt_checkout.session.async_payment_failed_x' })
    const res = await post(checkoutEvent('checkout.session.async_payment_failed'))
    expect((await res.json()).replay).toBe(true)
    expect(setLocationSubscriptionStatus).not.toHaveBeenCalled()
    expect(postSlackMessage).not.toHaveBeenCalled()
  })
})

describe('issue 313 — async_payment_succeeded is now a confirmation, not a trigger', () => {
  it('on an already-active location it is a no-op, NOT a second activation', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE())   // getLocationBilling → active + owner + sub
    h.enqueue('locations', ACTIVE())   // read-back
    const res = await post(checkoutEvent('checkout.session.async_payment_succeeded', {
      payment_status: 'paid',
    }))
    expect((await res.json()).processed).toBe(true)

    // The three things a double activation would have done.
    expect(activateLocationSubscription).not.toHaveBeenCalled()
    expect(addSeatsForPlan).not.toHaveBeenCalled()
    expect(recordStripeInvoice).not.toHaveBeenCalled()
  })

  it('what it DOES add is the confirmation that the money arrived', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE())
    h.enqueue('locations', ACTIVE())
    await post(checkoutEvent('checkout.session.async_payment_succeeded', { payment_status: 'paid' }))
    expect(clearAchInFlight).toHaveBeenCalledTimes(1)
    expect((clearAchInFlight as any).mock.calls[0][0]).toBe(LOC_UUID)
  })

  it('invoice.paid also clears the in-flight marker, so the ledger and the note close together', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE())
    h.enqueue('locations', ACTIVE())
    await post(invoicePaidEvent())
    expect(clearAchInFlight).toHaveBeenCalledTimes(1)
  })
})

// ── the downstream question instant activation forces ─────────
// paid_through_date used to mean "money received". After issue 313 it means
// "money promised", and issue 171's complete-onboarding gate treats a future
// date as an unforgeable licence to activate for FREE. isPrepaidTermCovering
// is what keeps a bounced promise from becoming that licence.
describe('issue 313 — a promised paid_through_date is not a receipt', () => {
  it('a genuinely prepaid location still reads as covered (issue 171 unchanged)', () => {
    const now = new Date('2026-08-19T12:00:00Z')
    expect(isPrepaidTermCovering(
      { paid_through_date: '2027-02-27', subscription_status: 'deferred' }, now,
    )).toBe(true)
    // …including an ACH still in flight: it is 'active', not past_due, and the
    // money may yet arrive. Nothing about the honest waiting case changes.
    expect(isPrepaidTermCovering(
      { paid_through_date: '2027-08-19', subscription_status: 'active' }, now,
    )).toBe(true)
  })

  it('a past_due location does NOT, even holding a future date', () => {
    const now = new Date('2026-08-19T12:00:00Z')
    // This is exactly the residue an ACH bounce leaves: activation stamped a
    // year out, then the debit failed. Without this the owner could walk back
    // through complete-onboarding and free-activate on money that never came.
    expect(isPrepaidTermCovering(
      { paid_through_date: '2027-08-19', subscription_status: 'past_due' }, now,
    )).toBe(false)
    // isPaidThroughFuture on its own still answers the raw date question —
    // the two are deliberately different questions, not a replacement.
    expect(isPaidThroughFuture('2027-08-19', now)).toBe(true)
  })

  it('a past or missing date is uncovered regardless of status', () => {
    const now = new Date('2026-08-19T12:00:00Z')
    expect(isPrepaidTermCovering({ paid_through_date: '2026-01-01', subscription_status: 'active' }, now)).toBe(false)
    expect(isPrepaidTermCovering({ paid_through_date: null, subscription_status: 'active' }, now)).toBe(false)
  })
})

// One bounce fires TWO Stripe events on a subscription — the checkout session's
// async_payment_failed and the invoice's payment_failed. Different event ids, so
// the replay guard cannot collapse them. The state converges (both write
// past_due, idempotently); only the alert needs deduping.
describe('issue 313 — one failed debit, one alert, across both events', () => {
  it('invoice.payment_failed on an ALREADY past_due location updates silently', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE({ subscription_status: 'past_due' }))
    const res = await post({
      id: 'evt_inv_failed', type: 'invoice.payment_failed',
      data: { object: {
        id: 'in_ach', customer: 'cus_ach', amount_paid: 0, currency: 'usd',
        billing_reason: 'subscription_create',
        parent: { subscription_details: { subscription: 'sub_ach' } },
      } },
    })
    expect((await res.json()).processed).toBe(true)
    // The ledger still moves…
    expect(setLocationSubscriptionStatus).toHaveBeenCalledWith(LOC_UUID, 'past_due')
    // …and Kevin is not told twice about one bounce.
    expect(postSlackMessage).not.toHaveBeenCalled()
  })

  it('invoice.payment_failed on an ACTIVE location still alerts — it is the first report', async () => {
    h.enqueue('stripe_webhook_events', null)
    h.enqueue('locations', ACTIVE())
    const res = await post({
      id: 'evt_inv_failed_2', type: 'invoice.payment_failed',
      data: { object: {
        id: 'in_ach2', customer: 'cus_ach', amount_paid: 0, currency: 'usd',
        billing_reason: 'subscription_cycle',
        parent: { subscription_details: { subscription: 'sub_ach' } },
      } },
    })
    expect((await res.json()).processed).toBe(true)
    expect(postSlackMessage).toHaveBeenCalledTimes(1)
    expect((postSlackMessage as any).mock.calls[0][0]).toContain('past_due')
  })
})
