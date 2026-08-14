// app/api/locations/[id]/checkout/route.ts
//
// POST — create a Stripe subscription-checkout session for owner
// activation (issue 161). The onboarding pay step calls this, then opens
// the returned URL on Stripe's hosted checkout; StripeCheckoutWait polls
// activation-status until the webhook (checkout.session.completed) flips
// the location active. Cards are entered ONLY on Stripe — never in Bee Hub.
//
// This is ADDITIVE, not a gate: it never blocks the record-only flow. If
// Stripe isn't configured (no owner stripe_price_id) or a Stripe call
// fails, the client falls back to the honest record-only confirm. That
// keeps the free-grant door open until a real recurring payment has
// round-tripped in test mode (issue 161 CRITICAL GUARDS).
//
// Corporate / non-paying locations never reach Stripe (402-style 409).
//
// issue 212 — THIS ROUTE NOW BILLS THE WHOLE SELECTION. It used to ignore its
// request body entirely, so every onboarding checkout charged for one owner
// seat no matter what the owner picked. It now takes the selection as input,
// validates it server-side (lib/seat-plan.ts — the client proposes, the server
// prices), builds one line item per billing tier through issue 182's existing
// lineItems field, stamps the plan on the session so the webhook can create
// the seats that were billed, and returns the authoritative quote the pay step
// displays. A second owner seat bills at the MANAGER rate (the co-owner rule),
// and every unit amount is verified against Stripe before the session is
// minted — so the number on screen and the number charged are the same number.
//
// Auth: super_admin (any location) or the owner of the target location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { stripeConfigured } from '@/lib/stripe'
import {
  createOwnerCheckoutSessionResilient,
  ownerCheckoutReturnUrls,
  retrievePriceUnitAmountCents,
} from '@/lib/stripe-billing'
import {
  getLocationBilling,
  writeLocationStripeIds,
  NON_PAYING_SOURCES,
} from '@/lib/subscription-activation'
import { isPaidThroughFuture } from '@/lib/subscription-math'
import { CHECKOUT_PREPAID_ERROR } from '@/lib/stripe-checkout-return'
import { getPrimaryOwnerForLocation } from '@/lib/owner-resolution'
import {
  normalizeSeatPlan,
  planBillingLines,
  priceBillingLinesCents,
  encodeSeatPlan,
} from '@/lib/seat-plan'

export const runtime = 'nodejs'

