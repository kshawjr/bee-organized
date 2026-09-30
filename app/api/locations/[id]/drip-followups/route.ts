// app/api/locations/[id]/drip-followups/route.ts
//
// The owner's switch for emails AFTER the first one (lib/drip-followups.ts
// holds the rule and the reasoning).
//
// GET   → { off, in_flight }
//         off        locations.drip_followups_off
//         in_flight  how many people at this location are partway through a
//                    sequence past step 1 right now — the number switching
//                    off would stop. Read live, so the confirm never quotes a
//                    stale figure.
// PATCH { off: boolean } → { ok, off, stopped }
//         off=true   saves the setting, THEN stops everyone past step 1
//                    (stopped_reason 'followups_off'). Setting first: a cron
//                    tick landing between the two writes then stops the row
//                    itself rather than sending it.
//         off=false  saves the setting and nothing else. Nobody stopped by
//                    the switch resumes — deliberate, and said on the screen.
//
// Step 1 and the welcome are not this route's to touch, in either direction.
//
// Auth: same as the other drip-config routes — signed in; lite_user and
// manager refused; an owner only for their own location, admins any.
// Until migrations/locations_drip_followups_off.sql is run the column is
// absent: GET reports off=false, PATCH refuses with 'not_set_up_yet'.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { followupsInFlight, readFollowupsOff, stopFollowupsInFlight } from '@/lib/drip-followups'

export const runtime = 'nodejs'

async function authorise(locId: string, write: boolean) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  if (write && (hubUser.role === 'lite_user' || hubUser.role === 'manager')) {
    return NextResponse.json({ error: 'forbidden_read_only' }, { status: 403 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locId) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }
  return null
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await authorise(params.id, false)
  if (denied) return denied
  const off = await readFollowupsOff(params.id)
  const found = await followupsInFlight(params.id)
  return NextResponse.json({ off, in_flight: found.error ? null : found.ids.length })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await authorise(params.id, true)
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }
  if (typeof body.off !== 'boolean') {
    return NextResponse.json({ error: 'off_must_be_boolean' }, { status: 400 })
  }
  const off = body.off

  const { error: upErr } = await supabaseService
    .from('locations')
    .update({ drip_followups_off: off })
    .eq('id', params.id)
  if (upErr) {
    console.error('[/api/locations/[id]/drip-followups PATCH] update failed', upErr.message)
    const missing = /drip_followups_off/.test(upErr.message)
    return NextResponse.json(
      { error: missing ? 'not_set_up_yet' : 'update_failed', detail: upErr.message },
      { status: missing ? 503 : 500 },
    )
  }

  if (!off) return NextResponse.json({ ok: true, off, stopped: 0 })

  const res = await stopFollowupsInFlight(params.id)
  if (res.error) {
    // The setting is saved, so the send path stops each of these as it comes
    // due anyway. Say so rather than pretend the whole thing failed.
    console.error('[/api/locations/[id]/drip-followups PATCH] stop in-flight failed', res.error)
    return NextResponse.json({ ok: true, off, stopped: null, warning: 'stop_in_flight_failed' })
  }
  return NextResponse.json({ ok: true, off, stopped: res.stopped })
}
