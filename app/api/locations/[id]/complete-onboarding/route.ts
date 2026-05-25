// app/api/locations/[id]/complete-onboarding/route.ts
//
// POST endpoint that marks a location's onboarding as complete by flipping
// subscription_status to 'active' (and stamping subscription_started_at).
//
// Without this, the launch animation runs to completion but the next page
// load still sees subscription_status='deferred' → effectiveCrmStatus stays
// 'onboarding' → user gets dropped back into the onboarding flow.
//
// Auth:
//   - super_admin: any location
//   - owner: their own location only
// Anyone else: 403.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

export async function POST(
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

  const isSuperAdmin    = hubUser.role === 'super_admin'
  const isOwnerOfTarget = hubUser.role === 'owner' && hubUser.location_id === params.id
  if (!isSuperAdmin && !isOwnerOfTarget) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabaseService
    .from('locations')
    .update({
      subscription_status:     'active',
      subscription_started_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .select('id, name, subscription_status, subscription_started_at')
    .single()

  if (error) {
    console.error('[complete-onboarding]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // (Previously seeded default drip paths here. With master drip_paths
  // replacing the old per-location bootstrap, locations don't need their
  // own copies until an owner clicks "Customize" in Settings → Paths.)

  return NextResponse.json({ ok: true, location: data })
}
