// @vitest-environment node
//
// issue 220 — the third and last site where the client's arithmetic became the
// permanent record of what a seat cost.
//
// /api/locations/[id]/complete-onboarding took `prorated_cost` out of the
// request body and handed it to activateLocationSubscription, which wrote it
// verbatim to the owner's activation seat. Same column, same defect as issues
// 217 and 219, and narrower only because issue 167's gate means the locations
// that reach it are the ones that owe nothing.
//
// What is pinned here:
//   • a client-supplied prorated_cost is IGNORED, whatever it says
//   • a prepaid activation (issue 171) records 0 and is still charged $0 —
//     the case where the old proration is most confidently computable and most
//     wrong, because the future paid_through_date makes it a big number
//   • an unpriced owner tier records NOTHING rather than 0, so "free" and
//     "we could not work it out" stay distinguishable in the column
//   • the non-paying and super_admin cases record 0 the same way
//   • issue 212's seats and issue 167's gate are untouched
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const LOC_UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

// ── A stateful fake of the tables this path touches ───────────
// Behaves rather than replays, so "what does the seat row actually hold
// afterwards" is a real question with a real answer.
const h = vi.hoisted(() => {
  const state = {
    seats: [] as any[],
    location: null as any,
    tierPrices: [] as any[],
    seq: 0,
  }

  const reset = () => {
    state.seats = []
    state.seq = 0
    state.tierPrices = [
      { id: 'owner', price_annual: 550, stripe_price_id: null },
      { id: 'manager', price_annual: 400, stripe_price_id: null },
      { id: 'light', price_annual: 0, stripe_price_id: null },
      { id: 'readonly', price_annual: 50, stripe_price_id: null },
    ]
    state.location = {
      id: LOC_UUID, name: 'Fort Lauderdale', location_id: 'loc_fortlauderdale',
      subscription_status: 'deferred', payment_source: 'direct',
      paid_through_date: null, stripe_customer_id: null, stripe_subscription_id: null,
    }
  }

  const rowsFor = (table: string): any[] => {
    if (table === 'subscription_seats') return state.seats
    if (table === 'locations') return state.location ? [state.location] : []
    if (table === 'tier_prices') return state.tierPrices
    return []
  }

  const makeBuilder = (table: string) => {
    const filters: Array<(r: any) => boolean> = []
    let pendingInsert: any[] | null = null
    let pendingUpdate: any | null = null
    let limit: number | null = null

    const apply = () => rowsFor(table).filter(r => filters.every(f => f(r)))

    const resolve = () => {
      if (pendingInsert) {
        const created = pendingInsert.map(r => ({
          id: `row-${++state.seq}`,
          status: 'active',              // the column default
          user_id: null,
          removed_at: null,
          prorated_cost: null,
          added_at: new Date(2026, 7, 14).toISOString(),
          added_by: null,
          notes: null,
          is_primary: false,
          scheduled_removal_at: null,
          ...r,
        }))
        rowsFor(table).push(...created)
        return { data: created, error: null, count: created.length }
      }
      if (pendingUpdate) {
        const hit = apply()
        for (const r of hit) Object.assign(r, pendingUpdate)
        return { data: hit, error: null, count: hit.length }
      }
      let out = apply()
      if (limit != null) out = out.slice(0, limit)
      return { data: out, error: null, count: out.length }
    }

    const b: any = {}
    b.select = () => b
    b.eq = (k: string, v: any) => { filters.push(r => r?.[k] === v); return b }
    b.neq = (k: string, v: any) => { filters.push(r => r?.[k] !== v); return b }
    b.is = (k: string, v: any) => { filters.push(r => (r?.[k] ?? null) === v); return b }
    b.in = (k: string, vs: any[]) => { filters.push(r => vs.includes(r?.[k])); return b }
    b.like = (k: string, pattern: string) => {
      const needle = String(pattern).replace(/^%|%$/g, '')
      filters.push(r => typeof r?.[k] === 'string' && r[k].includes(needle))
      return b
    }
    b.not = () => b
    b.or = () => b
    b.order = () => b
    b.limit = (n: number) => { limit = n; return b }
    b.insert = (arg: any) => { pendingInsert = Array.isArray(arg) ? arg : [arg]; return b }
    b.update = (arg: any) => { pendingUpdate = arg; return b }
    b.delete = () => b
    b.single = async () => { const r = resolve(); return { data: r.data?.[0] ?? null, error: r.error } }
    b.maybeSingle = async () => { const r = resolve(); return { data: r.data?.[0] ?? null, error: r.error } }
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }

  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

// The route's auth. The literals are repeated rather than referencing LOC_UUID:
// vi.hoisted factories run before module-level consts are initialised.
const auth = vi.hoisted(() => ({
  user: { id: 'own-1' } as any,
  hubUser: { role: 'owner', location_id: 'a1b2c3d4-1111-4222-8333-444455556666', email: 'owner@ftl.test' } as any,
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: auth.hubUser }) }) }) }),
  }),
}))

// Stripe is CONFIGURED throughout, so issue 167's gate is live and every case
// below reaches the route for a real reason rather than because Stripe is dark.
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => true, getStripe: vi.fn() }))

