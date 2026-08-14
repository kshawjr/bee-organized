// @vitest-environment node
//
// issue 212 — onboarding charges for every selected seat.
//
// THE PRODUCTION FAILURE THIS PINS: Fort Lauderdale onboarded with three seats
// selected (owner, an additional owner, a Hive Manager). The pay step quoted
// $1,350. The checkout POST sent a literal '{}', the route never read it, and
// createOwnerCheckoutSessionResilient fell to its single-owner-line default —
// so Stripe charged $550, activation created one seat, and Settings then
// refused both invites for want of a pool.
//
// Three numbers must always be equal: what the screen quotes, what Stripe
// charges, what lands in subscription_seats. This file pins the first two (the
// webhook file pins the third):
//   • the plan module — validation, the co-owner rate rule, metadata round-trip
//   • the checkout route — line items per billing tier, the 2-owner cap, the
//     price-mismatch guard, and quoted_total_cents === the Stripe line total
//   • owner-only checkout is byte-for-byte what it was before issue 212
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import {
  normalizeSeatPlan,
  planBillingLines,
  planAddOnRows,
  encodeSeatPlan,
  decodeSeatPlan,
  priceSeatPlanCents,
  priceBillingLinesCents,
  defaultSeatPlan,
} from '@/lib/seat-plan'
import { DEFAULT_TIER_PRICES } from '@/lib/subscription-math'

// ── Stripe mock — capture session params, serve price unit amounts ─
const stripe = vi.hoisted(() => ({
  customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
  prices: {
    retrieve: vi.fn(async (id: string) => {
      const amounts: Record<string, number> = { price_owner: 55000, price_mgr: 40000, price_ro: 5000 }
      return { id, unit_amount: amounts[id] ?? null }
    }),
  },
  checkout: {
    sessions: {
      create: vi.fn(async (p: any, _opts: any) => ({
        id: 'cs_212', url: 'https://checkout.stripe.com/c/cs_212', ...p,
      })),
    },
  },
}))
const cfg = vi.hoisted(() => ({ configured: true }))
vi.mock('@/lib/stripe', () => ({ getStripe: () => stripe, stripeConfigured: () => cfg.configured }))

// ── Auth: the owner of the target location ────────────────────
const auth = vi.hoisted(() => ({
  user: { id: 'own-1' } as any,
  hubUser: { role: 'owner', location_id: 'loc-ftl-uuid', email: 'owner@ftl.test' } as any,
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: auth.hubUser }) }) }) }),
  }),
}))

const db = vi.hoisted(() => ({
  tier_prices: [] as any[],
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

const loc = vi.hoisted(() => ({ value: null as any }))
vi.mock('@/lib/subscription-activation', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    getLocationBilling: vi.fn(async () => loc.value),
    writeLocationStripeIds: vi.fn(async () => {}),
  }
})
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own-1', email: 'owner@ftl.test', full_name: 'FTL Owner', phone: null })),
}))

import { POST } from '@/app/api/locations/[id]/checkout/route'

const LOC = (over: any = {}) => ({
  id: 'loc-ftl-uuid', name: 'Fort Lauderdale', location_id: 'loc_fortlauderdale',
  subscription_status: 'deferred', payment_source: 'direct',
  paid_through_date: null,
  stripe_customer_id: 'cus_ftl', stripe_subscription_id: null, ...over,
})

function post(body: any, id = 'loc-ftl-uuid') {
  return POST(
    new NextRequest('https://app.test/api/locations/x/checkout', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: { id } },
  )
}

// The exact selection Fort Lauderdale made: herself, her husband as an
// additional owner, her daughter as a Hive Manager.
const FTL_SELECTION = [
  { tier: 'owner', count: 2 },
  { tier: 'manager', count: 1 },
]

beforeEach(() => {
  vi.clearAllMocks()
  cfg.configured = true
  db.tier_prices = [
    { id: 'owner', price_annual: 550, stripe_price_id: 'price_owner' },
    { id: 'manager', price_annual: 400, stripe_price_id: 'price_mgr' },
    { id: 'light', price_annual: 0, stripe_price_id: null },
    { id: 'readonly', price_annual: 50, stripe_price_id: 'price_ro' },
  ]
  auth.user = { id: 'own-1' }
  auth.hubUser = { role: 'owner', location_id: 'loc-ftl-uuid', email: 'owner@ftl.test' }
  loc.value = LOC()
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.test'
})

