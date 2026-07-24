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
  getLocationBilling,
} from '@/lib/subscription-activation'

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

  const body = await req.json().catch(() => ({}))
  const proratedCostCents =
    Number.isInteger(body?.prorated_cost) && body.prorated_cost >= 0
      ? body.prorated_cost
      : null

  try {
    const result = await activateLocationSubscription({
      locationId: params.id,
      ownerUserId: isOwnerOfTarget ? user.id : null,
      proratedCostCents,
    })

    // (Previously seeded default drip paths here. With master drip_paths
    // replacing the old per-location bootstrap, locations don't need their
    // own copies until an owner clicks "Customize" in Settings → Paths.)

    return NextResponse.json({ ok: true, location: result.location, seat: result.seat })
  } catch (err: any) {
    console.error('[complete-onboarding]', err)
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
  }
}
