// lib/seat-cost.ts
// ─────────────────────────────────────────────────────────────
// issue 217 — THE SERVER COMPUTES WHAT A SEAT COSTS.
//
// THE BUG THIS EXISTS TO KILL: /api/seats POST and /api/seats/buy-and-invite
// both took `prorated_cost` out of the request body and wrote it to
// subscription_seats.prorated_cost verbatim. The only validation was SHAPE —
// a non-negative integer. There was no value check of any kind. So the
// client's arithmetic was the permanent record of what a seat cost, and a
// seat carried the right number only when the browser happened to compute
// correctly. issue 216 fixed the client's math; it did not make the client
// trustworthy, and a fixed client is still a client.
//
// Every input the figure needs is already on the server:
//   • the renewal anchor  → locations.paid_through_date
//   • the rate            → tier_prices.price_annual
//   • the co-owner rule   → planBillingLines() in lib/seat-plan
//   • the proration       → prorateToRenewal() in lib/subscription-math
// So the figure is computed HERE, once, and the routes write what this
// returns. The client's value is never written — see the routes.
//
// THE CO-OWNER RULE, INCREMENTALLY. lib/seat-plan owns the rule that a
// location's 2nd owner seat is an elevated manager and therefore bills at the
// MANAGER rate. That rule is stated exactly once, in planBillingLines(), and
// this module does not restate it — it DIFFERENCES it. A seat purchase is an
// increment, not a whole plan, so pricing one needs the lines for the seats
// the location will have MINUS the lines for the seats it already has:
//
//   existing owner × 1, buying owner × 1
//     before = planBillingLines(owner:1)  = owner × 1
//     after  = planBillingLines(owner:2)  = owner × 1, manager × 1
//     delta  =                              manager × 1     ← the co-owner rate
//
// A flat `tier_prices[tier] × quantity` lookup gets that case wrong by $150,
// which is precisely why it isn't written that way. Non-owner tiers difference
// to themselves (the owner lines cancel), so they cost what they always did.
//
// WHEN THERE IS NO HONEST FIGURE, NOTHING IS RECORDED. Two cases:
//   • the location has no paid_through_date → there is no renewal to prorate
//     to. This does NOT fall back to the legacy fixed March 1 (that constant
//     is the pre-Stripe cohort's, not a default) and it does not invent a
//     signup anniversary. perSeatCents is null and the row's prorated_cost is
//     LEFT UNSET.
//   • the tier has no tier_prices row → we don't know the rate. Same outcome.
// A null prorated_cost reads as "not known", which is true. A March-1 figure
// would read as "this is what the seat cost", which would be a fabrication.
// Neither case REFUSES the seat: charging behavior is unchanged by issue 217,
// and the free-grant rail (a location with no Stripe subscription) must keep
// working. The absence is loud, not silent — see unpricedReason, the seat
// note the routes attach, and the `cost` block in their responses.
//
// A tier priced at 0 is DIFFERENT from an unpriced one and is honestly free:
// prod currently carries price_annual = 0 for light and readonly, so those
// seats correctly record 0, not null.
//
// ── issue 219: THIS MODULE ALSO DECIDES WHAT STRIPE IS TOLD ──
// /api/seats POST now charges (see the route). "The amount charged and the
// amount recorded are the same number" is not a thing you can assert with a
// test alone — it has to be true by construction, so the quote carries BOTH
// halves and the route has nothing left to compute:
//
//   billingLines  → what Stripe's subscription is bumped by (price tier +
//                   quantity + the annual rate that price is supposed to be)
//   perSeatCents  → what each seat row records
//
// perSeatCents is billingLines PRICED. One list, two consumers, so the charge
// and the ledger cannot pick different tiers or different quantities. What
// they can still disagree about is the proration arithmetic — Stripe prorates
// against its own subscription period, we prorate against paid_through_date —
// which is why the route reports the outcome instead of assuming it.
//
// billingLines is populated on EVERY return path, including the unpriced ones.
// A location with no paid_through_date records no figure (that rule is issue
// 217's and is untouched), but Stripe does not need our anchor to bill — it
// has the real subscription period — so "we can't price it" must not silently
// become "nobody is charged".
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { parsePaidThroughDate, prorateToRenewal } from './subscription-math'
import {
  planBillingLines,
  TIER_ORDER,
  type SeatPlan,
  type SeatPlanTier,
  type SeatBillingLine,
} from './seat-plan'

