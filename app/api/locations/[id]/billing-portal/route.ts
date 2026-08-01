// app/api/locations/[id]/billing-portal/route.ts
//
// POST — mint a Stripe Billing Portal session (issue 161). One
// billingPortal.sessions.create behind the "Manage billing" button;
// owners manage cards, invoices, and cancellation on Stripe's hosted
// portal. Bee Hub builds NO billing UI for any of that.
//
// Auth: super_admin (any location) or the owner of the target location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { stripeConfigured } from '@/lib/stripe'
import { createBillingPortalSession } from '@/lib/stripe-billing'
import { getLocationBilling } from '@/lib/subscription-activation'

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
    .select('role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_profile' }, { status: 403 })

  const isSuperAdmin = hubUser.role === 'super_admin'
  const isOwnerOfTarget = hubUser.role === 'owner' && hubUser.location_id === params.id
  if (!isSuperAdmin && !isOwnerOfTarget) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 409 })
  }

  const location = await getLocationBilling(params.id)
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  if (!location.stripe_customer_id) {
    // No Stripe customer yet → nothing to manage (record-only / not activated).
    return NextResponse.json({ error: 'no_stripe_customer' }, { status: 409 })
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || req.nextUrl.origin

  try {
    const session = await createBillingPortalSession({
      customerId: location.stripe_customer_id,
      returnUrl: `${origin}/`,
    })
    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('[locations/billing-portal]', err?.message || err)
    return NextResponse.json({ error: 'stripe_error', detail: String(err?.message || err) }, { status: 502 })
  }
}
