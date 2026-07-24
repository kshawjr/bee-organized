import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// POST /api/locations/[id]/paths
// Body: { default_drip_path?, default_move_drip_path?, calendar_link? }
//
// Persists the onboarding paths-step selections to the location. Currently
// the onboarding wizard only lets users PICK from preset drip paths (path-a
// through path-e). Future Settings → Paths tab will let them build custom
// paths; that's a separate feature.
//
// calendar_link is also stored here (not just on the location step) because
// some drip paths embed it in their templates. It's the SAME column as the
// location step's calendarLink — whichever step the user completes first
// pre-fills the other.
//
// NOTE: the path_key values written here ('general-a', 'move-a', etc.)
// correspond to real drip_paths rows seeded for the 4 launch locations by
// migrations/drips_infrastructure.sql. Session 2 will resolve this text key
// into a drip_paths.id when a lead enters "New" to start their drip.

export async function POST(
  req: NextRequest,
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
    // Default drip-path / calendar config is owner/elevated — block lite_user
    // (read-only) and manager (operational lead; no location/drip config).
    if (role === 'lite_user' || role === 'manager') {
      return NextResponse.json({ error: 'Read-only role' }, { status: 403 })
    }
    if (role !== 'super_admin' && hubUser.location_id !== locId) {
      return NextResponse.json(
        { error: 'Cannot edit other locations' },
        { status: 403 }
      )
    }

    const body = await req.json().catch(() => ({}))
    const { default_drip_path, default_move_drip_path, calendar_link, rate_per_hour } =
      (body || {}) as {
        default_drip_path?: string
        default_move_drip_path?: string
        calendar_link?: string
        rate_per_hour?: string
      }

    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (typeof default_drip_path === 'string' && default_drip_path) {
      patch.default_drip_path = default_drip_path
    }
    if (typeof default_move_drip_path === 'string' && default_move_drip_path) {
      patch.default_move_drip_path = default_move_drip_path
    }
    // calendar_link is optional — only required if the selected drip path
    // needs one. Empty string clears (set to null) so users can switch from
    // a calendar-requiring path to one that doesn't.
    if (typeof calendar_link === 'string') {
      patch.calendar_link = calendar_link.trim() || null
    }
    // rate_per_hour: free-form TEXT ("$95"), rendered verbatim into drip
    // emails as {{rate_per_hour}}. Write-only-when-provided — the wizard
    // sends '' for paths C/D (no rate ask), and that must never wipe a rate
    // an owner already entered. Clearing happens in Settings, not here.
    if (typeof rate_per_hour === 'string' && rate_per_hour.trim()) {
      patch.rate_per_hour = rate_per_hour.trim()
    }

    const { error, data } = await supabaseService
      .from('locations')
      .update(patch)
      .eq('id', locId)
      .select('id, default_drip_path, default_move_drip_path, calendar_link, rate_per_hour')
      .single()

    if (error) {
      console.error(`[/api/locations/${locId}/paths POST] error:`, error.message)
      return NextResponse.json({ error: 'Failed to save your new lead emails' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, location: data })
  } catch (err: any) {
    console.error('[/api/locations/[id]/paths POST] error:', err?.message || err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}
