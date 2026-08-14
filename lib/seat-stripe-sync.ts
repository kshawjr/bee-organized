// lib/seat-stripe-sync.ts
//
// Ties a Bee Hub seat change to the location's Stripe subscription
// (issue 161): +1 line item on invite, −1 on removal. Stripe prorates the
// difference to the existing renewal date — we never compute the proration.
// An invite invoices + charges the prorated amount immediately; a removal
// credits the next invoice (see adjustSubscriptionSeatQuantity).
//
// CRITICAL GUARD (issue 161): this is a CONDITIONAL side effect, never a
// gate. A location that has not yet completed Stripe checkout has no
// stripe_subscription_id, so every seat change is a Stripe no-op and the
// free-grant path (record-only seats + invites) keeps working. Only once
// a real subscription exists do seat changes touch Stripe. A Stripe
// failure here NEVER rolls back the seat DB write — the seat is real; the
// billing line is reconciled from the loud log + Slack instead of
// stranding the invitee.

// issue 219 — "+ ADD SEATS" CHARGES WHAT THE SEAT COSTS.
//
// THE BUG THIS SECOND HALF EXISTS TO KILL: two buttons added a seat and only
// one charged. /api/seats POST inserted a row and never came here;
// buy-and-invite did. The identical seat was free through one door and billed
// through the other. issue 217 then made the free door record an accurate
// prorated cost, which made it worse — the ledger claimed money was owed and
// none moved.
//
// Kevin's rule: the TIER decides whether a seat is free, not the ROUTE. A
// readonly seat is free because tier_prices prices it at $0, and that is the
// only reason any seat is free. applySeatPurchaseToStripe below is the entry
// point /api/seats POST uses; it walks the quote's billing lines so the tiers
// and quantities it charges are the ones the seat rows recorded, not a second
// derivation that can drift from them.
//
// NOTE ON ISSUE 221 (the seat-tier vs billing-tier lookup): applySeatDeltaToStripe
// resolves tier_prices by whatever tier string it is handed. Its `tier` is
// therefore a BILLING tier, and this module's callers must hand it one.
// applySeatPurchaseToStripe passes line.billingTier — the co-owner rule has
// already been applied by lib/seat-plan before the line reaches here — so an
// owner-tier purchase through /api/seats bumps the MANAGER line for its 2nd
// seat, matching what issue 217 records. That is a caller-side discipline, not
// a fix: DELETE still passes the SEAT tier (see the call in /api/seats), so
// removing a co-owner seat still credits the owner line. issue 221 remains
// open for that path.

import { supabaseService } from './supabase-service'
import { stripeConfigured } from './stripe'
import { adjustSubscriptionSeatQuantity } from './stripe-billing'
import { getLocationBilling, NON_PAYING_SOURCES } from './subscription-activation'

export type SeatStripeResult = {
  applied: boolean
  // Why we skipped or failed — surfaced to the caller for logging, never fatal.
  reason?:
    | 'non_paying'
    | 'no_subscription'
    | 'stripe_unconfigured'
    | 'no_price'
    | 'stripe_error'
  quantity?: number
  detail?: string
}

// Apply a seat quantity delta for one tier to the location's live
// subscription. seatId (when known) anchors the Stripe idempotency key so
// a retry of the SAME seat change is a replay, not a double charge.
export async function applySeatDeltaToStripe(args: {
  locationId: string
  tier: string
  delta: number
  seatId?: string | null
}): Promise<SeatStripeResult> {
  const { locationId, tier, delta, seatId } = args
  if (!delta) return { applied: false, reason: 'no_subscription' }

  const location = await getLocationBilling(locationId)
  if (!location) return { applied: false, reason: 'no_subscription' }

  // Corporate / prepaid never bill through Stripe.
  if (NON_PAYING_SOURCES.includes(location.payment_source || '')) {
    return { applied: false, reason: 'non_paying' }
  }
  // No live subscription → free-grant location; skip Stripe entirely.
  if (!location.stripe_subscription_id) {
    return { applied: false, reason: 'no_subscription' }
  }
  if (!stripeConfigured()) return { applied: false, reason: 'stripe_unconfigured' }

  const { data: tierRow } = await supabaseService
    .from('tier_prices')
    .select('*')
    .eq('id', tier)
    .maybeSingle()
  const priceId = (tierRow as any)?.stripe_price_id ?? null
  if (!priceId) return { applied: false, reason: 'no_price' }

  const direction = delta > 0 ? 'add' : 'remove'
  const idempotencyKey = `bh_seat_${direction}_${seatId || `${tier}_${locationId}_${delta}`}`

  try {
    const res = await adjustSubscriptionSeatQuantity({
      subscriptionId: location.stripe_subscription_id,
      priceId,
      delta,
      idempotencyKey,
    })
    return { applied: true, quantity: res.quantity }
  } catch (err: any) {
    // Non-fatal by design — the seat write already landed.
    console.error(
      `[seat-stripe-sync] ${direction} tier=${tier} loc=${locationId} failed —`,
      err?.message || err,
    )
    return { applied: false, reason: 'stripe_error', detail: String(err?.message || err).slice(0, 300) }
  }
}

// ─────────────────────────────────────────────────────────────
// issue 219 — applying a whole PURCHASE, not a single delta
// ─────────────────────────────────────────────────────────────

// Why a line was not billed. The first five are applySeatDeltaToStripe's own
// reasons; 'zero_rate' is this layer's and never reaches Stripe at all.
export type SeatPurchaseSkipReason = NonNullable<SeatStripeResult['reason']> | 'zero_rate'

