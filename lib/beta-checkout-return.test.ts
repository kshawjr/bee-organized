// @vitest-environment node
//
// issue 163 — return the owner to Bee Hub after Stripe checkout.
// Pins the three behaviors the fix rests on:
//   • The checkout session is created with success_url / cancel_url pointing
//     at the onboarding route (the same-tab return targets), passed through
//     to the dahlia Checkout API.
//   • The pay step leaves for Stripe in the SAME tab (location.assign), never
//     window.open — and a 'complete' return resumes the POLLING wait step, so
//     a return that beats the webhook keeps polling instead of racing it.
//   • recordStripeInvoice now populates the dedicated stripe_invoice_id column
//     (the invoice id no longer hides only in reference_number).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── createOwnerCheckoutSession + ownerCheckoutReturnUrls ──────
const stripe = vi.hoisted(() => ({
  checkout: { sessions: { create: vi.fn(async (p: any) => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', ...p })) } },
}))
vi.mock('@/lib/stripe', () => ({ getStripe: () => stripe }))

import {
  ownerCheckoutReturnUrls,
  createOwnerCheckoutSession,
} from '@/lib/stripe-billing'
import {
  navigateToStripeCheckout,
  payStepForCheckoutReturn,
  CHECKOUT_INFLIGHT_KEY,
} from '@/lib/stripe-checkout-return'

describe('issue 163 — checkout return URLs', () => {
  it('both URLs point at the onboarding route with the return marker', () => {
    const { successUrl, cancelUrl } = ownerCheckoutReturnUrls('https://app.bee.test')
    expect(successUrl).toBe('https://app.bee.test/?stripe_checkout=complete')
    expect(cancelUrl).toBe('https://app.bee.test/?stripe_checkout=cancel')
  })

  it('a trailing slash on the origin does not double up', () => {
    const { successUrl } = ownerCheckoutReturnUrls('https://app.bee.test/')
    expect(successUrl).toBe('https://app.bee.test/?stripe_checkout=complete')
  })

  it('the session is created with those return URLs (dahlia success_url/cancel_url)', async () => {
    const { successUrl, cancelUrl } = ownerCheckoutReturnUrls('https://app.bee.test')
    await createOwnerCheckoutSession({
      customerId: 'cus_1', priceId: 'price_owner', locationId: 'loc-1',
      tier: 'owner', successUrl, cancelUrl,
    })
    const [params, opts] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params).toMatchObject({
      mode: 'subscription',
      success_url: 'https://app.bee.test/?stripe_checkout=complete',
      cancel_url: 'https://app.bee.test/?stripe_checkout=cancel',
      client_reference_id: 'loc-1',
    })
    // issue 165: the key is bucketed per attempt (bh_owner_checkout_<loc>_<bucket>),
    // so it still starts with the location prefix but no longer traps the owner on a
    // dead session forever. Exact bucketing is pinned in checkout-idempotency-key-scope.test.ts.
    expect(opts.idempotencyKey).toMatch(/^bh_owner_checkout_loc-1_\d+$/)
  })
})

describe('issue 163 — same-tab navigation, never window.open', () => {
  it('navigateToStripeCheckout uses location.assign and sets the in-flight flag', () => {
    const assign = vi.fn()
    const setItem = vi.fn()
    const openSpy = vi.fn()
    const fakeWin: any = { location: { assign }, sessionStorage: { setItem } as any, open: openSpy }
    navigateToStripeCheckout('https://checkout.stripe.com/c/cs_1', fakeWin)
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/cs_1')
    expect(openSpy).not.toHaveBeenCalled()
    expect(setItem).toHaveBeenCalledWith(CHECKOUT_INFLIGHT_KEY, '1')
  })

  it('no-ops on an empty url (no navigation, no window.open)', () => {
    const assign = vi.fn()
    navigateToStripeCheckout('', { location: { assign } } as any)
    expect(assign).not.toHaveBeenCalled()
  })
})

describe('issue 163 — return marker → pay step (polling is the backstop)', () => {
  it('complete → the polling wait step, so a return that beats the webhook keeps polling', () => {
    // stripe_wait mounts StripeCheckoutWait, which polls activation-status
    // until subscription_status flips active — no race with the webhook.
    expect(payStepForCheckoutReturn('complete')).toBe('stripe_wait')
  })
  it('cancel → the pay step (never a broken state)', () => {
    expect(payStepForCheckoutReturn('cancel')).toBe('pay_confirm')
  })
  it('an unrelated / missing marker leaves the step alone', () => {
    expect(payStepForCheckoutReturn('whatever')).toBeNull()
    expect(payStepForCheckoutReturn(null)).toBeNull()
    expect(payStepForCheckoutReturn(undefined)).toBeNull()
  })
})

// ── recordStripeInvoice: stripe_invoice_id population ─────────
const db = vi.hoisted(() => {
  const state = { inserts: [] as any[], nextError: null as any }
  const reset = () => { state.inserts = []; state.nextError = null }
  return { state, reset }
})
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: () => ({
      insert: (arg: any) => {
        db.state.inserts.push(arg)
        return Promise.resolve({ error: db.state.nextError })
      },
    }),
  },
}))

import { recordStripeInvoice } from '@/lib/subscription-activation'

beforeEach(() => { db.reset() })

describe('issue 163 — recordStripeInvoice populates stripe_invoice_id', () => {
  it('an invoice-sourced row fills stripe_invoice_id AND reference_number with the invoice id', async () => {
    const outcome = await recordStripeInvoice({
      locationId: 'loc-1', amountCents: 55000, currency: 'usd',
      sessionId: null, invoiceId: 'in_1Tze89G6R4Z90UpnRmSvsMaV',
      paymentIntentId: 'pi_1', memo: 'Stripe subscription activation',
    })
    expect(outcome).toBe('inserted')
    const row = db.state.inserts[0]
    expect(row.stripe_invoice_id).toBe('in_1Tze89G6R4Z90UpnRmSvsMaV')
    expect(row.reference_number).toBe('in_1Tze89G6R4Z90UpnRmSvsMaV')
    expect(row.stripe_payment_intent_id).toBe('pi_1') // idempotency key column, unchanged
  })

  it('a checkout-session-sourced row (no invoice id) keeps the session id in reference_number and leaves stripe_invoice_id null', async () => {
    await recordStripeInvoice({
      locationId: 'loc-1', amountCents: 55000, currency: 'usd',
      sessionId: 'cs_123', paymentIntentId: 'pi_2', memo: 'Stripe checkout',
    })
    const row = db.state.inserts[0]
    expect(row.reference_number).toBe('cs_123')
    expect(row.stripe_invoice_id).toBeNull()
  })

  it('a zero-amount session is skipped (no row)', async () => {
    const outcome = await recordStripeInvoice({
      locationId: 'loc-1', amountCents: 0, currency: 'usd',
      sessionId: null, invoiceId: 'in_free', paymentIntentId: null, memo: '100% coupon',
    })
    expect(outcome).toBe('skipped_zero_amount')
    expect(db.state.inserts.length).toBe(0)
  })
})
