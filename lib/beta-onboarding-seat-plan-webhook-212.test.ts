// @vitest-environment node
//
// issue 212 — the half that matters most: the seats that were BILLED must
// appear in subscription_seats.
//
// Fort Lauderdale paid $550, activated, and received one seat. The owner had
// selected three. activateLocationSubscription creates exactly one owner seat
// and never did anything else, so everything beyond it silently evaporated.
//
// This pins the seat side end-to-end against a stateful fake of
// subscription_seats — the assertions are about the rows that actually exist
// afterwards, not about which mock was called — covering:
//   • checkout.session.completed creates all three seats, the co-owner recorded
//     at the manager rate it was billed at
//   • a redelivered webhook creates NO duplicates
//   • an owner-only session, and a pre-212 session with no plan metadata, both
//     behave exactly as they did before
//   • the 2-owner cap is re-checked against live rows, not just the plan
//   • issue 182's active-location link still mints no seat at all
//   • the zero-charge prepaid path (issue 171) charges nothing and still seats
//     the whole selection
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'

const SECRET = 'whsec_test_secret_for_unit_tests'
const LOC_UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

// ── A stateful fake of the tables these paths touch ───────────
// Behaves rather than replays: inserts append (with the DB's status='active'
// default), selects filter, so "how many active owner seats exist now" is a
// real question with a real answer.
const h = vi.hoisted(() => {
  const state = {
    seats: [] as any[],
    location: null as any,
    tierPrices: [] as any[],
    events: [] as any[],
    seq: 0,
  }

  const reset = () => {
    state.seats = []
    state.events = []
    state.seq = 0
    state.tierPrices = [
      { id: 'owner', price_annual: 550, stripe_price_id: 'price_owner' },
      { id: 'manager', price_annual: 400, stripe_price_id: 'price_mgr' },
      { id: 'light', price_annual: 0, stripe_price_id: null },
      { id: 'readonly', price_annual: 50, stripe_price_id: 'price_ro' },
    ]
    state.location = {
      id: LOC_UUID, name: 'Fort Lauderdale', location_id: 'loc_fortlauderdale',
      subscription_status: 'deferred', payment_source: 'direct',
      paid_through_date: null, stripe_customer_id: 'cus_ftl', stripe_subscription_id: null,
    }
  }

  const rowsFor = (table: string): any[] => {
    if (table === 'subscription_seats') return state.seats
    if (table === 'locations') return state.location ? [state.location] : []
    if (table === 'tier_prices') return state.tierPrices
    if (table === 'stripe_webhook_events') return state.events
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
vi.mock('@/lib/slack', () => ({ postSlackMessage: vi.fn(async () => {}) }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own-1', email: 'owner@ftl.test', full_name: 'FTL Owner', phone: null })),
}))
vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => true, getStripe: vi.fn() }))
vi.mock('@/lib/stripe-billing', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    // The activation branch reads the real period end off the subscription.
    retrieveSubscription: vi.fn(async () => ({
      id: 'sub_212', customer: 'cus_ftl',
      items: { data: [{ current_period_end: Math.floor(Date.UTC(2027, 7, 14) / 1000) }] },
    })),
  }
})

// complete-onboarding's auth (the owner of the target location).
// The literal is repeated rather than referencing LOC_UUID: vi.hoisted factories
// run before module-level consts are initialised.
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

import { POST as WEBHOOK } from '@/app/api/webhooks/stripe/route'
import { POST as COMPLETE_ONBOARDING } from '@/app/api/locations/[id]/complete-onboarding/route'

// ── Event + request helpers ───────────────────────────────────
function postWebhook(event: any) {
  const rawBody = JSON.stringify(event)
  const t = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', SECRET).update(`${t}.${rawBody}`, 'utf8').digest('hex')
  return WEBHOOK(new Request('http://test/api/webhooks/stripe', {
    method: 'POST', body: rawBody, headers: { 'stripe-signature': `t=${t},v1=${sig}` },
  }) as any)
}

