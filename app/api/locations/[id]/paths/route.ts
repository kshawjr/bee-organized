import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'

// POST /api/locations/[id]/paths
// Body: { default_drip_path?, default_move_drip_path?, calendar_link?,
//         rate_per_hour? }
//
// Persists the onboarding "New lead emails" selections to the location. The
// wizard picks from the four seeded master styles per project type (path_key
// 'organizing-a'..'-d' / 'moving-a'..'-d', seeded by
// migrations/seed_master_drip_paths.sql) or defers with 'custom', which the
// client maps to null — content customization lives in Settings →
// Communications (clone-and-edit of the masters; there is no from-scratch
// builder).
//
// calendar_link lives on the locations row and is owned by this step +
// Settings — the onboarding location step collects no calendar input. The
// wizard pre-seeds from the stored value and sends write-only-when-provided,
// so a re-run can never wipe a saved link; the clear-on-'' below exists for
// Settings-style callers that DO mean "remove it".
//
// lib/drip-lifecycle.startDrip resolves the stored path_key into a
// drip_paths row (location copy first, corp master fallback) when a lead
// enrolls.

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
