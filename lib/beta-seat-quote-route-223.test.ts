// @vitest-environment node
//
// issue 223 — WHERE THE CONFIRM SCREEN'S FIGURE COMES FROM.
//
// The modals could not keep promising "no card will be charged" and they
// could not compute the truth themselves either — issue 217 moved seat
// pricing to the server precisely so the browser would stop doing money
// math, and issue 216 is what happens when it does. So the confirm step asks:
// GET /api/seats/quote.
//
// The one property that matters here is that the quote is not a SECOND
// OPINION. A preview that reasons independently about what will be charged
// is just a new way for the screen and the server to disagree, which is the
// bug rather than the fix. So these pin:
//
//   A) the route's figure IS quoteSeatPurchase's figure — the same function
//      /api/seats POST writes to the row and charges from
//   B) the route's verdict matches what the charging path actually does,
//      reason for reason, across every skip case
//   C) it writes nothing and calls Stripe not at all
//   D) it is gated as a billing read
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    inserts: [] as { table: string; arg: any }[],
    updates: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.inserts = []; state.updates = [] }
  const enqueue = (table: string, data: any, extra: Partial<Resp> = {}) =>
    state.queue.push({ table, resp: { data, error: null, ...extra } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'like', 'order', 'limit']) {
      b[m] = () => b
    }
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.delete = () => b
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'own1' } as any }))
const stripeOn = vi.hoisted(() => ({ current: true }))
const adjust = vi.hoisted(() => ({
  fn: vi.fn(async () => ({ quantity: 1, itemId: 'si_1', created: true, removed: false })),
}))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => stripeOn.current }))
vi.mock('@/lib/stripe-billing', () => ({ adjustSubscriptionSeatQuantity: adjust.fn }))

import { GET as QUOTE_GET } from '@/app/api/seats/quote/route'
import { quoteSeatPurchase } from '@/lib/seat-cost'
import { previewSeatPurchaseBilling, applySeatPurchaseToStripe } from '@/lib/seat-stripe-sync'
import { seatChargeNotice } from '@/lib/seat-charge-notice'

const LOC = 'loc-uuid'
const ANCHOR = '2027-02-27'
const OWNER_CALLER = { id: 'own1', role: 'owner', location_id: LOC }

const TIER_ROWS = [
  { id: 'owner', price_annual: 550 },
  { id: 'manager', price_annual: 400 },
  { id: 'light', price_annual: 0 },
  { id: 'readonly', price_annual: 0 },
]

const LOCATION_BILLING = (over: any = {}) => ({
  id: LOC, name: 'Test Territory', location_id: 'test-territory',
  subscription_status: 'active', payment_source: 'direct', paid_through_date: ANCHOR,
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', ...over,
})

const quoteCall = (qs: string) => {
  const url = new URL(`http://test/api/seats/quote?${qs}`)
  const req = new Request(url) as any
  Object.defineProperty(req, 'nextUrl', { value: url })
  return QUOTE_GET(req)
}

// The reads one quote + preview makes, in order: hub_users (auth), locations
// + tier_prices (quoteSeatPurchase), then per line locations + tier_prices
// (resolveSeatBillingGate).
function seedQuote(opts: { billing?: any; priceRow?: any; lines?: number } = {}) {
  const lines = opts.lines ?? 1
  h.enqueue('hub_users', OWNER_CALLER)
  h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
  h.enqueue('tier_prices', TIER_ROWS)
  for (let i = 0; i < lines; i++) {
    h.enqueue('locations', opts.billing === null ? null : LOCATION_BILLING(opts.billing || {}))
    h.enqueue('tier_prices', opts.priceRow === undefined
      ? { id: 'manager', price_annual: 400, stripe_price_id: 'price_manager' }
      : opts.priceRow)
  }
}

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'own1' }
  stripeOn.current = true
  adjust.fn.mockClear()
})

