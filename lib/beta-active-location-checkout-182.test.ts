// @vitest-environment node
//
// issue 182 — "checkout link for an already-active location".
//
// Pins the mint side of the feature:
//   • The zero-charge mechanism (lib/stripe-billing.createOwnerCheckoutSession):
//     a future billing_cycle_anchor + proration_behavior 'none' anchors the
//     first invoice to the prepaid-through date and charges nothing today —
//     including with MULTIPLE line items (owner + managers). Onboarding's pay
//     step (no anchor, single owner line) is unaffected.
//   • The super_admin route (POST /api/admin/subscription-checkout-link):
//     an ACTIVE location mints a session with one line item PER ACTIVE SEAT
//     TIER at the real quantities (read from subscription_seats), anchored to
//     a FUTURE paid_through_date. A null/past date is REJECTED rather than
//     silently charged; inactive / corporate locations are refused; a location
//     with no billable seats is refused (nothing invented).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { parsePaidThroughDate } from '@/lib/subscription-math'

// ── Stripe mock — capture the exact session params ────────────
const stripe = vi.hoisted(() => ({
  customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
  checkout: {
    sessions: {
      create: vi.fn(async (p: any, _opts: any) => ({ id: 'cs_182', url: 'https://checkout.stripe.com/c/cs_182', ...p })),
    },
  },
}))
const cfg = vi.hoisted(() => ({ configured: true }))
vi.mock('@/lib/stripe', () => ({ getStripe: () => stripe, stripeConfigured: () => cfg.configured }))

// ── Auth (super_admin by default) ─────────────────────────────
const auth = vi.hoisted(() => ({
  user: { id: 'admin-1' } as any,
  hubUser: { role: 'super_admin' } as any,
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: auth.hubUser }) }) }) }),
  }),
}))

// ── Table-aware supabase-service mock (tier_prices + seats) ───
const db = vi.hoisted(() => ({
  tier_prices: [
    { id: 'owner', price_annual: 550, stripe_price_id: 'price_owner' },
    { id: 'manager', price_annual: 400, stripe_price_id: 'price_mgr' },
    { id: 'light', price_annual: 0, stripe_price_id: null },
    { id: 'readonly', price_annual: 0, stripe_price_id: null },
  ] as any[],
  subscription_seats: [{ tier: 'owner' }] as any[],
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const b: any = {}
      const rows = () => (db as any)[table] ?? []
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is', 'not', 'neq', 'like']) b[m] = () => b
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null })
      b.single = async () => ({ data: rows()[0] ?? null, error: null })
      b.then = (res: any, rej: any) => Promise.resolve({ data: rows(), error: null }).then(res, rej)
      return b
    },
  },
}))

// ── Location under test (real subscription-activation otherwise) ─
const loc = vi.hoisted(() => ({ value: null as any }))
const writeIds = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/subscription-activation', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    getLocationBilling: vi.fn(async () => loc.value),
    writeLocationStripeIds: writeIds,
  }
})
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own-1', email: 'owner@kc.test', full_name: 'KC Owner', phone: null })),
}))

import { createOwnerCheckoutSession } from '@/lib/stripe-billing'
import { POST } from '@/app/api/admin/subscription-checkout-link/route'

const LOC = (over: any = {}) => ({
  id: 'loc-kc-uuid', name: 'Kansas City', location_id: 'loc_kc',
  subscription_status: 'active', payment_source: 'direct',
  paid_through_date: '2027-05-01',
  stripe_customer_id: 'cus_active', stripe_subscription_id: null, ...over,
})

function post(body: any) {
  return POST(new NextRequest('https://app.test/api/admin/subscription-checkout-link', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  cfg.configured = true
  db.tier_prices = [
    { id: 'owner', price_annual: 550, stripe_price_id: 'price_owner' },
    { id: 'manager', price_annual: 400, stripe_price_id: 'price_mgr' },
    { id: 'light', price_annual: 0, stripe_price_id: null },
    { id: 'readonly', price_annual: 0, stripe_price_id: null },
  ]
  db.subscription_seats = [{ tier: 'owner' }]
  auth.user = { id: 'admin-1' }
  auth.hubUser = { role: 'super_admin' }
  loc.value = LOC()
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.test'
})

// ── The zero-charge mechanism (multi-line) ────────────────────
describe('issue 182 — createOwnerCheckoutSession anchors and charges zero', () => {
  it('a future anchor + proration none bills nothing today, even with multiple lines', async () => {
    const anchor = Math.floor(parsePaidThroughDate('2027-05-01')!.getTime() / 1000)
    await createOwnerCheckoutSession({
      customerId: 'cus_active', priceId: 'price_owner', locationId: 'loc-kc-uuid',
      successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no',
      billingCycleAnchor: anchor,
      lineItems: [{ price: 'price_owner', quantity: 1 }, { price: 'price_mgr', quantity: 2 }],
      nowMs: 1_700_000_000_000,
    })
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.mode).toBe('subscription')
    // Anchored to the prepaid-through date...
    expect(params.subscription_data.billing_cycle_anchor).toBe(anchor)
    // ...with proration_behavior 'none' — the ONLY setting that suppresses an
    // immediate now→anchor charge. With a future anchor, NO line (owner or
    // manager) is invoiced at checkout; the whole subscription's first invoice
    // is deferred to the anchor, so amount due today is $0 regardless of how
    // many lines it carries.
    expect(params.subscription_data.proration_behavior).toBe('none')
    expect(params.line_items).toEqual([
      { price: 'price_owner', quantity: 1 },
      { price: 'price_mgr', quantity: 2 },
    ])
  })

  it('the onboarding pay step (no anchor, no lineItems) is unchanged — single owner line, no overrides', async () => {
    await createOwnerCheckoutSession({
      customerId: 'cus_active', priceId: 'price_owner', locationId: 'loc-kc-uuid',
      successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no',
      nowMs: 1_700_000_000_000,
    })
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.line_items).toEqual([{ price: 'price_owner', quantity: 1 }])
    expect(params.subscription_data.billing_cycle_anchor).toBeUndefined()
    expect(params.subscription_data.proration_behavior).toBeUndefined()
  })
})

