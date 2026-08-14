// @vitest-environment node
//
// issue 221 — REMOVING A SEAT CREDITS THE LINE IT WAS CHARGED ON.
//
// THE BUG THESE PIN: /api/seats DELETE handed applySeatDeltaToStripe the SEAT
// tier where it wanted a BILLING tier. A co-owner is an owner-tier seat billed
// at the MANAGER rate (lib/seat-plan's co-owner rule), so removing one credited
// the $550 owner line for a seat that had been charged $400 — the owner was
// handed $150 they never paid. issue 219 had already fixed the ADD direction by
// walking the quote's billing lines; DELETE was left on the flat lookup.
//
// The fix differences the SAME planBillingLines() the add differences, in
// reverse: the lines the location has, minus the lines it will have. So:
//
//   1. Removing a co-owner credits the MANAGER line, never the owner line.
//   2. It is a COUNT, not an identity — removing either of two owner rows
//      credits manager and leaves the survivor on the owner line, and removing
//      both credits manager then owner in EITHER order.
//   3. A $0 tier removal mints no Stripe call at all (issue 219's rule).
//   4. A location with no Stripe subscription does not fail on removal.
//   5. A non-owner removal is exactly what it always was.
//   6. Credit timing is untouched — decreases stay on create_prorations
//      (issue 161: credit at renewal, no refund).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Recording supabase mock — the shape beta-add-seats-charges-219.test.ts uses,
// plus a read log so "this tier never reads the owner count" is assertable.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    reads: [] as string[],
    updates: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.reads = []; state.updates = [] }
  const enqueue = (table: string, data: any, extra: Partial<Resp> = {}) =>
    state.queue.push({ table, resp: { data, error: null, ...extra } })
  const enqueueCount = (table: string, count: number) =>
    state.queue.push({ table, resp: { data: null, error: null, count } })
  const makeBuilder = (table: string) => {
    state.reads.push(table)
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
    b.insert = () => b
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, enqueueCount, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'adm1' } as any }))

