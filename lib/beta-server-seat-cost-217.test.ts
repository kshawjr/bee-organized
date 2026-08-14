// @vitest-environment node
//
// issue 217 — THE SERVER COMPUTES WHAT A SEAT COSTS.
//
// Before this, /api/seats POST and /api/seats/buy-and-invite both took
// `prorated_cost` out of the request body and wrote it to
// subscription_seats.prorated_cost verbatim, shape-checked but never
// value-checked. The client's arithmetic WAS the permanent record of what a
// seat cost. These tests pin the four things that must now hold:
//
//   1. The server computes the figure and IGNORES a client value that
//      disagrees (the disagreement is recorded, never obeyed).
//   2. A seat added to a location with a future paid_through_date prorates to
//      THAT date — the location's real anchor, resolved server-side.
//   3. A location with no paid_through_date does NOT fall back to March 1.
//      No honest figure exists, so none is recorded.
//   4. The co-owner rate is applied through lib/seat-plan, not a flat tier
//      lookup — a 2nd owner seat records the MANAGER rate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Recording supabase mock: chainable builder + per-table FIFO queue, plus
// captured insert payloads. Same shape as beta-super-admin-grant-seat.test.ts,
// extended with `count` so head:true count queries resolve.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.inserts = [] }
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
    b.update = () => b
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

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
// issue 219 gave both purchase routes a Stripe leg. These tests are about what
// gets RECORDED, so the charge is stubbed out entirely — but it has to be
// stubbed with the whole surface the routes now import, and with a result that
// exercises the "recorded but not charged" branch (a location with no
// subscription), because that branch appends a note and these tests read notes.
vi.mock('@/lib/seat-stripe-sync', () => ({
  applySeatDeltaToStripe: vi.fn(async () => ({ applied: false, reason: 'no_subscription' })),
  applySeatPurchaseToStripe: vi.fn(async (args: any) => {
    let cursor = 0
    const lines = (args.lines || []).map((l: any) => {
      const seatIds = (args.seatIds || []).slice(cursor, cursor + l.quantity)
      cursor += l.quantity
      return {
        billingTier: l.billingTier,
        quantity: l.quantity,
        seatIds,
        applied: false,
        reason: l.annualUnitCents === 0 ? 'zero_rate' : 'no_subscription',
      }
    })
    return {
      applied: false,
      lines,
      unbilledSeatIds: lines.filter((l: any) => l.reason !== 'zero_rate').flatMap((l: any) => l.seatIds),
    }
  }),
  unchargedSeatNote: () => 'issue 219: cost recorded but NOT charged — stub',
  unrecordedChargeNote: () => 'issue 219: charged but no cost figure was recorded — stub',
  SEAT_BILLING_MISMATCH_MARKER: 'issue 219',
}))
vi.mock('@/lib/resend', () => ({
  sendEmailDirect: vi.fn(async () => ({ success: true })),
}))

import { POST as SEATS_POST } from '@/app/api/seats/route'
import { POST as BUY_POST } from '@/app/api/seats/buy-and-invite/route'
import {
  incrementalBillingLines,
  perSeatCentsFromLines,
  seatCostDivergence,
  SEAT_COST_DIVERGENCE_MARKER,
} from '@/lib/seat-cost'
import {
  prorateToRenewal,
  parsePaidThroughDate,
  legacyFixedRenewalDate,
} from '@/lib/subscription-math'

// A fixed "today" so a prorated figure is a number the test can name rather
// than a moving target. Nothing here depends on the real clock.
const TODAY = new Date('2026-08-14T00:00:00Z')

const LOC = 'loc-uuid'
const OWNER_CALLER = { id: 'own1', role: 'owner', location_id: LOC }

// The live prod catalog at the time of writing: light/readonly are genuinely
// $0, owner $550, manager $400.
const TIER_ROWS = [
  { id: 'owner', price_annual: 550 },
  { id: 'manager', price_annual: 400 },
  { id: 'light', price_annual: 0 },
  { id: 'readonly', price_annual: 0 },
]

// Prorate an annual dollar rate to a paid_through_date, as cents — the figure
// the server is expected to record.
const centsFor = (annual: number, paidThrough: string) =>
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
  // The route builds the invite URL from request.nextUrl.origin; a plain
  // Request has no nextUrl, so stand one in.
  Object.defineProperty(req, 'nextUrl', { value: new URL('http://test/api/seats/buy-and-invite') })
  return BUY_POST(req as any)
}

const seatInsert = () => h.state.inserts.find(i => i.table === 'subscription_seats')
// /api/seats inserts an ARRAY of rows; buy-and-invite inserts one object.
const seatRows = (): any[] => {
  const ins = seatInsert()
  if (!ins) return []
  return Array.isArray(ins.arg) ? ins.arg : [ins.arg]
}

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'own1' }
  vi.useFakeTimers()
  vi.setSystemTime(TODAY)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Queue the reads a non-owner-tier /api/seats POST makes, in order:
