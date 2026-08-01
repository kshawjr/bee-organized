// @vitest-environment node
//
// issue 167 — the pay path fails into free activation, three ways. Each bug
// ends the same: a location activated for free, no invoice, nothing flags it.
// These pin the seams that close all three.
//
// BUG 1 — a replayed/deleted customer recovers instead of 502ing. The customer
//   idempotency key is now bucketed per attempt (so Stripe can't replay a
//   since-deleted customer's id for 24h), and createOwnerCheckoutSessionResilient
//   catches "No such customer", mints a fresh customer under a key derived from
//   the dead id, overwrites the stale column, and retries the session ONCE.
// BUG 2 — a FAILED checkout must NOT fall back to the record-only "no charge"
//   confirm. classifyCheckoutResponse maps only the specific 409 "not
//   configured" errors to 'unconfigured' (record-only legit); a 502 / network
//   failure is 'error' (surface it, no free-activation button).
// BUG 3 — the record-only complete-onboarding path must not free-activate an
//   owner-pays location that CAN pay through Stripe. ownerCheckoutConfigured is
//   the server gate; super_admin comp grants and unconfigured tiers stay open.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Stripe mock (customers + checkout sessions) ──────────────
const stripe = vi.hoisted(() => {
  const state = {
    customerSeq: 0,
    sessionFailNextNoCustomer: false,
  }
  const reset = () => { state.customerSeq = 0; state.sessionFailNextNoCustomer = false }
  return {
    state,
    reset,
    customers: {
      create: vi.fn(async (_p: any, _opts: any) => ({ id: `cus_fresh_${++state.customerSeq}` })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async (p: any, opts: any) => {
          if (state.sessionFailNextNoCustomer) {
            state.sessionFailNextNoCustomer = false
            const err: any = new Error(`No such customer: ${p.customer}`)
            err.code = 'resource_missing'
            err.param = 'customer'
            throw err
          }
          return { id: `cs_${opts?.idempotencyKey}`, url: 'https://checkout.stripe.com/c/cs', ...p }
        }),
      },
    },
  }
})
vi.mock('@/lib/stripe', () => ({
  getStripe: () => stripe,
  stripeConfigured: () => stripeConfiguredMock.value,
}))
const stripeConfiguredMock = vi.hoisted(() => ({ value: true }))

// ── supabase-service mock (tier_prices reads for the gate) ───
const db = vi.hoisted(() => ({ ownerPriceId: 'price_owner' as string | null }))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (_t: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: db.ownerPriceId ? { stripe_price_id: db.ownerPriceId } : {} }),
        }),
      }),
    }),
  },
}))

import {
  createOwnerCheckoutSessionResilient,
  isNoSuchCustomerError,
  ownerCheckoutIdempotencyKey,
} from '@/lib/stripe-billing'
import { classifyCheckoutResponse } from '@/lib/stripe-checkout-return'
import { ownerCheckoutConfigured } from '@/lib/subscription-activation'

beforeEach(() => {
  stripe.reset()
  stripe.customers.create.mockClear()
  stripe.checkout.sessions.create.mockClear()
  stripeConfiguredMock.value = true
  db.ownerPriceId = 'price_owner'
})

const base = {
  locationId: 'loc-1',
  name: 'Acme',
  email: 'a@x.test',
  priceId: 'price_owner',
  successUrl: 'https://app/ok',
  cancelUrl: 'https://app/no',
  tier: 'owner',
  nowMs: 1_700_000_000_000,
}

