import {
  DEFAULT_TIER_PRICES,
  type SeatLine,
  LEGACY_RENEWAL_MONTH,
  LEGACY_RENEWAL_DAY,
  legacyFixedRenewalDate,
  addYears,
  annualRenewalFromSignup,
  parsePaidThroughDate,
  resolveLocationRenewalDate,
  daysUntilRenewal,
  prorateToRenewal,
  calculateOwnerSubtotal,
  calculateSeatTotal,
  calculateProratedSeatTotal,
  getSubscriptionDisplay,
  formatCurrency,
  formatRenewalDate,
} from './subscription-math'

// issue 162: March 1 is no longer a fleet-wide renewal date. A location's
// renewal anniversary is its own signup date (mirrored into paid_through_date
// from Stripe's period end). The fixed March-1 constants survive ONLY as the
// legacy fallback for the pre-Stripe cohort.

describe('legacyFixedRenewalDate (legacy cohort only)', () => {
  it('returns current-year March 1 when from is before March 1', () => {
    expect(legacyFixedRenewalDate(new Date('2026-01-15T00:00:00Z')).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    )
  })

  it('advances to next year on/after March 1', () => {
    expect(legacyFixedRenewalDate(new Date('2026-03-01T00:00:00Z')).toISOString()).toBe(
      '2027-03-01T00:00:00.000Z',
    )
    expect(legacyFixedRenewalDate(new Date('2026-05-17T00:00:00Z')).toISOString()).toBe(
      '2027-03-01T00:00:00.000Z',
    )
  })

  it('constants remain March 1 for the legacy path', () => {
    expect(LEGACY_RENEWAL_MONTH).toBe(3)
    expect(LEGACY_RENEWAL_DAY).toBe(1)
  })
})

describe('addYears / annualRenewalFromSignup (new-location model)', () => {
  it('adds one calendar year in UTC', () => {
    expect(addYears(new Date('2026-05-17T00:00:00Z'), 1).toISOString()).toBe(
      '2027-05-17T00:00:00.000Z',
    )
  })

  it('a new location renews one year from signup, NOT March 1', () => {
    const signup = new Date('2026-08-01T00:00:00Z')
    const renewal = annualRenewalFromSignup(signup)
    expect(renewal.toISOString()).toBe('2027-08-01T00:00:00.000Z')
    // Explicitly not the legacy fixed date.
    expect(renewal.toISOString()).not.toBe(legacyFixedRenewalDate(signup).toISOString())
  })
})

describe('resolveLocationRenewalDate', () => {
  const from = new Date('2026-11-17T00:00:00Z')

  it('uses paid_through_date (Stripe period-end mirror) when present', () => {
    const d = resolveLocationRenewalDate({ paidThroughDate: '2027-05-17' }, from)
    expect(d.toISOString()).toBe('2027-05-17T00:00:00.000Z')
  })

  it('resolves the legacy fixed date for a location with no paid_through', () => {
    // The legacy path still resolves — for the pre-Stripe cohort / any row
    // with no paid_through_date at all.
    const d = resolveLocationRenewalDate({ paidThroughDate: null }, from)
    expect(d.toISOString()).toBe('2027-03-01T00:00:00.000Z')
  })

  it('legacy-ten shape: a fixed 2027-02-27 date resolves to itself', () => {
    const d = resolveLocationRenewalDate({ paidThroughDate: '2027-02-27' }, from)
    expect(d.toISOString()).toBe('2027-02-27T00:00:00.000Z')
  })

  it('ignores a malformed paid_through and falls back to legacy', () => {
    expect(parsePaidThroughDate('not-a-date')).toBeNull()
    const d = resolveLocationRenewalDate({ paidThroughDate: 'not-a-date' }, from)
    expect(d.toISOString()).toBe('2027-03-01T00:00:00.000Z')
  })
})

describe('prorateToRenewal / daysUntilRenewal (mid-year seat adds)', () => {
  it('prorates a mid-year seat to the LOCATION\'S OWN renewal date, not March 1', () => {
    const from = new Date('2026-11-17T00:00:00Z')
    const ownRenewal = resolveLocationRenewalDate({ paidThroughDate: '2027-05-17' }, from)
    const legacyRenewal = legacyFixedRenewalDate(from)

    // 181 days to the location's own anniversary vs 104 to the legacy March 1.
    expect(daysUntilRenewal(ownRenewal, from)).toBe(181)
    expect(daysUntilRenewal(legacyRenewal, from)).toBe(104)

    const toOwn = prorateToRenewal(400, ownRenewal, from)
    const toLegacy = prorateToRenewal(400, legacyRenewal, from)
    expect(toOwn).toBe(Math.round((400 * 181) / 365 * 100) / 100) // 198.36
    // Proving the anchor moved: own-date proration differs from March-1 proration.
    expect(toOwn).not.toBe(toLegacy)
  })

  it('returns 0 for a zero annual price', () => {
    const from = new Date('2026-11-17T00:00:00Z')
    const renewal = resolveLocationRenewalDate({ paidThroughDate: '2027-05-17' }, from)
    expect(prorateToRenewal(0, renewal, from)).toBe(0)
  })

  it('never goes negative past the renewal date', () => {
    const from = new Date('2027-06-01T00:00:00Z')
    expect(daysUntilRenewal(new Date('2027-05-17T00:00:00Z'), from)).toBe(0)
    expect(prorateToRenewal(400, new Date('2027-05-17T00:00:00Z'), from)).toBe(0)
  })
})