// The Stripe seam: adjustSubscriptionSeatQuantity is the last thing before the
// SDK, so asserting on it is asserting on what Stripe is actually told.
const adjust = vi.hoisted(() => ({
  fn: vi.fn(async () => ({ quantity: 0, itemId: 'si_1', created: false, removed: true })),
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

import { DELETE as SEATS_DELETE } from '@/app/api/seats/route'
import {
  applySeatRemovalToStripe,
  SEAT_BILLING_MISMATCH_MARKER,
} from '@/lib/seat-stripe-sync'
import {
  decrementalBillingLines,
  incrementalBillingLines,
  quoteSeatRemoval,
} from '@/lib/seat-cost'

const LOC = 'loc-uuid'
const ADMIN_CALLER = { id: 'adm1', role: 'super_admin', location_id: null }

// The live prod catalog: owner $550, manager $400, light/readonly genuinely $0.
const TIER_ROWS = [
  { id: 'owner', price_annual: 550 },
  { id: 'manager', price_annual: 400 },
  { id: 'light', price_annual: 0 },
  { id: 'readonly', price_annual: 0 },
]

const PRICE_ROW = (id: string, price_annual: number, stripe_price_id: string | null = `price_${id}`) =>
  ({ id, price_annual, stripe_price_id })

const LOCATION_BILLING = (over: any = {}) => ({
  id: LOC, name: 'Fort Lauderdale', location_id: 'fort-lauderdale',
  subscription_status: 'active', payment_source: 'direct', paid_through_date: '2027-02-27',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', ...over,
})

const deleteCall = (id: string) => {
  const req = new Request(`http://test/api/seats?id=${id}`, { method: 'DELETE' })
  Object.defineProperty(req, 'nextUrl', { value: new URL(`http://test/api/seats?id=${id}`) })
  return SEATS_DELETE(req as any)
}

// The reads a DELETE makes, in table order:
//   hub_users (caller)
//   → subscription_seats (the soft-delete UPDATE)
//   → subscription_seats (owner count — OWNER TIER ONLY)
//   → tier_prices (rates, for the $0 skip)
//   → locations (getLocationBilling) → tier_prices (stripe_price_id)
function queueDelete(opts: {
  seat: any
  // Owner seats still ACTIVE after the removal. Omit for non-owner tiers,
  // which never read the count.
  remainingOwnerSeats?: number
  creditTier?: string
  creditAnnual?: number
  stripePriceId?: string | null
  location?: any
}) {
  h.enqueue('hub_users', ADMIN_CALLER)
  h.enqueue('subscription_seats', opts.seat)
  if (opts.remainingOwnerSeats !== undefined) {
    h.enqueueCount('subscription_seats', opts.remainingOwnerSeats)
  }
  h.enqueue('tier_prices', TIER_ROWS)
  h.enqueue('locations', opts.location === undefined ? LOCATION_BILLING() : opts.location)
  if (opts.creditTier) {
    h.enqueue('tier_prices', PRICE_ROW(
      opts.creditTier,
      opts.creditAnnual ?? 400,
      opts.stripePriceId === undefined ? `price_${opts.creditTier}` : opts.stripePriceId,
    ))
  }
}

const SEAT = (over: any = {}) => ({
  id: 'seat2', location_id: LOC, tier: 'owner', status: 'inactive',
  is_primary: false, notes: null, prorated_cost: 40000, ...over,
})

const stripeCalls = () =>
  adjust.fn.mock.calls.map(c => ({ priceId: (c[0] as any).priceId, delta: (c[0] as any).delta }))

const seatNoteUpdates = () =>
  h.state.updates.filter(u => u.table === 'subscription_seats' && typeof u.arg?.notes === 'string')

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'adm1' }
  adjust.fn.mockClear()
  adjust.fn.mockResolvedValue({ quantity: 0, itemId: 'si_1', created: false, removed: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════
// 1. The differencing, run backwards — pure, no database
// ══════════════════════════════════════════════════════════════
describe('issue 221 — a removal is the purchase difference with the plans swapped', () => {
  it('removing the 2nd owner seat drops the MANAGER line — the rate it was billed at', () => {
    expect(decrementalBillingLines(2, 'owner', 1)).toEqual([{ billingTier: 'manager', quantity: 1 }])
  })

  it('removing the ONLY owner seat drops the owner line', () => {
    expect(decrementalBillingLines(1, 'owner', 1)).toEqual([{ billingTier: 'owner', quantity: 1 }])
  })

  it('removing BOTH owner seats at once drops one of each — exactly what two owner seats cost', () => {
    expect(decrementalBillingLines(2, 'owner', 2)).toEqual([
      { billingTier: 'owner', quantity: 1 },
      { billingTier: 'manager', quantity: 1 },
    ])
  })

  it('non-owner tiers difference to themselves — the owner lines cancel, whatever they are', () => {
    for (const owners of [0, 1, 2]) {
      expect(decrementalBillingLines(owners, 'manager', 1)).toEqual([{ billingTier: 'manager', quantity: 1 }])
      expect(decrementalBillingLines(owners, 'readonly', 3)).toEqual([{ billingTier: 'readonly', quantity: 3 }])
    }
  })

  it('IT REALLY IS THE SAME DIFFERENCE: removing seats drops exactly the lines adding them back would add', () => {
    // What this pins is the OPERAND conversion, which is the only thing the two
    // directions disagree about: an addition differences from where the location
    // stands now, a removal from where it will stand after. Get that wrong and a
    // co-owner removal credits the owner line again — the bug — so it is worth
    // stating as an equation rather than leaving to the route tests below.
    const cases: Array<[number, any, number]> = [
      [1, 'owner', 1],
      [2, 'owner', 1],
      [2, 'owner', 2],
      [0, 'manager', 1],
      [2, 'manager', 2],
      [1, 'readonly', 1],
      [2, 'light', 4],
    ]
    for (const [existing, tier, qty] of cases) {
      const remaining = tier === 'owner' ? existing - qty : existing
      expect(decrementalBillingLines(existing, tier, qty)).toEqual(
        incrementalBillingLines(remaining, tier, qty),
      )
    }
  })

  it('does not restate the co-owner rule — lib/seat-plan is still the only place it is written', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./seat-cost.ts', import.meta.url), 'utf8')
    // Every billing-line answer in this module comes out of planBillingLines().
    // A hand-rolled "second owner seat → manager" branch here would be the
    // second copy of the rule that issues 212/217/219 exist to prevent.
    expect(src).toContain('planBillingLines')
    expect(src.match(/planBillingLines\(/g)!.length).toBeGreaterThanOrEqual(2)
  })
})

// ══════════════════════════════════════════════════════════════
// 2. The bug itself: removing a co-owner
// ══════════════════════════════════════════════════════════════
describe('issue 221 — removing a co-owner credits the manager line', () => {
  it('credits price_manager, NOT the $550 owner line the seat was never charged on', async () => {
    queueDelete({ seat: SEAT(), remainingOwnerSeats: 1, creditTier: 'manager' })

    const res = await deleteCall('seat2')
    expect(res.status).toBe(200)

    expect(adjust.fn).toHaveBeenCalledTimes(1)
    const arg = adjust.fn.mock.calls[0][0] as any
    expect(arg.priceId).toBe('price_manager')
    expect(arg.priceId).not.toBe('price_owner') // the $150 the owner never paid
    expect(arg.delta).toBe(-1)
    expect(arg.subscriptionId).toBe('sub_1')
  })

  it('the credit is anchored on the seat, so a retry of the same removal replays', async () => {
    queueDelete({ seat: SEAT(), remainingOwnerSeats: 1, creditTier: 'manager' })
    await deleteCall('seat2')

    const key = (adjust.fn.mock.calls[0][0] as any).idempotencyKey as string
    expect(key).toContain('seat2')
    expect(key).toContain('remove')
    // …and carries the line, so a multi-line removal cannot reuse one key for
    // two different prices (Stripe rejects that, and it reads as a failed credit).
    expect(key).toContain('manager')
  })

  it('the response reports the credit instead of leaving it implied', async () => {
    queueDelete({ seat: SEAT(), remainingOwnerSeats: 1, creditTier: 'manager' })
    const json = await (await deleteCall('seat2')).json()
    expect(json.billing.stripe_applied).toBe(true)
    expect(json.billing.stripe_skip_reason).toBeUndefined()
    expect(json.status).toBe('inactive') // the seat write is still the point
  })
})

// ══════════════════════════════════════════════════════════════
// 3. Two owner seats, and WHICH row goes
// ══════════════════════════════════════════════════════════════
describe('issue 221 — with two owner seats, the credit follows the COUNT, not the row', () => {
  // A location holding both owner seats bills owner × 1 + manager × 1. Remove
  // one and it must bill owner × 1: the survivor sits on the owner line and the
  // manager line drops. The arithmetic differences counts, so it cannot see
  // which of the two rows was deleted — and these pin that it does not.
  it('removing the CO-OWNER row credits manager', async () => {
    queueDelete({
      seat: SEAT({ id: 'seat2', is_primary: false }),
      remainingOwnerSeats: 1,
      creditTier: 'manager',
    })
    await deleteCall('seat2')
    expect(stripeCalls()).toEqual([{ priceId: 'price_manager', delta: -1 }])
  })

  it('removing the PRIMARY owner row credits manager too — the survivor moves onto the owner line', async () => {
    queueDelete({
      seat: SEAT({ id: 'seat1', is_primary: true, prorated_cost: 55000 }),
      remainingOwnerSeats: 1,
      creditTier: 'manager',
    })
    await deleteCall('seat1')
    // NOT price_owner, even though this is the row that was charged $550: the
    // location still holds one owner seat, and one owner seat bills at the
    // owner rate. Crediting the owner line here would leave the subscription
    // billing manager-only for a location with a franchise owner on it.
    expect(stripeCalls()).toEqual([{ priceId: 'price_manager', delta: -1 }])
  })

  for (const [first, second] of [['seat2', 'seat1'], ['seat1', 'seat2']] as const) {
    it(`removing both, ${first} then ${second}, credits manager then owner — order does not change the total`, async () => {
      queueDelete({
        seat: SEAT({ id: first, is_primary: first === 'seat1' }),
        remainingOwnerSeats: 1,
        creditTier: 'manager',
      })
      await deleteCall(first)

      h.reset()
      queueDelete({
        seat: SEAT({ id: second, is_primary: second === 'seat1' }),
        remainingOwnerSeats: 0, // the last owner seat is going
        creditTier: 'owner',
        creditAnnual: 550,
      })
      await deleteCall(second)

      expect(stripeCalls()).toEqual([
        { priceId: 'price_manager', delta: -1 },
        { priceId: 'price_owner', delta: -1 },
      ])
    })
  }

  it('the quote reads what REMAINS and adds the removal back, so the row is already inactive', async () => {
    h.enqueueCount('subscription_seats', 1) // one owner seat still active
    h.enqueue('tier_prices', TIER_ROWS)

    const quote = await quoteSeatRemoval({ locationId: LOC, tier: 'owner' })

    // remaining 1 + the one just removed = the 2 the location held → manager.
    expect(quote.billingLines).toEqual([
      { billingTier: 'manager', quantity: 1, annualUnitCents: 40000 },
    ])
  })
})

// ══════════════════════════════════════════════════════════════
// 4. A $0 tier removal mints no Stripe operation (issue 219's rule)
// ══════════════════════════════════════════════════════════════
describe('issue 221 — a $0 tier is free coming and going', () => {
  for (const tier of ['readonly', 'light']) {
    it(`removing a ${tier} seat (price_annual 0) never touches Stripe`, async () => {
      queueDelete({ seat: SEAT({ id: 's9', tier }) }) // no credit tier read at all

      const res = await deleteCall('s9')
      expect(res.status).toBe(200)
      expect(adjust.fn).not.toHaveBeenCalled()

      const json = await res.json()
      expect(json.billing.stripe_applied).toBe(false)
      expect(json.billing.stripe_skip_reason).toBe('zero_rate')
    })
  }

  it('and leaves NO mismatch note — nothing was owed, so nothing is owed back', async () => {
    queueDelete({ seat: SEAT({ id: 's9', tier: 'readonly' }) })
    await deleteCall('s9')
    expect(seatNoteUpdates()).toHaveLength(0)
  })

  it('applySeatRemovalToStripe itself: a 0-rate line short-circuits before any Stripe work', async () => {
    const out = await applySeatRemovalToStripe({
      locationId: LOC,
      lines: [{ billingTier: 'readonly', quantity: 2, annualUnitCents: 0 }],
      seatId: 's9',
    })
    expect(adjust.fn).not.toHaveBeenCalled()
    expect(out.lines[0].reason).toBe('zero_rate')
    expect(out.applied).toBe(true) // nothing owed → nothing missing
  })

  it('an UNKNOWN rate is not a free rate — it still goes to Stripe and is refused there', async () => {
    h.enqueue('hub_users', ADMIN_CALLER)
    h.enqueue('subscription_seats', SEAT({ id: 's5', tier: 'manager' }))
    h.enqueue('tier_prices', [{ id: 'owner', price_annual: 550 }]) // manager row missing
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', null) // no row → no_price

    const json = await (await deleteCall('s5')).json()
    expect(json.billing.stripe_skip_reason).toBe('no_price') // reads as broken, not free
    // A live subscription that should have been credited and was not — money.
    expect(seatNoteUpdates()[0]?.arg?.notes as string).toContain(SEAT_BILLING_MISMATCH_MARKER)
  })
})

// ══════════════════════════════════════════════════════════════
// 5. A location with no Stripe subscription — 32 of 55 today
// ══════════════════════════════════════════════════════════════
describe('issue 221 — no subscription: the removal still lands', () => {
  it('does not fail the request and mints no Stripe call', async () => {
    queueDelete({
      seat: SEAT(),
      remainingOwnerSeats: 1,
      location: LOCATION_BILLING({ stripe_subscription_id: null }),
    })
    // The tier_prices price-id read never happens — the guard is upstream of it.
    const res = await deleteCall('seat2')
    expect(res.status).toBe(200)
    expect(adjust.fn).not.toHaveBeenCalled()
    expect((await res.json()).billing.stripe_skip_reason).toBe('no_subscription')
  })

  it('…and writes NO note — nothing was ever charged here, so nothing is owed back', async () => {
    queueDelete({
      seat: SEAT(),
      remainingOwnerSeats: 1,
      location: LOCATION_BILLING({ stripe_subscription_id: null }),
    })
    await deleteCall('seat2')
    // Narrower than the add side on purpose: a purchase records a figure, so an
    // unbilled one is a real disagreement. A removal records nothing, and the
    // value of `notes ilike '%issue 219%'` is that a row in it means money.
    expect(seatNoteUpdates()).toHaveLength(0)
  })

  it('a corporate/prepaid location is skipped as non_paying, not as a failure — and un-noted for the same reason', async () => {
    queueDelete({
      seat: SEAT(),
      remainingOwnerSeats: 1,
      location: LOCATION_BILLING({ payment_source: 'prepaid_corporate' }),
    })
    const res = await deleteCall('seat2')
    expect(res.status).toBe(200)
    expect(adjust.fn).not.toHaveBeenCalled()
    expect((await res.json()).billing.stripe_skip_reason).toBe('non_paying')
    expect(seatNoteUpdates()).toHaveLength(0)
  })

  it('a Stripe failure does NOT un-do the removal — 200, and the row carries the issue 219 marker', async () => {
    queueDelete({ seat: SEAT({ notes: 'seat for Dana' }), remainingOwnerSeats: 1, creditTier: 'manager' })
    h.enqueue('subscription_seats', SEAT({ notes: 'seat for Dana' })) // the note write-back
    adjust.fn.mockRejectedValueOnce(new Error('subscription_item_missing'))

    const res = await deleteCall('seat2')
    expect(res.status).toBe(200)
    expect((await res.json()).billing.stripe_applied).toBe(false)

    // One marker for both directions, so `notes ilike '%issue 219%'` keeps
    // finding every seat whose money and ledger disagree.
    const note = seatNoteUpdates()[0]?.arg?.notes as string
    expect(note).toContain(SEAT_BILLING_MISMATCH_MARKER)
    expect(note).toContain('credit was NOT applied')
    expect(note).toContain('subscription_item_missing')
    expect(note).toContain('seat for Dana') // the notes the row already carried
  })
})

// ══════════════════════════════════════════════════════════════
// 6. Everything else about a removal is unchanged
// ══════════════════════════════════════════════════════════════
describe('issue 221 — a non-owner removal is exactly what it always was', () => {
  it('a manager seat credits the manager line by 1', async () => {
    queueDelete({ seat: SEAT({ id: 's5', tier: 'manager' }), creditTier: 'manager' })
    const res = await deleteCall('s5')
    expect(res.status).toBe(200)
    expect(stripeCalls()).toEqual([{ priceId: 'price_manager', delta: -1 }])
  })

  it('and never reads the owner count — only an owner removal can cross the rate boundary', async () => {
    queueDelete({ seat: SEAT({ id: 's5', tier: 'manager' }), creditTier: 'manager' })
    await deleteCall('s5')
    // One subscription_seats touch: the soft-delete itself.
    expect(h.state.reads.filter(t => t === 'subscription_seats')).toHaveLength(1)
  })

  it('credit timing is untouched: the delta is NEGATIVE, which is what selects create_prorations', async () => {
    queueDelete({ seat: SEAT({ id: 's5', tier: 'manager' }), creditTier: 'manager' })
    await deleteCall('s5')
    expect((adjust.fn.mock.calls[0][0] as any).delta).toBeLessThan(0)
  })

  it('…and the sign is the ONLY thing choosing it — issue 161 credits at renewal, no refund', async () => {
    const { readFileSync } = await import('node:fs')
    // adjustSubscriptionSeatQuantity owns the proration behavior: increases
    // invoice now, decreases credit the next invoice. Nothing above it names a
    // behavior of its own, so a removal cannot start refunding money Kevin
    // decided not to refund.
    const billing = readFileSync(new URL('./stripe-billing.ts', import.meta.url), 'utf8')
    expect(billing).toContain("delta > 0 ? 'always_invoice' : 'create_prorations'")
    const sync = readFileSync(new URL('./seat-stripe-sync.ts', import.meta.url), 'utf8')
    const route = readFileSync(new URL('../app/api/seats/route.ts', import.meta.url), 'utf8')
    expect(sync).not.toContain('proration_behavior')
    expect(route).not.toContain('proration_behavior')
  })
})
