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

export const DAYS_PER_YEAR = 365

export type PaymentSource = 'direct' | 'prepaid_corporate' | 'corporate_sponsored'

// issue 216 — the payment_source values locations.payment_source actually
// stores, plus 'none' for a location corporate hasn't classified yet.
//
// The admin Billing Snapshot kept its own bucket keys — corporate / direct /
// sponsored / none — and none of the corporate ones matched the column. Both
// corporate flavours failed the key lookup and fell into 'none', so a card
// that hides zero rows had never once rendered "Corporate-funded" or
// "Sponsored", and every corporate location was reported as unconfigured.
// Counting lives here now so a display can't invent its own vocabulary.
// payment_source values that mean "Bee Organized/corporate pays, not the
// owner" — these locations never go through Stripe checkout. Everything else
// ('direct', 'stripe', 'none', null) is an owner-pays location.
//
// issue 226 step 7 — this lives HERE, in the pure module, because a client
// surface needs it too: the Careful confirmation has to say "Bee Hub will stop
// sending seat changes to Stripe" and must read the same list the gate reads.
// It used to live in lib/subscription-activation, which instantiates a
// SERVICE-ROLE supabase client at import time — importing it from a component
// dragged that client into the browser bundle. lib/subscription-activation
// re-exports this, so every existing server-side consumer is unchanged.
export const NON_PAYING_SOURCES: readonly string[] = [
  'prepaid_corporate',
  'corporate_sponsored',
  'corporate',
]

export const PAYMENT_SOURCE_KEYS = [
  'prepaid_corporate',
  'corporate_sponsored',
  'direct',
  'none',
] as const

export type PaymentSourceKey = (typeof PAYMENT_SOURCE_KEYS)[number]

// Tally locations by payment_source. Anything absent, null, or unrecognised
// counts as 'none' — an unknown value is genuinely unconfigured, and the
// fallback must never silently absorb a value we DO know (which is exactly
// what the old four-key object did).
export function bucketByPaymentSource(
  locations: Array<{ payment_source?: string | null }>,
): Record<PaymentSourceKey, number> {
  const counts = {
    prepaid_corporate: 0,
    corporate_sponsored: 0,
    direct: 0,
    none: 0,
  } as Record<PaymentSourceKey, number>
  for (const l of locations || []) {
    const key = (l?.payment_source || 'none') as PaymentSourceKey
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key]++
    else counts.none++
  }
  return counts
}

export type SeatLine = { tier: TierKey; count: number }

const MS_PER_DAY = 1000 * 60 * 60 * 24

// ── Renewal model (issue 162) ─────────────────────────────────
// March 1 is NOT a fleet-wide renewal date. A location's renewal anniversary
// is its OWN signup date — Stripe sets the subscription's billing_cycle_anchor
// at checkout (issue 161), and the webhook mirrors that period end into
// locations.paid_through_date. So the real source of a location's renewal is
// paid_through_date, resolved by resolveLocationRenewalDate() below.
//
// The fixed March-1 constants survive ONLY as an explicit LEGACY fallback for
// the ~10 pre-Stripe cohort locations that were seeded at a fixed date and
// have no Stripe subscription. Never use them as the default for a new,
// self-paying franchise.
export const LEGACY_RENEWAL_MONTH = 3
export const LEGACY_RENEWAL_DAY = 1

// LEGACY-ONLY: the next fixed March 1. Reserved for the pre-Stripe cohort and
// as a last-resort fallback when a location has no paid_through_date at all.
export function legacyFixedRenewalDate(from: Date = new Date()): Date {
  const year = from.getUTCFullYear()
  const currentYearRenewal = new Date(Date.UTC(year, LEGACY_RENEWAL_MONTH - 1, LEGACY_RENEWAL_DAY))
  if (from.getTime() < currentYearRenewal.getTime()) return currentYearRenewal
  return new Date(Date.UTC(year + 1, LEGACY_RENEWAL_MONTH - 1, LEGACY_RENEWAL_DAY))
}

// Add whole calendar years in UTC. This is only ever the client-side estimate
// / activation default — the authoritative renewal is Stripe's period end,
// mirrored into paid_through_date — so JS's Feb-29 normalization is immaterial.
export function addYears(from: Date, years: number): Date {
  const d = new Date(from.getTime())
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d
}

// The new-location model: a franchise pays a full year at signup, so its
// renewal anniversary is exactly one year out.
export function annualRenewalFromSignup(signup: Date = new Date()): Date {
  return addYears(signup, 1)
}

// Parse a YYYY-MM-DD paid_through_date to a UTC Date, or null if absent/bad.
export function parsePaidThroughDate(paidThroughDate?: string | null): Date | null {
  if (!paidThroughDate || !/^\d{4}-\d{2}-\d{2}$/.test(paidThroughDate)) return null
  const d = new Date(paidThroughDate + 'T00:00:00Z')
  return isNaN(d.getTime()) ? null : d
}

