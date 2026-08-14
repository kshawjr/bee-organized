// lib/seat-plan.ts
// ─────────────────────────────────────────────────────────────
// issue 212 — the ONE place that turns an onboarding seat selection into
// money and into seat rows.
//
// THE BUG THIS EXISTS TO KILL: the onboarding pay step let an owner pick
// seats (herself + a co-owner + a Hive Manager), quoted her the full total,
// then sent Stripe a hard-coded single owner line. Stripe charged for one
// seat, activation created one seat, and Settings then refused both invites
// because the pool was empty. Three numbers that must always be equal — what
// the screen quotes, what Stripe charges, what appears in subscription_seats
// — were produced by three different pieces of code.
//
// So they are produced HERE, once, from a single validated plan:
//
//   normalizeSeatPlan()      the untrusted client selection → a plan, or a
//                            typed rejection. The client cannot price itself.
//   planBillingLines()       plan → billing lines (tier, quantity, the tier
//                            whose PRICE applies). This is where the co-owner
//                            rule lives — see below.
//   planAddOnRows()          plan → the seat rows to insert BEYOND the single
//                            owner seat activateLocationSubscription makes.
//   encodeSeatPlan()         plan → a compact string for Stripe metadata, so
//                            the webhook can rebuild the plan from the SESSION
//                            rather than from client state that is long gone.
//
// THE CO-OWNER RULE (the case that actually broke Fort Lauderdale):
// a location may hold 2 owner seats. The 2nd is an elevated manager with
// owner permissions, not a second franchise owner, so it BILLS AT THE MANAGER
// RATE. calculateOwnerSubtotal() in subscription-math.ts has always encoded
// that for the on-screen total; planBillingLines() encodes the SAME rule for
// the Stripe line items. Both are derived from this module's billing lines in
// the checkout route, and a test pins them equal, so the screen and the charge
// cannot drift for exactly the configuration that failed.
//
// Seat TIER vs billing TIER is the distinction that makes this work:
//   plan            owner × 2, manager × 1     ← what she picked, what we create
//   billing lines   owner × 1, manager × 2     ← what Stripe charges
// A co-owner is an owner-tier SEAT on a manager-tier PRICE. Nothing else in
// the codebase needs to know that, because nothing else builds either list.
// ─────────────────────────────────────────────────────────────

import { calculateSeatTotal, type SeatLine, type TierPrices } from './subscription-math'

// The tiers a plan may name. Same whitelist as /api/seats POST.
export const SEAT_PLAN_TIERS = ['owner', 'manager', 'light', 'readonly'] as const
export type SeatPlanTier = (typeof SEAT_PLAN_TIERS)[number]

// A location holds at most 2 owner seats (primary + one co-owner). Mirrors
// /api/seats POST, addStripePurchasedSeats, addManuallyGrantedSeats and
// /api/admin/invite-owner — every owner-seat writer agrees on this number.
export const MAX_OWNER_SEATS = 2

// Server-side sanity ceiling on one selection. The onboarding stepper caps
// non-owner tiers well below this; the ceiling only stops an absurd payload.
export const MAX_SEATS_PER_TIER = 50

// Stable display/line order so a session's lines and a quote's breakdown read
// the same way every time. Mirrors issue 182's TIER_ORDER.
export const TIER_ORDER: readonly string[] = ['owner', 'manager', 'light', 'readonly']

export type SeatPlan = Array<{ tier: SeatPlanTier; count: number }>

export type SeatPlanRejection =
  | 'seat_plan_not_an_array'
  | 'seat_plan_invalid_tier'
  | 'seat_plan_invalid_count'
  | 'seat_plan_owner_required'
  | 'max_owners_reached'

export type SeatPlanResult =
  | { ok: true; plan: SeatPlan }
  | { ok: false; error: SeatPlanRejection; detail: string }

// The plan every pre-issue-212 caller implicitly used: one owner seat. Callers
// that send no selection at all keep exactly today's behavior.
export function defaultSeatPlan(): SeatPlan {
  return [{ tier: 'owner', count: 1 }]
}

function isPlanTier(v: unknown): v is SeatPlanTier {
  return typeof v === 'string' && (SEAT_PLAN_TIERS as readonly string[]).includes(v)
}

