// @vitest-environment node
//
// issue 222 — A SCHEDULED REMOVAL CREDITS STRIPE.
//
// THE GAP THESE PIN: POST /api/admin/process-scheduled-removals deactivated
// seats and never called Stripe at all. Not the wrong line — NO line, at any
// tier. issue 221 fixed which line an immediate removal credits and left this
// door shut entirely, and this is the wider one: scheduling is how a seat is
// meant to leave. A seat retired here kept its price on the subscription
// forever, so the owner went on paying at renewal for a seat nobody holds.
//
// What the fix must hold, and what each section below pins:
//
//   1. The scheduled path credits THE SAME LINE the immediate path does —
//      literally the same two calls, asserted equal rather than described.
//   2. Many seats at once is the real difference. Two owner seats removed in
//      ONE run credit owner × 1 + manager × 1 (what they were charged), not the
//      manager line twice — the co-owner rule differenced once at the group's
//      real quantity.
//   3. A run spans locations. One location failing must not abandon the rest.
//   4. issue 221's decisions carry: $0 tiers mint no call, a location with no
//      subscription does not fail, decreases stay on create_prorations.
//   5. The note allowlist (issue 219's convention, 221's narrowing) is the same
//      list on both doors — because it is now literally one list.
//   6. issue 216's scoping is not weakened: no scope is still a 400, and a 400
//      credits nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The 221 harness, unchanged: a per-table response queue plus a read/update log.
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
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'lte', 'like', 'order', 'limit']) {
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

const stripeOn = vi.hoisted(() => ({ configured: true }))

// The Stripe seam: adjustSubscriptionSeatQuantity is the last thing before the
// SDK, so asserting on it is asserting on what Stripe is actually told.
const adjust = vi.hoisted(() => ({
  fn: vi.fn(async (_args: any) => ({ quantity: 0, itemId: 'si_1', created: false, removed: true })),
}))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'adm1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => stripeOn.configured }))
vi.mock('@/lib/stripe-billing', () => ({ adjustSubscriptionSeatQuantity: adjust.fn }))

import { POST as PROCESS_REMOVALS } from '@/app/api/admin/process-scheduled-removals/route'
import { DELETE as SEATS_DELETE } from '@/app/api/seats/route'
import { creditRemovedSeats } from '@/lib/seat-removal-batch'
import { CREDIT_FAILED_REASONS, creditWasOwed, SEAT_BILLING_MISMATCH_MARKER } from '@/lib/seat-stripe-sync'

const LOC = 'loc-uuid'
const SUPER_ADMIN = { id: 'adm1', role: 'super_admin', location_id: null }

// The live prod catalog: owner $550, manager $400, light/readonly genuinely $0.
const TIER_ROWS = [
  { id: 'owner', price_annual: 550 },
  { id: 'manager', price_annual: 400 },
  { id: 'light', price_annual: 0 },
  { id: 'readonly', price_annual: 0 },
]

const PRICE_ROW = (id: string, stripe_price_id: string | null = `price_${id}`) =>
  ({ id, price_annual: id === 'owner' ? 550 : 400, stripe_price_id })

const LOCATION_BILLING = (over: any = {}) => ({
  id: LOC, name: 'Fort Lauderdale', location_id: 'fort-lauderdale',
  subscription_status: 'active', payment_source: 'direct', paid_through_date: '2027-02-27',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', ...over,
})

const SEAT = (over: any = {}) => ({
  id: 'seat2', location_id: LOC, tier: 'owner', notes: null, ...over,
})

const processCall = (body: any) => PROCESS_REMOVALS({ json: async () => body } as any)

const deleteCall = (id: string) => {
  const req = new Request(`http://test/api/seats?id=${id}`, { method: 'DELETE' })
  Object.defineProperty(req, 'nextUrl', { value: new URL(`http://test/api/seats?id=${id}`) })
  return SEATS_DELETE(req as any)
}

const stripeCalls = () =>
  adjust.fn.mock.calls.map((c: any[]) => ({
    priceId: (c[0] as any).priceId,
    delta: (c[0] as any).delta,
    subscriptionId: (c[0] as any).subscriptionId,
  }))

const seatNoteUpdates = () =>
  h.state.updates.filter(u => u.table === 'subscription_seats' && typeof u.arg?.notes === 'string')

// The reads a processed run makes, in order:
//   hub_users (caller) → subscription_seats (the scoped UPDATE)
//   then, per (location, tier) group:
//     subscription_seats (owner count — OWNER TIER ONLY)
//     → tier_prices (rates, for the $0 skip)
//     → locations (getLocationBilling) → tier_prices (stripe_price_id) per line
function queueRun(opts: {
  removed: any[]
  groups?: Array<{
    remainingOwnerSeats?: number
    location?: any
    creditTiers?: Array<string | { tier: string; stripePriceId: string | null }>
  }>
}) {
  h.enqueue('hub_users', SUPER_ADMIN)
  h.enqueue('subscription_seats', opts.removed)
  for (const g of opts.groups || []) {
    if (g.remainingOwnerSeats !== undefined) h.enqueueCount('subscription_seats', g.remainingOwnerSeats)
    h.enqueue('tier_prices', TIER_ROWS)
    // The gate is consulted once PER LINE, and it reads the location every
    // time — so a two-line owner group reads `locations` twice.
    const tiers = g.creditTiers || []
    for (let i = 0; i < Math.max(1, tiers.length); i++) {
      h.enqueue('locations', g.location ?? LOCATION_BILLING())
    }
    for (const t of tiers) {
      const tier = typeof t === 'string' ? t : t.tier
      const priceId = typeof t === 'string' ? `price_${tier}` : t.stripePriceId
      h.enqueue('tier_prices', PRICE_ROW(tier, priceId))
    }
  }
}

beforeEach(() => {
  h.reset()
  stripeOn.configured = true
  adjust.fn.mockClear()
  adjust.fn.mockResolvedValue({ quantity: 0, itemId: 'si_1', created: false, removed: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════
// 1. The gap itself: the scheduled door now credits, and credits the
//    SAME line the immediate door does
// ══════════════════════════════════════════════════════════════
describe('issue 222 — a scheduled removal credits the line an immediate one would', () => {
  it('credits price_manager for a co-owner — the scheduled path used to credit nothing at all', async () => {
    queueRun({
      removed: [SEAT()],
      groups: [{ remainingOwnerSeats: 1, creditTiers: ['manager'] }],
    })

    const res = await processCall({ seat_ids: ['seat2'] })
    expect(res.status).toBe(200)

    expect(adjust.fn).toHaveBeenCalledTimes(1)
    expect(stripeCalls()[0]).toMatchObject({ priceId: 'price_manager', delta: -1, subscriptionId: 'sub_1' })
    // …and NOT the $550 owner line the seat was never charged on (issue 221).
    expect(stripeCalls()[0].priceId).not.toBe('price_owner')
  })

  it('IS THE SAME CALL: the two doors tell Stripe the identical thing for the identical seat', async () => {
    // The point of reusing quoteSeatRemoval + applySeatRemovalToStripe rather
    // than writing a second removal-pricing path is that these cannot drift.
    // Stated as an equation, not as prose.
    queueRun({ removed: [SEAT()], groups: [{ remainingOwnerSeats: 1, creditTiers: ['manager'] }] })
    await processCall({ seat_ids: ['seat2'] })
    const scheduled = stripeCalls()

    h.reset()
    adjust.fn.mockClear()
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('subscription_seats', SEAT({ status: 'inactive', is_primary: false }))
    h.enqueueCount('subscription_seats', 1)
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', PRICE_ROW('manager'))
    await deleteCall('seat2')
    const immediate = stripeCalls()

    expect(scheduled).toEqual(immediate)
  })

  it('reports the credit per location instead of leaving it implied', async () => {
    queueRun({ removed: [SEAT()], groups: [{ remainingOwnerSeats: 1, creditTiers: ['manager'] }] })
    const json = await (await processCall({ seat_ids: ['seat2'] })).json()

    expect(json.removed_count).toBe(1)
    expect(json.billing.groups).toHaveLength(1)
    expect(json.billing.groups[0]).toMatchObject({
      location_id: LOC,
      tier: 'owner',
      seat_ids: ['seat2'],
      applied: true,
    })
    expect(json.billing.groups[0].lines[0]).toMatchObject({ billingTier: 'manager', quantity: 1, applied: true })
    expect(json.billing.uncredited_seat_ids).toEqual([])
  })

  it('a manager seat credits its own line — the ordinary case, which also used to credit nothing', async () => {
    queueRun({
      removed: [SEAT({ id: 's5', tier: 'manager' })],
      groups: [{ creditTiers: ['manager'] }],
    })
    await processCall({ seat_ids: ['s5'] })
    expect(stripeCalls()).toEqual([{ priceId: 'price_manager', delta: -1, subscriptionId: 'sub_1' }])
    // and never reads the owner count — only an owner removal can cross the
    // owner→manager rate boundary.
    expect(h.state.reads.filter(t => t === 'subscription_seats')).toHaveLength(1)
  })
})

// ══════════════════════════════════════════════════════════════
// 2. MANY seats at once — the shape this route has and DELETE does not
// ══════════════════════════════════════════════════════════════
describe('issue 222 — two owner seats in ONE run difference correctly', () => {
  it('credits owner × 1 + manager × 1, not the manager line twice', async () => {
    // Both of a location's owner seats due in the same click. The location held
    // owner × 1 + manager × 1 (the co-owner rule), so that is what comes back.
    // Pricing each seat as though the other were staying would credit manager
    // twice — $800 back on $950 charged.
    queueRun({
      removed: [SEAT({ id: 'seat1' }), SEAT({ id: 'seat2' })],
      groups: [{ remainingOwnerSeats: 0, creditTiers: ['owner', 'manager'] }],
    })

    const res = await processCall({ seat_ids: ['seat1', 'seat2'] })
    expect(res.status).toBe(200)
    expect(stripeCalls().map(c => ({ priceId: c.priceId, delta: c.delta }))).toEqual([
      { priceId: 'price_owner', delta: -1 },
      { priceId: 'price_manager', delta: -1 },
    ])
  })

  it('…which is exactly what removing them one at a time through /api/seats produces', async () => {
    queueRun({
      removed: [SEAT({ id: 'seat1' }), SEAT({ id: 'seat2' })],
      groups: [{ remainingOwnerSeats: 0, creditTiers: ['owner', 'manager'] }],
    })
    await processCall({ seat_ids: ['seat1', 'seat2'] })
    const batched = stripeCalls().map(c => ({ priceId: c.priceId, delta: c.delta })).sort(byPrice)

    h.reset()
    adjust.fn.mockClear()
    // seat2 first: one owner seat still remains, so the manager line drops.
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('subscription_seats', SEAT({ id: 'seat2' }))
    h.enqueueCount('subscription_seats', 1)
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', PRICE_ROW('manager'))
    await deleteCall('seat2')
    // then seat1: the last owner seat goes, so the owner line drops.
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('subscription_seats', SEAT({ id: 'seat1', is_primary: true }))
    h.enqueueCount('subscription_seats', 0)
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('locations', LOCATION_BILLING())
    h.enqueue('tier_prices', PRICE_ROW('owner'))
    await deleteCall('seat1')
    const sequential = stripeCalls().map(c => ({ priceId: c.priceId, delta: c.delta })).sort(byPrice)

    expect(batched).toEqual(sequential)
  })

  it('one credit per line, so the group is differenced ONCE — not once per seat', async () => {
    queueRun({
      removed: [SEAT({ id: 'seat1' }), SEAT({ id: 'seat2' })],
      groups: [{ remainingOwnerSeats: 0, creditTiers: ['owner', 'manager'] }],
    })
    await processCall({ seat_ids: ['seat1', 'seat2'] })
    // Two seats, two lines, two calls — and the owner count is read ONCE.
    expect(adjust.fn).toHaveBeenCalledTimes(2)
    const keys = adjust.fn.mock.calls.map((c: any[]) => (c[0] as any).idempotencyKey)
    // Distinct keys per line: Stripe rejects a key replayed with different
    // parameters, and that error would read as a failed credit.
    expect(new Set(keys).size).toBe(2)
    // Anchored on a seat, and on the LOWEST id, so re-running the same group
    // replays instead of minting a second credit.
    for (const k of keys) expect(k).toContain('seat1')
  })

  it('three managers in one run credit the manager line by 3, in one call', async () => {
    queueRun({
      removed: ['a', 'b', 'c'].map(id => SEAT({ id, tier: 'manager' })),
      groups: [{ creditTiers: ['manager'] }],
    })
    await processCall({ seat_ids: ['a', 'b', 'c'] })
    expect(stripeCalls().map(c => ({ priceId: c.priceId, delta: c.delta }))).toEqual([
      { priceId: 'price_manager', delta: -3 },
    ])
  })

  it('groups by LOCATION as well as tier — a credit belongs to one subscription', async () => {
    queueRun({
      removed: [
        SEAT({ id: 'a', location_id: 'loc-1', tier: 'manager' }),
        SEAT({ id: 'b', location_id: 'loc-2', tier: 'manager' }),
      ],
      groups: [
        { location: LOCATION_BILLING({ id: 'loc-1', stripe_subscription_id: 'sub_1' }), creditTiers: ['manager'] },
        { location: LOCATION_BILLING({ id: 'loc-2', stripe_subscription_id: 'sub_2' }), creditTiers: ['manager'] },
      ],
    })
    await processCall({ seat_ids: ['a', 'b'] })
    // Never one −2 against whichever subscription happened to be read first.
    expect(stripeCalls()).toEqual([
      { priceId: 'price_manager', delta: -1, subscriptionId: 'sub_1' },
      { priceId: 'price_manager', delta: -1, subscriptionId: 'sub_2' },
    ])
  })
})

// ══════════════════════════════════════════════════════════════
// 3. A location failing mid-run does not abandon the rest
// ══════════════════════════════════════════════════════════════
describe('issue 222 — five locations, the third fails', () => {
  const fiveLocations = () => {
    const removed = [1, 2, 3, 4, 5].map(n =>
      SEAT({ id: `s${n}`, location_id: `loc-${n}`, tier: 'manager' }))
    queueRun({
      removed,
      groups: [1, 2, 3, 4, 5].map(n => ({
        location: LOCATION_BILLING({ id: `loc-${n}`, stripe_subscription_id: `sub_${n}` }),
        creditTiers: ['manager'],
      })),
    })
    return removed.map(r => r.id)
  }

  it('the other four are credited and the run reports 200', async () => {
    const ids = fiveLocations()
    adjust.fn.mockImplementation(async (args: any) => {
      if (args.subscriptionId === 'sub_3') throw new Error('subscription_item_missing')
      return { quantity: 0, itemId: 'si_1', created: false, removed: true }
    })

    const res = await processCall({ seat_ids: ids })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.removed_count).toBe(5) // the seat write is still the point
    expect(stripeCalls().map(c => c.subscriptionId)).toEqual(['sub_1', 'sub_2', 'sub_3', 'sub_4', 'sub_5'])

    const applied = json.billing.groups.map((g: any) => g.applied)
    expect(applied).toEqual([true, true, false, true, true])
  })

  it('the failure is named — the seat, the location, and the reason', async () => {
    const ids = fiveLocations()
    adjust.fn.mockImplementation(async (args: any) => {
      if (args.subscriptionId === 'sub_3') throw new Error('subscription_item_missing')
      return { quantity: 0, itemId: 'si_1', created: false, removed: true }
    })
    const json = await (await processCall({ seat_ids: ids })).json()

    const failed = json.billing.groups.find((g: any) => !g.applied)
    expect(failed.location_id).toBe('loc-3')
    expect(failed.seat_ids).toEqual(['s3'])
    expect(failed.lines[0].reason).toBe('stripe_error')
    expect(failed.lines[0].detail).toContain('subscription_item_missing')
    // Only that seat is uncredited — the run's other four are money that moved.
    expect(json.billing.uncredited_seat_ids).toEqual(['s3'])
  })

  it('a location whose credit cannot even be PRICED is contained the same way', async () => {
    // Not a Stripe failure — the quote itself throws. Without a per-group catch
    // this takes the whole run down after the seats are already inactive.
    h.enqueue('hub_users', SUPER_ADMIN)
    h.enqueue('subscription_seats', [
      SEAT({ id: 'a', location_id: 'loc-1', tier: 'manager' }),
      SEAT({ id: 'b', location_id: 'loc-2', tier: 'owner' }),
      SEAT({ id: 'c', location_id: 'loc-3', tier: 'manager' }),
    ])
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('locations', LOCATION_BILLING({ id: 'loc-1', stripe_subscription_id: 'sub_1' }))
    h.enqueue('tier_prices', PRICE_ROW('manager'))
    // loc-2's owner-count read blows up.
    h.state.queue.push({
      table: 'subscription_seats',
      resp: { data: null, error: null, get count(): number { throw new Error('read timeout') } } as any,
    })
    h.enqueue('tier_prices', TIER_ROWS)
    h.enqueue('locations', LOCATION_BILLING({ id: 'loc-3', stripe_subscription_id: 'sub_3' }))
    h.enqueue('tier_prices', PRICE_ROW('manager'))

    const res = await processCall({ seat_ids: ['a', 'b', 'c'] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.billing.groups.map((g: any) => [g.location_id, g.applied])).toEqual([
      ['loc-1', true],
      ['loc-2', false],
      ['loc-3', true],
    ])
    expect(json.billing.groups[1].lines[0].detail).toContain('could not price the credit')
    // loc-3 was still reached.
    expect(stripeCalls().map(c => c.subscriptionId)).toEqual(['sub_1', 'sub_3'])
  })
})

// ══════════════════════════════════════════════════════════════
// 4. issue 221's decisions carry
// ══════════════════════════════════════════════════════════════
describe('issue 222 — $0 tiers, missing subscriptions, and credit timing', () => {
  for (const tier of ['readonly', 'light']) {
    it(`a ${tier} seat (price_annual 0) mints no Stripe call`, async () => {
      queueRun({ removed: [SEAT({ id: 'z1', tier })], groups: [{ creditTiers: [] }] })
      // No locations read is queued and none is needed — the $0 skip is upstream
      // of the gate entirely.
      const res = await processCall({ seat_ids: ['z1'] })
      expect(res.status).toBe(200)
      expect(adjust.fn).not.toHaveBeenCalled()

      const json = await res.json()
      expect(json.billing.groups[0].applied).toBe(false)
      expect(json.billing.groups[0].lines[0].reason).toBe('zero_rate')
      expect(json.billing.uncredited_seat_ids).toEqual([]) // nothing owed back
    })
  }

  it('a location with no Stripe subscription does not fail the run', async () => {
    queueRun({
      removed: [SEAT()],
      groups: [{
        remainingOwnerSeats: 1,
        location: LOCATION_BILLING({ stripe_subscription_id: null }),
      }],
    })
    const res = await processCall({ seat_ids: ['seat2'] })
    expect(res.status).toBe(200)
    expect(adjust.fn).not.toHaveBeenCalled()
    const json = await res.json()
    expect(json.removed_count).toBe(1)
    expect(json.billing.groups[0].lines[0].reason).toBe('no_subscription')
  })

  it('a corporate/prepaid location is skipped as non_paying, not as a failure', async () => {
    queueRun({
      removed: [SEAT()],
      groups: [{ remainingOwnerSeats: 1, location: LOCATION_BILLING({ payment_source: 'prepaid_corporate' }) }],
    })
    const json = await (await processCall({ seat_ids: ['seat2'] })).json()
    expect(adjust.fn).not.toHaveBeenCalled()
    expect(json.billing.groups[0].lines[0].reason).toBe('non_paying')
  })

  it('credit timing is untouched: every delta is NEGATIVE, which is what selects create_prorations', async () => {
    queueRun({
      removed: [SEAT({ id: 'seat1' }), SEAT({ id: 'seat2' })],
      groups: [{ remainingOwnerSeats: 0, creditTiers: ['owner', 'manager'] }],
    })
    await processCall({ seat_ids: ['seat1', 'seat2'] })
    for (const c of stripeCalls()) expect(c.delta).toBeLessThan(0)
  })

  it('…and the sign is the ONLY thing choosing it — issue 161 credits at renewal, no refund', async () => {
    const { readFileSync } = await import('node:fs')
    const billing = readFileSync(new URL('./stripe-billing.ts', import.meta.url), 'utf8')
    expect(billing).toContain("delta > 0 ? 'always_invoice' : 'create_prorations'")
    // Nothing on the scheduled path names a proration behavior of its own, so a
    // batch removal cannot start refunding money Kevin decided not to refund.
    const batch = readFileSync(new URL('./seat-removal-batch.ts', import.meta.url), 'utf8')
    const route = readFileSync(
      new URL('../app/api/admin/process-scheduled-removals/route.ts', import.meta.url), 'utf8')
    expect(batch).not.toContain('proration_behavior')
    expect(batch).not.toContain('always_invoice')
    expect(route).not.toContain('proration_behavior')
  })

  it('does not write a second removal-pricing path — it calls the one issue 221 built', async () => {
    const { readFileSync } = await import('node:fs')
    const batch = readFileSync(new URL('./seat-removal-batch.ts', import.meta.url), 'utf8')
    expect(batch).toContain('quoteSeatRemoval')
    expect(batch).toContain('applySeatRemovalToStripe')
    // The co-owner rule is not restated here, and no price tier is resolved
    // here either — both come out of the quote. (Comments stripped: the header
    // NAMES planBillingLines to say where the rule lives, which is the point.)
    const code = batch.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('planBillingLines')
    expect(code).not.toContain('tier_prices')
  })
})

// ══════════════════════════════════════════════════════════════
// 5. The note allowlist — one list, both doors
// ══════════════════════════════════════════════════════════════
describe('issue 222 — the issue 219 note, under issue 221’s narrowed allowlist', () => {
  it('a failed credit writes the note onto the seat row', async () => {
    queueRun({
      removed: [SEAT({ id: 's5', tier: 'manager', notes: 'seat for Dana' })],
      groups: [{ creditTiers: ['manager'] }],
    })
    adjust.fn.mockRejectedValueOnce(new Error('subscription_item_missing'))

    const res = await processCall({ seat_ids: ['s5'] })
    expect(res.status).toBe(200) // the seat is already gone; billing never fails the run

    const note = seatNoteUpdates()[0]?.arg?.notes as string
    expect(note).toContain(SEAT_BILLING_MISMATCH_MARKER) // ONE marker for both directions
    expect(note).toContain('credit was NOT applied')
    expect(note).toContain('subscription_item_missing')
    expect(note).toContain('seat for Dana') // what the row already carried
  })

  it('a missing stripe_price_id is a misconfiguration, not a free seat — and is noted', async () => {
    queueRun({
      removed: [SEAT({ id: 's5', tier: 'manager' })],
      groups: [{ creditTiers: [{ tier: 'manager', stripePriceId: null }] }],
    })
    const json = await (await processCall({ seat_ids: ['s5'] })).json()
    expect(json.billing.groups[0].lines[0].reason).toBe('no_price')
    expect(seatNoteUpdates()[0]?.arg?.notes as string).toContain(SEAT_BILLING_MISMATCH_MARKER)
  })

  it('an unconfigured Stripe deployment is noted too — a live subscription was owed a credit', async () => {
    stripeOn.configured = false
    queueRun({
      removed: [SEAT({ id: 's5', tier: 'manager' })],
      groups: [{ creditTiers: [] }],
    })
    const json = await (await processCall({ seat_ids: ['s5'] })).json()
    expect(json.billing.groups[0].lines[0].reason).toBe('stripe_unconfigured')
    expect(seatNoteUpdates()).toHaveLength(1)
  })

  for (const [label, opts] of [
    ['no_subscription', { remainingOwnerSeats: 1, location: LOCATION_BILLING({ stripe_subscription_id: null }) }],
    ['non_paying', { remainingOwnerSeats: 1, location: LOCATION_BILLING({ payment_source: 'corporate' }) }],
  ] as const) {
    it(`${label} writes NO note — this location was never billed, so nothing is owed back`, async () => {
      queueRun({ removed: [SEAT()], groups: [opts as any] })
      await processCall({ seat_ids: ['seat2'] })
      expect(seatNoteUpdates()).toHaveLength(0)
    })
  }

  it('zero_rate writes NO note — the tier is free coming and going', async () => {
    queueRun({ removed: [SEAT({ id: 'z1', tier: 'readonly' })], groups: [{ creditTiers: [] }] })
    await processCall({ seat_ids: ['z1'] })
    expect(seatNoteUpdates()).toHaveLength(0)
  })

  it('every seat a failed line covered gets the note — the arithmetic differences counts, not rows', async () => {
    queueRun({
      removed: [SEAT({ id: 'seat1' }), SEAT({ id: 'seat2' })],
      groups: [{ remainingOwnerSeats: 0, creditTiers: ['owner', 'manager'] }],
    })
    adjust.fn.mockRejectedValue(new Error('card_declined'))
    const json = await (await processCall({ seat_ids: ['seat1', 'seat2'] })).json()
    // No single row is "the one" the owner line or the manager line belongs to,
    // so whoever reconciles this sees the gap on both.
    expect(seatNoteUpdates().map(u => u.arg.notes)).toHaveLength(2)
    expect(json.billing.uncredited_seat_ids.sort()).toEqual(['seat1', 'seat2'])
  })

  it('the allowlist is ONE list, shared with /api/seats DELETE', async () => {
    expect([...CREDIT_FAILED_REASONS].sort()).toEqual(['no_price', 'stripe_error', 'stripe_unconfigured'])
    for (const r of ['no_subscription', 'non_paying', 'zero_rate'] as const) {
      expect(creditWasOwed(r)).toBe(false)
    }
    for (const r of CREDIT_FAILED_REASONS) expect(creditWasOwed(r)).toBe(true)

    const { readFileSync } = await import('node:fs')
    const seatsRoute = readFileSync(new URL('../app/api/seats/route.ts', import.meta.url), 'utf8')
    // The immediate door reads the shared rule rather than keeping its own copy.
    expect(seatsRoute).toContain('creditWasOwed(')
    expect(seatsRoute).not.toContain("const CREDIT_FAILED_REASONS")
  })
})

// ══════════════════════════════════════════════════════════════
// 6. issue 216's scoping is not weakened, and the ordering is stated
// ══════════════════════════════════════════════════════════════
describe('issue 222 — scope and ordering', () => {
  it('no scope is still a 400, and a 400 credits nothing', async () => {
    h.enqueue('hub_users', SUPER_ADMIN)
    const res = await processCall({})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('scope_required')
    expect(adjust.fn).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })

  it('nothing due means nothing credited — an empty run is not a Stripe call', async () => {
    queueRun({ removed: [] })
    const json = await (await processCall({ scope: 'all' })).json()
    expect(json.removed_count).toBe(0)
    expect(adjust.fn).not.toHaveBeenCalled()
    expect(json.billing.groups).toEqual([])
  })

  it('THE SEATS ARE DEACTIVATED FIRST — the credit is priced from what remains', async () => {
    // Not an implementation detail: quoteSeatRemoval counts the owner seats
    // still ACTIVE and adds the removal back, so the co-owner arithmetic is only
    // correct once the rows are inactive. The UPDATE is therefore the first
    // write and the credit follows it, which is also the order /api/seats DELETE
    // uses. What that leaves open — seat gone, credit missing — is the failure
    // the note and the response exist to make visible.
    queueRun({ removed: [SEAT()], groups: [{ remainingOwnerSeats: 1, creditTiers: ['manager'] }] })
    await processCall({ seat_ids: ['seat2'] })

    const seatUpdate = h.state.updates.find(u => u.table === 'subscription_seats')
    expect(seatUpdate?.arg?.status).toBe('inactive')
    // The deactivating UPDATE is logged before the first Stripe call happens.
    expect(h.state.updates[0].arg.status).toBe('inactive')
    expect(adjust.fn).toHaveBeenCalled()
  })

  it('a removed row with no location or tier is reported, not silently skipped', async () => {
    queueRun({ removed: [{ id: 'orphan', location_id: null, tier: null }] })
    const json = await (await processCall({ seat_ids: ['orphan'] })).json()
    expect(json.removed_count).toBe(1)
    expect(json.billing.unbillable_seat_ids).toEqual(['orphan'])
    expect(adjust.fn).not.toHaveBeenCalled()
  })

  it('creditRemovedSeats never throws — the seats are already gone', async () => {
    // Direct, because the route must be able to trust this.
    h.enqueue('tier_prices', TIER_ROWS)
    h.state.queue.push({
      table: 'locations',
      resp: { error: null, get data(): any { throw new Error('connection reset') } } as any,
    })
    const out = await creditRemovedSeats([SEAT({ id: 'x', tier: 'manager' })])
    expect(out.groups[0].applied).toBe(false)
    expect(out.uncredited_seat_ids).toEqual(['x'])
  })
})

function byPrice(a: { priceId: string }, b: { priceId: string }) {
  return a.priceId.localeCompare(b.priceId)
}