// issue 171 — a location whose paid_through_date is in the FUTURE has already
// been paid for. The pre-Stripe cohort (five corporate-bought Zoho licences,
// five owner-bought) was seeded with paid_through_date = 2027-02-27; either way
// that first year is owed to them as Bee Hub value. The pay step must recognise
// this, charge nothing, and activate.
//
// Pure and date-injectable so the SAME truth drives all three seams: the client
// pay-step display, the checkout route (skip minting a Stripe session), and the
// complete-onboarding gate (let this zero-due activation through issue 167's
// guard). Comparison is strict `>` against the parsed midnight-UTC date, so on
// the renewal day itself the term is no longer "in the future" — the location
// falls back to the normal Stripe path, which is exactly when it must start
// paying again.
export function isPaidThroughFuture(
  paidThroughDate?: string | null,
  from: Date = new Date(),
): boolean {
  const paid = parsePaidThroughDate(paidThroughDate)
  if (!paid) return false
  return paid.getTime() > from.getTime()
}

// Resolve a location's OWN renewal date for mid-cycle proration and removal
// scheduling. Priority (issue 162):
//   1. paid_through_date — the webhook's mirror of the Stripe subscription's
//      current_period_end. This is the true anniversary and the same date
//      Stripe prorates a mid-year seat add against.
//   2. legacyFixedRenewalDate — the pre-Stripe cohort / last-resort fallback.
// The legacy-ten locations carry a real paid_through_date (e.g. 2027-02-27),
// so branch 1 already resolves them correctly; branch 2 only fires when a
// location has no paid_through_date at all.
export function resolveLocationRenewalDate(
  args: { paidThroughDate?: string | null },
  from: Date = new Date(),
): Date {
  return parsePaidThroughDate(args.paidThroughDate) ?? legacyFixedRenewalDate(from)
}

export function daysUntilRenewal(renewalDate: Date, from: Date = new Date()): number {
  return Math.max(0, Math.ceil((renewalDate.getTime() - from.getTime()) / MS_PER_DAY))
}

// Prorate an annual price across the days remaining until a GIVEN renewal date.
// The caller supplies the location's own renewal date (resolveLocationRenewalDate)
// so mid-year seat adds prorate to the same period end Stripe bills against.
export function prorateToRenewal(
  annualPrice: number,
  renewalDate: Date,
  from: Date = new Date(),
): number {
  const days = daysUntilRenewal(renewalDate, from)
  return Math.round(annualPrice * (days / DAYS_PER_YEAR) * 100) / 100
}

// Co-owner pricing rule: a location is capped at 2 Zee Bee (owner) seats. The
// 2nd seat represents an elevated manager with owner permissions rather than
// a second franchise owner, so it bills at the Hive Manager rate. Centralized
// here so every cost surface (onboarding, renewal card, admin panel) agrees.
export function calculateOwnerSubtotal(
  ownerCount: number,
  prices: TierPrices = DEFAULT_TIER_PRICES,
): number {
  if (ownerCount <= 0) return 0
  const ownerPrice = prices.owner ?? 0
  const managerPrice = prices.manager ?? 0
  if (ownerCount <= 1) return ownerPrice
  return ownerPrice + (ownerCount - 1) * managerPrice
}

export function calculateSeatTotal(
  seats: SeatLine[],
  prices: TierPrices = DEFAULT_TIER_PRICES,
): number {
  return seats.reduce((sum, line) => {
    if (line.tier === 'owner') return sum + calculateOwnerSubtotal(line.count, prices)
    return sum + (prices[line.tier] ?? 0) * line.count
  }, 0)
}

// Prorate a whole seat configuration to the location's own renewal date.
export function calculateProratedSeatTotal(
  seats: SeatLine[],
  renewalDate: Date,
  from: Date = new Date(),
  prices: TierPrices = DEFAULT_TIER_PRICES,
): number {
  return prorateToRenewal(calculateSeatTotal(seats, prices), renewalDate, from)
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
  // Amount due today. issue 162: a NEW self-paying location pays a FULL YEAR
  // at signup (no proration), so for 'direct' this equals `annual`. Prepaid /
  // sponsored owe nothing today, so it's 0.
  dueToday: number
  renewalDate: Date
  message: string
  seatLines: SeatLine[]
}

// New-location onboarding pay-step display (issue 162).
//
// A new franchise pays a FULL YEAR at signup — there is no proration on the
// pay step. Its renewal anniversary is one year from signup (Stripe sets the
// same billing_cycle_anchor at checkout), NOT a fixed March 1. The amount
// shown here is calculateSeatTotal(...) — the exact per-tier catalog the
// Stripe subscription price mirrors — so the number on screen and the number
// Stripe charges come from the same tier_prices source with no date-dependent
// term left to drift.
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
  const renewalDate = annualRenewalFromSignup(from)
  const dueToday = mode === 'direct' ? annual : 0

  const renewalLabel = formatRenewalDate(renewalDate)
  let message: string
  if (mode === 'prepaid') {
    message = `Prepaid through ${renewalLabel}`
  } else if (mode === 'sponsored') {
    message = 'Sponsored by corporate during testing'
  } else {
    message = `${formatCurrency(annual)} today · Renews ${renewalLabel} at ${formatCurrency(annual)}/yr`
  }

  return {
    mode,
    annual,
    dueToday,
    renewalDate,
    message,
    seatLines: seats,
  }
}