// Why a purchase carries no recorded figure. Never a reason to refuse the
// purchase — only a reason to leave prorated_cost unset and say so.
export type SeatCostUnpricedReason = 'no_renewal_anchor' | 'tier_not_priced'

export type SeatCostLine = {
  billingTier: string
  quantity: number
  annualUnitCents: number
  proratedUnitCents: number
}

// issue 219 — one entry per PRICE LINE the location's Stripe subscription must
// be bumped by. This is the unpriced-safe half of a quote: it exists even when
// no figure can be recorded, because what to charge for is knowable from the
// seat plan alone.
//
// annualUnitCents distinguishes the two kinds of "no money":
//   0     → the tier is genuinely free (prod prices light and readonly at 0).
//           Bumping Stripe by a $0 line would move nothing now and nothing at
//           renewal, so the route skips the call outright.
//   null  → the tier has no tier_prices row at all. We don't know the rate;
//           that is a misconfiguration, not a free seat.
export type SeatBillingRateLine = {
  billingTier: string
  quantity: number
  annualUnitCents: number | null
}

export type SeatCostQuote = {
  // One entry per seat about to be inserted, IN INSERT ORDER. null means no
  // honest figure exists — the caller must leave prorated_cost unset rather
  // than write a guess.
  perSeatCents: number[] | null
  totalCents: number | null
  // The anchor the proration ran against — the location's real
  // paid_through_date, parsed server-side. null when it has none.
  renewalDate: Date | null
  paidThroughDate: string | null
  // The billing lines the figure came from (empty when unpriced).
  lines: SeatCostLine[]
  // issue 219 — the SAME lines, un-priced, and therefore present even when
  // `lines` is empty. This is what the Stripe bump iterates, so the charge and
  // the record are structurally the same tiers at the same quantities.
  billingLines: SeatBillingRateLine[]
  unpricedReason?: SeatCostUnpricedReason
}

// ── The co-owner rule, differenced ───────────────────────────
// Incremental billing lines for adding `quantity` seats at `tier` to a
// location that already holds `existingOwnerSeats` active owner seats.
// Pure, so the rule is testable without a database.
export function incrementalBillingLines(
  existingOwnerSeats: number,
  tier: SeatPlanTier,
  quantity: number,
): SeatBillingLine[] {
  const existing = Math.max(0, Math.trunc(existingOwnerSeats))
  const qty = Math.max(0, Math.trunc(quantity))
  if (qty === 0) return []

  const ownerLine = (count: number): SeatPlan => (count > 0 ? [{ tier: 'owner', count }] : [])

  const before = planBillingLines(ownerLine(existing))
  const after = planBillingLines(
    tier === 'owner'
      ? ownerLine(existing + qty)
      : [...ownerLine(existing), { tier, count: qty }],
  )

  const beforeQty = new Map<string, number>(before.map((l) => [l.billingTier, l.quantity]))
  const lines: SeatBillingLine[] = []
  for (const t of TIER_ORDER) {
    const delta =
      (after.find((l) => l.billingTier === t)?.quantity ?? 0) - (beforeQty.get(t) ?? 0)
    if (delta > 0) lines.push({ billingTier: t as SeatPlanTier, quantity: delta })
  }
  return lines
}

