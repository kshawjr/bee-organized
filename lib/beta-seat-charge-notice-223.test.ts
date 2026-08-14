// issue 223 — the seat modals promised no charge, then charged.
//
// Both owner seat modals rendered one fixed line: "Online payment isn't set
// up yet, so no card will be charged. Confirming records this purchase and
// Bee Organized will invoice you for it separately." True when written;
// false since issues 161 and 219, which made /api/seats and
// /api/seats/buy-and-invite charge as Stripe subscription lines.
//
// These pin the four properties the fix has to hold:
//
//   A) a paid tier that will be charged shows the REAL figure and never
//      claims no charge
//   B) a $0 tier says free — because it is
//   C) a location with no Stripe subscription says invoiced, NOT free —
//      money is owed, there is just nothing to bill it on
//   D) the figure shown is the one the server quoted, to the cent
//
// The copy lives in lib/seat-charge-notice so it can be asserted as text
// rather than scraped out of JSX, and so the two modals cannot drift into
// saying different things about the same outcome.
import { describe, it, expect } from 'vitest'
import { seatChargeNotice, type SeatChargePreview } from '@/lib/seat-charge-notice'

const CHARGES: SeatChargePreview = { willCharge: true, reason: null }
const FREE_TIER: SeatChargePreview = { willCharge: false, reason: 'zero_rate' }
const NO_SUB: SeatChargePreview = { willCharge: false, reason: 'no_subscription' }
const NON_PAYING: SeatChargePreview = { willCharge: false, reason: 'non_paying' }
const NO_PRICE: SeatChargePreview = { willCharge: false, reason: 'no_price' }
const UNCONFIGURED: SeatChargePreview = { willCharge: false, reason: 'stripe_unconfigured' }

const notice = (
  preview: SeatChargePreview,
  totalCents: number | null,
  renewalDate: string | null = '2027-08-14',
  seatWord = 'Hive Manager seat',
) => seatChargeNotice({ quote: { totalCents, renewalDate }, preview, seatWord })

// Every case together, for the cross-cutting invariants below.
const ALL = () => [
  notice(CHARGES, 21945),
  notice(CHARGES, null),
  notice(CHARGES, 0),
  notice(FREE_TIER, 0),
  notice(NON_PAYING, null),
  notice(NO_SUB, 21945),
]

// ── A) a real charge says so, with the real number ────────────────────
describe('issue 223 — a seat that will be charged', () => {
  const n = notice(CHARGES, 21945)

  it('names the exact amount, to the cent', () => {
    expect(n.heading).toContain('$219.45')
  })

  it('does NOT round the figure to whole dollars', () => {
    // formatCurrency's 'auto' mode ceilings anything over $100 — $219.45
    // would display as "$220" and the owner would see a number they never
    // agreed to. The notice must use the exact figure.
    expect(n.heading).not.toContain('$220')
    expect(n.body).not.toContain('$220')
  })

  it('never claims no card will be charged', () => {
    expect(n.body).not.toMatch(/no card will be charged/i)
    expect(n.body).not.toMatch(/isn.t set up/i)
    expect(n.tone).toBe('charge')
    expect(n.kind).toBe('charge')
  })

  it('says the money comes off the card already on file', () => {
    expect(n.body).toMatch(/card you already have on file/i)
  })

  it('explains the amount covers the rest of the year, up to the renewal date', () => {
    expect(n.body).toMatch(/part of your year that.s left/i)
    expect(n.body).toContain('Aug 14, 2027')
  })

  it('puts the amount on the confirm button too', () => {
    // issue 225 — "about": Stripe settles this figure per-second against its
    // own period, so the button names it without promising it.
    expect(n.confirmLabel).toBe('Confirm & Pay about $219.45')
  })

  it('a small charge under $100 still shows cents', () => {
    expect(notice(CHARGES, 4212).heading).toContain('$42.12')
  })
})

// ── charged, but the server could not price it (issue 217's no-anchor) ─
describe('issue 223 — charged with no figure available', () => {
  const n = notice(CHARGES, null, null)

  it('still warns that the card will be charged', () => {
    expect(n.kind).toBe('charge_unpriced')
    expect(n.tone).toBe('charge')
    expect(n.heading).toMatch(/card will be charged/i)
  })

  it('invents no figure', () => {
    expect(n.heading).not.toMatch(/\$/)
    expect(n.body).not.toMatch(/\$/)
    expect(n.confirmLabel).not.toMatch(/\$/)
  })

  it('says the exact amount is settled when the payment goes through', () => {
    expect(n.body).toMatch(/exact\s+amount is worked out/i)
  })
})