// A completed onboarding checkout. `seat_plan` is what the checkout route
// stamped on the session when it built the line items.
const activationEvent = (over: { seatPlan?: string | null; eventId?: string; sessionId?: string; amount?: number } = {}) => {
  const metadata: Record<string, string> = { tier: 'owner', location_id: LOC_UUID }
  if (over.seatPlan !== null && over.seatPlan !== undefined) metadata.seat_plan = over.seatPlan
  return {
    id: over.eventId ?? 'evt_212',
    type: 'checkout.session.completed',
    data: { object: {
      id: over.sessionId ?? 'cs_212',
      payment_intent: null,
      client_reference_id: LOC_UUID,
      metadata,
      amount_total: over.amount ?? 135000,
      currency: 'usd',
      payment_status: 'paid',
      subscription: 'sub_212',
      customer: 'cus_ftl',
    } },
  }
}

const activeSeats = () => h.state.seats.filter(s => s.status === 'active')
const seatsAtTier = (tier: string) => activeSeats().filter(s => s.tier === tier)

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
})
afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET })

// ── The fix ───────────────────────────────────────────────────
describe('issue 212 — the webhook creates every seat that was billed', () => {
  it('Fort Lauderdale: owner:2,manager:1 produces THREE seats, not one', async () => {
    const res = await postWebhook(activationEvent({ seatPlan: 'owner:2,manager:1' }))
    expect(res.status).toBe(200)

    expect(activeSeats()).toHaveLength(3)
    expect(seatsAtTier('owner')).toHaveLength(2)
    expect(seatsAtTier('manager')).toHaveLength(1)

    // The owner's own seat is claimed by her; the two she bought sit unassigned
    // in the pool, which is exactly what Settings needs to offer both invites.
    expect(seatsAtTier('owner').filter(s => s.user_id === 'own-1')).toHaveLength(1)
    expect(activeSeats().filter(s => s.user_id === null)).toHaveLength(2)

    // The location actually activated.
    expect(h.state.location.subscription_status).toBe('active')
  })

  it('records the co-owner seat at the MANAGER rate it was billed at', async () => {
    await postWebhook(activationEvent({ seatPlan: 'owner:2,manager:1' }))
    const coOwner = seatsAtTier('owner').find(s => s.user_id === null)
    expect(coOwner).toBeDefined()
    expect(coOwner.prorated_cost).toBe(40000)          // $400, the manager rate
    expect(coOwner.notes).toContain('co-owner seat, billed at the manager rate')

    const manager = seatsAtTier('manager')[0]
    expect(manager.prorated_cost).toBe(40000)
  })

  it('a redelivered webhook creates NO duplicate seats', async () => {
    await postWebhook(activationEvent({ seatPlan: 'owner:2,manager:1' }))
    expect(activeSeats()).toHaveLength(3)

    // Same session, a different event id — i.e. past the event-id replay guard,
    // the way a delivery that died mid-way is re-run in full.
    const res = await postWebhook(activationEvent({ seatPlan: 'owner:2,manager:1', eventId: 'evt_212_retry' }))
    expect(res.status).toBe(200)
    expect(activeSeats()).toHaveLength(3)
    expect(seatsAtTier('owner')).toHaveLength(2)
    expect(seatsAtTier('manager')).toHaveLength(1)
  })

  it('a plan with a co-owner but no manager creates two seats', async () => {
    await postWebhook(activationEvent({ seatPlan: 'owner:2', amount: 95000 }))
    expect(activeSeats()).toHaveLength(2)
    expect(seatsAtTier('owner')).toHaveLength(2)
  })

  // ── Regression guards ──────────────────────────────────────
  it('owner-only (seat_plan owner:1) creates exactly ONE seat, as before', async () => {
    await postWebhook(activationEvent({ seatPlan: 'owner:1', amount: 55000 }))
    expect(activeSeats()).toHaveLength(1)
    expect(seatsAtTier('owner')).toHaveLength(1)
  })

  it('a pre-212 session with NO seat_plan metadata behaves exactly as it did', async () => {
    await postWebhook(activationEvent({ seatPlan: null, amount: 55000 }))
    expect(activeSeats()).toHaveLength(1)
    expect(seatsAtTier('owner')).toHaveLength(1)
    expect(h.state.location.subscription_status).toBe('active')
  })

  it('corrupted seat_plan metadata mints nothing extra rather than guessing', async () => {
    await postWebhook(activationEvent({ seatPlan: 'owner:99,manager:4' }))
    expect(activeSeats()).toHaveLength(1)
  })

  it('the 2-owner cap is re-checked against live rows — a pre-allocated owner seat is respected', async () => {
    // The invite-owner path pre-allocated an unclaimed owner seat before
    // onboarding. Activation claims it, so a plan asking for a 2nd owner would
    // be the location's 2nd — allowed — but a 3rd must never appear.
    h.state.seats.push({
      id: 'pre-1', location_id: LOC_UUID, tier: 'owner', user_id: null,
      status: 'active', notes: 'Corp-sponsored owner seat', prorated_cost: 0,
    })
    await postWebhook(activationEvent({ seatPlan: 'owner:2,manager:1' }))
    expect(seatsAtTier('owner')).toHaveLength(2)      // claimed one + the co-owner
    expect(seatsAtTier('manager')).toHaveLength(1)
    expect(activeSeats()).toHaveLength(3)
  })

  it('issue 182 — an already-active location link still mints NO seat', async () => {
    h.state.location.subscription_status = 'active'
    h.state.location.paid_through_date = '2027-05-01'
    const res = await postWebhook(activationEvent({ seatPlan: 'owner:2,manager:1', amount: 0 }))
    expect(res.status).toBe(200)
    expect(activeSeats()).toHaveLength(0)
  })
})

