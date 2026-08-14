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
// ── issue 221: AND WHAT STRIPE IS TOLD ON THE WAY OUT ────────
// The co-owner rule was applied to additions and not to removals, so removing
// a co-owner credited the owner line for a seat charged at the manager rate.
// quoteSeatRemoval below closes that: it differences the very same billing
// lines in the opposite direction. See decrementalBillingLines.
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
// Both directions difference the SAME two plans; they only disagree about
// which one is the subtrahend. An add asks "what lines does the location gain",
// a removal asks "what lines does it lose", and neither restates the co-owner
// rule — planBillingLines() is still the only place it is written down.

const ownerLine = (count: number): SeatPlan => (count > 0 ? [{ tier: 'owner', count }] : [])

// The two plans a seat change sits between: the location WITHOUT the seats in
// question, and WITH them. `steadyOwnerSeats` is the owner seats present in
// both — for an owner-tier change that is the count EXCLUDING the seats being
// added or removed, which is what makes the pair the same for either direction.
function planPair(
  steadyOwnerSeats: number,
  tier: SeatPlanTier,
  quantity: number,
): [SeatPlan, SeatPlan] {
  const without = ownerLine(steadyOwnerSeats)
  const withThem: SeatPlan =
    tier === 'owner'
      ? ownerLine(steadyOwnerSeats + quantity)
      : [...ownerLine(steadyOwnerSeats), { tier, count: quantity }]
  return [without, withThem]
}

// Lines gained going `from` → `to`. Only positive deltas survive: a caller asks
// either "what did this add" or "what did this drop", and gets that list as
// quantities to move the subscription BY, sign supplied by the caller.
function positiveDelta(from: SeatBillingLine[], to: SeatBillingLine[]): SeatBillingLine[] {
  const fromQty = new Map<string, number>(from.map((l) => [l.billingTier, l.quantity]))
  const lines: SeatBillingLine[] = []
  for (const t of TIER_ORDER) {
    const delta = (to.find((l) => l.billingTier === t)?.quantity ?? 0) - (fromQty.get(t) ?? 0)
    if (delta > 0) lines.push({ billingTier: t as SeatPlanTier, quantity: delta })
  }
  return lines
}

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

  // Every existing owner seat stays, so all of them are the steady count.
  const [without, withThem] = planPair(existing, tier, qty)
  return positiveDelta(planBillingLines(without), planBillingLines(withThem))
}

