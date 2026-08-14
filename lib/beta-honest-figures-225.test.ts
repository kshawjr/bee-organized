// @vitest-environment node
//
// issue 225 — TWO SMALL HONESTY REPAIRS, UNRELATED TO EACH OTHER.
//
// ── PART 1: say "about" where the figure can differ ──
// We prorate in whole days against the location's paid_through_date. Stripe
// prorates to the SECOND against its own subscription period. They agree to
// within cents and never exactly, so a screen reading "$372.60 today" can
// produce an invoice reading $372.19.
//
// Kevin's call was not to close that with an upcoming-invoice call — a round
// trip on every tier selection, with no answer at all on the 32-of-55
// locations that have no subscription, to chase pennies. So the words carry
// it. What matters is that the hedge lands ONLY where Stripe does the
// arithmetic; hedging a number we control is its own small dishonesty,
// because a hedge on an exact figure reads as doubt about a fact we know.
//
//   charge             hedged — Stripe settles this one
//   invoiced           NOT hedged — we bill this amount ourselves
//   free_tier          NOT hedged — a $0 tier is exactly free
//   charge_zero_today  NOT hedged — exactly nothing today
//   charge_unpriced    NOT hedged — it names no figure to soften
//   the annual line    NOT hedged — the catalog price, not a proration
//
// ── PART 2: null vs 0 for a free seat ──
// Within ONE zero-charge activation the owner's seat recorded prorated_cost 0
// (issue 220) while addSeatsForPlan's extras recorded null (issue 212). Both
// meant "no charge", so a query had to know which code path minted each row
// to read either answer.
//
// The two values are genuinely different facts, and issue 220 leaned on the
// difference: 0 is "this cost nothing", null is "we could not work out what
// this cost". A free seat on a PRICED tier is the first. So the extras record
// 0 — and a tier with no tier_prices row still records nothing, because there
// the two meanings really are the same silence.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const LOC_UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

// ── A stateful fake of the tables the activation path touches ──
// Same shape as issues 212 and 220 use: it behaves rather than replays, so
// "what does the row actually hold afterwards" has a real answer.
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
      // issue 171: prepaid through a FUTURE date ⇒ owes nothing today, which
      // is what lets issue 167's gate step aside and this route run at all.
      paid_through_date: '2027-02-27',
      stripe_customer_id: null, stripe_subscription_id: null,
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
          status: 'active',
          user_id: null,
          removed_at: null,
          prorated_cost: null,          // the column default — an absent write stays null
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

vi.mock('@/lib/stripe', () => ({ stripeConfigured: () => true, getStripe: vi.fn() }))

import { seatChargeNotice, seatPickerPrice } from './seat-charge-notice'
import { POST as COMPLETE_ONBOARDING } from '@/app/api/locations/[id]/complete-onboarding/route'

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────
// PART 1 — the hedge, and its limits
// ─────────────────────────────────────────────────────────────

const RENEWAL = '2027-08-10'

// $372.60 today against a $400/yr Hive Manager — Kevin's own example, and the
// one whose invoice came back at $372.19.
const notice = (over: any = {}, preview: any = { willCharge: true, reason: null }) =>
  seatChargeNotice({
    quote: { totalCents: 37260, renewalDate: RENEWAL, ...over },
    preview,
    seatWord: 'seat',
  })

const picker = (over: any = {}, preview: any = { willCharge: true, reason: null }) =>
  seatPickerPrice({
    quote: { totalCents: 37260, annualTotalCents: 40000, renewalDate: RENEWAL, ...over },
    preview,
  })

// "Reads as approximate" is a claim about words, so it is tested as one. A
// figure is hedged when the sentence carrying it also carries a softener.
// Deliberately a small closed list rather than a vibe check: the point of
// this issue is that the softener appears in one place and nowhere else, and
// a loose pattern could not tell the difference.
const APPROX = /\babout\b|\baround\b|\broughly\b|a few cents either side/i

describe('issue 225 — the charge case reads as an approximation', () => {
  it('the confirm heading hedges the figure it names', () => {
    const n = notice()
    expect(n.heading).toMatch(APPROX)
    expect(n.heading).toContain('$372.60')
  })

  it('the confirm body says where the exact number comes from, without saying "prorated"', () => {
    const body = notice().body
    expect(body).toMatch(/receipt/i)
    expect(body.toLowerCase()).not.toContain('prorat')
  })

  it('the confirm BUTTON hedges too — it is the last thing read before committing', () => {
    expect(notice().confirmLabel).toBe('Confirm & Pay about $372.60')
  })

  it('the picker hedges the today figure', () => {
    expect(picker().today).toBe('About $372.60 today')
  })

  it('the figure is still named — a hedge is not a refusal to say the number', () => {
    expect(notice().heading).toContain('$372.60')
    expect(picker().today).toContain('$372.60')
  })
})