// Expand billing lines into one prorated cents figure PER SEAT, in TIER_ORDER
// (so the owner-rate seat leads and the co-owner's manager-rate seat follows).
// Returns null if any billed line has no known rate.
export function perSeatCentsFromLines(
  lines: SeatBillingLine[],
  annualDollarsByTier: Record<string, number | null | undefined>,
  renewalDate: Date,
  from: Date = new Date(),
): { perSeatCents: number[]; lines: SeatCostLine[] } | null {
  const perSeatCents: number[] = []
  const detail: SeatCostLine[] = []
  for (const line of lines) {
    const annual = annualDollarsByTier[line.billingTier]
    if (typeof annual !== 'number' || !Number.isFinite(annual) || annual < 0) return null
    // Same arithmetic the pay surfaces use: prorate the ANNUAL dollar rate to
    // the location's own renewal, then round once to whole cents.
    const proratedUnitCents = Math.round(prorateToRenewal(annual, renewalDate, from) * 100)
    detail.push({
      billingTier: line.billingTier,
      quantity: line.quantity,
      annualUnitCents: Math.round(annual * 100),
      proratedUnitCents,
    })
    for (let i = 0; i < line.quantity; i++) perSeatCents.push(proratedUnitCents)
  }
  return { perSeatCents, lines: detail }
}

const UNPRICED = (
  reason: SeatCostUnpricedReason,
  paidThroughDate: string | null,
  renewalDate: Date | null,
  // issue 219 — an unpriced quote still knows WHAT was bought. Dropping the
  // lines here is what would turn "no figure" into "no charge".
  billingLines: SeatBillingRateLine[] = [],
): SeatCostQuote => ({
  perSeatCents: null,
  totalCents: null,
  renewalDate,
  paidThroughDate,
  lines: [],
  billingLines,
  unpricedReason: reason,
})

// ── The one entry point the routes call ──────────────────────
// Reads the location's real paid_through_date, the live tier_prices rates and
// (for owner buys) the location's existing owner-seat count, then prices the
// increment. Never throws on a missing input — it returns an unpriced quote so
// the caller can still create the seat.
export async function quoteSeatPurchase(args: {
  locationId: string
  tier: SeatPlanTier
  quantity: number
  from?: Date
}): Promise<SeatCostQuote> {
  const { locationId, tier, quantity } = args
  const from = args.from ?? new Date()

  // 1. The renewal anchor — the location's OWN paid_through_date, read here.
  //    Never a client-passed date; never legacyFixedRenewalDate().
  const { data: location } = await supabaseService
    .from('locations')
    .select('id, paid_through_date')
    .eq('id', locationId)
    .maybeSingle()

  const paidThroughDate = (location as any)?.paid_through_date ?? null
  const renewalDate = parsePaidThroughDate(paidThroughDate)

  // 2. The owner seats already held — the co-owner rule's other operand. Only
  //    an owner-tier buy can cross the owner→manager rate boundary, so this
  //    read is skipped entirely for every other tier.
  let existingOwnerSeats = 0
  if (tier === 'owner') {
    const { count } = await supabaseService
      .from('subscription_seats')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .eq('status', 'active')
    existingOwnerSeats = count ?? 0
  }

  const lines = incrementalBillingLines(existingOwnerSeats, tier, quantity)
  if (lines.length === 0) {
    return { perSeatCents: [], totalCents: 0, renewalDate, paidThroughDate, lines: [], billingLines: [] }
  }

  // 3. The live rates. tier_prices.price_annual is whole dollars and NOT NULL
  //    in schema, so a tier is unpriced only when its ROW is missing.
  //
  //    issue 219 — this read used to sit BELOW the renewal-anchor check, so a
  //    location with no paid_through_date never learned its rates. Now that the
  //    quote also tells the route what to charge, the rates are needed on every
  //    path: a $0 tier must be recognisable as free even when no figure can be
  //    recorded, otherwise a readonly seat would mint a pointless Stripe call
  //    on exactly the locations we know least about.
  const { data: tierRows } = await supabaseService.from('tier_prices').select('id, price_annual')
  const annualByTier: Record<string, number> = {}
  for (const row of (tierRows || []) as any[]) {
    if (typeof row?.price_annual === 'number') annualByTier[row.id] = row.price_annual
  }

  const billingLines: SeatBillingRateLine[] = lines.map((l) => {
    const annual = annualByTier[l.billingTier]
    const known = typeof annual === 'number' && Number.isFinite(annual) && annual >= 0
    return {
      billingTier: l.billingTier,
      quantity: l.quantity,
      annualUnitCents: known ? Math.round(annual * 100) : null,
    }
  })

  // 4. The anchor. Missing means no HONEST FIGURE — issue 217's rule, unchanged
  //    — but the billing lines above survive, because whether the seat is
  //    chargeable was never a question the anchor answered.
  if (!renewalDate) {
    return UNPRICED('no_renewal_anchor', paidThroughDate, null, billingLines)
  }

  const priced = perSeatCentsFromLines(lines, annualByTier, renewalDate, from)
  if (!priced) return UNPRICED('tier_not_priced', paidThroughDate, renewalDate, billingLines)

  return {
    perSeatCents: priced.perSeatCents,
    totalCents: priced.perSeatCents.reduce((a, b) => a + b, 0),
    renewalDate,
    paidThroughDate,
    lines: priced.lines,
    billingLines,
  }
}