// Validate an untrusted selection into a plan.
//
// The client sends what the owner picked; this decides whether it is
// chargeable. Anything malformed is REJECTED, never silently coerced — a
// coerced plan would bill a number nobody saw. Duplicate tier entries are
// merged (a client that sends owner:1 twice means owner:2), zero counts are
// dropped, and the result is ordered by TIER_ORDER.
//
// `undefined`/`null` means "no selection sent" → the owner-only default, so a
// stale client that posts an empty body behaves exactly as it does today.
export function normalizeSeatPlan(input: unknown): SeatPlanResult {
  if (input === undefined || input === null) {
    return { ok: true, plan: defaultSeatPlan() }
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: 'seat_plan_not_an_array', detail: 'seats must be an array of { tier, count }' }
  }

  const counts = new Map<SeatPlanTier, number>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'seat_plan_not_an_array', detail: 'each seat line must be an object { tier, count }' }
    }
    const tier = (raw as any).tier
    const count = (raw as any).count
    if (!isPlanTier(tier)) {
      return {
        ok: false,
        error: 'seat_plan_invalid_tier',
        detail: `invalid tier "${String(tier)}" — must be one of: ${SEAT_PLAN_TIERS.join(', ')}`,
      }
    }
    if (!Number.isInteger(count) || count < 0 || count > MAX_SEATS_PER_TIER) {
      return {
        ok: false,
        error: 'seat_plan_invalid_count',
        detail: `count for tier "${tier}" must be an integer between 0 and ${MAX_SEATS_PER_TIER}`,
      }
    }
    counts.set(tier, (counts.get(tier) || 0) + count)
  }

  const ownerCount = counts.get('owner') || 0
  if (ownerCount < 1) {
    // Every location bills at least one owner seat — that IS the subscription.
    return { ok: false, error: 'seat_plan_owner_required', detail: 'a seat plan must include at least 1 owner seat' }
  }
  if (ownerCount > MAX_OWNER_SEATS) {
    return {
      ok: false,
      error: 'max_owners_reached',
      detail: `a location can have at most ${MAX_OWNER_SEATS} owner seats`,
    }
  }
  // Merged duplicates can push a tier past the ceiling even when each entry
  // was individually in range (owner:1 sent 60 times).
  for (const tier of SEAT_PLAN_TIERS) {
    const count = counts.get(tier) || 0
    if (count > MAX_SEATS_PER_TIER) {
      return {
        ok: false,
        error: 'seat_plan_invalid_count',
        detail: `count for tier "${tier}" must be an integer between 0 and ${MAX_SEATS_PER_TIER}`,
      }
    }
  }

  const plan: SeatPlan = []
  for (const tier of TIER_ORDER) {
    const count = counts.get(tier as SeatPlanTier) || 0
    if (count > 0) plan.push({ tier: tier as SeatPlanTier, count })
  }
  return { ok: true, plan }
}

export function planOwnerCount(plan: SeatPlan): number {
  return plan.find((l) => l.tier === 'owner')?.count ?? 0
}

// ── Billing lines: where the co-owner rate rule lives ─────────
// One entry per PRICE that will appear on the subscription. `seatTier` is what
// the owner picked; `billingTier` is whose price applies. They differ only for
// co-owner seats (owner seat, manager price).
export type SeatBillingLine = {
  billingTier: SeatPlanTier
  quantity: number
}

// plan → the quantities Stripe should be charged for, per price tier.
//
//   owner × 1              → owner price × 1
//   owner × 2              → owner price × 1, manager price × 1   (co-owner rule)
//   owner × 2, manager × 1 → owner price × 1, manager price × 2
//
// This is the arithmetic sibling of calculateOwnerSubtotal() — that function
// returns the same configuration as DOLLARS, this one as QUANTITIES. The
// checkout route prices these quantities and shows the result, so the two can
// never disagree about a co-owner.
export function planBillingLines(plan: SeatPlan): SeatBillingLine[] {
  const billed = new Map<SeatPlanTier, number>()
  const add = (tier: SeatPlanTier, qty: number) => {
    if (qty <= 0) return
    billed.set(tier, (billed.get(tier) || 0) + qty)
  }

  for (const line of plan) {
    if (line.tier === 'owner') {
      // The primary owner bills at the owner rate; every additional owner seat
      // is an elevated manager and bills at the manager rate.
      add('owner', Math.min(1, line.count))
      add('manager', Math.max(0, line.count - 1))
    } else {
      add(line.tier, line.count)
    }
  }

  const lines: SeatBillingLine[] = []
  for (const tier of TIER_ORDER) {
    const quantity = billed.get(tier as SeatPlanTier) || 0
    if (quantity > 0) lines.push({ billingTier: tier as SeatPlanTier, quantity })
  }
  return lines
}

