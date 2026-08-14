// issue 224 — the picker's price label, as words.
//
// WHAT KEVIN SAW: the tier picker offered "Hive Manager — $400/yr" over the
// sentence "You only pay for the part of the year that's left before your
// renewal on Aug 10, 2027. We'll show you that amount before anything is
// charged." The figure on the next screen was right. The one attached to the
// choice was not the one being charged, and the screen said so.
//
// These pin the two things that fix has to hold at once:
//
//   BOTH FIGURES ARE PRESENT and it is obvious which is charged today, so
//   picking a tier is picking a known price.
//
//   THE SIX CASES issue 223 SEPARATED STAY SEPARATE. A price label is under
//   more pressure to collapse than a paragraph is — it is two short lines
//   beside a button — and collapsing them is how the original bug happened.
//   The zero-today case must not read as free, the no-subscription case must
//   not read as free, and the case with no anchor must name no figure at all.
import { describe, it, expect, vi } from 'vitest'

// annualTotalCents and seatCostResponse are pure, but lib/seat-cost constructs
// a service client at import time. Nothing here touches the database.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => ({}) } }))

import { seatPickerPrice } from './seat-charge-notice'
import { annualTotalCents, seatCostResponse, type SeatCostQuote } from './seat-cost'

const RENEWAL = '2027-08-10'

// $372.60 today against a $400/yr Hive Manager — Kevin's own example.
const price = (over: Partial<Parameters<typeof seatPickerPrice>[0]['quote']> = {}, preview: any = { willCharge: true, reason: null }) =>
  seatPickerPrice({
    quote: { totalCents: 37260, annualTotalCents: 40000, renewalDate: RENEWAL, ...over },
    preview,
  })

describe('issue 224 — a paid seat on a live subscription', () => {
  it('names the amount charged today', () => {
    // issue 225 — "About", because Stripe settles this sum per-second against
    // its own period while we work it out in whole days. The figure is still
    // named; it is no longer promised.
    expect(price().today).toBe('About $372.60 today')
  })

  it('names the annual price and the date it starts renewing', () => {
    expect(price().renews).toBe('Then $400 a year, starting Aug 10, 2027')
  })

  it('puts the two figures in different lines, so neither can be mistaken for the other', () => {
    const p = price()
    expect(p.today).toContain('$372.60')
    expect(p.today).not.toContain('$400')
    expect(p.renews).toContain('$400')
    expect(p.renews).not.toContain('$372.60')
  })

  it('the word "today" is on the figure that is charged today', () => {
    expect(price().today).toMatch(/today/i)
    expect(price().renews).toMatch(/^Then /)
  })

  it('shows cents — the ceiling in formatCurrency\'s auto mode would overstate the charge', () => {
    // $219.45 would render as "$220" under 'auto'. That is a number the owner
    // never agreed to.
    expect(price({ totalCents: 21945 }).today).toBe('About $219.45 today')
  })

  it('does not round the annual figure up when it carries cents', () => {
    expect(price({ annualTotalCents: 40050 }).renews).toContain('$400.50')
  })
})