describe('issue 225 — the annual figure is exact and stays unhedged', () => {
  it('the picker\'s renewal line carries no softener', () => {
    expect(picker().renews).toBe('Then $400 a year, starting Aug 10, 2027')
    expect(picker().renews).not.toMatch(APPROX)
  })

  it('every case that names a yearly price names it flatly', () => {
    const withAnnualLine = [
      picker(),
      picker({ totalCents: null, renewalDate: null }),
      picker({ totalCents: 0 }),
      picker({}, { willCharge: false, reason: 'no_subscription' }),
    ]
    for (const p of withAnnualLine) expect(p.renews).not.toMatch(APPROX)
  })

  it('the confirm notice hedges TODAY\'s figure and nothing else in the sentence', () => {
    const body = notice().body
    // The softening is attached to today's amount, explicitly.
    expect(body).toMatch(/a few cents either side of \$372\.60/)
    // The renewal clause states a plain fact and carries no qualifier.
    expect(body).toMatch(/included in your usual renewal/i)
    expect(body).not.toMatch(/about (a year|your renewal|the renewal)/i)
  })
})

// The five cases whose figures are ours (or absent). None of them may soften.
//   invoiced           we name an amount WE will bill — our number is the number
//   free_tier          a $0 tier is exactly free
//   charge_zero_today  exactly nothing today
//   charge_unpriced    names no figure at all, so there is nothing to soften
//   covered            somebody else pays; no figure either
const EXACT_NOTICES = {
  invoiced:          notice({}, { willCharge: false, reason: 'no_subscription' }),
  free_tier:         notice({ totalCents: 0 }, { willCharge: false, reason: 'zero_rate' }),
  charge_zero_today: notice({ totalCents: 0 }),
  charge_unpriced:   notice({ totalCents: null, renewalDate: null }),
  covered:           notice({}, { willCharge: false, reason: 'non_paying' }),
} as const

const EXACT_PICKER = {
  invoiced:          picker({}, { willCharge: false, reason: 'no_subscription' }),
  free_tier:         picker({ totalCents: 0, annualTotalCents: 0 }, { willCharge: false, reason: 'zero_rate' }),
  charge_zero_today: picker({ totalCents: 0 }),
  charge_unpriced:   picker({ totalCents: null, renewalDate: null }),
  covered:           picker({}, { willCharge: false, reason: 'non_paying' }),
} as const

describe('issue 225 — the exact cases stay exact', () => {
  it('each case is still classified as itself — the hedge changed words, not the taxonomy', () => {
    for (const [name, n] of Object.entries(EXACT_NOTICES)) expect(n.kind).toBe(name)
    for (const [name, p] of Object.entries(EXACT_PICKER)) expect(p.kind).toBe(name)
  })

  it('no exact confirm notice softens its figure', () => {
    for (const [name, n] of Object.entries(EXACT_NOTICES)) {
      expect(`${name}: ${n.heading} ${n.body}`).not.toMatch(APPROX)
    }
  })

  it('no exact picker label softens its figure', () => {
    for (const [name, p] of Object.entries(EXACT_PICKER)) {
      expect(`${name}: ${p.today} ${p.renews}`).not.toMatch(APPROX)
    }
  })

  it('the invoiced case still names the amount flatly — we bill it ourselves', () => {
    expect(EXACT_NOTICES.invoiced.body).toContain('$372.60')
    expect(EXACT_PICKER.invoiced.today).toBe("$372.60 — we'll invoice you")
  })

  it('a $0 tier is free with no qualifier attached', () => {
    expect(EXACT_PICKER.free_tier.today).toBe('Free')
    expect(EXACT_NOTICES.free_tier.heading).toBe('This one is free')
  })

  it('charge_zero_today is nothing today, stated flatly', () => {
    expect(EXACT_PICKER.charge_zero_today.today).toBe('Nothing to pay today')
    expect(EXACT_NOTICES.charge_zero_today.heading).toBe('Nothing to pay today')
  })

  it('the confirm buttons of the exact cases promise no payment at all', () => {
    for (const n of Object.values(EXACT_NOTICES)) expect(n.confirmLabel).toBe('Confirm & Add')
  })
})