// ── Seat rows to create ──────────────────────────────────────
// activateLocationSubscription() already creates (or claims) exactly ONE
// owner seat on every activation path. These are the rows that must be added
// on top of it so the seat pool matches what was billed.
//
// `billingTier` rides along so each row can record the price it was actually
// billed at — a co-owner row is tier 'owner' with the manager rate in
// prorated_cost, which is the honest record of that seat.
export type SeatAddOnRow = {
  tier: SeatPlanTier
  billingTier: SeatPlanTier
}

export function planAddOnRows(plan: SeatPlan): SeatAddOnRow[] {
  const rows: SeatAddOnRow[] = []
  for (const tier of TIER_ORDER) {
    const line = plan.find((l) => l.tier === tier)
    if (!line || line.count <= 0) continue
    if (line.tier === 'owner') {
      // Skip the first owner seat — activation owns it. Everything beyond it
      // is a co-owner: an owner-tier seat billed at the manager rate.
      for (let i = 1; i < line.count; i++) rows.push({ tier: 'owner', billingTier: 'manager' })
    } else {
      for (let i = 0; i < line.count; i++) rows.push({ tier: line.tier, billingTier: line.tier })
    }
  }
  return rows
}

// ── Pricing ──────────────────────────────────────────────────
// Price the billing lines with per-tier annual unit amounts IN CENTS. The
// checkout route sources those cents from the very tier_prices rows it pulls
// stripe_price_id from, so the quote it returns is the arithmetic of the
// session it just built — not a parallel estimate.
export function priceBillingLinesCents(
  lines: SeatBillingLine[],
  unitCentsByTier: Record<string, number | null | undefined>,
): number {
  return lines.reduce((sum, l) => sum + (unitCentsByTier[l.billingTier] ?? 0) * l.quantity, 0)
}

// The same total via the display path (subscription-math's dollar catalog).
// Kept so a test can pin the two representations equal — if the co-owner rule
// ever drifts between them, that test fails rather than an owner's card.
export function priceSeatPlanCents(plan: SeatPlan, prices: TierPrices): number {
  return Math.round(calculateSeatTotal(plan as SeatLine[], prices) * 100)
}

// ── Stripe metadata round-trip ───────────────────────────────
// The webhook must know what was bought WITHOUT trusting client state (the
// browser that made the selection may be closed by the time Stripe calls).
// Stamping the validated plan on the session's metadata at creation makes the
// SESSION itself the carrier: what we billed and what we create come from one
// server-authored string.
//
// Format is deliberately boring and short — "owner:2,manager:1" — well inside
// Stripe's 500-character metadata value limit for any plan this app can build.
export const SEAT_PLAN_METADATA_KEY = 'seat_plan'

export function encodeSeatPlan(plan: SeatPlan): string {
  return plan
    .filter((l) => l.count > 0)
    .map((l) => `${l.tier}:${l.count}`)
    .join(',')
}

// Parse a metadata string back to a plan. Returns null for anything malformed
// or absent — callers treat null as "no plan on this session" and fall back to
// today's owner-only behavior rather than inventing seats.
export function decodeSeatPlan(encoded: unknown): SeatPlan | null {
  if (typeof encoded !== 'string' || !encoded.trim()) return null
  const parts = encoded.split(',')
  const counts: Array<{ tier: SeatPlanTier; count: number }> = []
  for (const part of parts) {
    const [tier, rawCount] = part.split(':')
    if (!isPlanTier(tier?.trim())) return null
    const count = Number.parseInt((rawCount ?? '').trim(), 10)
    if (!Number.isInteger(count) || count < 0 || count > MAX_SEATS_PER_TIER) return null
    counts.push({ tier: tier.trim() as SeatPlanTier, count })
  }
  // Re-validate through the same gate the client's selection passes, so a
  // corrupted or hand-edited metadata value can never mint seats a fresh
  // selection would have been refused.
  const result = normalizeSeatPlan(counts)
  return result.ok ? result.plan : null
}
