// @vitest-environment node
//
// issue 165 — the owner-checkout idempotency key was too coarse.
//
// The old key bh_owner_checkout_{locationId} never varied, so Stripe (which
// replays the SAME session for a repeated key) made a location's first
// checkout session its ONLY one. A session that is already completed (a
// location reset for a repeat onboarding test) or expired (Checkout Sessions
// die after 24h) then trapped the owner on Stripe's "you're all done / timed
// out" page with no way to start over.
//
// The fix buckets the key by a coarse time window. This pins the three
// behaviors it rests on:
//   • a completed or expired session does NOT block a new one — a later
//     attempt (new window) produces a different key ⇒ a fresh session;
//   • a rapid double-submit does NOT create two subscriptions — two calls in
//     the same window share the key ⇒ Stripe replays ONE session, and even a
//     completed one only activates a location once (webhook is idempotent);
//   • the customer is NOT duplicated across attempts — bh_customer_{loc} is
//     unchanged and stable, one customer per location.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const stripe = vi.hoisted(() => ({
  checkout: {
    sessions: {
      create: vi.fn(async (p: any, opts: any) => ({ id: `cs_${opts?.idempotencyKey}`, url: 'https://checkout.stripe.com/c/cs', ...p })),
    },
  },
  customers: {
    create: vi.fn(async (_p: any, _opts: any) => ({ id: 'cus_1' })),
  },
}))
vi.mock('@/lib/stripe', () => ({ getStripe: () => stripe }))

import {
  ownerCheckoutIdempotencyKey,
  CHECKOUT_IDEMPOTENCY_WINDOW_MS,
  createOwnerCheckoutSession,
  getOrCreateStripeCustomer,
} from '@/lib/stripe-billing'

beforeEach(() => {
  stripe.checkout.sessions.create.mockClear()
  stripe.customers.create.mockClear()
})

describe('issue 165 — ownerCheckoutIdempotencyKey buckets per attempt', () => {
  it('keeps the location prefix so the key is still recognizably scoped', () => {
    expect(ownerCheckoutIdempotencyKey('loc-1', 0)).toMatch(/^bh_owner_checkout_loc-1_\d+$/)
  })

  it('a rapid double-submit (same window) yields the SAME key ⇒ Stripe replays one session', () => {
    const t0 = 1_700_000_000_000
    const a = ownerCheckoutIdempotencyKey('loc-1', t0)
    // 900ms later — a double-click / immediate network re-send, same bucket.
    const b = ownerCheckoutIdempotencyKey('loc-1', t0 + 900)
    expect(a).toBe(b)
  })

  it('a completed or expired session does NOT block a new one: a later attempt gets a NEW key', () => {
    const t0 = 1_700_000_000_000
    const first = ownerCheckoutIdempotencyKey('loc-1', t0)
    // The next onboarding test / return-after-abandon lands in a later window.
    const later = ownerCheckoutIdempotencyKey('loc-1', t0 + CHECKOUT_IDEMPOTENCY_WINDOW_MS)
    const nextDay = ownerCheckoutIdempotencyKey('loc-1', t0 + 24 * 60 * 60 * 1000)
    expect(later).not.toBe(first)
    expect(nextDay).not.toBe(first)
  })

  it('the window is short enough to un-stick an owner fast, but far under a session\'s 24h life', () => {
    expect(CHECKOUT_IDEMPOTENCY_WINDOW_MS).toBeGreaterThan(0)
    expect(CHECKOUT_IDEMPOTENCY_WINDOW_MS).toBeLessThan(24 * 60 * 60 * 1000)
  })

  it('different locations never share a bucket key', () => {
    const t0 = 1_700_000_000_000
    expect(ownerCheckoutIdempotencyKey('loc-1', t0)).not.toBe(ownerCheckoutIdempotencyKey('loc-2', t0))
  })
})

describe('issue 165 — createOwnerCheckoutSession threads the bucketed key to Stripe', () => {
  const base = {
    customerId: 'cus_1', priceId: 'price_owner', locationId: 'loc-1',
    tier: 'owner', successUrl: 'https://app/ok', cancelUrl: 'https://app/no',
  }

  it('a rapid double-submit passes ONE idempotency key ⇒ a single subscription can be born', async () => {
    const t0 = 1_700_000_000_000
    await createOwnerCheckoutSession({ ...base, nowMs: t0 })
    await createOwnerCheckoutSession({ ...base, nowMs: t0 + 500 })
    const key1 = (stripe.checkout.sessions.create.mock.calls[0][1] as any).idempotencyKey
    const key2 = (stripe.checkout.sessions.create.mock.calls[1][1] as any).idempotencyKey
    expect(key1).toBe(key2)
  })

  it('a completed/expired session no longer blocks a new attempt: a later create uses a DIFFERENT key', async () => {
    const t0 = 1_700_000_000_000
    await createOwnerCheckoutSession({ ...base, nowMs: t0 })
    await createOwnerCheckoutSession({ ...base, nowMs: t0 + CHECKOUT_IDEMPOTENCY_WINDOW_MS })
    const key1 = (stripe.checkout.sessions.create.mock.calls[0][1] as any).idempotencyKey
    const key2 = (stripe.checkout.sessions.create.mock.calls[1][1] as any).idempotencyKey
    expect(key1).not.toBe(key2)
  })
})

describe('issue 165 — the customer key stays permanent (one customer per location)', () => {
  it('bh_customer_{locationId} is stable across attempts ⇒ no duplicate customer', async () => {
    await getOrCreateStripeCustomer({ locationId: 'loc-1', name: 'A', email: 'a@x.test', existingCustomerId: null })
    await getOrCreateStripeCustomer({ locationId: 'loc-1', name: 'A', email: 'a@x.test', existingCustomerId: null })
    const opts1 = stripe.customers.create.mock.calls[0][1] as any
    const opts2 = stripe.customers.create.mock.calls[1][1] as any
    expect(opts1.idempotencyKey).toBe('bh_customer_loc-1')
    expect(opts2.idempotencyKey).toBe('bh_customer_loc-1')
  })

  it('a stored customer id short-circuits before any create call (never a second customer)', async () => {
    const res = await getOrCreateStripeCustomer({ locationId: 'loc-1', existingCustomerId: 'cus_existing' })
    expect(res).toEqual({ customerId: 'cus_existing', created: false })
    expect(stripe.customers.create).not.toHaveBeenCalled()
  })
})