// ── The plan module ───────────────────────────────────────────
describe('issue 212 — seat plan validation (the client proposes, the server prices)', () => {
  it('accepts the Fort Lauderdale selection', () => {
    const r = normalizeSeatPlan(FTL_SELECTION)
    expect(r.ok).toBe(true)
    expect(r.ok && r.plan).toEqual([{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }])
  })

  it('no selection at all falls back to owner-only — pre-212 behavior for a stale client', () => {
    expect(normalizeSeatPlan(undefined)).toEqual({ ok: true, plan: defaultSeatPlan() })
    expect(normalizeSeatPlan(null)).toEqual({ ok: true, plan: [{ tier: 'owner', count: 1 }] })
  })

  it('enforces the 2-owner cap', () => {
    const r = normalizeSeatPlan([{ tier: 'owner', count: 3 }])
    expect(r).toMatchObject({ ok: false, error: 'max_owners_reached' })
  })

  it('a plan with no owner seat is refused — the owner seat IS the subscription', () => {
    const r = normalizeSeatPlan([{ tier: 'manager', count: 2 }])
    expect(r).toMatchObject({ ok: false, error: 'seat_plan_owner_required' })
  })

  it('rejects junk rather than coercing it — a coerced plan bills a number nobody saw', () => {
    expect(normalizeSeatPlan('owner')).toMatchObject({ ok: false, error: 'seat_plan_not_an_array' })
    expect(normalizeSeatPlan([{ tier: 'admin', count: 1 }])).toMatchObject({ ok: false, error: 'seat_plan_invalid_tier' })
    expect(normalizeSeatPlan([{ tier: 'owner', count: 1.5 }])).toMatchObject({ ok: false, error: 'seat_plan_invalid_count' })
    expect(normalizeSeatPlan([{ tier: 'owner', count: -1 }])).toMatchObject({ ok: false, error: 'seat_plan_invalid_count' })
  })

  it('merges duplicate tier entries, and the cap still applies to the merged total', () => {
    expect(normalizeSeatPlan([{ tier: 'owner', count: 1 }, { tier: 'owner', count: 1 }])).toMatchObject({
      ok: true, plan: [{ tier: 'owner', count: 2 }],
    })
    expect(
      normalizeSeatPlan([{ tier: 'owner', count: 1 }, { tier: 'owner', count: 1 }, { tier: 'owner', count: 1 }]),
    ).toMatchObject({ ok: false, error: 'max_owners_reached' })
  })
})

describe('issue 212 — the co-owner rule (a 2nd owner bills at the MANAGER rate)', () => {
  it('owner×2 + manager×1 bills owner×1 + manager×2', () => {
    expect(planBillingLines([{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }])).toEqual([
      { billingTier: 'owner', quantity: 1 },
      { billingTier: 'manager', quantity: 2 },
    ])
  })

  it('owner×2 alone bills owner×1 + manager×1 — the co-owner is not a second $550 seat', () => {
    expect(planBillingLines([{ tier: 'owner', count: 2 }])).toEqual([
      { billingTier: 'owner', quantity: 1 },
      { billingTier: 'manager', quantity: 1 },
    ])
  })

  it('owner-only bills a single owner line', () => {
    expect(planBillingLines([{ tier: 'owner', count: 1 }])).toEqual([{ billingTier: 'owner', quantity: 1 }])
  })

  // The invariant that keeps the screen and the charge honest: the billing
  // lines and subscription-math's dollar catalog must price a plan identically.
  // calculateSeatTotal drives the pricing-step display; planBillingLines drives
  // the Stripe line items. If the co-owner rule ever drifts between them, this
  // fails here rather than on an owner's card.
  it('billing lines price identically to calculateSeatTotal, for every plan shape', () => {
    const unitCents = {
      owner: DEFAULT_TIER_PRICES.owner * 100,
      manager: DEFAULT_TIER_PRICES.manager * 100,
      light: DEFAULT_TIER_PRICES.light * 100,
      readonly: DEFAULT_TIER_PRICES.readonly * 100,
    }
    const shapes = [
      [{ tier: 'owner', count: 1 }],
      [{ tier: 'owner', count: 2 }],
      [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }],
      [{ tier: 'owner', count: 1 }, { tier: 'manager', count: 3 }],
      [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 2 }, { tier: 'readonly', count: 4 }],
    ] as any[]
    for (const plan of shapes) {
      expect(priceBillingLinesCents(planBillingLines(plan), unitCents)).toBe(
        priceSeatPlanCents(plan, DEFAULT_TIER_PRICES),
      )
    }
  })

  it('prices Fort Lauderdale at $1,350 — $550 owner + $400 co-owner + $400 manager', () => {
    expect(priceSeatPlanCents(FTL_SELECTION as any, DEFAULT_TIER_PRICES)).toBe(135000)
  })
})

