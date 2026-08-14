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
import { isPaidThroughFuture } from '@/lib/subscription-math'
import { normalizeSeatPlan } from '@/lib/seat-plan'

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
  //     paid_through_date null or past → isPaidThroughFuture is false → the gate
  //     below fires exactly as issue 167 built it. So the guarantee is intact:
  //     the ONLY owner-pays locations that free-activate here are the ones that
  //     genuinely owe nothing.
  // The client maps the gate's 409 to bouncing back to the pay step and
  // starting Stripe checkout (completePay), so the owner is never stuck.
  if (
    isOwnerOfTarget &&
    !isSuperAdmin &&
    location.subscription_status !== 'active' &&
    !isPaidThroughFuture(location.paid_through_date) &&
    (await ownerCheckoutConfigured(location))
  ) {
    return NextResponse.json({ error: 'stripe_checkout_required' }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}))
  const proratedCostCents =
    Number.isInteger(body?.prorated_cost) && body.prorated_cost >= 0
      ? body.prorated_cost
      : null

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

  try {
    const result = await activateLocationSubscription({
      locationId: params.id,
      ownerUserId: isOwnerOfTarget ? user.id : null,
      proratedCostCents,
    })

    // Seats beyond the owner's own. prorated_cost is left unset — nothing was
    // charged for these, and writing a price would misrepresent a free seat as
    // a paid one. Keyed on the location id: one onboarding per location, so a
    // retried confirm finds its own marker and adds nothing twice.
    const planned = await addSeatsForPlan({
      locationId: params.id,
      plan: planResult.plan,
      marker: seatPlanMarker('onboarding', params.id),
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
      ...(planned.ownerCapHit ? { warning: 'max_owners_reached — extra owner seat not created' } : {}),
    })
  } catch (err: any) {
    console.error('[complete-onboarding]', err)
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
  }
}