// hub_users (caller) → locations (anchor) → tier_prices → seats insert.
function queueSeatsPost(opts: { paidThrough: string | null; insertResult?: any }) {
  h.enqueue('hub_users', OWNER_CALLER)
  h.enqueue('locations', { id: LOC, paid_through_date: opts.paidThrough })
  h.enqueue('tier_prices', TIER_ROWS)
  h.enqueue('subscription_seats', opts.insertResult ?? [{ id: 'seat1' }])
}

// ══════════════════════════════════════════════════════════════
// 1. The server computes the figure and ignores a disagreeing client value
// ══════════════════════════════════════════════════════════════
describe('issue 217 — a client value that disagrees is ignored, not written', () => {
  it('/api/seats writes the SERVER figure when the client sends a different one', async () => {
    queueSeatsPost({ paidThrough: '2027-02-27' })

    const server = centsFor(400, '2027-02-27') // manager, prorated to the anchor
    const clientLie = 100 // $1.00 — nothing like the real figure

    const res = await seatsCall({
      location_id: LOC,
      tier: 'manager',
      prorated_cost: clientLie,
    })
    expect(res.status).toBe(201)

    const rows = seatRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].prorated_cost).toBe(server)
    expect(rows[0].prorated_cost).not.toBe(clientLie)
  })

  it('records the divergence on the seat row so it is visible, not just discarded', async () => {
    queueSeatsPost({ paidThrough: '2027-02-27' })

    await seatsCall({ location_id: LOC, tier: 'manager', prorated_cost: 100 })

    const notes = seatRows()[0].notes as string
    expect(notes).toContain(SEAT_COST_DIVERGENCE_MARKER)
    expect(notes).toContain('client sent 100c/seat')
    expect(notes).toContain('server value used')
    // And loudly, for the runtime logs.
    expect(console.error).toHaveBeenCalled()
  })

  it('a client value that AGREES leaves no divergence note (only disagreement is recorded)', async () => {
    queueSeatsPost({ paidThrough: '2027-02-27' })

    await seatsCall({
      location_id: LOC,
      tier: 'manager',
      prorated_cost: centsFor(400, '2027-02-27'),
    })

    const row = seatRows()[0]
    expect(row.prorated_cost).toBe(centsFor(400, '2027-02-27'))
    expect(row.notes ?? '').not.toContain(SEAT_COST_DIVERGENCE_MARKER)
  })

  it('sending NO prorated_cost at all still records the server figure', async () => {
    queueSeatsPost({ paidThrough: '2027-02-27' })

    await seatsCall({ location_id: LOC, tier: 'manager' })

    expect(seatRows()[0].prorated_cost).toBe(centsFor(400, '2027-02-27'))
  })

  it('/api/seats/buy-and-invite likewise writes the server figure, not the body', async () => {
    h.enqueue('hub_users', OWNER_CALLER)            // caller
    h.enqueue('hub_users', [])                      // existing-hub_user check
    h.enqueue('locations', { id: LOC, paid_through_date: '2027-02-27' })
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', { id: 'seat1', location_id: LOC, tier: 'manager' })
    h.enqueue('pending_invites', { id: 'inv1', email: 'new@x.com' })
    h.enqueue('locations', { name: 'Fort Lauderdale' }) // email step
    h.enqueue('hub_users', { full_name: 'Kevin' })      // email step

    const res = await buyCall({
      location_id: LOC,
      tier: 'manager',
      email: 'new@x.com',
      prorated_cost: 100,
    })
    expect(res.status).toBe(201)

    const row = seatRows()[0]
    expect(row.prorated_cost).toBe(centsFor(400, '2027-02-27'))
    expect(row.prorated_cost).not.toBe(100)
    expect(row.notes).toContain(SEAT_COST_DIVERGENCE_MARKER)

    // The response tells the caller what the SERVER decided.
    const json = await res.json()
    expect(json.cost.source).toBe('server')
    expect(json.cost.per_seat_cents).toEqual([centsFor(400, '2027-02-27')])
    expect(json.cost.paid_through_date).toBe('2027-02-27')
  })

  it('seatCostDivergence itself: agreeing / absent / disagreeing', () => {
    expect(seatCostDivergence(undefined, [21589]).diverged).toBe(false)
    expect(seatCostDivergence(null, [21589]).diverged).toBe(false)
    expect(seatCostDivergence(21589, [21589]).diverged).toBe(false)
    expect(seatCostDivergence(100, [21589]).diverged).toBe(true)
    // No server figure at all is still a disagreement worth recording.
    expect(seatCostDivergence(100, null).diverged).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════
// 2. Proration anchors to the location's real paid_through_date
// ══════════════════════════════════════════════════════════════
describe('issue 217 — the renewal anchor is the location\'s real paid_through_date', () => {
  it('a future paid_through_date is what the seat prorates to', async () => {
    queueSeatsPost({ paidThrough: '2027-02-27' })

    await seatsCall({ location_id: LOC, tier: 'manager' })

    // 197 days from 2026-08-14 to 2027-02-27, on a $400 annual rate.
    expect(seatRows()[0].prorated_cost).toBe(centsFor(400, '2027-02-27'))
  })

  it('a DIFFERENT paid_through_date produces a different figure (the date is really read)', async () => {
    queueSeatsPost({ paidThrough: '2026-10-01' })
    await seatsCall({ location_id: LOC, tier: 'manager' })
    const near = seatRows()[0].prorated_cost

    h.reset()
    queueSeatsPost({ paidThrough: '2027-06-30' })
    await seatsCall({ location_id: LOC, tier: 'manager' })
    const far = seatRows()[0].prorated_cost

    expect(near).toBe(centsFor(400, '2026-10-01'))
    expect(far).toBe(centsFor(400, '2027-06-30'))
    expect(far).toBeGreaterThan(near)
  })

  it('a tier priced at $0 records 0 — genuinely free, not unknown', async () => {
    queueSeatsPost({ paidThrough: '2027-02-27' })
    await seatsCall({ location_id: LOC, tier: 'readonly' })
    expect(seatRows()[0].prorated_cost).toBe(0)
  })

  it('bulk quantity prices every row from the same anchor', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueue('locations', { id: LOC, paid_through_date: '2027-02-27' })
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', [{ id: 's1' }, { id: 's2' }, { id: 's3' }])

    await seatsCall({ location_id: LOC, tier: 'manager', quantity: 3 })

    const rows = seatRows()
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.prorated_cost).toBe(centsFor(400, '2027-02-27'))
  })
})

