// lib/billing-state.ts — issue 226 step 2.
//
// Two pure derivations the consolidated admin Locations screen is built on.
// No UI, no I/O, no dates read from the ambient clock unless you let them.
//
// ── Why a classifier at all ───────────────────────────────────
// `payment_source` records what a location is CONFIGURED to do. It does not
// record what will actually happen when the renewal date arrives. Five active
// locations today are configured perfectly and will be charged nothing:
// Omaha, Portland, Scottsdale and Seattle are `direct` with no Stripe customer
// at all, and Test Location is `corporate_sponsored`. On the old Billing
// Snapshot all five read as healthy, because it counted intent.
//
// This module reports billing REALITY instead: does a live Stripe
// subscription exist, and if not, is anything covering this location.

import { isPaidThroughFuture } from './subscription-math'

// ── The states, in classification order ───────────────────────
// FIRST MATCH WINS. The order is the whole design, not a formatting choice.
//
// The trap it exists to avoid: "active, no Stripe subscription" and "prepaid,
// no card, future date" are not two groups. As bare predicates they describe
// the SAME rows — every location in the second is also in the first. Scored
// independently, the alarm bucket would permanently contain the backlog
// bucket and stop meaning anything. Ordering `owe_money_later` ahead of
// `active_not_billing` is what separates "covered for now, will fall off a
// cliff" from "nothing is coming and nothing is paid".
export const BILLING_STATES = [
  'payment_failed',
  'billing_normally',
  'owe_money_later',
  'active_not_billing',
  'not_live_yet',
] as const

export type BillingState = (typeof BILLING_STATES)[number]

// Chip copy lives next to the predicate it describes so the two cannot drift.
// A label is a definition here, not presentation — the screen decides colour,
// order and placement.
export const BILLING_STATE_LABELS: Record<BillingState, string> = {
  payment_failed: 'Payment failed',
  billing_normally: 'Billing normally',
  owe_money_later: 'Owe money later',
  active_not_billing: 'Active but not billing',
  not_live_yet: 'Not live yet',
}

// Only the fields the classifier reads. Deliberately structural rather than a
// full location type: the server feed, a test fixture and a future admin route
// can all satisfy it without agreeing on anything else.
export type BillingStateInput = {
  lifecycle_status?: string | null
  subscription_status?: string | null
  stripe_subscription_id?: string | null
  paid_through_date?: string | null
}

const ACTIVE_LIFECYCLE = 'active'

/**
 * Classify one location into exactly one billing state.
 *
 * Total by construction: `not_live_yet` is the catch-all, so every input
 * returns a state and the tallies always sum to the row count.
 *
 * `now` is injected rather than read from the clock so the boundary cases —
 * a paid_through_date of *today* is NOT in the future (isPaidThroughFuture
 * compares strictly, issue 171) — are testable without freezing time.
 *
 * A CANCELED subscription is handled by `hasLiveSubscription` above: it falls
 * to active_not_billing (or owe_money_later inside a prepaid term), not to
 * the catch-all. See that comment for why it needs no state of its own.
 */
export function classifyBillingState(
  loc: BillingStateInput,
  now: Date = new Date(),
): BillingState {
  const subscriptionStatus = loc.subscription_status ?? null

  // "Has a subscription" has to mean "has one that will CHARGE", not "has an
  // id on the row" (issue 226 step 3). A canceled subscription leaves its id
  // behind — the Stripe webhook writes subscription_status='canceled' on
  // customer.subscription.deleted and never clears stripe_subscription_id.
  //
  // Keyed on the id alone, such a location matched no bucket except the
  // catch-all, so a live franchise that had just lost its subscription
  // rendered as "Not live yet" next to a status column reading "Active" —
  // a self-contradictory row, filed under the one muted chip nobody checks.
  //
  // It needs no sixth state. "Live, and nothing is going to charge it" is
  // precisely what active_not_billing already means, and a canceled
  // subscription still inside a prepaid term is precisely owe_money_later.
  // Both buckets now reach it. Zero rows change today — all 15 subscriptions
  // in production are 'active' — and the test asserts that equivalence.
  const hasLiveSubscription =
    !!loc.stripe_subscription_id && subscriptionStatus === 'active'

  // 1. The card bounced. Written by the Stripe webhook on
  //    invoice.payment_failed and mirrored from customer.subscription.updated.
  //    First because it is the only state where money was attempted and lost.
  if (subscriptionStatus === 'past_due') return 'payment_failed'

  // 2. A live subscription that Stripe reports as active. Nothing to do.
  if (hasLiveSubscription) return 'billing_normally'

  // 3. LIVE, no subscription, but a paid-through date still in the future —
  //    the pre-Stripe cohort and the corporate-sponsored locations. Covered
  //    today, charged by nobody on the day that date passes. This is a
  //    worklist, not an alarm.
  //
  //    The lifecycle condition is load-bearing and was added deliberately.
  //    Without it, three ONBOARDING locations carrying prepaid future dates
  //    (Oklahoma City, San Antonio, and the loc_other routing bucket) landed
  //    here. Kevin's test for every bucket: is this a row I would act on? A
  //    franchise whose owner has not started onboarding is not — nothing is
  //    owed until somebody is actually using the product. They belong in
  //    not_live_yet, and this clause is what puts them there.
  if (
    loc.lifecycle_status === ACTIVE_LIFECYCLE &&
    !hasLiveSubscription &&
    isPaidThroughFuture(loc.paid_through_date, now)
  ) {
    return 'owe_money_later'
  }

  // 4. Live, no subscription, and nothing covering it. The alarm. Empty today
  //    precisely BECAUSE bucket 3 ran first — which is the point: this bucket
  //    fills as prepaid terms expire, one location at a time, and it should
  //    be empty on a healthy day.
  if (loc.lifecycle_status === ACTIVE_LIFECYCLE && !hasLiveSubscription) {
    return 'active_not_billing'
  }

  // 5. Everything else — overwhelmingly the onboarding franchises that have
  //    not reached the pay step. Muted on the screen, but counted, so the
  //    chips account for every row instead of quietly describing half of them.
  return 'not_live_yet'
}

