// app/api/locations/[id]/complete-onboarding/route.ts
//
// POST endpoint that marks a location's onboarding as complete by
// activating its subscription through lib/subscription-activation.ts —
// the SAME function the Stripe webhook uses, so the two paths can never
// drift. Activation creates/claims the owner seat AND flips
// subscription_status='deferred' → 'active' (the client no longer POSTs
// /api/seats separately).
//
// Without this, the launch animation runs to completion but the next page
// load still sees subscription_status='deferred' → effectiveCrmStatus stays
// 'onboarding' → user gets dropped back into the onboarding flow.
//
// NOTE (milestone 1, Kevin's call): NO Stripe gate here yet — the
// record-only flip stays open even when an owner Payment Link exists.
// The UI shows the Stripe Pay button when a link is configured (and the
// client already handles a 402 payment_required from this route);
// closing the free path server-side is a separate step once the paid
// path is proven.
//
// issue 220 — THIS ROUTE CHARGES NOTHING, AND NOW SAYS SO IN THE LEDGER.
// `prorated_cost` in the body is no longer written to the owner's activation
// seat; it is compared against the server's decision and, on disagreement,
// recorded as a note. Every case that gets this far owes nothing today —
// prepaid (issue 171), non-paying source, unconfigured tier, or super_admin
// acting on someone's behalf — so the seat records 0 when the owner tier's
// rate is known and nothing at all when it is not. See lib/seat-cost's
// quoteActivationSeat.
//
// issue 225 — AND SO DO THE REST OF THE SEATS. The extras from the owner's
// selection recorded null where the activation seat recorded 0, so one
// activation wrote "no charge" two ways. They now agree: 0 on a priced tier,
// unset on an unpriced one. See zeroChargeUnitCentsByTier.
//
// Auth:
//   - super_admin: any location
//   - owner: their own location only
// Anyone else: 403.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import {
  activateLocationSubscription,
  addSeatsForPlan,
  getLocationBilling,
  ownerCheckoutConfigured,
  seatPlanMarker,
} from '@/lib/subscription-activation'
import { isPrepaidTermCovering } from '@/lib/subscription-math'
import { normalizeSeatPlan } from '@/lib/seat-plan'
import {
  activationCostResponse,
  activationSeatNote,
  quoteActivationSeat,
  seatCostDivergence,
  zeroChargeUnitCentsByTier,
} from '@/lib/seat-cost'

