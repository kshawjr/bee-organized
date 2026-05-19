import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// POST /api/locations/[id]/launch
// Body: (none)
//
// Final step of the owner onboarding flow. Flips lifecycle_status from
// 'onboarding' → 'active', stamps activated_at, and clears the cached
// onboarding_state since the user is done with the checklist.
//
// Does NOT touch subscription_status — that's already 'active' by this point
// (the pay step calls /api/locations/[id]/complete-onboarding to flip it).
// Two separate flags because:
//   - subscription_status tracks billing state (active / past_due / paused)
//   - lifecycle_status tracks setup state (onboarding / active / etc.)
// They can diverge: a past_due subscription is still 'lifecycle_status=active'.

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) {
      return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    }

    const locId = params.id
    const role = hubUser.role
    if (role === 'lite_user') {
      return NextResponse.json({ error: 'Read-only role' }, { status: 403 })
    }
    if (role !== 'super_admin' && hubUser.location_id !== locId) {
      return NextResponse.json(
        { error: 'Cannot launch other locations' },
        { status: 403 }
      )
    }

    const now = new Date().toISOString()
    const { error, data } = await supabaseService
      .from('locations')
      .update({
        lifecycle_status: 'active',
        activated_at: now,
        // Clear onboarding cache — flow is complete, no resume needed.
        // Audit rows in onboarding_progress remain as a permanent record
        // of when each step was completed.
        onboarding_state: {},
        updated_at: now,
      })
      .eq('id', locId)
      .select('id, lifecycle_status, activated_at, subscription_status')
      .single()

    if (error) {
      console.error(`[/api/locations/${locId}/launch POST] error:`, error.message)
      return NextResponse.json({ error: 'Failed to launch' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, location: data })
  } catch (err: any) {
    console.error('[/api/locations/[id]/launch POST] error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}