const OWNER_TIER = 'owner'

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

  const isSuperAdmin = hubUser.role === 'super_admin'
  const isOwnerOfTarget = hubUser.role === 'owner' && hubUser.location_id === params.id
  if (!isSuperAdmin && !isOwnerOfTarget) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const location = await getLocationBilling(params.id)
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  // Corporate / prepaid locations never pay through Stripe.
  if (NON_PAYING_SOURCES.includes(location.payment_source || '')) {
    return NextResponse.json({ error: 'non_paying_source' }, { status: 409 })
  }
  // Already activated — nothing to buy.
  if (location.subscription_status === 'active') {
    return NextResponse.json({ error: 'already_active' }, { status: 409 })
  }

  // issue 171 — a location prepaid through a FUTURE date has already been paid
  // for (the pre-Stripe cohort seeded with paid_through_date = 2027-02-27). It
  // owes nothing today, so never mint a checkout session and never quote a
  // charge: the client shows the "paid through …" surface and records the
  // activation through complete-onboarding, whose issue-167 gate now steps
  // aside for exactly this case. This runs BEFORE the Stripe-config checks so a
  // configured owner price can't drag a prepaid location into a $550 quote.
  if (isPaidThroughFuture(location.paid_through_date)) {
    return NextResponse.json(
      { error: CHECKOUT_PREPAID_ERROR, paid_through_date: location.paid_through_date },
      { status: 409 },
    )
  }

  if (!stripeConfigured()) {
    // Not configured → client keeps the record-only confirm.
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 409 })
  }

  // ── issue 212: the seat selection is an INPUT to this route ──
  // Before issue 212 the onboarding pay step POSTed a literal '{}' and this
  // route never read the body, so createOwnerCheckoutSessionResilient always
  // fell to its single-owner-line default. An owner who picked a co-owner and
  // a Hive Manager was quoted $1,350 and charged $550, and activation created
  // one seat. The selection now travels with the request and is validated
  // HERE — the client proposes, the server prices. A malformed or over-cap
  // selection is refused (400/409); no selection at all keeps the pre-212
  // owner-only behavior exactly.
  const body = await req.json().catch(() => ({}))
  const planResult = normalizeSeatPlan((body as any)?.seats)
  if (!planResult.ok) {
    const status = planResult.error === 'max_owners_reached' ? 409 : 400
    return NextResponse.json({ error: planResult.error, message: planResult.detail }, { status })
  }
  const seatPlan = planResult.plan

  // Prices live in tier_prices.stripe_price_id (test + live mode carry
  // different ids). select('*') tolerates a pre-migration schema. We need every
  // tier the plan bills, not just owner, so pull the whole table and index it —
  // the same shape issue 182 uses.
  const { data: tierRows } = await supabaseService
    .from('tier_prices')
    .select('*')
  const tierById = new Map<string, any>((tierRows || []).map((r: any) => [r.id, r]))
  const priceId = tierById.get(OWNER_TIER)?.stripe_price_id ?? null
  if (!priceId) {
    return NextResponse.json({ error: 'owner_price_not_configured' }, { status: 409 })
  }

  // Plan → billing lines. planBillingLines() owns the co-owner rule: a 2nd
  // owner seat is an owner-tier SEAT on the MANAGER price, which is exactly
  // what the confirm step renders as "co-owner … billed at Hive Manager rate".
  // One function produces both the Stripe line items and the quote below, so
  // the screen and the charge cannot disagree about it.
  const billingLines = planBillingLines(seatPlan)

  // One pass: resolve each billing line to its Stripe price + expected unit
  // amount, or fail closed. `billable` is the single list everything below is
  // derived from — line items, the quote, and the price check.
  const billable: Array<{
    tier: string
    quantity: number
    priceId: string
    unitPriceAnnual: number
    unitCents: number
  }> = []

  for (const line of billingLines) {
    const row = tierById.get(line.billingTier)
    const tierPriceId = row?.stripe_price_id ?? null
    const priceAnnual = typeof row?.price_annual === 'number' ? row.price_annual : 0
    if (tierPriceId) {
      billable.push({
        tier: line.billingTier,
        quantity: line.quantity,
        priceId: tierPriceId,
        unitPriceAnnual: priceAnnual,
        unitCents: priceAnnual * 100,
      })
    } else if (priceAnnual > 0) {
      // A paid tier with no Stripe price would silently under-bill — the exact
      // failure mode issue 212 exists to close. Fail closed, never drop a line.
      return NextResponse.json({ error: 'seat_tier_not_priced', tier: line.billingTier }, { status: 409 })
    }
    // Otherwise a genuinely free tier (price_annual 0/null, no price id):
    // carries no line and costs nothing, same as issue 182.
  }

  if (billable.length === 0) {
    return NextResponse.json({ error: 'no_billable_seats' }, { status: 409 })
  }

  const lineItems = billable.map((b) => ({ price: b.priceId, quantity: b.quantity }))

  // The quote — derived from the very lines we are about to send Stripe, using
  // the very tier_prices rows we pulled the price ids from.
  const unitCentsByTier: Record<string, number> = {}
  for (const b of billable) unitCentsByTier[b.tier] = b.unitCents
  const quotedTotalCents = priceBillingLinesCents(billingLines, unitCentsByTier)

  // …and then CHECKED against Stripe itself. tier_prices.price_annual is what
  // the pay step quotes; price.unit_amount is what the card is charged. If a
  // price was edited on one side only, those diverge silently — so we ask
  // Stripe for every unit amount and refuse to mint a session that would
  // charge a number the owner was never shown. A price we cannot verify is a
  // price we do not charge.
  try {
    for (const b of billable) {
      const stripeCents = await retrievePriceUnitAmountCents(b.priceId)
      if (stripeCents === null || stripeCents !== b.unitCents) {
        console.error(
          `[locations/checkout] price_mismatch tier=${b.tier} stripe=${stripeCents} tier_prices=${b.unitCents}`,
        )
        return NextResponse.json(
          {
            error: 'price_mismatch',
            tier: b.tier,
            stripe_unit_amount_cents: stripeCents,
            tier_prices_unit_amount_cents: b.unitCents,
          },
          { status: 409 },
        )
      }
    }
  } catch (err: any) {
    console.error('[locations/checkout] price verification failed —', err?.message || err)
    return NextResponse.json(
      { error: 'stripe_error', detail: String(err?.message || err) },
      { status: 502 },
    )
  }

  // Prefer the calling owner's email; fall back to the resolved primary owner.
  let email: string | null = isOwnerOfTarget ? (hubUser.email ?? null) : null
  if (!email) {
    const owner = await getPrimaryOwnerForLocation(location.id)
    email = owner?.email ?? null
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || req.nextUrl.origin

  try {
    // Customer + subscription-mode checkout session for the owner's annual
    // seat, in one resilient call (issue 167):
    //  • writes locations.stripe_customer_id (the column that had no write
    //    path) via writeLocationStripeIds, only when it changes;
    //  • recovers from a stale/deleted customer — if Stripe throws "No such
    //    customer" (a dashboard deletion, or a 24h idempotency-key replay of a
    //    since-deleted customer), it mints a fresh customer, overwrites the
    //    stale column, and retries the session ONCE, rather than 502ing.
    // issue 163: return the owner to the onboarding route in the SAME tab
    // after checkout (success_url / cancel_url).
    // issue 212: lineItems is the validated plan's billing lines (issue 182's
    // field, reused — there is no second line-item builder), and seatPlan
    // stamps the plan onto the session so checkout.session.completed can
    // create exactly the seats this session bills for.
    const { successUrl, cancelUrl } = ownerCheckoutReturnUrls(origin)
    const { session, customerId } = await createOwnerCheckoutSessionResilient({
      locationId: location.id,
      name: location.name,
      email,
      existingCustomerId: location.stripe_customer_id,
      priceId,
      tier: OWNER_TIER,
      successUrl,
      cancelUrl,
      lineItems,
      seatPlan: encodeSeatPlan(seatPlan),
      persistCustomerId: (cid) => writeLocationStripeIds(location.id, { customerId: cid }),
    })

    if (!session.url) {
      return NextResponse.json({ error: 'checkout_no_url' }, { status: 502 })
    }
    // quoted_total_cents is the authoritative amount due today. The pay step
    // renders THIS number rather than recomputing one, so what the owner
    // confirms is the arithmetic of the session she is about to be sent to.
    return NextResponse.json({
      url: session.url,
      customer_id: customerId,
      quoted_total_cents: quotedTotalCents,
      seat_plan: encodeSeatPlan(seatPlan),
      lines: billable.map((b) => ({
        tier: b.tier,
        quantity: b.quantity,
        unit_price_annual: b.unitPriceAnnual,
      })),
    })
  } catch (err: any) {
    console.error('[locations/checkout]', err?.message || err)
    return NextResponse.json({ error: 'stripe_error', detail: String(err?.message || err) }, { status: 502 })
  }
}
