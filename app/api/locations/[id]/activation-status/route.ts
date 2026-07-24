// app/api/locations/[id]/activation-status/route.ts
//
// Lightweight poll target for the "waiting for Stripe payment" states.
// After the owner opens Stripe checkout in a new tab, the originating
// surface polls this until the webhook's writes become visible:
//   - onboarding activation → subscription_status flips to 'active'
//   - seat purchase         → active seat count at the tier increases
//
// Read-only, cheap (two indexed queries), safe to hit every few seconds.
//
// Auth: elevated roles, or any hub_user belonging to the location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
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

  const isElevated = hubUser.role === 'super_admin' || hubUser.role === 'admin'
  if (!isElevated && hubUser.location_id !== params.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const [{ data: location }, { data: seats }] = await Promise.all([
    supabaseService
      .from('locations')
      .select('id, subscription_status, paid_through_date')
      .eq('id', params.id)
      .maybeSingle(),
    supabaseService
      .from('subscription_seats')
      .select('tier')
      .eq('location_id', params.id)
      .eq('status', 'active'),
  ])

  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  const active_seats_by_tier: Record<string, number> = {}
  for (const s of seats || []) {
    active_seats_by_tier[s.tier] = (active_seats_by_tier[s.tier] || 0) + 1
  }

  return NextResponse.json({
    subscription_status: location.subscription_status,
    paid_through_date: location.paid_through_date,
    active_seats_by_tier,
  })
}
