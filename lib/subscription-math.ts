// Fallback defaults — used when no live prices are passed from Supabase.
// Real source of truth is the `tier_prices` table (see migrations/tier_prices.sql),
// fetched by app/page.tsx and threaded through TierPricesContext in BeeHub.jsx.
// Keep these in sync with the seed values in the migration as a safety net.
export const DEFAULT_TIER_PRICES = {
  owner: 550,
  manager: 400,
  light: 200,
  readonly: 50,
} as const

export type TierKey = keyof typeof DEFAULT_TIER_PRICES
export type TierPrices = Record<string, number>

export const RENEWAL_MONTH = 3
export const RENEWAL_DAY = 1
export const DAYS_PER_YEAR = 365

export type PaymentSource = 'direct' | 'prepaid_corporate' | 'corporate_sponsored'

export type SeatLine = { tier: TierKey; count: number }

const MS_PER_DAY = 1000 * 60 * 60 * 24

export function nextRenewalDate(from: Date = new Date()): Date {
  const year = from.getUTCFullYear()
  const currentYearRenewal = new Date(Date.UTC(year, RENEWAL_MONTH - 1, RENEWAL_DAY))
  if (from.getTime() < currentYearRenewal.getTime()) return currentYearRenewal
  return new Date(Date.UTC(year + 1, RENEWAL_MONTH - 1, RENEWAL_DAY))
}

export function daysUntilNextRenewal(from: Date = new Date()): number {
  const renewal = nextRenewalDate(from)
  return Math.ceil((renewal.getTime() - from.getTime()) / MS_PER_DAY)
}

export function prorateToNextRenewal(annualPrice: number, from: Date = new Date()): number {
  const days = daysUntilNextRenewal(from)
  return Math.round(annualPrice * (days / DAYS_PER_YEAR) * 100) / 100
}

export function calculateSeatTotal(
  seats: SeatLine[],
  prices: TierPrices = DEFAULT_TIER_PRICES,
): number {
  return seats.reduce((sum, line) => sum + (prices[line.tier] ?? 0) * line.count, 0)
}

export function calculateProratedSeatTotal(
  seats: SeatLine[],
  from: Date = new Date(),
  prices: TierPrices = DEFAULT_TIER_PRICES,
): number {
  return prorateToNextRenewal(calculateSeatTotal(seats, prices), from)
}

export function formatCurrency(
  amount: number,
  opts: { showCents?: 'always' | 'auto' | 'never' } = {},
): string {
  const showCents = opts.showCents ?? 'auto'
  const useCents =
    showCents === 'always' ? true : showCents === 'never' ? false : Math.abs(amount) < 100

  if (useCents) {
    return (
      '$' +
      amount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    )
  }
  return '$' + Math.ceil(amount).toLocaleString('en-US')
}

export function formatRenewalDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export type SubscriptionDisplay = {
  mode: 'prepaid' | 'sponsored' | 'direct'
  annual: number
  prorated: number
  renewalDate: Date
  daysUntilRenewal: number
  message: string
  seatLines: SeatLine[]
}

export function getSubscriptionDisplay(
  paymentSource: PaymentSource,
  seats: SeatLine[],
  from: Date = new Date(),
  prices: TierPrices = DEFAULT_TIER_PRICES,
): SubscriptionDisplay {
  const mode: SubscriptionDisplay['mode'] =
    paymentSource === 'prepaid_corporate'
      ? 'prepaid'
      : paymentSource === 'corporate_sponsored'
        ? 'sponsored'
        : 'direct'

  const annual = calculateSeatTotal(seats, prices)
  const renewalDate = nextRenewalDate(from)
  const daysUntilRenewal = daysUntilNextRenewal(from)
  const prorated = mode === 'direct' ? prorateToNextRenewal(annual, from) : 0

  const renewalLabel = formatRenewalDate(renewalDate)
  let message: string
  if (mode === 'prepaid') {
    message = `Prepaid through ${renewalLabel}`
  } else if (mode === 'sponsored') {
    message = 'Sponsored by corporate during testing'
  } else {
    message = `${formatCurrency(prorated)} prorated · Renews ${renewalLabel} at ${formatCurrency(annual)}/yr`
  }

  return {
    mode,
    annual,
    prorated,
    renewalDate,
    daysUntilRenewal,
    message,
    seatLines: seats,
  }
}