import { POST as COMPLETE_ONBOARDING } from '@/app/api/locations/[id]/complete-onboarding/route'
import { quoteActivationSeat } from '@/lib/seat-cost'

function completeOnboarding(body: any) {
  return COMPLETE_ONBOARDING(
    new NextRequest('https://app.test/api/locations/x/complete-onboarding', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }),
    { params: { id: LOC_UUID } },
  )
}

const activeSeats = () => h.state.seats.filter(s => s.status === 'active')
const ownerSeat = () => activeSeats().find(s => s.tier === 'owner' && s.user_id === 'own-1')

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ── The fix ───────────────────────────────────────────────────
describe("issue 220 — the client's number is not the record", () => {
  beforeEach(() => {
    // issue 171: paid through a FUTURE date ⇒ owes nothing today, and the
    // issue-167 gate steps aside for exactly this case.
    h.state.location.paid_through_date = '2027-02-27'
  })

  it('ignores a client-supplied prorated_cost outright', async () => {
    const res = await completeOnboarding({ prorated_cost: 99999999, seats: [{ tier: 'owner', count: 1 }] })
    expect(res.status).toBe(200)

    const seat = ownerSeat()
    expect(seat).toBeDefined()
    expect(seat.prorated_cost).toBe(0)
    expect(seat.prorated_cost).not.toBe(99999999)
  })

  it('records the disagreement on the row instead of silently discarding it', async () => {
    await completeOnboarding({ prorated_cost: 55000, seats: [{ tier: 'owner', count: 1 }] })
    const seat = ownerSeat()
    expect(seat.notes).toContain('issue 217 cost divergence')
    expect(seat.notes).toContain('client sent 55000c/seat')
    expect(seat.notes).toContain('server recorded 0c')
  })

  it('a client that sends nothing produces no divergence note', async () => {
    await completeOnboarding({ seats: [{ tier: 'owner', count: 1 }] })
    const seat = ownerSeat()
    expect(seat.notes).not.toContain('divergence')
    expect(seat.notes).toContain('issue 220: activation charged nothing')
  })

  it('a prepaid activation records 0 and stays $0 — the proration is never written', async () => {
    // The old code would have written whatever the client computed against this
    // future anchor. quoteSeatPurchase against the SAME anchor still returns a
    // healthy positive figure — which is exactly the number that must not land
    // on the row, because nothing was charged.
    const wouldHaveCost = await quoteActivationSeat({ locationId: LOC_UUID })
    expect(wouldHaveCost.quote.totalCents).toBeGreaterThan(0)

    const res = await completeOnboarding({ prorated_cost: wouldHaveCost.quote.totalCents, seats: [{ tier: 'owner', count: 1 }] })
    const json = await res.json()

    expect(ownerSeat().prorated_cost).toBe(0)
    expect(json.cost.recorded_cents).toBe(0)
    expect(json.cost.charged_cents).toBe(0)
    // issue 171 intact: the location activated without being sent to Stripe.
    expect(h.state.location.subscription_status).toBe('active')
    expect(h.state.location.paid_through_date).toBe('2027-02-27')
  })

  it('an unpriced owner tier records NOTHING rather than 0', async () => {
    h.state.tierPrices = h.state.tierPrices.filter(t => t.id !== 'owner')

    const res = await completeOnboarding({ prorated_cost: 55000, seats: [{ tier: 'owner', count: 1 }] })
    const json = await res.json()

    const seat = ownerSeat()
    expect(seat.prorated_cost).toBeNull()
    expect(seat.notes).toContain('no tier_prices row')
    expect(json.cost.recorded_cents).toBeNull()
    expect(json.cost.unpriced_reason).toBe('tier_not_priced')
    // And it is still an activation — an absent rate never refuses the seat.
    expect(h.state.location.subscription_status).toBe('active')
  })

  it('a $0 owner tier is honestly free — 0, not null', async () => {
    h.state.tierPrices = h.state.tierPrices.map(t => (t.id === 'owner' ? { ...t, price_annual: 0 } : t))
    await completeOnboarding({ seats: [{ tier: 'owner', count: 1 }] })
    expect(ownerSeat().prorated_cost).toBe(0)
  })
})