// ── The zero-charge path (issue 171 prepaid / corporate) ──────
describe('issue 212 — a prepaid location charges nothing and still gets its seats', () => {
  function completeOnboarding(body: any) {
    return COMPLETE_ONBOARDING(
      new NextRequest('https://app.test/api/locations/x/complete-onboarding', {
        method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
      }),
      { params: { id: LOC_UUID } },
    )
  }

  beforeEach(() => {
    // issue 171: paid through a FUTURE date ⇒ owes nothing today, and the
    // issue-167 gate steps aside for exactly this case.
    h.state.location.paid_through_date = '2027-02-27'
    auth.hubUser = { role: 'owner', location_id: LOC_UUID, email: 'owner@ftl.test' }
  })

  it('activates with all three seats and no charge recorded on any of them', async () => {
    const res = await completeOnboarding({
      seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }],
      prorated_cost: 0,
    })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)

    expect(activeSeats()).toHaveLength(3)
    expect(seatsAtTier('owner')).toHaveLength(2)
    expect(seatsAtTier('manager')).toHaveLength(1)
    expect(h.state.location.subscription_status).toBe('active')

    // Nothing was charged for the extra seats, so nothing is recorded as paid.
    // issue 225 — that is now written as 0 rather than null: the tiers are
    // priced, so "this cost nothing" is a fact we know, and it is the same
    // answer the activation seat on this very activation records. null is
    // reserved for the case where no rate exists to judge by.
    const extras = activeSeats().filter(s => s.user_id === null)
    expect(extras).toHaveLength(2)
    for (const s of extras) expect(s.prorated_cost).toBe(0)
  })

  it('a retried confirm adds no duplicate seats', async () => {
    await completeOnboarding({ seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }] })
    expect(activeSeats()).toHaveLength(3)
    await completeOnboarding({ seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }] })
    expect(activeSeats()).toHaveLength(3)
  })

  it('no seats in the body still activates with the single owner seat, as before', async () => {
    const res = await completeOnboarding({})
    expect(res.status).toBe(200)
    expect(activeSeats()).toHaveLength(1)
    expect(seatsAtTier('owner')).toHaveLength(1)
  })

  it('an over-cap selection is refused (409) and nothing is activated', async () => {
    const res = await completeOnboarding({ seats: [{ tier: 'owner', count: 3 }] })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('max_owners_reached')
    expect(activeSeats()).toHaveLength(0)
    expect(h.state.location.subscription_status).toBe('deferred')
  })
})