// ── BUG 1 ────────────────────────────────────────────────────
describe('issue 167 BUG 1 — stale/deleted customer recovery', () => {
  it('isNoSuchCustomerError matches Stripe resource_missing on customer and the message', () => {
    expect(isNoSuchCustomerError({ code: 'resource_missing', param: 'customer' })).toBe(true)
    expect(isNoSuchCustomerError(new Error('No such customer: cus_x'))).toBe(true)
    expect(isNoSuchCustomerError({ raw: { code: 'resource_missing', param: 'customer' } })).toBe(true)
    expect(isNoSuchCustomerError({ code: 'card_declined' })).toBe(false)
    expect(isNoSuchCustomerError(null)).toBe(false)
  })

  it('a stored customer that no longer exists recovers: fresh customer, column overwritten, session succeeds', async () => {
    stripe.state.sessionFailNextNoCustomer = true // first session.create throws "No such customer"
    const persistCustomerId = vi.fn(async () => {})
    const { session, customerId, recovered } = await createOwnerCheckoutSessionResilient({
      ...base,
      existingCustomerId: 'cus_stale', // stale/deleted id stored on the location
      persistCustomerId,
    })
    expect(recovered).toBe(true)
    expect(customerId).toMatch(/^cus_fresh_/)          // a genuinely fresh customer
    expect(session.url).toBeTruthy()                    // session succeeded on retry — no 502
    // The stale column is overwritten with the fresh id (never left pointing at a ghost).
    expect(persistCustomerId).toHaveBeenCalledTimes(1)
    expect(persistCustomerId).toHaveBeenCalledWith(customerId)
    // The fresh customer is minted under a key derived from the dead id — it can
    // never replay the ghost, and it is stable across retries of this recovery.
    const custKey = (stripe.customers.create.mock.calls[0][1] as any).idempotencyKey
    expect(custKey).toBe('bh_customer_loc-1_recover_cus_stale')
    // The retry session carries a DIFFERENT key than the poisoned first attempt.
    const sessKeys = stripe.checkout.sessions.create.mock.calls.map((c: any) => c[1].idempotencyKey)
    expect(sessKeys[0]).toBe(ownerCheckoutIdempotencyKey('loc-1', base.nowMs))
    expect(sessKeys[1]).toBe(`${ownerCheckoutIdempotencyKey('loc-1', base.nowMs)}_recover_cus_stale`)
  })

  it('the happy path (no stale customer) creates one customer, persists it, no recovery', async () => {
    const persistCustomerId = vi.fn(async () => {})
    const { recovered, customerId } = await createOwnerCheckoutSessionResilient({
      ...base,
      existingCustomerId: null,
      persistCustomerId,
    })
    expect(recovered).toBe(false)
    expect(persistCustomerId).toHaveBeenCalledTimes(1)
    expect(persistCustomerId).toHaveBeenCalledWith(customerId)
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1)
  })

  it('a stored, VALID customer is reused — no create, no persist', async () => {
    const persistCustomerId = vi.fn(async () => {})
    const { customerId, recovered } = await createOwnerCheckoutSessionResilient({
      ...base,
      existingCustomerId: 'cus_valid',
      persistCustomerId,
    })
    expect(recovered).toBe(false)
    expect(customerId).toBe('cus_valid')
    expect(stripe.customers.create).not.toHaveBeenCalled()
    expect(persistCustomerId).not.toHaveBeenCalled()
  })

  it('a non-customer Stripe error propagates (not silently swallowed into a free path)', async () => {
    stripe.checkout.sessions.create.mockImplementationOnce(async () => {
      const err: any = new Error('rate limited'); err.code = 'rate_limit'; throw err
    })
    await expect(createOwnerCheckoutSessionResilient({
      ...base, existingCustomerId: 'cus_valid', persistCustomerId: async () => {},
    })).rejects.toThrow('rate limited')
  })
})

// ── BUG 2 ────────────────────────────────────────────────────
describe('issue 167 BUG 2 — a failed checkout is not the record-only fallback', () => {
  it('a 502 stripe_error is classified BROKEN, never unconfigured', () => {
    expect(classifyCheckoutResponse(502, { error: 'stripe_error' })).toBe('error')
    expect(classifyCheckoutResponse(502, { error: 'checkout_no_url' })).toBe('error')
  })

  it('a network failure (no body) is BROKEN', () => {
    expect(classifyCheckoutResponse(0, null)).toBe('error')
  })

  it('only the specific 409 "not configured" errors are unconfigured (record-only legit)', () => {
    expect(classifyCheckoutResponse(409, { error: 'stripe_not_configured' })).toBe('unconfigured')
    expect(classifyCheckoutResponse(409, { error: 'owner_price_not_configured' })).toBe('unconfigured')
    expect(classifyCheckoutResponse(409, { error: 'non_paying_source' })).toBe('unconfigured')
  })

  it('a ready session url is ready; an already-active 409 resumes polling', () => {
    expect(classifyCheckoutResponse(200, { url: 'https://checkout.stripe.com/c/cs' })).toBe('ready')
    expect(classifyCheckoutResponse(200, {})).toBe('error') // 200 without a url is broken, not record-only
    expect(classifyCheckoutResponse(409, { error: 'already_active' })).toBe('already_active')
  })
})

// ── BUG 3 ────────────────────────────────────────────────────
describe('issue 167 BUG 3 — the record-only gate (ownerCheckoutConfigured)', () => {
  it('owner-pays + Stripe configured + owner price ⇒ configured (record-only must be refused for an owner)', async () => {
    const loc: any = { id: 'loc-1', payment_source: 'direct' }
    expect(await ownerCheckoutConfigured(loc)).toBe(true)
  })

  it('a non-paying / corporate source is NOT owner-checkout-configured (record-only/free-grant door stays open)', async () => {
    for (const src of ['prepaid_corporate', 'corporate_sponsored', 'corporate']) {
      expect(await ownerCheckoutConfigured({ id: 'loc-1', payment_source: src } as any)).toBe(false)
    }
  })

  it('Stripe not configured ⇒ not configured (unconfigured tier still gets record-only)', async () => {
    stripeConfiguredMock.value = false
    expect(await ownerCheckoutConfigured({ id: 'loc-1', payment_source: 'direct' } as any)).toBe(false)
  })

  it('no owner stripe_price_id ⇒ not configured', async () => {
    db.ownerPriceId = null
    expect(await ownerCheckoutConfigured({ id: 'loc-1', payment_source: 'direct' } as any)).toBe(false)
  })
})