describe('issue 212 — seat rows to create beyond activation own owner seat', () => {
  it('owner-only adds nothing — activation already made that seat', () => {
    expect(planAddOnRows([{ tier: 'owner', count: 1 }])).toEqual([])
  })

  it('Fort Lauderdale adds a co-owner row and a manager row', () => {
    expect(planAddOnRows(FTL_SELECTION as any)).toEqual([
      { tier: 'owner', billingTier: 'manager' },
      { tier: 'manager', billingTier: 'manager' },
    ])
  })
})

describe('issue 212 — seat plan survives the round trip through Stripe metadata', () => {
  it('encodes and decodes losslessly', () => {
    const encoded = encodeSeatPlan(FTL_SELECTION as any)
    expect(encoded).toBe('owner:2,manager:1')
    expect(decodeSeatPlan(encoded)).toEqual(FTL_SELECTION)
  })

  it('a corrupted or over-cap metadata value decodes to null — never mints seats', () => {
    expect(decodeSeatPlan('owner:9')).toBeNull()        // over the 2-owner cap
    expect(decodeSeatPlan('manager:2')).toBeNull()      // no owner seat
    expect(decodeSeatPlan('nonsense')).toBeNull()
    expect(decodeSeatPlan('owner:abc')).toBeNull()
    expect(decodeSeatPlan('')).toBeNull()
    expect(decodeSeatPlan(undefined)).toBeNull()
  })
})

// ── The checkout route ────────────────────────────────────────
describe('issue 212 — checkout bills every selected seat', () => {
  it('Fort Lauderdale: 2 owners + 1 manager mints owner×1 + manager×2 and quotes $1,350', async () => {
    const res = await post({ seats: FTL_SELECTION })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.url).toBe('https://checkout.stripe.com/c/cs_212')

    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    // The whole selection is billed — this is the assertion that would have
    // caught the production bug: before issue 212 this was [owner × 1].
    expect(params.line_items).toEqual([
      { price: 'price_owner', quantity: 1 },
      { price: 'price_mgr', quantity: 2 },
    ])
    // …with the second owner on the MANAGER price, matching the confirm step's
    // "co-owner … billed at Hive Manager rate" line.
    expect(json.lines).toEqual([
      { tier: 'owner', quantity: 1, unit_price_annual: 550 },
      { tier: 'manager', quantity: 2, unit_price_annual: 400 },
    ])
    expect(json.quoted_total_cents).toBe(135000)
  })

  // The brief's headline requirement, asserted directly against the mocked
  // Stripe catalog rather than against our own arithmetic.
  it('the quoted total equals what Stripe will actually charge for the session lines', async () => {
    const res = await post({ seats: FTL_SELECTION })
    const json = await res.json()
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any

    const stripeUnit: Record<string, number> = { price_owner: 55000, price_mgr: 40000, price_ro: 5000 }
    const stripeTotal = params.line_items.reduce(
      (sum: number, li: any) => sum + stripeUnit[li.price] * li.quantity, 0,
    )
    expect(json.quoted_total_cents).toBe(stripeTotal)
    expect(stripeTotal).toBe(135000)
  })

  it('stamps the plan on the session AND the subscription so the webhook can seat it', async () => {
    const res = await post({ seats: FTL_SELECTION })
    const json = await res.json()
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.metadata).toMatchObject({ tier: 'owner', location_id: 'loc-ftl-uuid', seat_plan: 'owner:2,manager:1' })
    expect(params.subscription_data.metadata).toMatchObject({ seat_plan: 'owner:2,manager:1' })
    expect(json.seat_plan).toBe('owner:2,manager:1')
  })

  it('a mixed plan with a free tier bills only the priced lines', async () => {
    const res = await post({ seats: [{ tier: 'owner', count: 1 }, { tier: 'readonly', count: 2 }] })
    const json = await res.json()
    expect(res.status).toBe(200)
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.line_items).toEqual([
      { price: 'price_owner', quantity: 1 },
      { price: 'price_ro', quantity: 2 },
    ])
    expect(json.quoted_total_cents).toBe(55000 + 2 * 5000)
  })

  // ── The regression guard: owner-only is untouched ───────────
  it('owner-only checkout is exactly what it was before issue 212 — one line, $550', async () => {
    const res = await post({ seats: [{ tier: 'owner', count: 1 }] })
    const json = await res.json()
    expect(res.status).toBe(200)
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.line_items).toEqual([{ price: 'price_owner', quantity: 1 }])
    expect(params.subscription_data.billing_cycle_anchor).toBeUndefined()
    expect(params.subscription_data.proration_behavior).toBeUndefined()
    expect(json.quoted_total_cents).toBe(55000)
  })

  it('an empty body (a client that never sends seats) still mints the single owner line', async () => {
    const res = await post({})
    const json = await res.json()
    expect(res.status).toBe(200)
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as any
    expect(params.line_items).toEqual([{ price: 'price_owner', quantity: 1 }])
    expect(json.quoted_total_cents).toBe(55000)
  })
})