export type SeatPurchaseLineResult = {
  billingTier: string
  quantity: number
  // The seat rows this line paid for, in insert order.
  seatIds: string[]
  applied: boolean
  reason?: SeatPurchaseSkipReason
  detail?: string
}

export type SeatPurchaseStripeResult = {
  // Every chargeable line reached Stripe. A purchase made entirely of $0-rate
  // lines is `applied: true` with nothing charged — nothing was owed.
  applied: boolean
  lines: SeatPurchaseLineResult[]
  // Seats that owe money nobody billed: a chargeable line that did not apply.
  // These are what get the loud note on their row.
  unbilledSeatIds: string[]
}

// A price line the subscription must be bumped by. Structurally
// SeatCostQuote.billingLines — declared locally so this module keeps not
// importing lib/seat-cost (which imports lib/seat-plan, which imports
// subscription-math; the dependency only ever needs to run one way).
export type SeatPurchaseLine = {
  billingTier: string
  quantity: number
  annualUnitCents: number | null
}

// Bump the location's subscription once per billing line, and report which
// seats ended up billed.
//
// $0 TIERS NEVER REACH STRIPE. A line whose annual rate is 0 is skipped before
// any API call: adding a $0 price to a subscription charges nothing today and
// nothing at renewal, so the call would be pure noise on the invoice and in
// the Stripe event log. Note this keys on the ANNUAL RATE, not on the prorated
// figure — a $400/yr seat added on the renewal date itself prorates to $0 but
// MUST still bump the quantity, or it silently rides free forever from the
// next invoice onward.
//
// An unknown rate (null — the tier has no tier_prices row) is NOT treated as
// free. It goes to Stripe, which skips it as 'no_price' and says so, because a
// missing row is a misconfiguration and should read like one.
//
// seatIds are consumed in line order, which is the order the rows were
// inserted — both come from the same TIER_ORDER expansion in lib/seat-cost, so
// seat i belongs to the line that priced cents entry i.
export async function applySeatPurchaseToStripe(args: {
  locationId: string
  lines: SeatPurchaseLine[]
  seatIds: string[]
}): Promise<SeatPurchaseStripeResult> {
  const { locationId, lines, seatIds } = args

  const results: SeatPurchaseLineResult[] = []
  const unbilledSeatIds: string[] = []
  let cursor = 0

  for (const line of lines) {
    const mine = seatIds.slice(cursor, cursor + line.quantity)
    cursor += line.quantity

    if (line.annualUnitCents === 0) {
      results.push({
        billingTier: line.billingTier,
        quantity: line.quantity,
        seatIds: mine,
        applied: false,
        reason: 'zero_rate',
      })
      continue
    }

    // line.billingTier, NOT the seat tier — see the issue 221 note at the top.
    const res = await applySeatDeltaToStripe({
      locationId,
      tier: line.billingTier,
      delta: line.quantity,
      seatId: mine[0] ?? null,
    })
    results.push({
      billingTier: line.billingTier,
      quantity: line.quantity,
      seatIds: mine,
      applied: res.applied,
      ...(res.reason ? { reason: res.reason } : {}),
      ...(res.detail ? { detail: res.detail } : {}),
    })
    if (!res.applied) unbilledSeatIds.push(...mine)
  }

  return {
    applied: results.every((r) => r.applied || r.reason === 'zero_rate'),
    lines: results,
    unbilledSeatIds,
  }
}

// ── The reconciliation trail ─────────────────────────────────
// A seat whose recorded cost and actual charge disagree is the exact failure
// issue 219 exists to end, so when it happens anyway it is written onto the
// seat row rather than only logged. One marker, so a single query finds every
// one of them:
//
//   select id, location_id, tier, prorated_cost, notes
//   from subscription_seats where notes ilike '%issue 219%';
export const SEAT_BILLING_MISMATCH_MARKER = 'issue 219'

function skipPhrase(reason: SeatPurchaseSkipReason | undefined, detail?: string): string {
  switch (reason) {
    case 'no_subscription':
      return 'this location has no Stripe subscription'
    case 'non_paying':
      return "this location's payment source is not billed through Stripe"
    case 'stripe_unconfigured':
      return 'Stripe is not configured on this deployment'
    case 'no_price':
      return 'the tier has no stripe_price_id in tier_prices'
    case 'stripe_error':
      return `the Stripe call failed — ${detail || 'no detail'}`
    default:
      return 'no reason was reported'
  }
}

// The seat recorded a figure and no money moved.
export function unchargedSeatNote(
  reason: SeatPurchaseSkipReason | undefined,
  detail?: string,
): string {
  return `${SEAT_BILLING_MISMATCH_MARKER}: cost recorded but NOT charged — ${skipPhrase(reason, detail)}`
}

// The mirror image: money moved and no figure was recorded. Reachable only on
// a location whose quote came back unpriced yet whose subscription still took
// the bump — Stripe prorates against the real subscription period, which it
// knows even when we have no anchor of our own.
export function unrecordedChargeNote(
  reason: 'no_renewal_anchor' | 'tier_not_priced' | undefined,
): string {
  const why =
    reason === 'tier_not_priced'
      ? 'the tier has no price_annual in tier_prices'
      : 'the location has no paid_through_date to prorate to'
  return `${SEAT_BILLING_MISMATCH_MARKER}: charged on the Stripe subscription but no cost figure was recorded — ${why}, so Stripe's own proration is the only record of what this seat cost`
}