// ── A) the route's figure is the server's figure ──────────────────────
describe('issue 223 — the quote route reports what the server prices', () => {
  it('returns quoteSeatPurchase\'s total, to the cent', async () => {
    // The figure the WRITE path would record for this same purchase.
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueue('tier_prices', TIER_ROWS)
    const truth = await quoteSeatPurchase({ locationId: LOC, tier: 'manager', quantity: 1 })

    seedQuote()
    const res = await quoteCall(`location_id=${LOC}&tier=manager&quantity=1`)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.cost.total_cents).toBe(truth.totalCents)
    expect(json.cost.source).toBe('server')
    expect(json.cost.renewal_date).toBe(ANCHOR)
  })

  it('scales with quantity the way the write path does', async () => {
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueue('tier_prices', TIER_ROWS)
    const truth = await quoteSeatPurchase({ locationId: LOC, tier: 'manager', quantity: 3 })

    seedQuote()
    const json = await (await quoteCall(`location_id=${LOC}&tier=manager&quantity=3`)).json()
    expect(json.cost.total_cents).toBe(truth.totalCents)
    expect(json.cost.per_seat_cents).toHaveLength(3)
  })

  it('a location with no renewal anchor reports no figure rather than inventing one', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueue('locations', { id: LOC, paid_through_date: null })
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('locations', LOCATION_BILLING({ paid_through_date: null }))
    h.enqueue('tier_prices', { id: 'manager', price_annual: 400, stripe_price_id: 'price_manager' })

    const json = await (await quoteCall(`location_id=${LOC}&tier=manager`)).json()
    expect(json.cost.total_cents).toBeNull()
    expect(json.cost.unpriced_reason).toBe('no_renewal_anchor')
    // ...and is still charged, because Stripe bills against the real period.
    expect(json.billing.will_charge).toBe(true)
  })
})

// ── B) the verdict matches what actually happens ──────────────────────
describe('issue 223 — the preview and the charge agree, reason for reason', () => {
  const CASES: Array<{ label: string; billing?: any; priceRow?: any; stripe?: boolean; reason: string | null }> = [
    { label: 'a normal paying location', reason: null },
    { label: 'no Stripe subscription', billing: { stripe_subscription_id: null }, reason: 'no_subscription' },
    { label: 'a corporate source', billing: { payment_source: 'prepaid_corporate' }, reason: 'non_paying' },
    { label: 'a sponsored source', billing: { payment_source: 'corporate_sponsored' }, reason: 'non_paying' },
    { label: 'the tier has no Stripe price', priceRow: { id: 'manager', price_annual: 400, stripe_price_id: null }, reason: 'no_price' },
    { label: 'Stripe not configured', stripe: false, reason: 'stripe_unconfigured' },
  ]

  for (const c of CASES) {
    it(`${c.label}: preview says ${c.reason ?? 'it will charge'}, and so does the real walk`, async () => {
      const lines = [{ billingTier: 'manager', quantity: 1, annualUnitCents: 40000 }]

      // What the PREVIEW predicts.
      stripeOn.current = c.stripe ?? true
      h.enqueue('locations', c.billing === null ? null : LOCATION_BILLING(c.billing || {}))
      h.enqueue('tier_prices', c.priceRow ?? { id: 'manager', price_annual: 400, stripe_price_id: 'price_manager' })
      const preview = await previewSeatPurchaseBilling({ locationId: LOC, lines })

      // What the CHARGING path actually does with the same inputs.
      h.enqueue('locations', c.billing === null ? null : LOCATION_BILLING(c.billing || {}))
      h.enqueue('tier_prices', c.priceRow ?? { id: 'manager', price_annual: 400, stripe_price_id: 'price_manager' })
      const actual = await applySeatPurchaseToStripe({ locationId: LOC, lines, seatIds: ['seat1'] })

      expect(preview.willCharge).toBe(actual.applied)
      expect(preview.reason).toBe(c.reason)
      expect(actual.lines[0].reason ?? null).toBe(c.reason)
    })
  }

  it('a $0 tier is predicted free and really does skip Stripe', async () => {
    const lines = [{ billingTier: 'readonly', quantity: 1, annualUnitCents: 0 }]

    const preview = await previewSeatPurchaseBilling({ locationId: LOC, lines })
    const actual = await applySeatPurchaseToStripe({ locationId: LOC, lines, seatIds: ['seat1'] })

    expect(preview.willCharge).toBe(false)
    expect(preview.reason).toBe('zero_rate')
    expect(actual.lines[0].reason).toBe('zero_rate')
    // Predicted without touching Stripe, and charged without touching it too.
    expect(adjust.fn).not.toHaveBeenCalled()
  })
})

// ── C) the quote is read-only ─────────────────────────────────────────
describe('issue 223 — quoting writes nothing and charges nothing', () => {
  it('inserts no rows, updates no rows, calls Stripe zero times', async () => {
    seedQuote()
    const res = await quoteCall(`location_id=${LOC}&tier=manager&quantity=2`)
    expect(res.status).toBe(200)
    expect(h.state.inserts).toEqual([])
    expect(h.state.updates).toEqual([])
    expect(adjust.fn).not.toHaveBeenCalled()
  })
})

