// @ts-nocheck — describe/it/expect are provided by Jest or Vitest once a test
// runner is wired in. Remove this directive after the runner is configured.
import {
  DEFAULT_TIER_PRICES,
  type SeatLine,
  nextRenewalDate,
  daysUntilNextRenewal,
  prorateToNextRenewal,
  calculateSeatTotal,
  calculateProratedSeatTotal,
  getSubscriptionDisplay,
  formatCurrency,
  formatRenewalDate,
} from './subscription-math'

describe('nextRenewalDate', () => {
  it('returns current year March 1 when from is before March 1', () => {
    const from = new Date('2026-01-15T00:00:00Z')
    const result = nextRenewalDate(from)
    expect(result.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('advances to next year when from is exactly on March 1', () => {
    const from = new Date('2026-03-01T00:00:00Z')
    const result = nextRenewalDate(from)
    expect(result.toISOString()).toBe('2027-03-01T00:00:00.000Z')
  })

  it('returns next year March 1 when from is after March 1', () => {
    const from = new Date('2026-05-17T00:00:00Z')
    const result = nextRenewalDate(from)
    expect(result.toISOString()).toBe('2027-03-01T00:00:00.000Z')
  })
})

describe('daysUntilNextRenewal', () => {
  it('returns 288 for 2026-05-17 to 2027-03-01', () => {
    const from = new Date('2026-05-17T00:00:00Z')
    expect(daysUntilNextRenewal(from)).toBe(288)
  })

  it('returns 1 on the day before renewal', () => {
    const from = new Date('2026-02-28T00:00:00Z')
    expect(daysUntilNextRenewal(from)).toBe(1)
  })

  it('returns 365 on March 1 (advances to next year)', () => {
    const from = new Date('2026-03-01T00:00:00Z')
    expect(daysUntilNextRenewal(from)).toBe(365)
  })

  it('leap year: Feb 29 to March 1 is 1 day, not 0', () => {
    const from = new Date('2024-02-29T00:00:00Z')
    expect(daysUntilNextRenewal(from)).toBe(1)
  })
})

describe('prorateToNextRenewal', () => {
  it('prorates owner annual price (550) from 2026-05-17 to 433.97', () => {
    const from = new Date('2026-05-17T00:00:00Z')
    expect(prorateToNextRenewal(550, from)).toBe(433.97)
  })

  it('rounds to 2 decimal places (cents precision)', () => {
    const from = new Date('2026-05-17T00:00:00Z')
    const result = prorateToNextRenewal(200, from)
    expect(result).toBe(Math.round((200 * 288) / 365 * 100) / 100)
  })

  it('returns 0 for zero annual price', () => {
    const from = new Date('2026-05-17T00:00:00Z')
    expect(prorateToNextRenewal(0, from)).toBe(0)
  })
})

describe('calculateSeatTotal', () => {
  it('owner alone', () => {
    expect(calculateSeatTotal([{ tier: 'owner', count: 1 }])).toBe(550)
  })

  it('manager alone', () => {
    expect(calculateSeatTotal([{ tier: 'manager', count: 1 }])).toBe(400)
  })

  it('light alone', () => {
    expect(calculateSeatTotal([{ tier: 'light', count: 1 }])).toBe(200)
  })

  it('readonly alone', () => {
    expect(calculateSeatTotal([{ tier: 'readonly', count: 1 }])).toBe(50)
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

  it('co-owned (two owners, second billed as manager) sums to 950', () => {
    const coOwned: SeatLine[] = [
      { tier: 'owner', count: 1 },
      { tier: 'manager', count: 1 },
    ]
    expect(calculateSeatTotal(coOwned)).toBe(950)
  })

  it('zero seats returns 0', () => {
    expect(calculateSeatTotal([])).toBe(0)
  })

  it('zero count lines contribute 0', () => {
    expect(calculateSeatTotal([{ tier: 'owner', count: 0 }])).toBe(0)
  })
})

describe('calculateProratedSeatTotal', () => {
  it('matches prorateToNextRenewal(calculateSeatTotal(...))', () => {
    const from = new Date('2026-05-17T00:00:00Z')
    const seats: SeatLine[] = [{ tier: 'owner', count: 1 }]
    expect(calculateProratedSeatTotal(seats, from)).toBe(433.97)
  })
})

describe('getSubscriptionDisplay', () => {
  const from = new Date('2026-05-17T00:00:00Z')
  const seats: SeatLine[] = [{ tier: 'owner', count: 1 }]

  it('direct mode shows prorated + annual', () => {
    const result = getSubscriptionDisplay('direct', seats, from)
    expect(result.mode).toBe('direct')
    expect(result.annual).toBe(550)
    expect(result.prorated).toBe(433.97)
    expect(result.daysUntilRenewal).toBe(288)
    expect(result.message).toBe('$434 prorated · Renews Mar 1, 2027 at $550/yr')
  })

  it('prepaid_corporate maps to prepaid mode with zero prorated', () => {
    const result = getSubscriptionDisplay('prepaid_corporate', seats, from)
    expect(result.mode).toBe('prepaid')
    expect(result.prorated).toBe(0)
    expect(result.message).toBe('Prepaid through Mar 1, 2027')
  })

  it('corporate_sponsored maps to sponsored mode', () => {
    const result = getSubscriptionDisplay('corporate_sponsored', seats, from)
    expect(result.mode).toBe('sponsored')
    expect(result.prorated).toBe(0)
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

  it('auto: ceils up rather than nearest (432.46 → $433, not $432)', () => {
    expect(formatCurrency(432.46)).toBe('$433')
  })

  it('auto: 100.01 → $101 (proves ceil, not round)', () => {
    expect(formatCurrency(100.01)).toBe('$101')
  })

  it("showCents 'always' shows two decimals", () => {
    expect(formatCurrency(15, { showCents: 'always' })).toBe('$15.00')
  })

  it("showCents 'never' ceils to whole", () => {
    expect(formatCurrency(15.34, { showCents: 'never' })).toBe('$16')
  })

  it('comma separator for thousands', () => {
    expect(formatCurrency(12345.67, { showCents: 'never' })).toBe('$12,346')
  })
})

describe('formatRenewalDate', () => {
  it('formats March 1 2027 as Mar 1, 2027', () => {
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