/**
 * Count locations by state. Every key is present, zeros included, so a chip
 * whose bucket is empty renders "0" rather than disappearing — the old
 * Billing Snapshot filtered zero rows out, which is how two of its four
 * categories went years without ever being seen.
 */
export function tallyBillingStates(
  locs: readonly BillingStateInput[],
  now: Date = new Date(),
): Record<BillingState, number> {
  const tally = Object.fromEntries(
    BILLING_STATES.map((s) => [s, 0]),
  ) as Record<BillingState, number>
  for (const loc of locs) tally[classifyBillingState(loc, now)] += 1
  return tally
}

// ── Seat composition ──────────────────────────────────────────
// Extracted from app/_hub-page.tsx (issue 226 step 1), which is now the only
// caller. It lives here so it can be tested; there is no second copy.

// Catalog order. Duplicated from lib/seat-plan's TIER_ORDER *by import*, not
// by restatement — see the import below.
import { TIER_ORDER } from './seat-plan'

export type SeatCompositionRow = {
  location_id?: string | null
  tier?: string | null
}

// Structurally compatible with lib/subscription-math's SeatLine, but `tier` is
// a plain string: a tier present in the DB but absent from the price catalog
// must still be counted, not dropped on the floor. calculateSeatTotal prices
// an unknown tier at 0 via its `?? 0`, which is the honest outcome.
export type SeatLineCount = { tier: string; count: number }

export type SeatComposition = {
  seatLinesByLocation: Record<string, SeatLineCount[]>
  seatCountByLocation: Record<string, number>
}

/**
 * Reduce active seat rows to per-location tier composition.
 *
 * Callers pass ACTIVE seats only — this function does not filter by status,
 * because the query that feeds it already does and re-checking here would
 * invent a second place the definition of "a seat you are billed for" lives.
 *
 * UNASSIGNED seats count. A paid, empty seat is billed exactly like a claimed
 * one, and hiding it would restate the bug issue 216 fixed in the roster.
 *
 * Lines come back ordered by TIER_ORDER so a location's composition is stable
 * across renders; unrecognised tiers sort last, alphabetically, rather than
 * being silently discarded.
 */
export function deriveSeatComposition(
  rows: readonly SeatCompositionRow[],
): SeatComposition {
  const byLocationTier: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    if (!row?.location_id || !row?.tier) continue
    const byTier = (byLocationTier[row.location_id] ||= {})
    byTier[row.tier] = (byTier[row.tier] || 0) + 1
  }

  const seatLinesByLocation: Record<string, SeatLineCount[]> = {}
  const seatCountByLocation: Record<string, number> = {}

  for (const [locationId, byTier] of Object.entries(byLocationTier)) {
    seatLinesByLocation[locationId] = Object.entries(byTier)
      .sort(([a], [b]) => {
        const ia = TIER_ORDER.indexOf(a)
        const ib = TIER_ORDER.indexOf(b)
        if (ia === -1 && ib === -1) return a.localeCompare(b)
        if (ia === -1) return 1
        if (ib === -1) return -1
        return ia - ib
      })
      .map(([tier, count]) => ({ tier, count }))
    seatCountByLocation[locationId] = Object.values(byTier).reduce(
      (n, c) => n + c,
      0,
    )
  }

  return { seatLinesByLocation, seatCountByLocation }
}
