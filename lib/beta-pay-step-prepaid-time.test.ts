// @vitest-environment node
//
// issue 171 — the pay step must respect prepaid time.
//
// Ten legacy locations are payment_source 'direct' with paid_through_date
// '2027-02-27' — their first year is already paid for. Eight are onboarded;
// two (San Antonio, Oklahoma City) have not. When either walks the wizard she
// reaches the pay step and — because the location is 'direct' with a configured
// owner stripe_price_id — used to be quoted $550 today. She owes nothing until
// 2027-02-27.
//
// These pins hold the three seams that make that true WITHOUT reopening the
// issue 167 free-activation hole:
//   1. isPaidThroughFuture — the single, date-injectable predicate all three
//      seams (client display, checkout route, complete-onboarding gate) read.
//   2. classifyCheckoutResponse — the prepaid 409 becomes its own client state,
//      never 'error' (which would surface a scary "unavailable") nor
//      'unconfigured' (which would show the dishonest "isn't set up" copy).
//   3. The complete-onboarding gate — a composition of isPaidThroughFuture and
//      ownerCheckoutConfigured. A prepaid location flips for free; a location
//      that actually owes money (null/past paid_through_date) is still blocked
//      exactly as issue 167 built it.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── stripe + supabase-service mocks (for ownerCheckoutConfigured) ──
// Same shape as beta-pay-path-free-activation.test.ts: the tier_prices read
// resolves to an owner price when db.ownerPriceId is set.
vi.mock('@/lib/stripe', () => ({
  stripeConfigured: () => stripeConfiguredMock.value,
}))
const stripeConfiguredMock = vi.hoisted(() => ({ value: true }))

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

import { isPaidThroughFuture } from '@/lib/subscription-math'
import { classifyCheckoutResponse, CHECKOUT_PREPAID_ERROR } from '@/lib/stripe-checkout-return'
import { ownerCheckoutConfigured } from '@/lib/subscription-activation'

beforeEach(() => {
  stripeConfiguredMock.value = true
  db.ownerPriceId = 'price_owner'
})

// A stable "today" so the future/past assertions never drift with the wall clock.
const NOW = new Date('2026-08-01T00:00:00Z')
const FUTURE = '2027-02-27' // the legacy-ten's real paid_through_date
const PAST = '2025-02-27'

// ── Seam 1: the predicate ─────────────────────────────────────
describe('issue 171 — isPaidThroughFuture', () => {
  it('a future paid_through_date is prepaid', () => {
    expect(isPaidThroughFuture(FUTURE, NOW)).toBe(true)
  })

  it('a past paid_through_date is NOT prepaid (the term has lapsed → pay again)', () => {
    expect(isPaidThroughFuture(PAST, NOW)).toBe(false)
  })

  it('a null/absent paid_through_date is NOT prepaid (a fresh self-paying franchise)', () => {
    expect(isPaidThroughFuture(null, NOW)).toBe(false)
    expect(isPaidThroughFuture(undefined, NOW)).toBe(false)
    expect(isPaidThroughFuture('', NOW)).toBe(false)
  })

  it('the renewal day itself is NOT the future — that is exactly when charging resumes', () => {
    // Strict `>` against parsed midnight-UTC: any time on 2027-02-27 is not
    // "in the future" of that date, so the location falls back to Stripe.
    expect(isPaidThroughFuture(FUTURE, new Date('2027-02-27T00:00:00Z'))).toBe(false)
    expect(isPaidThroughFuture(FUTURE, new Date('2027-02-27T12:00:00Z'))).toBe(false)
    // One second before midnight it is still prepaid.
    expect(isPaidThroughFuture(FUTURE, new Date('2027-02-26T23:59:59Z'))).toBe(true)
  })

  it('a malformed date string is NOT prepaid (fails closed to the normal path)', () => {
    expect(isPaidThroughFuture('not-a-date', NOW)).toBe(false)
    expect(isPaidThroughFuture('2027-02', NOW)).toBe(false)
  })
})