describe('calculateOwnerSubtotal', () => {
  it('0 owners → 0', () => {
    expect(calculateOwnerSubtotal(0)).toBe(0)
  })

  it('1 owner → owner price', () => {
    expect(calculateOwnerSubtotal(1)).toBe(550)
  })

  it('2 owners → owner price + manager price (co-owner discount)', () => {
    expect(calculateOwnerSubtotal(2)).toBe(950)
  })

  it('honors live prices override', () => {
    expect(calculateOwnerSubtotal(2, { owner: 550, manager: 450, light: 200, readonly: 50 })).toBe(1000)
  })
})

describe('calculateSeatTotal', () => {
  it('owner alone', () => {
    expect(calculateSeatTotal([{ tier: 'owner', count: 1 }])).toBe(550)
  })

  it('two owners apply co-owner discount (550 + 400 = 950, not 1100)', () => {
    expect(calculateSeatTotal([{ tier: 'owner', count: 2 }])).toBe(950)
  })

  it('full team mix sums to 1650', () => {
    const fullTeam: SeatLine[] = [
      { tier: 'owner', count: 1 },
      { tier: 'manager', count: 1 },
      { tier: 'light', count: 3 },
      { tier: 'readonly', count: 2 },
    ]
    expect(calculateSeatTotal(fullTeam)).toBe(1650)
  })

  it('zero seats returns 0', () => {
    expect(calculateSeatTotal([])).toBe(0)
  })
})

describe('calculateProratedSeatTotal', () => {
  it('prorates a seat config to the given renewal date', () => {
    const from = new Date('2026-11-17T00:00:00Z')
    const renewal = resolveLocationRenewalDate({ paidThroughDate: '2027-05-17' }, from)
    const seats: SeatLine[] = [{ tier: 'manager', count: 1 }]
    expect(calculateProratedSeatTotal(seats, renewal, from)).toBe(
      prorateToRenewal(400, renewal, from),
    )
  })
})

describe('getSubscriptionDisplay — new-location pay step (issue 162)', () => {
  const from = new Date('2026-08-01T00:00:00Z')
  const seats: SeatLine[] = [{ tier: 'owner', count: 1 }]

  it('direct: a new location (paid_through NULL) is quoted the FULL annual, no proration', () => {
    const result = getSubscriptionDisplay('direct', seats, from)
    expect(result.mode).toBe('direct')
    expect(result.annual).toBe(550)
    // Due today equals the full annual — the number Stripe charges — with no
    // date-dependent proration term that could drift from the actual charge.
    expect(result.dueToday).toBe(550)
    expect(result.dueToday).toBe(result.annual)
    // Renewal is the signup anniversary, not March 1.
    expect(result.renewalDate.toISOString()).toBe('2027-08-01T00:00:00.000Z')
    expect(result.message).toBe('$550 today · Renews Aug 1, 2027 at $550/yr')
  })

  it('full team direct quote is the full annual sum', () => {
    const team: SeatLine[] = [
      { tier: 'owner', count: 1 },
      { tier: 'manager', count: 2 },
    ]
    const result = getSubscriptionDisplay('direct', team, from)
    expect(result.dueToday).toBe(calculateSeatTotal(team))
  })

  it('prepaid_corporate owes nothing today', () => {
    const result = getSubscriptionDisplay('prepaid_corporate', seats, from)
    expect(result.mode).toBe('prepaid')
    expect(result.dueToday).toBe(0)
    expect(result.message).toBe('Prepaid through Aug 1, 2027')
  })

  it('corporate_sponsored owes nothing today', () => {
    const result = getSubscriptionDisplay('corporate_sponsored', seats, from)
    expect(result.mode).toBe('sponsored')
    expect(result.dueToday).toBe(0)
    expect(result.message).toBe('Sponsored by corporate during testing')
  })

  it('passes seatLines through', () => {
    const result = getSubscriptionDisplay('direct', seats, from)
    expect(result.seatLines).toEqual(seats)
  })
})

describe('formatCurrency', () => {
  it('auto: rounds whole dollars when >= 100', () => {
    expect(formatCurrency(1600)).toBe('$1,600')
  })

  it('auto: shows cents when < 100', () => {
    expect(formatCurrency(15.34)).toBe('$15.34')
  })

  it('auto: rounds UP (ceil) to whole when >= 100', () => {
    expect(formatCurrency(435.67)).toBe('$436')
  })

  it("showCents 'never' ceils to whole", () => {
    expect(formatCurrency(15.34, { showCents: 'never' })).toBe('$16')
  })

  it('comma separator for thousands', () => {
    expect(formatCurrency(12345.67, { showCents: 'never' })).toBe('$12,346')
  })
})

describe('formatRenewalDate', () => {
  it('formats a signup-anniversary date', () => {
    expect(formatRenewalDate(new Date('2027-08-01T00:00:00Z'))).toBe('Aug 1, 2027')
  })

  it('formats a legacy March 1 date', () => {
    expect(formatRenewalDate(new Date('2027-03-01T00:00:00Z'))).toBe('Mar 1, 2027')
  })
})

describe('DEFAULT_TIER_PRICES', () => {
  it('exposes expected fallback constants (override at runtime via tier_prices table)', () => {
    expect(DEFAULT_TIER_PRICES.owner).toBe(550)
    expect(DEFAULT_TIER_PRICES.manager).toBe(400)
    expect(DEFAULT_TIER_PRICES.light).toBe(200)
    expect(DEFAULT_TIER_PRICES.readonly).toBe(50)
  })
})
