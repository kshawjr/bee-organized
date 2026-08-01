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
// Auth: super_admin (any location) or the owner of the target location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { stripeConfigured } from '@/lib/stripe'
import {
  createOwnerCheckoutSessionResilient,
  ownerCheckoutReturnUrls,
} from '@/lib/stripe-billing'
import {
  getLocationBilling,
  writeLocationStripeIds,
  NON_PAYING_SOURCES,
} from '@/lib/subscription-activation'
import { isPaidThroughFuture } from '@/lib/subscription-math'
import { CHECKOUT_PREPAID_ERROR } from '@/lib/stripe-checkout-return'
import { getPrimaryOwnerForLocation } from '@/lib/owner-resolution'

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

  // The owner price lives in tier_prices.stripe_price_id (test + live mode
  // carry different ids). select('*') tolerates a pre-migration schema.
  const { data: tierRow } = await supabaseService
    .from('tier_prices')
    .select('*')
    .eq('id', OWNER_TIER)
    .maybeSingle()
  const priceId = (tierRow as any)?.stripe_price_id ?? null
  if (!priceId) {
    return NextResponse.json({ error: 'owner_price_not_configured' }, { status: 409 })
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
      persistCustomerId: (cid) => writeLocationStripeIds(location.id, { customerId: cid }),
    })

    if (!session.url) {
      return NextResponse.json({ error: 'checkout_no_url' }, { status: 502 })
    }
    return NextResponse.json({ url: session.url, customer_id: customerId })
  } catch (err: any) {
    console.error('[locations/checkout]', err?.message || err)
    return NextResponse.json({ error: 'stripe_error', detail: String(err?.message || err) }, { status: 502 })
  }
}