// issue 221 — THE SAME DIFFERENCE, RUN BACKWARDS.
//
// Removing a seat credits a line, and it must be the line that seat was
// actually CHARGED on. A flat `tier_prices[seat.tier]` lookup credits the $550
// owner line for a co-owner that was billed $400 at the manager rate — the
// owner is handed $150 they never paid. So a removal is priced exactly the way
// issue 217 priced an addition, with the two plans swapped: the lines the
// location HAS, minus the lines it WILL have.
//
//   existing owner × 2, removing owner × 1
//     has       = planBillingLines(owner:2)  = owner × 1, manager × 1
//     will have = planBillingLines(owner:1)  = owner × 1
//     credit    =                              manager × 1   ← the co-owner rate
//
//   existing owner × 1, removing owner × 1
//     has       = owner × 1
//     will have = (no seats)                 = (no lines)
//     credit    = owner × 1
//
// `existingOwnerSeats` is the count BEFORE the removal — same meaning as
// incrementalBillingLines' operand — and it is a COUNT, not an identity. That
// is the whole answer to "which of the two owner rows was deleted": the
// arithmetic cannot see which row it was, so removing either one of a
// location's two owner seats credits the manager line and leaves the survivor
// on the owner line. Removing both, in either order, credits manager then
// owner — one credit per line, exactly what was charged.
//
// Non-owner tiers difference to themselves (the owner lines cancel on both
// sides), so a manager/light/readonly removal credits its own line, unchanged.
export function decrementalBillingLines(
  existingOwnerSeats: number,
  tier: SeatPlanTier,
  quantity: number,
): SeatBillingLine[] {
  const existing = Math.max(0, Math.trunc(existingOwnerSeats))
  const qty = Math.max(0, Math.trunc(quantity))
  if (qty === 0) return []

  // The owner seats that SURVIVE the removal are the steady count — for an
  // owner-tier removal that is the existing count minus what is going. That
  // operand is the only thing the two directions disagree about: an addition
  // differences from where the location stands NOW, a removal from where it
  // will stand AFTER. The difference itself is the same one, taken the same
  // way round — has (with the seats) minus will-have (without them).
  const steady = tier === 'owner' ? Math.max(0, existing - qty) : existing
  const [without, withThem] = planPair(steady, tier, qty)
  return positiveDelta(planBillingLines(without), planBillingLines(withThem))
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

// ── issue 220: quoting an ACTIVATION, which charges nothing ──
//
// THE THIRD AND LAST SITE. /api/locations/[id]/complete-onboarding took
// `prorated_cost` out of the request body and handed it to
// activateLocationSubscription, which wrote it verbatim to the owner's
// activation seat — the same column and the same defect issues 217 and 219
// closed on /api/seats and /api/seats/buy-and-invite.
//
// DOES THE INCREMENT MACHINERY FIT AN ACTIVATION? Its two halves answer
// differently, and that is the whole design here.
//
//   The LINES half fits exactly. An activation is the increment from zero:
//   quoteSeatPurchase(tier 'owner', quantity 1) on a location with no owner
//   seat differences planBillingLines([]) against planBillingLines(owner:1),
//   which is owner × 1. Nothing about planPair/positiveDelta needs a special
//   case for an empty "before" — an empty plan produces an empty line list and
//   the delta is simply the whole "after". So this does NOT restate the rule.
//
//   The PRICED half does not fit, and must not be used. perSeatCents answers
//   "what does buying this seat cost today", prorated from now to the
//   location's renewal. Every caller that reaches this route is buying
//   nothing: issue 167's gate sends any owner-pays location that CAN be
//   charged to Stripe instead, so what is left is prepaid (issue 171),
//   corporate/non-paying, an unconfigured tier, or super_admin acting on
//   someone's behalf. Worse, the case where the proration is most confidently
//   computable is the one where it is most wrong: an issue-171 prepaid
//   location HAS a future paid_through_date, so quoteSeatPurchase returns a
//   healthy positive figure for a seat that was charged $0. Recording it would
//   swap one fabrication (the client's) for another (ours).
//
// So this composes quoteSeatPurchase and consumes the half issue 219 built for
// exactly this shape — billingLines, which is populated on every return path
// including the unpriced ones, because "what tier is this seat billed on" was
// never a question the renewal anchor answered. That leaves one question worth
// asking: do we know a rate for that tier at all?
//
//   rate known (0 included) → the seat records 0. We charged nothing, and we
//                             can say so because we know what it would have
//                             cost. A tier priced at 0 is honestly free.
//   no tier_prices row      → the seat records NOTHING. Without a rate, "free"
//                             and "we could not work it out" are the same
//                             silence, and issue 217's rule stands: an absent
//                             figure is true, a fabricated one is not.
//
// The distinction survives in the column itself — 0 versus null — which is
// what issue 223's copy leans on, and it is repeated in the seat's note so a
// row read on its own still explains itself.
//
// The renewal anchor is deliberately NOT a reason to withhold the figure here,
// unlike in a purchase. A purchase with no anchor cannot be prorated; an
// activation is not prorated at all, so a missing paid_through_date has no
// bearing on whether $0 is the honest record. It is.
export type ActivationSeatQuote = {
  // What the activation seat's prorated_cost records. 0 = charged nothing,
  // rate known. null = no rate, so nothing is written.
  recordedCents: number | null
  unpricedReason?: SeatCostUnpricedReason
  // The underlying purchase quote. NEVER written — reported so a caller can
  // see what the seat would have cost had it been bought, and so the annual
  // rate (which is knowable even here) stays available to the response.
  quote: SeatCostQuote
}

export async function quoteActivationSeat(args: {
  locationId: string
  from?: Date
}): Promise<ActivationSeatQuote> {
  // quantity 1: activateLocationSubscription creates exactly ONE owner seat,
  // and every seat beyond it is addSeatsForPlan's (issue 212).
  const quote = await quoteSeatPurchase({
    locationId: args.locationId,
    tier: 'owner',
    quantity: 1,
    from: args.from,
  })

  // One line, because one seat. On a fresh location that line is owner × 1.
  // A location that already holds an owner seat differences to the manager
  // line instead (the co-owner rule) — harmless, because activation CLAIMS a
  // pre-allocated owner seat rather than inserting one, so nothing is recorded
  // on that path at all.
  const line = quote.billingLines[0]
  if (!line || line.annualUnitCents === null) {
    return { recordedCents: null, unpricedReason: 'tier_not_priced', quote }
  }
  return { recordedCents: 0, quote }
}

// The note that keeps the two kinds of "no money" apart on the row itself.
export function activationSeatNote(q: ActivationSeatQuote): string {
  return q.recordedCents === null
    ? 'issue 220: no cost recorded for this activation — the owner tier has no tier_prices row, so a free seat and an unknown one could not be told apart'
    : 'issue 220: activation charged nothing — $0 recorded'
}

// The `cost` block for the activation response, deliberately NOT
// seatCostResponse(): that reports a purchase's prorated figure, and this route
// makes no purchase. What a caller needs here is what was recorded, the fact
// that nothing was charged, and the annual rate this location renews at.
export function activationCostResponse(q: ActivationSeatQuote) {
  return {
    recorded_cents: q.recordedCents,
    // This route does not touch Stripe. Stated rather than implied, so a
    // recorded 0 is never read as "we charged and it came to zero".
    charged_cents: 0,
    annual_total_cents: annualTotalCents(q.quote),
    paid_through_date: q.quote.paidThroughDate,
    ...(q.unpricedReason ? { unpriced_reason: q.unpricedReason } : {}),
    source: 'server' as const,
  }
}

// ── issue 221: quoting a REMOVAL ─────────────────────────────
// The mirror of quoteSeatPurchase, and deliberately smaller. A removal records
// no figure — subscription_seats.prorated_cost is the historical record of what
// that seat cost when it was bought, and a credit does not rewrite history — so
// there is no renewal anchor to resolve and no per-seat cents to compute. What
// the removal DOES need is the one thing the old call site got wrong: which
// price line to credit, and whether that line is worth a Stripe call at all.
export type SeatRemovalQuote = {
  // The lines to decrement, with the annual rate so a $0 tier can be skipped
  // before any Stripe work — same shape and same rule as a purchase's.
  billingLines: SeatBillingRateLine[]
}

// CALL ORDER MATTERS, so it is stated here rather than left to the caller to
// remember: this reads the owner seats that REMAIN ACTIVE and adds the removal
// back, which means it must run AFTER the seat rows have been marked inactive.
// /api/seats DELETE writes the row first by design (the seat write is
// authoritative and is never blocked on billing), so counting what remains is
// both the natural read and the stable one: re-issuing the same DELETE against
// an already-inactive seat recomputes the IDENTICAL line, so Stripe replays the
// first credit through the seat-anchored idempotency key instead of erroring on
// a key reused with different parameters.
export async function quoteSeatRemoval(args: {
  locationId: string
  tier: SeatPlanTier
  quantity?: number
}): Promise<SeatRemovalQuote> {
  const { locationId, tier } = args
  const quantity = args.quantity ?? 1

  // Only an owner-tier removal can cross the owner→manager rate boundary, so
  // every other tier skips this read exactly as quoteSeatPurchase does.
  let existingOwnerSeats = 0
  if (tier === 'owner') {
    const { count } = await supabaseService
      .from('subscription_seats')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .eq('status', 'active')
    // What remains + what we just removed = what the location held.
    existingOwnerSeats = (count ?? 0) + quantity
  }

  const lines = decrementalBillingLines(existingOwnerSeats, tier, quantity)
  if (lines.length === 0) return { billingLines: [] }

  const { data: tierRows } = await supabaseService.from('tier_prices').select('id, price_annual')
  const annualByTier: Record<string, number> = {}
  for (const row of (tierRows || []) as any[]) {
    if (typeof row?.price_annual === 'number') annualByTier[row.id] = row.price_annual
  }

  return {
    billingLines: lines.map((l) => {
      const annual = annualByTier[l.billingTier]
      const known = typeof annual === 'number' && Number.isFinite(annual) && annual >= 0
      return {
        billingTier: l.billingTier,
        quantity: l.quantity,
        annualUnitCents: known ? Math.round(annual * 100) : null,
      }
    }),
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

// ── issue 224: the OTHER figure the screen needs ─────────────
// The tier picker names two amounts — what is charged today and what renews
// every year after. The first has been the server's since issue 217. The
// second was still the browser's: the modals read tier_prices out of a React
// context and, in the add-seats case, multiplied it by the quantity. That is
// the same shape of client money math issue 216 fixed and issue 217 closed,
// and it disagrees with the charge in exactly the case the co-owner rule
// exists for — a 2nd owner seat renews at the MANAGER rate, so a
// `tier_prices[tier] × quantity` lookup overstates it by $150.
//
// So the annual figure is differenced from the SAME billingLines the charge
// walks and the per-seat record is priced from. One list, now three
// consumers, and none of them can pick a different tier or quantity.
//
// null when ANY billed line has no known rate (`annualUnitCents: null` — a
// missing tier_prices row). A partial sum would read as the whole year's
// price while silently omitting a line, so there is no partial sum. Note this
// is orthogonal to totalCents being null: a location with no
// paid_through_date cannot be quoted a figure for today (issue 217 refuses to
// invent an anchor) but its annual rate is perfectly knowable, and the picker
// says so rather than going blank on both halves.
export function annualTotalCents(quote: SeatCostQuote): number | null {
  let total = 0
  for (const line of quote.billingLines) {
    if (line.annualUnitCents === null) return null
    total += line.annualUnitCents * line.quantity
  }
  return total
}

// Compact `cost` block for a route response, so a caller can see what the
// server decided instead of assuming its own number was accepted.
export function seatCostResponse(quote: SeatCostQuote) {
  return {
    per_seat_cents: quote.perSeatCents,
    total_cents: quote.totalCents,
    // issue 224 — what this purchase adds to the location's yearly bill from
    // its renewal onward. Present even when total_cents is null.
    annual_total_cents: annualTotalCents(quote),
    renewal_date: quote.renewalDate ? quote.renewalDate.toISOString().slice(0, 10) : null,
    paid_through_date: quote.paidThroughDate,
    lines: quote.lines,
    ...(quote.unpricedReason ? { unpriced_reason: quote.unpricedReason } : {}),
    source: 'server' as const,
  }
}