// ══════════════════════════════════════════════════════════════
// 3. No paid_through_date must NOT become March 1
// ══════════════════════════════════════════════════════════════
describe('issue 217 — a location with no paid_through_date does not fall back to March 1', () => {
  it('records NO figure at all rather than a fabricated one', async () => {
    queueSeatsPost({ paidThrough: null })

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(res.status).toBe(201) // the seat is still created — charging is unchanged

    const row = seatRows()[0]
    // The column is left unset, not zeroed and not guessed.
    expect(row).not.toHaveProperty('prorated_cost')
  })

  it('specifically does not write the March-1 figure the legacy fallback would produce', async () => {
    queueSeatsPost({ paidThrough: null })
    await seatsCall({ location_id: LOC, tier: 'manager' })

    // What resolveLocationRenewalDate's legacy branch WOULD have anchored to.
    const marchFirst = Math.round(
      prorateToRenewal(400, legacyFixedRenewalDate(TODAY), TODAY) * 100,
    )
    expect(marchFirst).toBeGreaterThan(0) // the wrong answer is a real number…
    expect(seatRows()[0].prorated_cost).toBeUndefined() // …and it is not recorded
  })

  it('says WHY on the row, so a null cost is not mistaken for an oversight', async () => {
    queueSeatsPost({ paidThrough: null })
    await seatsCall({ location_id: LOC, tier: 'manager' })

    expect(seatRows()[0].notes).toContain('issue 217')
    expect(seatRows()[0].notes).toContain('no paid_through_date')
  })

  it('a client-supplied figure cannot fill the gap when the server has no anchor', async () => {
    queueSeatsPost({ paidThrough: null })

    await seatsCall({ location_id: LOC, tier: 'manager', prorated_cost: 21589 })

    const row = seatRows()[0]
    expect(row).not.toHaveProperty('prorated_cost')
    expect(row.notes).toContain(SEAT_COST_DIVERGENCE_MARKER)
    expect(row.notes).toContain('no figure recorded')
  })

  it('an UNPRICED tier (no tier_prices row) is treated the same way', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueue('locations', { id: LOC, paid_through_date: '2027-02-27' })
    h.enqueue('tier_prices', [{ id: 'owner', price_annual: 550 }]) // manager row missing
    h.enqueue('subscription_seats', [{ id: 'seat1' }])

    const res = await seatsCall({ location_id: LOC, tier: 'manager' })
    expect(res.status).toBe(201)
    const row = seatRows()[0]
    expect(row).not.toHaveProperty('prorated_cost')
    expect(row.notes).toContain('no tier_prices row')
  })
})

