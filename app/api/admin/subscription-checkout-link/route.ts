// app/api/admin/subscription-checkout-link/route.ts
//
// issue 182 — "checkout link for an already-active location".
//
// THE GAP: subscription creation only existed inside the onboarding pay
// step. Ten legacy locations are onboarded and ACTIVE with seats but have
// no Stripe customer and no subscription — corporate paid for them directly
// through a fixed future paid_through_date. When that date arrives, Bee Hub
// should start billing them. There was no route to start a subscription for
// a location that never walked the pay step (or walked it before Stripe
// existed).
//
// THIS ROUTE: a super_admin-only action that mints a Stripe Checkout Session
// for one active location and returns its URL. Kevin copies the URL and
// sends it to the owner — there are ten owners he knows by name, so a link
// is enough; no screen in the app.
//
// The session anchors the subscription's first invoice to the location's
// paid_through_date (a FUTURE billing_cycle_anchor) and charges NOTHING
// today — the owner enters a card, the subscription exists immediately, and
// the first invoice lands on their date. See lib/stripe-billing.ts
// createOwnerCheckoutSession for the billing_cycle_anchor + proration_behavior
// 'none' zero-charge mechanism.
//
// REUSE: this drives the SAME issue-161 machinery the onboarding pay step
// uses (createOwnerCheckoutSessionResilient) with one added, optional field —
// the anchor. It is NOT a second checkout path.
//
// GUARDS (fail-closed; never silently charge):
//   • super_admin only.
//   • location must exist, be owner-pays (not corporate), and already be
//     ACTIVE — an inactive location activates through onboarding, not here.
//   • paid_through_date must be in the FUTURE. A null or past date is
//     rejected (409), never anchored — anchoring to a past date would make
//     Stripe bill immediately, the exact silent charge this route exists to
//     avoid.
//   • Stripe must be configured with an owner price (else 409, like the
//     onboarding checkout route).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { stripeConfigured } from '@/lib/stripe'
import { supabaseService } from '@/lib/supabase-service'
import {
  createOwnerCheckoutSessionResilient,
} from '@/lib/stripe-billing'
import {
  getLocationBilling,
  writeLocationStripeIds,
  NON_PAYING_SOURCES,
} from '@/lib/subscription-activation'
import { isPaidThroughFuture, parsePaidThroughDate } from '@/lib/subscription-math'
import { getPrimaryOwnerForLocation } from '@/lib/owner-resolution'

export const runtime = 'nodejs'

const OWNER_TIER = 'owner'

