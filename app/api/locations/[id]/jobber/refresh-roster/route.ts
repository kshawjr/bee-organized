// app/api/locations/[id]/jobber/refresh-roster/route.ts
//
// Manual "Refresh Jobber roster" button from Settings → Team. Fetches the
// current team from Jobber, updates locations.jobber_team_roster +
// locations.jobber_team_roster_synced_at, and re-runs the email-based
// auto-match for any hub_users at this location that don't have a
// jobber_user_id yet.
//
// Authorization: super_admin / admin always allowed; owner allowed only
// for their own location. Mirrors the pattern used by the DELETE handler
// in /api/hub_users/[id]/route.ts.
//
// Returns the refreshed roster + match counts so the UI can refresh the
// dropdown options without a separate fetch.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  fetchRosterByLocationSlug,
  persistRosterAndMatch,
} from '@/lib/jobber-team-roster'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const locationUuid = params.id
  if (!locationUuid) {
    return NextResponse.json({ error: 'location id required' }, { status: 400 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!caller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const isOwnerOfTargetLoc =
    caller.role === 'owner' && caller.location_id === locationUuid
  if (!isElevated(caller.role) && !isOwnerOfTargetLoc) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Resolve the location's slug — lib/jobber's high-level helpers key on
  // locations.location_id (the Zoho slug), not the uuid PK.
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, location_id, jobber_access_token')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr || !loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }
  if (!loc.jobber_access_token) {
    return NextResponse.json(
      { error: 'location not connected to Jobber', code: 'not_connected' },
      { status: 400 }
    )
  }

  const roster = await fetchRosterByLocationSlug(loc.location_id)
  if (!roster) {
    return NextResponse.json(
      { error: 'Jobber roster fetch failed. Check Jobber connection.' },
      { status: 502 }
    )
  }

  const { matched, rosterSize } = await persistRosterAndMatch(loc.id, roster)

  return NextResponse.json({
    ok: true,
    roster,
    roster_size: rosterSize,
    newly_linked: matched,
    synced_at: new Date().toISOString(),
  })
}
