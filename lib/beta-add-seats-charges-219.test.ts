// @vitest-environment node
//
// issue 219 — "+ ADD SEATS" CHARGES WHAT THE SEAT COSTS.
//
// THE BUG THESE PIN: two buttons added a seat and only one charged.
// /api/seats POST inserted a subscription_seats row and never called Stripe;
// /api/seats/buy-and-invite charged for the identical seat. Which button an
// owner clicked decided whether the seat was free. issue 217 then made the
// free button record an ACCURATE prorated cost, which is worse than the
// original bug — the ledger asserted money was owed and none moved.
//
// Kevin's rule: the TIER decides whether a seat is free, not the ROUTE. So:
//
//   1. A paid seat bumps the subscription and the figure Stripe is bumped by
//      is the figure the row recorded — same tier, same quantity, one source.
//   2. A $0 tier (prod prices light and readonly at 0) records 0 and mints NO
//      Stripe call at all. Keyed on the ANNUAL RATE, not on the prorated
//      figure, so a paid seat added on the renewal date still bumps.
//   3. A location with no Stripe subscription still gets its seat, still
//      records the cost, and says ON THE ROW that nothing was charged.
//   4. issue 217's no-anchor rule survives: no paid_through_date still records
//      nothing. Charging does not reintroduce a guess.
//   5. Admin → Grant Seat is a different route entirely and still comps.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Recording supabase mock — same shape as beta-server-seat-cost-217.test.ts,
// extended with captured UPDATE payloads so the post-charge billing note is
// observable.
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
  const enqueueCount = (table: string, count: number) =>
    state.queue.push({ table, resp: { data: null, error: null, count } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
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
  return { state, reset, enqueue, enqueueCount, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'own1' } as any }))

// The Stripe seam. adjustSubscriptionSeatQuantity is the LAST thing before the
// Stripe SDK, so asserting on it is asserting on what Stripe is actually told.
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
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => true }))
vi.mock('@/lib/stripe-billing', () => ({ adjustSubscriptionSeatQuantity: adjust.fn }))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: vi.fn(async () => ({ success: true })) }))

import { POST as SEATS_POST } from '@/app/api/seats/route'
import { POST as BUY_POST } from '@/app/api/seats/buy-and-invite/route'
import { applySeatPurchaseToStripe, SEAT_BILLING_MISMATCH_MARKER } from '@/lib/seat-stripe-sync'
import { quoteSeatPurchase } from '@/lib/seat-cost'
import { prorateToRenewal, parsePaidThroughDate } from '@/lib/subscription-math'

const TODAY = new Date('2026-08-14T00:00:00Z')
const LOC = 'loc-uuid'
const ANCHOR = '2027-02-27'
const OWNER_CALLER = { id: 'own1', role: 'owner', location_id: LOC }

// The live prod catalog: owner $550, manager $400, light/readonly genuinely $0.
const TIER_ROWS = [
  { id: 'owner', price_annual: 550 },
  { id: 'manager', price_annual: 400 },
  { id: 'light', price_annual: 0 },
  { id: 'readonly', price_annual: 0 },
]

// The tier_prices row applySeatDeltaToStripe reads for its Stripe price id.
const PRICE_ROW = (id: string, price_annual: number, stripe_price_id: string | null = `price_${id}`) =>
  ({ id, price_annual, stripe_price_id })

const LOCATION_BILLING = (over: any = {}) => ({
  id: LOC, name: 'Test Territory', location_id: 'test-territory',
  subscription_status: 'active', payment_source: 'direct', paid_through_date: ANCHOR,
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', ...over,
})

const centsFor = (annual: number, paidThrough: string = ANCHOR) =>
  Math.round(prorateToRenewal(annual, parsePaidThroughDate(paidThrough)!, TODAY) * 100)