// ── charged, but nothing is due today (added on the renewal date) ──────
describe('issue 223 — a paid seat that prorates to nothing today', () => {
  const n = notice(CHARGES, 0)

  it('says nothing is due now', () => {
    expect(n.kind).toBe('charge_zero_today')
    expect(n.heading).toMatch(/nothing to pay today/i)
  })

  it('does NOT call the seat free — it is on the plan from renewal onward', () => {
    expect(n.tone).toBe('later')
    expect(n.body).not.toMatch(/\bfree\b/i)
    expect(n.body).not.toMatch(/at no cost/i)
    expect(n.body).toContain('Aug 14, 2027')
  })
})

// ── B) a $0 tier is honestly free ─────────────────────────────────────
describe('issue 223 — a $0 tier', () => {
  const n = notice(FREE_TIER, 0, '2027-08-14', 'Honey Watcher seat')

  it('says it is free', () => {
    expect(n.kind).toBe('free_tier')
    expect(n.tone).toBe('free')
    expect(n.body).toMatch(/at no cost/i)
  })

  it('promises nothing at renewal either — a $0 tier is free forever', () => {
    expect(n.body).toMatch(/won.t add anything to your renewal/i)
  })

  it('quotes no figure and asks for no payment', () => {
    expect(n.confirmLabel).toBe('Confirm & Add')
    expect(n.confirmLabel).not.toMatch(/pay/i)
  })
})

// ── C) no subscription: owed, not free ────────────────────────────────
describe('issue 223 — a location with no Stripe subscription', () => {
  const n = notice(NO_SUB, 21945)

  it('says it will be invoiced, NOT that it is free', () => {
    expect(n.kind).toBe('invoiced')
    expect(n.body).toMatch(/send you an invoice/i)
    expect(n.body).not.toMatch(/\bfree\b/i)
    expect(n.body).not.toMatch(/at no cost/i)
    expect(n.body).not.toMatch(/included in your plan at no/i)
  })

  it('still tells the owner what it costs, since they will owe it', () => {
    expect(n.body).toContain('$219.45')
    expect(n.body).toContain('Aug 14, 2027')
  })

  it('is toned as money-owed-later, not money-never', () => {
    expect(n.tone).toBe('later')
  })

  it('reads differently from the genuinely-free case', () => {
    expect(n.body).not.toBe(notice(FREE_TIER, 0).body)
    expect(n.heading).not.toBe(notice(FREE_TIER, 0).heading)
  })

  it('works when the cost could not be priced either', () => {
    const unpriced = notice(NO_SUB, null, null)
    expect(unpriced.kind).toBe('invoiced')
    expect(unpriced.body).toMatch(/send you an invoice/i)
    expect(unpriced.body).not.toMatch(/\$/)
  })
})

// ── a non-paying source is covered by somebody else ───────────────────
describe('issue 223 — a corporate / prepaid location', () => {
  const n = notice(NON_PAYING, null)

  it('says the account is billed separately, not that the seat is free', () => {
    expect(n.kind).toBe('covered')
    expect(n.body).toMatch(/billed separately/i)
  })

  it('reads differently from both the free tier and the invoiced case', () => {
    expect(n.heading).not.toBe(notice(FREE_TIER, 0).heading)
    expect(n.heading).not.toBe(notice(NO_SUB, 21945).heading)
  })
})

// ── a misconfiguration must never read as a free seat ─────────────────
describe('issue 223 — Stripe misconfigured for this tier', () => {
  for (const [label, preview] of [
    ['no_price', NO_PRICE],
    ['stripe_unconfigured', UNCONFIGURED],
  ] as const) {
    it(`${label} says invoiced, never free`, () => {
      const n = notice(preview, 21945)
      expect(n.kind).toBe('invoiced')
      expect(n.body).not.toMatch(/\bfree\b/i)
      expect(n.body).toMatch(/send you an invoice/i)
    })
  }
})

// ── cross-cutting: the original lie is gone everywhere ────────────────
describe('issue 223 — the retired sentence appears in no case', () => {
  it('nothing says "online payment isn\'t set up yet"', () => {
    for (const n of ALL()) {
      expect(`${n.heading} ${n.body}`).not.toMatch(/online payment isn.t set up/i)
    }
  })

  it('only the genuinely-free cases promise no charge', () => {
    for (const n of ALL()) {
      if (n.body.match(/at no cost|billed separately/i)) {
        expect(n.tone).toBe('free')
      }
    }
  })

  it('every case has a heading, a body and a confirm label', () => {
    for (const n of ALL()) {
      expect(n.heading.length).toBeGreaterThan(0)
      expect(n.body.length).toBeGreaterThan(0)
      expect(n.confirmLabel.length).toBeGreaterThan(0)
    }
  })

  it('no case uses billing jargon — the audience is non-technical', () => {
    for (const n of ALL()) {
      const text = `${n.heading} ${n.body} ${n.confirmLabel}`
      for (const jargon of [
        'prorat', 'line item', 'subscription quantity', 'invoice item',
        'price ID', 'webhook', 'Stripe',
      ]) {
        expect(text.toLowerCase()).not.toContain(jargon.toLowerCase())
      }
    }
  })
})