// ══════════════════════════════════════════════════════════════
// 4. The co-owner rate comes through seat-plan, not a flat lookup
// ══════════════════════════════════════════════════════════════
describe('issue 217 — the co-owner rate is applied through lib/seat-plan', () => {
  it('incrementalBillingLines: the 2nd owner seat bills at the MANAGER rate', () => {
    // Location already holds the primary owner; buying one more owner seat.
    expect(incrementalBillingLines(1, 'owner', 1)).toEqual([
      { billingTier: 'manager', quantity: 1 },
    ])
  })

  it('incrementalBillingLines: the FIRST owner seat bills at the owner rate', () => {
    expect(incrementalBillingLines(0, 'owner', 1)).toEqual([
      { billingTier: 'owner', quantity: 1 },
    ])
  })

  it('incrementalBillingLines: buying both owner seats at once splits the rates', () => {
    expect(incrementalBillingLines(0, 'owner', 2)).toEqual([
      { billingTier: 'owner', quantity: 1 },
      { billingTier: 'manager', quantity: 1 },
    ])
  })

  it('incrementalBillingLines: non-owner tiers are unaffected by owner count', () => {
    for (const existing of [0, 1, 2]) {
      expect(incrementalBillingLines(existing, 'manager', 2)).toEqual([
        { billingTier: 'manager', quantity: 2 },
      ])
      expect(incrementalBillingLines(existing, 'readonly', 1)).toEqual([
        { billingTier: 'readonly', quantity: 1 },
      ])
    }
  })

  it('/api/seats records the manager rate for a 2nd owner seat, not the owner rate', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueueCount('subscription_seats', 1) // route owner-cap check: 1 existing owner
    h.enqueue('locations', { id: LOC, paid_through_date: '2027-02-27' })
    h.enqueueCount('subscription_seats', 1) // quote: same 1 existing owner
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', [{ id: 'seat2' }])

    const res = await seatsCall({ location_id: LOC, tier: 'owner' })
    expect(res.status).toBe(201)

    const recorded = seatRows()[0].prorated_cost
    const managerRate = centsFor(400, '2027-02-27')
    const flatOwnerLookup = centsFor(550, '2027-02-27')

    expect(recorded).toBe(managerRate)
    // The whole point: a flat tier_prices[tier] lookup is a DIFFERENT number,
    // and it is not the one on the row.
    expect(flatOwnerLookup).not.toBe(managerRate)
    expect(recorded).not.toBe(flatOwnerLookup)
  })

  it('/api/seats records the owner rate for the FIRST owner seat', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueueCount('subscription_seats', 0) // cap check: no owner seats yet
    h.enqueue('locations', { id: LOC, paid_through_date: '2027-02-27' })
    h.enqueueCount('subscription_seats', 0) // quote
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', [{ id: 'seat1' }])

    await seatsCall({ location_id: LOC, tier: 'owner' })

    expect(seatRows()[0].prorated_cost).toBe(centsFor(550, '2027-02-27'))
  })

  it('buying both owner seats at once writes ONE owner-rate row and ONE manager-rate row', async () => {
    h.enqueue('hub_users', OWNER_CALLER)
    h.enqueueCount('subscription_seats', 0) // cap check
    h.enqueue('locations', { id: LOC, paid_through_date: '2027-02-27' })
    h.enqueueCount('subscription_seats', 0) // quote
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('subscription_seats', [{ id: 's1' }, { id: 's2' }])

    await seatsCall({ location_id: LOC, tier: 'owner', quantity: 2 })

    const costs = seatRows().map(r => r.prorated_cost)
    expect(costs).toEqual([centsFor(550, '2027-02-27'), centsFor(400, '2027-02-27')])
    // A flat lookup would have written the owner rate twice.
    expect(costs[0]).not.toBe(costs[1])
  })

  it('/api/seats/buy-and-invite cannot receive an owner tier at all (400 before pricing)', async () => {
    h.enqueue('hub_users', OWNER_CALLER)

    const res = await buyCall({
      location_id: LOC,
      tier: 'owner',
      email: 'coowner@x.com',
    })
    expect(res.status).toBe(400)
    expect(seatInsert()).toBeUndefined()
  })

  it('perSeatCentsFromLines expands lines to one figure per seat, in line order', () => {
    const renewal = parsePaidThroughDate('2027-02-27')!
    const out = perSeatCentsFromLines(
      [{ billingTier: 'owner', quantity: 1 }, { billingTier: 'manager', quantity: 2 }] as any,
      { owner: 550, manager: 400 },
      renewal,
      TODAY,
    )!
    expect(out.perSeatCents).toEqual([
      centsFor(550, '2027-02-27'),
      centsFor(400, '2027-02-27'),
      centsFor(400, '2027-02-27'),
    ])
  })

  it('perSeatCentsFromLines returns null when a billed tier has no rate', () => {
    const renewal = parsePaidThroughDate('2027-02-27')!
    expect(
      perSeatCentsFromLines(
        [{ billingTier: 'manager', quantity: 1 }] as any,
        { owner: 550 },
        renewal,
        TODAY,
      ),
    ).toBeNull()
  })
})