// ── The other cases that reach this route ─────────────────────
describe('issue 220 — every zero-charge case records the same 0', () => {
  it('a non-paying payment_source records 0', async () => {
    h.state.location.payment_source = 'corporate_sponsored'
    const res = await completeOnboarding({ prorated_cost: 55000, seats: [{ tier: 'owner', count: 1 }] })
    expect(res.status).toBe(200)
    expect(ownerSeat().prorated_cost).toBe(0)
  })

  it('an unconfigured owner tier (no stripe_price_id) records 0', async () => {
    // payment_source 'direct', no paid_through_date, Stripe configured but the
    // owner tier has no price id — issue 167's gate stays open, and the honest
    // record is still 0 even though there is no renewal anchor to prorate to.
    expect(h.state.location.paid_through_date).toBeNull()
    const res = await completeOnboarding({ prorated_cost: 55000, seats: [{ tier: 'owner', count: 1 }] })
    expect(res.status).toBe(200)
    expect(ownerSeat().prorated_cost).toBe(0)
  })

  it('super_admin acting on an owner-pays location records 0, not the body', async () => {
    auth.user = { id: 'admin-1' }
    auth.hubUser = { role: 'super_admin', location_id: null, email: 'kevin@bmave.com' }
    h.state.tierPrices = h.state.tierPrices.map(t => (t.id === 'owner' ? { ...t, stripe_price_id: 'price_owner' } : t))

    const res = await completeOnboarding({ prorated_cost: 42424242, seats: [{ tier: 'owner', count: 1 }] })
    expect(res.status).toBe(200)

    // The seat is unclaimed (super_admin is not the owner), so find it by tier.
    const seat = activeSeats().find(s => s.tier === 'owner')
    expect(seat.prorated_cost).toBe(0)

    auth.user = { id: 'own-1' }
    auth.hubUser = { role: 'owner', location_id: LOC_UUID, email: 'owner@ftl.test' }
  })
})

// ── What must not have changed ────────────────────────────────
describe('issue 220 — the guards around it are untouched', () => {
  it("issue 167: an owner-pays location that CAN be charged still gets 409, no seat", async () => {
    h.state.tierPrices = h.state.tierPrices.map(t => (t.id === 'owner' ? { ...t, stripe_price_id: 'price_owner' } : t))
    const res = await completeOnboarding({ prorated_cost: 0, seats: [{ tier: 'owner', count: 1 }] })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('stripe_checkout_required')
    expect(activeSeats()).toHaveLength(0)
    expect(h.state.location.subscription_status).toBe('deferred')
  })

  it("issue 212: the selection's extra seats are still created, and now agree with the owner's", async () => {
    h.state.location.paid_through_date = '2027-02-27'
    const res = await completeOnboarding({
      prorated_cost: 135000,
      seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }],
    })
    expect(res.status).toBe(200)
    expect(activeSeats()).toHaveLength(3)

    // issue 225 — the activation seat's 0 and the add-ons' now match. issue
    // 220 left this inconsistent on purpose and said so; this closes it.
    expect(ownerSeat().prorated_cost).toBe(0)
    const extras = activeSeats().filter(s => s.user_id === null)
    expect(extras).toHaveLength(2)
    for (const s of extras) expect(s.prorated_cost).toBe(0)
  })

  it('a retried confirm neither re-records nor duplicates', async () => {
    h.state.location.paid_through_date = '2027-02-27'
    await completeOnboarding({ seats: [{ tier: 'owner', count: 2 }] })
    expect(activeSeats()).toHaveLength(2)

    await completeOnboarding({ prorated_cost: 99999999, seats: [{ tier: 'owner', count: 2 }] })
    expect(activeSeats()).toHaveLength(2)
    expect(ownerSeat().prorated_cost).toBe(0)
  })

  it('a pre-allocated owner seat is CLAIMED, and its recorded cost is left alone', async () => {
    // The invite-owner path pre-allocates an unclaimed owner seat at 0 with its
    // own note. Activation claims it rather than inserting, so nothing issue 220
    // computes is written to it.
    h.state.location.paid_through_date = '2027-02-27'
    h.state.seats.push({
      id: 'pre-1', location_id: LOC_UUID, tier: 'owner', user_id: null,
      status: 'active', notes: 'Corp-sponsored owner seat', prorated_cost: 0,
    })
    await completeOnboarding({ prorated_cost: 99999999, seats: [{ tier: 'owner', count: 1 }] })

    const claimed = h.state.seats.find(s => s.id === 'pre-1')
    expect(claimed.user_id).toBe('own-1')
    expect(claimed.prorated_cost).toBe(0)
    expect(claimed.notes).toBe('Corp-sponsored owner seat')
    expect(activeSeats()).toHaveLength(1)
  })
})

// ── The unit the route leans on ───────────────────────────────
describe('issue 220 — quoteActivationSeat', () => {
  it('differences from zero: a fresh location bills the owner line, not manager', async () => {
    const q = await quoteActivationSeat({ locationId: LOC_UUID })
    expect(q.quote.billingLines).toEqual([{ billingTier: 'owner', quantity: 1, annualUnitCents: 55000 }])
    expect(q.recordedCents).toBe(0)
  })

  it('a missing renewal anchor does NOT withhold the figure — an activation is not prorated', async () => {
    expect(h.state.location.paid_through_date).toBeNull()
    const q = await quoteActivationSeat({ locationId: LOC_UUID })
    // The underlying purchase quote cannot price itself...
    expect(q.quote.totalCents).toBeNull()
    expect(q.quote.unpricedReason).toBe('no_renewal_anchor')
    // ...but $0 is still the honest record of an activation that charged nothing.
    expect(q.recordedCents).toBe(0)
    expect(q.unpricedReason).toBeUndefined()
  })

  it('reports the annual rate even when nothing was charged', async () => {
    const q = await quoteActivationSeat({ locationId: LOC_UUID })
    expect(q.quote.billingLines[0].annualUnitCents).toBe(55000)
  })
})