// ── Guards: never charge a number the owner was not shown ─────
describe('issue 212 — checkout guards fail closed', () => {
  it('a 3-owner selection is refused (409), no Stripe session', async () => {
    const res = await post({ seats: [{ tier: 'owner', count: 3 }] })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('max_owners_reached')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a malformed selection is refused (400), no Stripe session', async () => {
    const res = await post({ seats: [{ tier: 'wizard', count: 1 }] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('seat_plan_invalid_tier')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a paid tier with no Stripe price fails closed rather than under-billing', async () => {
    db.tier_prices = [
      { id: 'owner', price_annual: 550, stripe_price_id: 'price_owner' },
      { id: 'manager', price_annual: 400, stripe_price_id: null },
    ]
    const res = await post({ seats: FTL_SELECTION })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('seat_tier_not_priced')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  // The guarantee that the quote IS the charge, rather than merely agreeing
  // with it by convention: a price edited on one side only is refused.
  it('a Stripe price that disagrees with Admin > Pricing is refused (409), no session', async () => {
    stripe.prices.retrieve.mockImplementation(async (id: string) => ({
      id, unit_amount: id === 'price_mgr' ? 45000 : 55000, // manager drifted to $450
    }))
    const res = await post({ seats: FTL_SELECTION })
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).toBe('price_mismatch')
    expect(json).toMatchObject({ tier: 'manager', stripe_unit_amount_cents: 45000, tier_prices_unit_amount_cents: 40000 })
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  // ── The DO-NOT-BREAK set ───────────────────────────────────
  it('issue 171 — a prepaid-through-future location never reaches Stripe', async () => {
    loc.value = LOC({ paid_through_date: '2027-02-27' })
    const res = await post({ seats: FTL_SELECTION })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('prepaid_through_future')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a non-paying payment_source skips Stripe entirely', async () => {
    loc.value = LOC({ payment_source: 'corporate_sponsored' })
    const res = await post({ seats: FTL_SELECTION })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('non_paying_source')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('an already-active location is refused', async () => {
    loc.value = LOC({ subscription_status: 'active' })
    const res = await post({ seats: FTL_SELECTION })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('already_active')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('issue 167 — Stripe unconfigured stays classifiable as unconfigured, not a silent charge', async () => {
    cfg.configured = false
    const res = await post({ seats: FTL_SELECTION })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('stripe_not_configured')
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a stranger cannot mint a session for someone else location', async () => {
    auth.hubUser = { role: 'owner', location_id: 'someone-else', email: 'x@y.test' }
    const res = await post({ seats: FTL_SELECTION })
    expect(res.status).toBe(403)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })
})