// ── the six issue-223 cases, still six ────────────────────────────────
describe('issue 224 — the six cases read differently on the picker', () => {
  const CASES = {
    charge:            price(),
    charge_unpriced:   price({ totalCents: null, renewalDate: null }),
    charge_zero_today: price({ totalCents: 0 }),
    free_tier:         price({ totalCents: 0, annualTotalCents: 0 }, { willCharge: false, reason: 'zero_rate' }),
    covered:           price({}, { willCharge: false, reason: 'non_paying' }),
    invoiced:          price({}, { willCharge: false, reason: 'no_subscription' }),
  } as const

  it('each case is classified as itself', () => {
    for (const [name, p] of Object.entries(CASES)) expect(p.kind).toBe(name)
  })

  it('no two cases produce the same pair of lines', () => {
    const rendered = Object.values(CASES).map(p => `${p.today}||${p.renews}`)
    expect(new Set(rendered).size).toBe(rendered.length)
  })

  it('a $0 tier is free NOW and free AT RENEWAL — the second half is what makes it different', () => {
    expect(CASES.free_tier.today).toBe('Free')
    expect(CASES.free_tier.renews).toMatch(/free at renewal/i)
    expect(CASES.free_tier.tone).toBe('free')
  })

  it('a location with no subscription is INVOICED, not free — and the amount is named', () => {
    expect(CASES.invoiced.today).toContain('$372.60')
    expect(CASES.invoiced.today).toMatch(/invoice/i)
    expect(CASES.invoiced.today).not.toMatch(/free/i)
    expect(CASES.invoiced.renews).toContain('$400')
  })

  it('a location with no paid_through_date names NO figure for today', () => {
    expect(CASES.charge_unpriced.today).not.toMatch(/\$/)
    // …and no date it does not have, rather than the legacy March 1.
    expect(CASES.charge_unpriced.renews).not.toMatch(/Mar 1/)
    // The yearly price is still knowable, so it is still stated.
    expect(CASES.charge_unpriced.renews).toContain('$400')
  })

  it('a seat added ON the renewal date costs nothing today and full price next year', () => {
    expect(CASES.charge_zero_today.today).toBe('Nothing to pay today')
    expect(CASES.charge_zero_today.renews).toBe('Then $400 a year, starting Aug 10, 2027')
    // Not "free" — the owner would discover otherwise on their next invoice.
    expect(CASES.charge_zero_today.today).not.toMatch(/free/i)
    expect(CASES.charge_zero_today.renews).not.toMatch(/free/i)
  })

  it('a covered account owes nothing in either column, which is not the same as free', () => {
    expect(CASES.covered.today).toBe('Nothing to pay')
    expect(CASES.covered.renews).toMatch(/billed separately/i)
    expect(CASES.covered.renews).not.toMatch(/\$/)
  })

  it('every case answers the yearly question — a blank second line would read as free', () => {
    for (const p of Object.values(CASES)) expect(p.renews.length).toBeGreaterThan(10)
  })

  it('none of them says "prorated" — wrong register for a 45-65 audience', () => {
    for (const p of Object.values(CASES)) {
      expect(`${p.today} ${p.renews}`.toLowerCase()).not.toContain('prorat')
    }
  })
})

// ── the misconfiguration reasons stay on the invoiced side ────────────
describe('issue 224 — money owed never renders as free', () => {
  for (const reason of ['no_subscription', 'stripe_unconfigured', 'no_price', 'stripe_error'] as const) {
    it(`${reason} is invoiced, not free`, () => {
      const p = price({}, { willCharge: false, reason })
      expect(p.kind).toBe('invoiced')
      expect(p.tone).toBe('later')
      expect(p.today).toMatch(/invoice/i)
    })
  }
})

// ── the annual figure is the server's, from the charging lines ────────
describe('issue 224 — annualTotalCents', () => {
  const quote = (billingLines: any[]): SeatCostQuote => ({
    perSeatCents: null,
    totalCents: null,
    renewalDate: null,
    paidThroughDate: null,
    lines: [],
    billingLines,
  })

  it('sums the billing lines the charge walks', () => {
    expect(annualTotalCents(quote([{ billingTier: 'manager', quantity: 2, annualUnitCents: 40000 }]))).toBe(80000)
  })

  it('honours the co-owner rule, because it differences the same lines the charge does', () => {
    // A 2nd owner seat bills at the MANAGER rate. tier_prices['owner'] × 1
    // would say $550 — the $150 overstatement issue 217 exists to prevent.
    expect(annualTotalCents(quote([{ billingTier: 'manager', quantity: 1, annualUnitCents: 40000 }]))).toBe(40000)
  })

  it('is null — never a partial sum — when any line has no known rate', () => {
    expect(annualTotalCents(quote([
      { billingTier: 'owner', quantity: 1, annualUnitCents: 55000 },
      { billingTier: 'manager', quantity: 1, annualUnitCents: null },
    ]))).toBeNull()
  })

  it('a $0 tier is 0, which is NOT the same as unknown', () => {
    expect(annualTotalCents(quote([{ billingTier: 'readonly', quantity: 3, annualUnitCents: 0 }]))).toBe(0)
  })

  it('survives an unpriced quote — no anchor for today does not mean no price a year', () => {
    const q = quote([{ billingTier: 'manager', quantity: 1, annualUnitCents: 40000 }])
    q.unpricedReason = 'no_renewal_anchor'
    const body = seatCostResponse(q)
    expect(body.total_cents).toBeNull()
    expect(body.annual_total_cents).toBe(40000)
  })

  it('rides on the route response so the picker never has to look a rate up', () => {
    const body = seatCostResponse(quote([{ billingTier: 'manager', quantity: 1, annualUnitCents: 40000 }]))
    expect(body).toHaveProperty('annual_total_cents')
    expect(body.source).toBe('server')
  })
})