// ── D) it is gated as a billing read ──────────────────────────────────
describe('issue 223 — quote route access', () => {
  it('401s when signed out', async () => {
    authUser.current = null
    expect((await quoteCall(`location_id=${LOC}&tier=manager`)).status).toBe(401)
  })

  it('403s for an owner of a DIFFERENT location', async () => {
    h.enqueue('hub_users', { id: 'own2', role: 'owner', location_id: 'other-loc' })
    expect((await quoteCall(`location_id=${LOC}&tier=manager`)).status).toBe(403)
  })

  it('403s for a non-owner member of the location', async () => {
    h.enqueue('hub_users', { id: 'm1', role: 'manager', location_id: LOC })
    expect((await quoteCall(`location_id=${LOC}&tier=manager`)).status).toBe(403)
  })

  it('allows super_admin against any location', async () => {
    h.enqueue('hub_users', { id: 'sa', role: 'super_admin', location_id: null })
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', { id: 'manager', price_annual: 400, stripe_price_id: 'price_manager' })
    expect((await quoteCall(`location_id=${LOC}&tier=manager`)).status).toBe(200)
  })

  it('400s on a missing or unknown tier', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    expect((await quoteCall(`location_id=${LOC}`)).status).toBe(400)
    h.enqueue('hub_users', OWNER_CALLER)
    expect((await quoteCall(`location_id=${LOC}&tier=platinum`)).status).toBe(400)
  })

  it('400s on a nonsense quantity', async () => {
    for (const q of ['0', '-2', '2.5', '999']) {
      h.enqueue('hub_users', OWNER_CALLER)
      expect((await quoteCall(`location_id=${LOC}&tier=manager&quantity=${q}`)).status).toBe(400)
    }
  })
})

// ── the whole point, end to end ───────────────────────────────────────
describe('issue 223 — what the owner ends up reading', () => {
  it('a paying location is told the real figure, not that it is free', async () => {
    seedQuote()
    const json = await (await quoteCall(`location_id=${LOC}&tier=manager`)).json()
    const n = seatChargeNotice({
      quote: { totalCents: json.cost.total_cents, renewalDate: json.cost.renewal_date },
      preview: { willCharge: json.billing.will_charge, reason: json.billing.reason },
      seatWord: 'Hive Manager seat',
    })
    expect(n.kind).toBe('charge')
    expect(n.heading).toContain('$')
    expect(n.body).not.toMatch(/no card will be charged/i)
    // The figure on screen is the figure the server quoted.
    const shown = Number(n.heading.replace(/[^0-9.]/g, '')) * 100
    expect(Math.round(shown)).toBe(json.cost.total_cents)
  })

  it('a location with no subscription is told it will be invoiced, not that it is free', async () => {
    seedQuote({ billing: { stripe_subscription_id: null } })
    const json = await (await quoteCall(`location_id=${LOC}&tier=manager`)).json()
    expect(json.billing.will_charge).toBe(false)
    expect(json.billing.reason).toBe('no_subscription')
    // The cost is still recorded — money IS owed here.
    expect(json.cost.total_cents).toBeGreaterThan(0)

    const n = seatChargeNotice({
      quote: { totalCents: json.cost.total_cents, renewalDate: json.cost.renewal_date },
      preview: { willCharge: json.billing.will_charge, reason: json.billing.reason },
      seatWord: 'Hive Manager seat',
    })
    expect(n.kind).toBe('invoiced')
    expect(n.body).toMatch(/send you an invoice/i)
    expect(n.body).not.toMatch(/\bfree\b/i)
  })

  it('a $0 tier is told it is free', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueue('tier_prices', TIER_ROWS)
    const json = await (await quoteCall(`location_id=${LOC}&tier=readonly`)).json()

    expect(json.cost.total_cents).toBe(0)
    expect(json.billing.will_charge).toBe(false)
    expect(json.billing.reason).toBe('zero_rate')

    const n = seatChargeNotice({
      quote: { totalCents: json.cost.total_cents, renewalDate: json.cost.renewal_date },
      preview: { willCharge: json.billing.will_charge, reason: json.billing.reason },
      seatWord: 'Honey Watcher seat',
    })
    expect(n.kind).toBe('free_tier')
    expect(n.body).toMatch(/at no cost/i)
  })
})
