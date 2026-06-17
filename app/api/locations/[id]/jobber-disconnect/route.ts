// app/api/locations/[id]/jobber-disconnect/route.ts
//
// In-app "Disconnect from Jobber" button (Settings → Location). Clears the
// location's Jobber tokens + cached identity and flips jobber_connected to
// false — the same teardown the Jobber-side APP_DISCONNECT webhook performs,
// via the shared disconnectJobberFromLocation helper.
//
// Preserves jobber_account_id (audit trail) and ALL imported lead / sub-record
// data, so the owner can reconnect — to the same workspace or a different one —
// without losing history.
//
// Authorization: super_admin / admin always allowed; owner allowed only for
// their own location. Mirrors /api/locations/[id]/jobber/refresh-roster.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { disconnectJobberFromLocation } from '@/lib/jobber-disconnect'

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

  // Confirm the location exists before writing (clean 404 vs a silent no-op).
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr || !loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  // In-app disconnect leaves last_sync_status clean (null) — there's no
  // failed sync to report, the owner deliberately disconnected.
  const { error } = await disconnectJobberFromLocation(locationUuid, {
    lastSyncStatus: null,
  })
  if (error) {
    return NextResponse.json(
      { error: `disconnect_failed: ${error}` },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    message: `Disconnected ${loc.name || loc.location_id} from Jobber. Imported data preserved.`,
  })
}