// ── The route: one line per active seat tier ──────────────────
describe('issue 182 — POST builds a line item per active seat tier', () => {
  it('KC (owner + 2 managers) mints owner×1 + manager×2, anchored, $1,350/yr', async () => {
    db.subscription_seats = [{ tier: 'owner' }, { tier: 'manager' }, { tier: 'manager' }]
    const res = await post({ location_id: 'loc-kc-uuid' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.url).toBe('https://checkout.stripe.com/c/cs_182')
    expect(json.anchor_date).toBe('2027-05-01')
    expect(json.projected_annual_cents).toBe(135000) // $1,350
    expect(json.lines).toEqual([
      { tier: 'owner', quantity: 1, unit_price_annual: 550 },
      { tier: 'manager', quantity: 2, unit_price_annual: 400 },
    ])

    const anchor = Math.floor(parsePaidThroughDate('2027-05-01')!.getTime() / 1000)
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.subscription_data.billing_cycle_anchor).toBe(anchor)
    expect(params.subscription_data.proration_behavior).toBe('none')
    expect(params.line_items).toEqual([
      { price: 'price_owner', quantity: 1 },
      { price: 'price_mgr', quantity: 2 },
    ])
    expect(params.metadata).toMatchObject({ tier: 'owner', location_id: 'loc-kc-uuid' })
  })

  it('an owner-only location mints a single owner line ($550/yr)', async () => {
    db.subscription_seats = [{ tier: 'owner' }]
    const res = await post({ location_id: 'loc-kc-uuid' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.projected_annual_cents).toBe(55000)
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.line_items).toEqual([{ price: 'price_owner', quantity: 1 }])
  })

  it('free tiers (no stripe price, $0) carry no line and are not billed', async () => {
    db.subscription_seats = [{ tier: 'owner' }, { tier: 'readonly' }, { tier: 'light' }]
    const res = await post({ location_id: 'loc-kc-uuid' })
    const json = await res.json()
    expect(res.status).toBe(200)
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.line_items).toEqual([{ price: 'price_owner', quantity: 1 }])
    expect(json.projected_annual_cents).toBe(55000)
  })

  it('the July cohort anchors to 2027-07-01', async () => {
    loc.value = LOC({ id: 'loc-portland-uuid', name: 'Portland', location_id: 'loc_portland', paid_through_date: '2027-07-01' })
    const res = await post({ location_id: 'loc-portland-uuid' })
    expect(res.status).toBe(200)
    const anchor = Math.floor(parsePaidThroughDate('2027-07-01')!.getTime() / 1000)
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.subscription_data.billing_cycle_anchor).toBe(anchor)
  })
})

// ── The guards: never silently charge / invent ───────────────
describe('issue 182 — guards reject rather than silently charge', () => {
  it('a NULL paid_through_date is rejected (409), no Stripe session', async () => {
    loc.value = LOC({ paid_through_date: null })
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('paid_through_not_future')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a PAST paid_through_date is rejected (409), no Stripe session', async () => {
    loc.value = LOC({ paid_through_date: '2020-01-01' })
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('paid_through_not_future')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a NOT-yet-active location is refused (409) — onboarding owns activation', async () => {
    loc.value = LOC({ subscription_status: 'deferred' })
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('location_not_active')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a corporate / non-paying source is refused (409)', async () => {
    loc.value = LOC({ payment_source: 'prepaid_corporate' })
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('non_paying_source')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('an active location with no billable seat rows is refused (nothing invented)', async () => {
    db.subscription_seats = []
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('no_billable_seats')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a paid seat tier with no Stripe price fails closed rather than under-billing', async () => {
    db.tier_prices = [
      { id: 'owner', price_annual: 550, stripe_price_id: 'price_owner' },
      { id: 'manager', price_annual: 400, stripe_price_id: null }, // paid, but unpriced in Stripe
    ]
    db.subscription_seats = [{ tier: 'owner' }, { tier: 'manager' }]
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('seat_tier_not_priced')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a non-super_admin is forbidden (403)', async () => {
    auth.hubUser = { role: 'owner' }
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(403)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('no owner price configured ⇒ 409, no session', async () => {
    db.tier_prices = [{ id: 'owner', price_annual: 550, stripe_price_id: null }]
    const res = await post({ location_id: 'loc-kc-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('owner_price_not_configured')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })
})