// ── Seam 2: the client classification ─────────────────────────
describe('issue 171 — classifyCheckoutResponse maps the prepaid 409', () => {
  it('the prepaid 409 is its OWN state, not error and not unconfigured', () => {
    expect(classifyCheckoutResponse(409, { error: CHECKOUT_PREPAID_ERROR })).toBe('prepaid')
    expect(classifyCheckoutResponse(409, { error: 'prepaid_through_future' })).toBe('prepaid')
  })

  it('issue 167 BUG 2 intact — a broken checkout is still error, never prepaid', () => {
    expect(classifyCheckoutResponse(502, { error: 'stripe_error' })).toBe('error')
    expect(classifyCheckoutResponse(502, { error: 'checkout_no_url' })).toBe('error')
    expect(classifyCheckoutResponse(0, null)).toBe('error')
    expect(classifyCheckoutResponse(200, {})).toBe('error')
  })

  it('the unconfigured errors are unchanged (record-only path still legit)', () => {
    expect(classifyCheckoutResponse(409, { error: 'stripe_not_configured' })).toBe('unconfigured')
    expect(classifyCheckoutResponse(409, { error: 'owner_price_not_configured' })).toBe('unconfigured')
    expect(classifyCheckoutResponse(409, { error: 'non_paying_source' })).toBe('unconfigured')
  })
})

// ── Seam 3: the complete-onboarding gate ──────────────────────
// The exact boolean from app/api/locations/[id]/complete-onboarding/route.ts.
// Composed from the two REAL functions so the test tracks the route's logic.
async function gateBlocks(
  location: any,
  ctx: { isSuperAdmin: boolean; isOwnerOfTarget: boolean },
  now: Date,
): Promise<boolean> {
  return (
    ctx.isOwnerOfTarget &&
    !ctx.isSuperAdmin &&
    location.subscription_status !== 'active' &&
    !isPaidThroughFuture(location.paid_through_date, now) &&
    (await ownerCheckoutConfigured(location))
  )
}

const OWNER = { isSuperAdmin: false, isOwnerOfTarget: true }

describe('issue 171 — complete-onboarding gate: prepaid activates, everyone else stays as issue 167 left them', () => {
  it('a prepaid direct location is NOT blocked — the free flip is authorised by paid_through_date', async () => {
    const loc = { id: 'sat', payment_source: 'direct', subscription_status: 'deferred', paid_through_date: FUTURE }
    expect(await gateBlocks(loc, OWNER, NOW)).toBe(false)
    // Belt-and-suspenders: it is genuinely owner-checkout-configured (Stripe set
    // up, owner price present) — so it is ONLY the prepaid fact that lets it
    // through, not a missing Stripe config.
    expect(await ownerCheckoutConfigured(loc as any)).toBe(true)
  })

  it('issue 167 intact — an owner-pays location that OWES money is still blocked', async () => {
    for (const paid_through_date of [null, PAST]) {
      const loc = { id: 'x', payment_source: 'direct', subscription_status: 'deferred', paid_through_date }
      expect(await gateBlocks(loc, OWNER, NOW)).toBe(true)
    }
  })

  it('a super_admin comp grant is never blocked, prepaid or not (Kevin\'s manual door)', async () => {
    const loc = { id: 'x', payment_source: 'direct', subscription_status: 'deferred', paid_through_date: null }
    expect(await gateBlocks(loc, { isSuperAdmin: true, isOwnerOfTarget: false }, NOW)).toBe(false)
  })

  it('an already-active location is never blocked (redundant confirm, not a free activation)', async () => {
    const loc = { id: 'x', payment_source: 'direct', subscription_status: 'active', paid_through_date: null }
    expect(await gateBlocks(loc, OWNER, NOW)).toBe(false)
  })

  it('a non-paying / corporate source stays open (its own zero-due path)', async () => {
    const loc = { id: 'x', payment_source: 'prepaid_corporate', subscription_status: 'deferred', paid_through_date: null }
    expect(await gateBlocks(loc, OWNER, NOW)).toBe(false)
  })
})
