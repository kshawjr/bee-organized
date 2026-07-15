// app/api/locations/[id]/slack-invite/route.ts
//
// "Team invite link" Save button on the SlackCard (Settings → Communications).
// Persists the location's shareable Slack invite URL (slack_invite_url) so the
// owner can copy it and hand it to teammates. LOCATION invite only — corporate
// invites are not written here.
//
// Authorization: super_admin / admin always allowed; owner allowed only for
// their own location. Mirrors /api/locations/[id]/slack-disconnect.
//
// slack_invite_url is a shareable URL and browser-safe. The bot token is never
// touched here (it stays server-only, written only by the OAuth callback).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function POST(
  request: NextRequest,
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

  let body: any = null
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // Normalise: trim; empty string clears the link (stored as null).
  const raw = typeof body?.slack_invite_url === 'string' ? body.slack_invite_url.trim() : ''
  const inviteUrl = raw.length ? raw : null

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

  // PK-keyed write — same pattern as lib/slack-disconnect. Only slack_invite_url
  // is touched; the bot token and cached identity are untouched.
  const { error } = await supabaseService
    .from('locations')
    .update({
      slack_invite_url: inviteUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', locationUuid)

  if (error) {
    return NextResponse.json(
      { error: `save_failed: ${error.message}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, slack_invite_url: inviteUrl })
}