describe('issue 225 — issue 223 and issue 224 survive the rewording', () => {
  it('the six cases still read differently from one another', () => {
    const all = [
      picker(),
      picker({ totalCents: null, renewalDate: null }),
      picker({ totalCents: 0 }),
      picker({ totalCents: 0, annualTotalCents: 0 }, { willCharge: false, reason: 'zero_rate' }),
      picker({}, { willCharge: false, reason: 'non_paying' }),
      picker({}, { willCharge: false, reason: 'no_subscription' }),
    ].map(p => `${p.today}||${p.renews}`)
    expect(new Set(all).size).toBe(all.length)
  })

  it('money owed still never reads as free', () => {
    for (const reason of ['no_subscription', 'stripe_unconfigured', 'no_price', 'stripe_error'] as const) {
      const n = notice({}, { willCharge: false, reason })
      expect(n.kind).toBe('invoiced')
      expect(`${n.heading} ${n.body}`).not.toMatch(/at no cost|this one is free/i)
    }
  })

  it('nothing anywhere says "prorated" — issue 223 removed it deliberately', () => {
    for (const n of [...Object.values(EXACT_NOTICES), notice()]) {
      expect(`${n.heading} ${n.body} ${n.confirmLabel}`.toLowerCase()).not.toContain('prorat')
    }
    for (const p of [...Object.values(EXACT_PICKER), picker()]) {
      expect(`${p.today} ${p.renews}`.toLowerCase()).not.toContain('prorat')
    }
  })
})

// ─────────────────────────────────────────────────────────────
// PART 2 — one zero-charge activation, one way of saying "free"
// ─────────────────────────────────────────────────────────────

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
const extras = () => activeSeats().filter(s => s.user_id === null)

describe('issue 225 — a free seat records the same thing whichever route made it', () => {
  it('every seat from one zero-charge activation records 0, not a mix of 0 and null', async () => {
    const res = await completeOnboarding({
      seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }],
    })
    expect(res.status).toBe(200)
    expect(activeSeats()).toHaveLength(3)

    // THE POINT: one query, one answer. Before this, the owner's seat said 0
    // and the two extras said null, so "what did these seats cost" depended on
    // knowing that activateLocationSubscription made one of them and
    // addSeatsForPlan made the others.
    const recorded = activeSeats().map(s => s.prorated_cost)
    expect(recorded).toEqual([0, 0, 0])
    expect(new Set(recorded).size).toBe(1)
  })

  it('the co-owner extra records 0 even though it bills at the manager rate', async () => {
    await completeOnboarding({ seats: [{ tier: 'owner', count: 2 }] })
    const coOwner = extras().find(s => s.tier === 'owner')
    expect(coOwner).toBeDefined()
    // It reads the MANAGER entry (a co-owner is an owner seat on the manager
    // price), and the manager tier is priced, so 0 is knowable.
    expect(coOwner.prorated_cost).toBe(0)
    expect(coOwner.notes).toContain('billed at the manager rate')
  })

  it('still no proration is written — issue 212\'s actual rule is intact', async () => {
    // The prepaid anchor makes a positive proration confidently computable,
    // which is exactly the number that must not land on a free seat. 0 is not
    // a price; a proration would be.
    await completeOnboarding({
      prorated_cost: 135000,
      seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }],
    })
    for (const s of activeSeats()) {
      expect(s.prorated_cost).toBe(0)
      expect(s.prorated_cost).not.toBe(135000)
    }
  })

  it('an UNPRICED tier still records nothing — 0 and null keep meaning different things', async () => {
    // No tier_prices row for manager: we cannot tell "free" from "we could not
    // work it out", so we say neither. The owner tier is still priced, so the
    // activation seat's 0 stands — the distinction is per-tier, not per-route.
    h.state.tierPrices = h.state.tierPrices.filter(t => t.id !== 'manager')

    const res = await completeOnboarding({
      seats: [{ tier: 'owner', count: 1 }, { tier: 'manager', count: 1 }],
    })
    expect(res.status).toBe(200)

    expect(ownerSeat().prorated_cost).toBe(0)
    const manager = extras().find(s => s.tier === 'manager')
    expect(manager).toBeDefined()
    expect(manager.prorated_cost).toBeNull()
  })

  it('a $0 tier records 0 — honestly free, not unknown', async () => {
    // light is priced at 0 in prod. That is a rate we know.
    await completeOnboarding({ seats: [{ tier: 'owner', count: 1 }, { tier: 'light', count: 1 }] })
    const light = extras().find(s => s.tier === 'light')
    expect(light).toBeDefined()
    expect(light.prorated_cost).toBe(0)
  })

  it('a retried confirm neither duplicates seats nor changes what they recorded', async () => {
    await completeOnboarding({ seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }] })
    await completeOnboarding({ seats: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }] })
    expect(activeSeats()).toHaveLength(3)
    for (const s of activeSeats()) expect(s.prorated_cost).toBe(0)
  })

  it('the seats are still marked as no-charge in their notes, not just in the column', async () => {
    await completeOnboarding({ seats: [{ tier: 'owner', count: 1 }, { tier: 'manager', count: 1 }] })
    const manager = extras().find(s => s.tier === 'manager')
    expect(manager.notes).toContain('no charge')
  })
})