export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role, location_id, email')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_profile' }, { status: 403 })

  const isSuperAdmin    = hubUser.role === 'super_admin'
  const isOwnerOfTarget = hubUser.role === 'owner' && hubUser.location_id === params.id
  if (!isSuperAdmin && !isOwnerOfTarget) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const location = await getLocationBilling(params.id)
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  // issue 167 BUG 3 — the record-only activation path must not hand an
  // owner-pays location the product for free when Stripe CAN charge them.
  // Only the Stripe webhook (a confirmed payment) may activate such a
  // location. This closes the hole server-side even if a stale client sends
  // the record-only POST. Deliberately NOT applied when:
  //   • the caller is super_admin — Kevin's comp / manual-grant door stays open;
  //   • the location is already active — this is then a redundant confirm, not
  //     a free activation (activateLocationSubscription short-circuits below);
  //   • Stripe isn't configured for the owner tier, or the source is
  //     non-paying — the honest record-only / free-grant path stays open;
  //   • issue 171: the location is prepaid through a FUTURE date — it owes
  //     nothing today, so activating it charges nothing legitimately. This is
  //     a DIFFERENT case from issue 167's: that hole was a BROKEN or ABANDONED
  //     checkout silently activating; here the server authorises the free flip
  //     off an unforgeable positive fact (paid_through_date > today) it reads
  //     itself, not off a client claim. A location that actually owes money has
  //     paid_through_date null or past → isPrepaidTermCovering is false → the gate
  //     below fires exactly as issue 167 built it. So the guarantee is intact:
  //     the ONLY owner-pays locations that free-activate here are the ones that
  //     genuinely owe nothing.
  // The client maps the gate's 409 to bouncing back to the pay step and
  // starting Stripe checkout (completePay), so the owner is never stuck.
  if (
    isOwnerOfTarget &&
    !isSuperAdmin &&
    location.subscription_status !== 'active' &&
    // issue 313: prepaid, not merely promised. An ACH that bounced leaves a
    // future paid_through_date behind on a past_due location; isPrepaidTermCovering
    // refuses to read that promise as a receipt, so the gate below fires and the
    // owner is sent to Stripe instead of free-activating on money that never came.
    !isPrepaidTermCovering(location) &&
    (await ownerCheckoutConfigured(location))
  ) {
    return NextResponse.json({ error: 'stripe_checkout_required' }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}))

  // issue 212 — this is the ZERO-CHARGE activation path: a prepaid location
  // (issue 171), a corporate/sponsored source, or a genuinely unconfigured
  // tier. Nothing is billed here, but the owner still picked a team on the pay
  // step, and activateLocationSubscription only ever makes the ONE owner seat.
  // So the selection is validated the same way the paid path validates it (the
  // 2-owner cap included) and the remaining seats are created. Charging
  // nothing must not mean receiving nothing.
  const planResult = normalizeSeatPlan(body?.seats)
  if (!planResult.ok) {
    const status = planResult.error === 'max_owners_reached' ? 409 : 400
    return NextResponse.json({ error: planResult.error, message: planResult.detail }, { status })
  }

  // issue 220 — THE SERVER DECIDES WHAT THE ACTIVATION SEAT RECORDS. The
  // body's `prorated_cost` used to travel straight through to the seat row, so
  // the browser's arithmetic became the permanent record of what activating
  // cost — the third instance of the defect issues 217 and 219 closed on the
  // two /api/seats routes.
  //
  // What replaces it is not the client's number made server-side. This route
  // charges nothing (it never talks to Stripe, and issue 167's gate above has
  // already sent every location that CAN be charged to checkout instead), so
  // the honest figure is 0 — not a proration of what a seat would have cost.
  // lib/seat-cost decides between 0 and nothing at all; see quoteActivationSeat
  // for why the anchor does not gate it and why an unpriced tier records null.
  const activationQuote = await quoteActivationSeat({ locationId: params.id })
  const noteParts: string[] = [activationSeatNote(activationQuote)]

  // The client still sends its figure on the direct-payment branch. It is never
  // written, but a disagreement is worth keeping: on this route it means the
  // screen quoted an amount for an activation that cost nothing, which is
  // precisely the gap issue 223's copy exists to close. Same marker as issue
  // 217, so one query finds every surface still doing money math:
  //   select id, tier, prorated_cost, notes from subscription_seats
  //   where notes ilike '%issue 217 cost divergence%'
  const divergence = seatCostDivergence(
    body?.prorated_cost,
    activationQuote.recordedCents === null ? null : [activationQuote.recordedCents],
  )
  if (divergence.diverged) {
    console.error(`[complete-onboarding] ${divergence.note} loc=${params.id}`)
    noteParts.push(divergence.note)
  }

  try {
    const result = await activateLocationSubscription({
      locationId: params.id,
      ownerUserId: isOwnerOfTarget ? user.id : null,
      proratedCostCents: activationQuote.recordedCents,
      // Applied only when a seat is INSERTED — a claimed pre-allocated seat
      // keeps the note it was created with.
      seatNotes: noteParts.join(' · '),
    })

    // Seats beyond the owner's own. Still no proration written — issue 212's
    // rule that a free seat must not be recorded as a paid one is unchanged.
    // Keyed on the location id: one onboarding per location, so a retried
    // confirm finds its own marker and adds nothing twice.
    //
    // issue 225 — THESE NOW RECORD 0, THE SAME AS THE ACTIVATION SEAT ABOVE.
    // They used to record null, so one zero-charge activation wrote "no
    // charge" two different ways and a query had to know which route made
    // each row. 0 says "this cost nothing"; null says "we could not work out
    // what this cost". These seats are the first — they are free on a priced
    // tier, which is a thing we know, not a thing we failed to compute. A
    // tier with no tier_prices row is absent from the map below and its rows
    // stay unset, so the second meaning is preserved exactly where it is
    // true. See zeroChargeUnitCentsByTier for why this overrides issue 212.
    const planned = await addSeatsForPlan({
      locationId: params.id,
      plan: planResult.plan,
      marker: seatPlanMarker('onboarding', params.id),
      unitCentsByTier: await zeroChargeUnitCentsByTier(),
      noteLabel: 'Onboarding seat selection — no charge',
    })

    // (Previously seeded default drip paths here. With master drip_paths
    // replacing the old per-location bootstrap, locations don't need their
    // own copies until an owner clicks "Customize" in Settings → Paths.)

    return NextResponse.json({
      ok: true,
      location: result.location,
      seat: result.seat,
      extra_seats: planned.seats,
      // issue 220 — what the server decided, so a caller can see it rather than
      // assume its own figure was accepted.
      cost: activationCostResponse(activationQuote),
      ...(planned.ownerCapHit ? { warning: 'max_owners_reached — extra owner seat not created' } : {}),
    })
  } catch (err: any) {
    console.error('[complete-onboarding]', err)
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
  }
}