// Where Stripe returns the owner after hosted checkout. Deliberately NOT the
// onboarding '?stripe_checkout=' marker (issue 163) — these owners are not
// onboarding, and that marker drives the onboarding pay-step polling. A benign
// marker lands them on the app without resuming an onboarding flow that is
// already complete for their location.
function activeLinkReturnUrls(origin: string): { successUrl: string; cancelUrl: string } {
  const base = origin.replace(/\/$/, '')
  return {
    successUrl: `${base}/?subscription_setup=complete`,
    cancelUrl: `${base}/?subscription_setup=cancel`,
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()
  // super_admin ONLY — this mints a billing subscription for a live location.
  if (!hubUser || hubUser.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden — super_admin only' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const locationId = body?.location_id
  if (typeof locationId !== 'string' || !locationId) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  const location = await getLocationBilling(locationId)
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  // ─── issue 226 step 7 — THE DUPLICATE-SUBSCRIPTION GUARD ───
  //
  // This check existed only in GetPaymentLinkButton, which fetched the id and
  // replaced its primary action with a red confirmation. That is good design
  // and it is not a guard: anything reaching this route directly — a second
  // tab, a retried request, a script, a future caller — minted a second
  // subscription and the location was billed twice. A guard in a component is
  // not a guard.
  //
  // WARN-AND-CONFIRM, NOT HARD-REFUSE, deliberately: a genuinely canceled or
  // failed subscription still needs to be re-mintable without a code change.
  // So the route refuses BY DEFAULT and accepts an explicit acknowledgement —
  // the server-side twin of the button's "generate anyway", which now sends
  // it. The default is the safe one, which is the half that was missing.
  //
  // stripe_subscription_id is already on the row getLocationBilling reads; the
  // route simply never looked at it.
  if (location.stripe_subscription_id && body?.confirm_replace_existing !== true) {
    return NextResponse.json(
      {
        error: 'subscription_exists',
        stripe_subscription_id: location.stripe_subscription_id,
        message:
          'This location already has a Stripe subscription. Minting another would bill it twice. Resend with confirm_replace_existing:true only if that subscription is known to be canceled or failed.',
      },
      { status: 409 },
    )
  }

  // Corporate / non-paying locations never pay through Stripe.
  if (NON_PAYING_SOURCES.includes(location.payment_source || '')) {
    return NextResponse.json({ error: 'non_paying_source' }, { status: 409 })
  }

  // This action is for ALREADY-ACTIVE locations only. A location that has not
  // activated yet has the onboarding pay step (and issue 171's prepaid branch);
  // starting a subscription here would race that flow.
  if (location.subscription_status !== 'active') {
    return NextResponse.json({ error: 'location_not_active' }, { status: 409 })
  }

  // The anchor is the location's paid_through_date, and it MUST be in the
  // future. A null or past date has nothing to anchor to — anchoring to it
  // would make Stripe bill immediately (a past billing_cycle_anchor prorates/
  // bills now). Reject rather than silently charge the owner. (issue 182)
  if (!isPaidThroughFuture(location.paid_through_date)) {
    return NextResponse.json(
      { error: 'paid_through_not_future', paid_through_date: location.paid_through_date },
      { status: 409 },
    )
  }
  const anchorDate = parsePaidThroughDate(location.paid_through_date)
  if (!anchorDate) {
    // Defensive: isPaidThroughFuture already parsed it, so this is unreachable.
    return NextResponse.json({ error: 'paid_through_unparseable' }, { status: 409 })
  }
  const billingCycleAnchor = Math.floor(anchorDate.getTime() / 1000)

  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 409 })
  }

  // Prices live in tier_prices.stripe_price_id (test + live carry different
  // ids). select('*') tolerates a pre-migration schema. Build a tier → row map
  // so we can price every seat tier the location actually holds.
  const { data: tierRows } = await supabaseService
    .from('tier_prices')
    .select('*')
  const tierById = new Map<string, any>(
    (tierRows || []).map((r: any) => [r.id, r]),
  )
  const ownerPriceId = tierById.get(OWNER_TIER)?.stripe_price_id ?? null
  if (!ownerPriceId) {
    return NextResponse.json({ error: 'owner_price_not_configured' }, { status: 409 })
  }

  // issue 182: build a line item per tier from the location's ACTIVE seat
  // rows, at the real quantities — so the whole existing team (owner +
  // managers + …) is on the subscription from creation and bills as ONE
  // invoice on the anchor date. We do NOT assume a count; we read the rows,
  // and if a location has no manager rows, no manager line is created (nothing
  // is invented). This mirrors seat-stripe-sync's 1:1 tier→stripe_price_id
  // mapping, so a seat added/removed later through the rails operates on the
  // same line this session creates.
  const { data: seatRows, error: seatErr } = await supabaseService
    .from('subscription_seats')
    .select('tier')
    .eq('location_id', location.id)
    .eq('status', 'active')
  if (seatErr) {
    console.error('[admin/subscription-checkout-link] seat read failed —', seatErr.message)
    return NextResponse.json({ error: 'seat_read_failed' }, { status: 500 })
  }

  const countByTier = new Map<string, number>()
  for (const s of seatRows || []) {
    const t = (s as any).tier
    if (typeof t === 'string' && t) countByTier.set(t, (countByTier.get(t) || 0) + 1)
  }

  // Assemble the line items. Order owner first for a stable, legible session.
  const TIER_ORDER = ['owner', 'manager', 'light', 'readonly']
  const orderedTiers = [
    ...TIER_ORDER.filter((t) => countByTier.has(t)),
    ...Array.from(countByTier.keys()).filter((t) => !TIER_ORDER.includes(t)),
  ]
  const lineItems: Array<{ price: string; quantity: number }> = []
  const lines: Array<{ tier: string; quantity: number; unit_price_annual: number | null }> = []
  for (const t of orderedTiers) {
    const quantity = countByTier.get(t) || 0
    if (quantity <= 0) continue
    const row = tierById.get(t)
    const priceId = row?.stripe_price_id ?? null
    const priceAnnual = typeof row?.price_annual === 'number' ? row.price_annual : null
    if (priceId) {
      lineItems.push({ price: priceId, quantity })
      lines.push({ tier: t, quantity, unit_price_annual: priceAnnual })
    } else if (priceAnnual && priceAnnual > 0) {
      // A paid tier with no Stripe price would silently under-bill — fail
      // closed rather than drop it from the subscription.
      return NextResponse.json(
        { error: 'seat_tier_not_priced', tier: t }, { status: 409 },
      )
    }
    // Otherwise a free tier (price_annual 0/null, no price id) — carry no line.
  }

  if (lineItems.length === 0) {
    // An active location with no billable seat rows has nothing to subscribe.
    return NextResponse.json({ error: 'no_billable_seats' }, { status: 409 })
  }

  const projectedAnnualCents = lines.reduce(
    (sum, l) => sum + (l.unit_price_annual ?? 0) * 100 * l.quantity, 0,
  )

  // Prefill the owner's email so their Stripe receipt / customer matches.
  const owner = await getPrimaryOwnerForLocation(location.id)
  const email = owner?.email ?? null

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || req.nextUrl.origin
  const { successUrl, cancelUrl } = activeLinkReturnUrls(origin)

  try {
    // SAME resilient machinery as the onboarding checkout route (issue 161 +
    // issue 167 stale-customer recovery), plus the future anchor. Seat
    // quantity: ALL of the location's active seats, one line per tier (issue
    // 182 — Kevin's call). The whole existing team is on the subscription at
    // creation, so the first invoice on the anchor date is a single charge for
    // owner + managers + …, never a mid-cycle proration added afterward.
    const { session } = await createOwnerCheckoutSessionResilient({
      locationId: location.id,
      name: location.name,
      email,
      existingCustomerId: location.stripe_customer_id,
      priceId: ownerPriceId,
      tier: OWNER_TIER,
      billingCycleAnchor,
      lineItems,
      successUrl,
      cancelUrl,
      persistCustomerId: (cid) => writeLocationStripeIds(location.id, { customerId: cid }),
    })

    if (!session.url) {
      return NextResponse.json({ error: 'checkout_no_url' }, { status: 502 })
    }
    return NextResponse.json({
      url: session.url,
      location_id: location.id,
      anchor_date: location.paid_through_date,
      // The composition Kevin can sanity-check before sending the link.
      lines,
      projected_annual_cents: projectedAnnualCents,
    })
  } catch (err: any) {
    console.error('[admin/subscription-checkout-link]', err?.message || err)
    return NextResponse.json({ error: 'stripe_error', detail: String(err?.message || err) }, { status: 502 })
  }
}