const seatsCall = (body: any) =>
  SEATS_POST(new Request('http://test/api/seats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any)

const buyCall = (body: any) => {
  const req = new Request('http://test/api/seats/buy-and-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  Object.defineProperty(req, 'nextUrl', { value: new URL('http://test/api/seats/buy-and-invite') })
  return BUY_POST(req as any)
}

const seatRows = (): any[] => {
  const ins = h.state.inserts.find(i => i.table === 'subscription_seats')
  if (!ins) return []
  return Array.isArray(ins.arg) ? ins.arg : [ins.arg]
}
const seatNoteUpdates = () =>
  h.state.updates.filter(u => u.table === 'subscription_seats' && typeof u.arg?.notes === 'string')

// The reads a non-owner-tier /api/seats POST makes, in table order:
//   hub_users (caller) → locations (anchor) → tier_prices (rates)
//   → subscription_seats (insert)
//   → locations (getLocationBilling) → tier_prices (stripe_price_id)
function queueSeatsPost(opts: {
  paidThrough?: string | null
  tier?: string
  annual?: number
  stripePriceId?: string | null
  location?: any
  insertResult?: any
  seatCount?: number
}) {
  const tier = opts.tier ?? 'manager'
  const n = opts.seatCount ?? 1
  h.enqueue('hub_users', OWNER_CALLER)
  h.enqueue('locations', { id: LOC, paid_through_date: opts.paidThrough === undefined ? ANCHOR : opts.paidThrough })
  h.enqueue('tier_prices', TIER_ROWS)
  h.enqueue('subscription_seats', opts.insertResult ?? Array.from({ length: n }, (_, i) => ({ id: `seat${i + 1}`, location_id: LOC, tier })))
  h.enqueue('locations', opts.location === undefined ? LOCATION_BILLING() : opts.location)
  h.enqueue('tier_prices', PRICE_ROW(tier, opts.annual ?? 400, opts.stripePriceId === undefined ? `price_${tier}` : opts.stripePriceId))
}

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'own1' }
  adjust.fn.mockClear()
  adjust.fn.mockResolvedValue({ quantity: 1, itemId: 'si_1', created: true, removed: false })
  vi.useFakeTimers()
  vi.setSystemTime(TODAY)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════
// 1. A paid seat bumps the subscription — and charges what it records
// ══════════════════════════════════════════════════════════════
describe('issue 219 — "+ Add seats" now reaches Stripe at all', () => {
  it('a manager seat bumps the EXISTING subscription by +1 on the manager price', async () => {
    queueSeatsPost({ tier: 'manager' })

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(res.status).toBe(201)

    // The whole bug: this used to be zero calls.
    expect(adjust.fn).toHaveBeenCalledTimes(1)
    const arg = adjust.fn.mock.calls[0][0] as any
    expect(arg.subscriptionId).toBe('sub_1') // the same subscription, not a new one
    expect(arg.priceId).toBe('price_manager')
    expect(arg.delta).toBe(1)
    // Anchored on the seat row, so a retry of the SAME seat replays.
    expect(arg.idempotencyKey).toContain('seat1')
    expect(arg.idempotencyKey).toContain('add')
  })

  it('the response reports the charge per seat instead of leaving it implied', async () => {
    queueSeatsPost({ tier: 'manager' })
    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    const json = await res.json()
    expect(json.billing.stripe_applied).toBe(true)
    expect(json.billing.stripe_skip_reason).toBeUndefined()
  })

  it('quantity 3 is ONE bump of +3, not three seats billed once', async () => {
    queueSeatsPost({ tier: 'manager', seatCount: 3 })

    await seatsCall({ location_id: LOC, tier: 'manager', quantity: 3 })

    expect(adjust.fn).toHaveBeenCalledTimes(1)
    expect((adjust.fn.mock.calls[0][0] as any).delta).toBe(3)
    // …and every row carries the same per-seat figure, so charged total and
    // recorded total are both 3 × the manager rate.
    const costs = seatRows().map(r => r.prorated_cost)
    expect(costs).toEqual([centsFor(400), centsFor(400), centsFor(400)])
  })

  it('CHARGED AND RECORDED ARE ONE LIST: the bumped tier+quantity is the priced tier+quantity', async () => {
    queueSeatsPost({ tier: 'manager', seatCount: 2 })
    await seatsCall({ location_id: LOC, tier: 'manager', quantity: 2 })

    const arg = adjust.fn.mock.calls[0][0] as any
    const rows = seatRows()
    // Stripe was bumped by exactly as many seats as were priced…
    expect(arg.delta).toBe(rows.length)
    // …on the price of exactly the tier those rows were priced at.
    expect(arg.priceId).toBe('price_manager')
    expect(rows.every(r => r.prorated_cost === centsFor(400))).toBe(true)
  })

  it('the quote hands out ONE line list — billingLines and the priced lines cannot disagree', async () => {
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueue('tier_prices', TIER_ROWS)

    const quote = await quoteSeatPurchase({ locationId: LOC, tier: 'manager', quantity: 2, from: TODAY })

    expect(quote.billingLines).toEqual([
      { billingTier: 'manager', quantity: 2, annualUnitCents: 40000 },
    ])
    // The priced view of the same list: same tier, same quantity.
    expect(quote.lines.map(l => ({ billingTier: l.billingTier, quantity: l.quantity }))).toEqual(
      quote.billingLines.map(l => ({ billingTier: l.billingTier, quantity: l.quantity })),
    )
    expect(quote.perSeatCents).toEqual([centsFor(400), centsFor(400)])
  })

  it('a Stripe failure does NOT cost the owner the seat — 201, and the row says so', async () => {
    queueSeatsPost({ tier: 'manager' })
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager', notes: null }])
    adjust.fn.mockRejectedValueOnce(new Error('card_declined'))

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.billing.stripe_applied).toBe(false)
    expect(json.billing.stripe_skip_reason).toBe('stripe_error')
    // The recorded figure is now a debt nobody billed, and the row says so.
    const note = seatNoteUpdates()[0]?.arg?.notes as string
    expect(note).toContain(SEAT_BILLING_MISMATCH_MARKER)
    expect(note).toContain('NOT charged')
    expect(note).toContain('card_declined')
  })
})

// ══════════════════════════════════════════════════════════════
// 2. A $0 tier records 0 and mints no Stripe call
// ══════════════════════════════════════════════════════════════
describe('issue 219 — a $0 tier is free because the TIER prices it at 0', () => {
  for (const tier of ['readonly', 'light']) {
    it(`${tier} (price_annual 0) records 0 and never touches Stripe`, async () => {
      queueSeatsPost({ tier, annual: 0 })

      const res = await seatsCall({ location_id: LOC, tier })
      expect(res.status).toBe(201)

      expect(seatRows()[0].prorated_cost).toBe(0) // genuinely free, not unknown
      expect(adjust.fn).not.toHaveBeenCalled()    // and no pointless Stripe op

      const json = await res.json()
      expect(json.billing.stripe_applied).toBe(false)
      expect(json.billing.stripe_skip_reason).toBe('zero_rate')
    })
  }

  it('a $0 tier leaves NO mismatch note — nothing was owed, so nothing is missing', async () => {
    queueSeatsPost({ tier: 'readonly', annual: 0 })
    await seatsCall({ location_id: LOC, tier: 'readonly' })
    expect(seatNoteUpdates()).toHaveLength(0)
  })

  it('the skip keys on the ANNUAL RATE, not the prorated figure — a paid seat added ON the renewal date still bumps', async () => {
    // days-to-renewal = 0, so the prorated figure is $0 for a $400/yr seat.
    queueSeatsPost({ paidThrough: '2026-08-14', tier: 'manager' })

    await seatsCall({ location_id: LOC, tier: 'manager' })

    expect(seatRows()[0].prorated_cost).toBe(0) // nothing owed for the remaining term…
    expect(adjust.fn).toHaveBeenCalledTimes(1)  // …but the seat must renew NEXT year
    expect((adjust.fn.mock.calls[0][0] as any).delta).toBe(1)
  })

  it('an UNKNOWN rate is not a free rate — a tier with no tier_prices row still goes to Stripe (and is refused there)', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueue('tier_prices', [{ id: 'owner', price_annual: 550 }]) // manager row missing
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager' }])
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', null) // no row → applySeatDeltaToStripe skips as no_price

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    const json = await res.json()

    expect(seatRows()[0]).not.toHaveProperty('prorated_cost') // unpriced, not free
    expect(json.billing.stripe_skip_reason).toBe('no_price')  // reads as broken, not free
  })

  it('applySeatPurchaseToStripe itself: a 0-rate line short-circuits before any Stripe work', async () => {
    const out = await applySeatPurchaseToStripe({
      locationId: LOC,
      lines: [{ billingTier: 'readonly', quantity: 2, annualUnitCents: 0 }],
      seatIds: ['s1', 's2'],
    })
    expect(adjust.fn).not.toHaveBeenCalled()
    expect(out.lines[0].reason).toBe('zero_rate')
    // Nothing was owed, so nothing is unbilled and the purchase is "applied".
    expect(out.unbilledSeatIds).toEqual([])
    expect(out.applied).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════
// 3. A location with NO Stripe subscription — 32 of 55 today
// ══════════════════════════════════════════════════════════════
describe('issue 219 — no subscription: the seat is created, the cost is recorded, the gap is flagged', () => {
  it('does not fail the request', async () => {
    queueSeatsPost({ tier: 'manager', location: LOCATION_BILLING({ stripe_subscription_id: null }) })
    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(res.status).toBe(201)
    expect(adjust.fn).not.toHaveBeenCalled()
  })

  it('still records what the seat costs — the debt is real even when nobody billed it', async () => {
    queueSeatsPost({ tier: 'manager', location: LOCATION_BILLING({ stripe_subscription_id: null }) })
    await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(seatRows()[0].prorated_cost).toBe(centsFor(400))
  })

  it('does NOT claim a charge that did not happen — the row and the response both say so', async () => {
    queueSeatsPost({ tier: 'manager', location: LOCATION_BILLING({ stripe_subscription_id: null }) })
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager' }])

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    const json = await res.json()

    expect(json.billing.stripe_applied).toBe(false)
    expect(json.billing.stripe_skip_reason).toBe('no_subscription')

    const note = seatNoteUpdates()[0]?.arg?.notes as string
    expect(note).toContain(SEAT_BILLING_MISMATCH_MARKER)
    expect(note).toContain('cost recorded but NOT charged')
    expect(note).toContain('no Stripe subscription')
  })

  it('a corporate/prepaid location is skipped as non_paying, not as a failure', async () => {
    queueSeatsPost({ tier: 'manager', location: LOCATION_BILLING({ payment_source: 'prepaid_corporate' }) })
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager' }])

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(res.status).toBe(201)
    expect(adjust.fn).not.toHaveBeenCalled()
    expect((await res.json()).billing.stripe_skip_reason).toBe('non_paying')
  })

  it('the mismatch note preserves the notes the request already carried', async () => {
    queueSeatsPost({ tier: 'manager', location: LOCATION_BILLING({ stripe_subscription_id: null }) })
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager' }])

    await seatsCall({ location_id: LOC, tier: 'manager', notes: 'seat for Dana' })

    const note = seatNoteUpdates()[0]?.arg?.notes as string
    expect(note).toContain('seat for Dana')
    expect(note).toContain(SEAT_BILLING_MISMATCH_MARKER)
  })
})

// ══════════════════════════════════════════════════════════════
// 4. issue 217's no-anchor rule survives — charging is not a guess
// ══════════════════════════════════════════════════════════════
describe('issue 219 — charging does not reintroduce a guessed figure', () => {
  it('no paid_through_date still records NOTHING', async () => {
    queueSeatsPost({ paidThrough: null, tier: 'manager' })
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager' }])

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(res.status).toBe(201)
    expect(seatRows()[0]).not.toHaveProperty('prorated_cost')
  })

  it('but the seat is still billed — Stripe prorates against the real subscription period, which is not a guess', async () => {
    queueSeatsPost({ paidThrough: null, tier: 'manager' })
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager' }])

    await seatsCall({ location_id: LOC, tier: 'manager' })

    expect(adjust.fn).toHaveBeenCalledTimes(1)
    expect((adjust.fn.mock.calls[0][0] as any).delta).toBe(1)
  })

  it('and the row says money moved without a recorded figure — the mirror-image mismatch', async () => {
    queueSeatsPost({ paidThrough: null, tier: 'manager' })
    h.enqueue('subscription_seats', [{ id: 'seat1', location_id: LOC, tier: 'manager' }])

    await seatsCall({ location_id: LOC, tier: 'manager' })

    const note = seatNoteUpdates()[0]?.arg?.notes as string
    expect(note).toContain(SEAT_BILLING_MISMATCH_MARKER)
    expect(note).toContain('no cost figure was recorded')
    expect(note).toContain('no paid_through_date')
    // issue 217's own explanation is still on the row alongside it.
    expect(note).toContain('issue 217')
  })

  it('an unpriced quote still knows WHAT was bought — that is what keeps the charge alive', async () => {
    h.enqueue('locations', { id: LOC, paid_through_date: null })
    h.enqueue('tier_prices', TIER_ROWS)

    const quote = await quoteSeatPurchase({ locationId: LOC, tier: 'manager', quantity: 2, from: TODAY })

    expect(quote.perSeatCents).toBeNull()          // issue 217: no figure…
    expect(quote.unpricedReason).toBe('no_renewal_anchor')
    expect(quote.billingLines).toEqual([           // …but the lines survive
      { billingTier: 'manager', quantity: 2, annualUnitCents: 40000 },
    ])
  })

  it('a $0 tier with no anchor is STILL free — the rate is known even when the anchor is not', async () => {
    queueSeatsPost({ paidThrough: null, tier: 'readonly', annual: 0 })
    await seatsCall({ location_id: LOC, tier: 'readonly' })
    expect(adjust.fn).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════
// 5. The co-owner rate — and why issue 221 does not go live here
// ══════════════════════════════════════════════════════════════
describe('issue 219 — an owner-tier add bumps the tier it RECORDS, not the tier of the seat', () => {
  it('a 2nd owner seat charges the MANAGER price, matching the manager rate issue 217 records', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueueCount('subscription_seats', 1) // route owner-cap check: 1 existing owner
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueueCount('subscription_seats', 1) // quote: the same 1 existing owner
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', [{ id: 'seat2', location_id: LOC, tier: 'owner' }])
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', PRICE_ROW('manager', 400, 'price_manager'))

    const res = await seatsCall({ location_id: LOC, tier: 'owner' })
    expect(res.status).toBe(201)

    const recorded = seatRows()[0].prorated_cost
    expect(recorded).toBe(centsFor(400)) // issue 217: the manager rate

    // issue 221 is the divergence where the SEAT tier reaches Stripe and the
    // BILLING tier reaches the ledger. It does not go live on this route: the
    // bump rides the quote's billing line, so Stripe is told 'manager' too.
    const arg = adjust.fn.mock.calls[0][0] as any
    expect(arg.priceId).toBe('price_manager')
    expect(arg.priceId).not.toBe('price_owner') // the $550 line issue 221 would have hit
  })

  it('buying BOTH owner seats at once splits into two lines — one owner-rate, one manager-rate', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueueCount('subscription_seats', 0) // cap check
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueueCount('subscription_seats', 0) // quote
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', [{ id: 's1', location_id: LOC, tier: 'owner' }, { id: 's2', location_id: LOC, tier: 'owner' }])
    // Two Stripe lines → two getLocationBilling + tier_prices read pairs.
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', PRICE_ROW('owner', 550, 'price_owner'))
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', PRICE_ROW('manager', 400, 'price_manager'))

    await seatsCall({ location_id: LOC, tier: 'owner', quantity: 2 })

    // Recorded: owner rate then manager rate.
    expect(seatRows().map(r => r.prorated_cost)).toEqual([centsFor(550), centsFor(400)])
    // Charged: the same two prices, one seat each. A flat seat-tier lookup
    // would have bumped price_owner by 2.
    expect(adjust.fn).toHaveBeenCalledTimes(2)
    const calls = adjust.fn.mock.calls.map(c => ({ priceId: (c[0] as any).priceId, delta: (c[0] as any).delta }))
    expect(calls).toEqual([
      { priceId: 'price_owner', delta: 1 },
      { priceId: 'price_manager', delta: 1 },
    ])
  })
})

// ══════════════════════════════════════════════════════════════
// 6. The other button — buy-and-invite stays in step
// ══════════════════════════════════════════════════════════════
describe('issue 219 — both buttons behave the same', () => {
  function queueBuy(opts: { tier: string; annual: number; stripePriceId?: string | null; location?: any }) {
    h.enqueue('hub_users', OWNER_CALLER)          // caller
    h.enqueue('hub_users', [])                    // existing-hub_user check
    h.enqueue('locations', { id: LOC, paid_through_date: ANCHOR })
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', { id: 'seat1', location_id: LOC, tier: opts.tier })
    h.enqueue('pending_invites', { id: 'inv1', email: 'new@x.com' })
    h.enqueue('locations', opts.location === undefined ? LOCATION_BILLING() : opts.location)
    h.enqueue('tier_prices', PRICE_ROW(opts.tier, opts.annual, opts.stripePriceId === undefined ? `price_${opts.tier}` : opts.stripePriceId))
    h.enqueue('locations', { name: 'Fort Lauderdale' }) // email step
    h.enqueue('hub_users', { full_name: 'Kevin' })      // email step
  }

  it('a paid seat still charges, as it always did', async () => {
    queueBuy({ tier: 'manager', annual: 400 })
    const res = await buyCall({ location_id: LOC, tier: 'manager', email: 'new@x.com' })
    expect(res.status).toBe(201)
    expect(adjust.fn).toHaveBeenCalledTimes(1)
    expect((adjust.fn.mock.calls[0][0] as any).priceId).toBe('price_manager')
    expect((await res.json()).billing.stripe_applied).toBe(true)
  })

  it('a $0 tier no longer mints a pointless Stripe line here either', async () => {
    queueBuy({ tier: 'readonly', annual: 0 })
    const res = await buyCall({ location_id: LOC, tier: 'readonly', email: 'watch@x.com' })
    expect(res.status).toBe(201)
    expect(adjust.fn).not.toHaveBeenCalled()
    expect((await res.json()).billing.stripe_skip_reason).toBe('zero_rate')
  })

  it('an uncharged seat gets the same reconciliation note the other button writes', async () => {
    queueBuy({ tier: 'manager', annual: 400, location: LOCATION_BILLING({ stripe_subscription_id: null }) })
    h.enqueue('subscription_seats', { id: 'seat1', location_id: LOC, tier: 'manager' })

    await buyCall({ location_id: LOC, tier: 'manager', email: 'new@x.com' })

    const note = seatNoteUpdates()[0]?.arg?.notes as string
    expect(note).toContain(SEAT_BILLING_MISMATCH_MARKER)
    expect(note).toContain('no Stripe subscription')
  })
})

// ══════════════════════════════════════════════════════════════
// 7. The comp rail is untouched
// ══════════════════════════════════════════════════════════════
describe('issue 219 — Admin → Grant Seat is still the free rail', () => {
  it('grant-seat does not import the seat↔Stripe bridge at all', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../app/api/admin/grant-seat/route.ts', import.meta.url),
      'utf8',
    )
    // The comp path writes seats through lib/subscription-activation, never
    // through /api/seats POST and never through the Stripe bridge. If either
    // ever appears here, a comp starts charging.
    expect(src).not.toContain('seat-stripe-sync')
    expect(src).not.toContain('applySeatDeltaToStripe')
    expect(src).not.toContain('applySeatPurchaseToStripe')
    expect(src).toContain('addManuallyGrantedSeats')
  })
})