// ── Divergence reporting ─────────────────────────────────────
// The client field is never written (see the routes), but a client that still
// sends its own arithmetic is worth knowing about — it tells us which surfaces
// are still doing money math and whether their answer matches ours. Divergence
// lands in TWO places Kevin can actually look at:
//
//   1. A console.error carrying this prefix — Vercel runtime logs, filter on
//      "issue 217".
//   2. The seat row's own `notes`, so the evidence sits permanently next to
//      the figure it concerns:
//        select id, tier, prorated_cost, notes from subscription_seats
//        where notes ilike '%issue 217%';
//
// A client that sends nothing, or sends the same number the server computed,
// produces no note — only real disagreement is recorded.
export const SEAT_COST_DIVERGENCE_MARKER = 'issue 217 cost divergence'

export function seatCostDivergence(
  clientValue: unknown,
  serverPerSeatCents: number[] | null,
): { diverged: false } | { diverged: true; clientCents: number; serverCents: number | null; note: string } {
  if (clientValue === undefined || clientValue === null) return { diverged: false }
  if (!Number.isInteger(clientValue) || (clientValue as number) < 0) return { diverged: false }
  const clientCents = clientValue as number
  // The client quotes ONE per-seat figure; compare it to the first seat's.
  const serverCents = serverPerSeatCents && serverPerSeatCents.length > 0 ? serverPerSeatCents[0] : null
  if (serverCents === clientCents) return { diverged: false }
  const serverLabel = serverCents === null ? 'no figure recorded' : `${serverCents}c`
  return {
    diverged: true,
    clientCents,
    serverCents,
    note: `${SEAT_COST_DIVERGENCE_MARKER}: client sent ${clientCents}c/seat, server recorded ${serverLabel} (server value used)`,
  }
}

// The note appended to a seat row when the server could not compute a figure.
// Without it, a null prorated_cost is indistinguishable from "nobody bothered".
export function unpricedSeatNote(reason: SeatCostUnpricedReason): string {
  return reason === 'no_renewal_anchor'
    ? 'issue 217: no prorated cost recorded — the location has no paid_through_date to prorate to'
    : 'issue 217: no prorated cost recorded — the tier has no tier_prices row'
}

// Compact `cost` block for a route response, so a caller can see what the
// server decided instead of assuming its own number was accepted.
export function seatCostResponse(quote: SeatCostQuote) {
  return {
    per_seat_cents: quote.perSeatCents,
    total_cents: quote.totalCents,
    renewal_date: quote.renewalDate ? quote.renewalDate.toISOString().slice(0, 10) : null,
    paid_through_date: quote.paidThroughDate,
    lines: quote.lines,
    ...(quote.unpricedReason ? { unpriced_reason: quote.unpricedReason } : {}),
    source: 'server' as const,
  }
}
