// app/api/locations/[id]/slack-test/route.ts
//
// In-app "Send test message" button on the SlackCard (Settings →
// Communications). Posts a plain-text test into the location's connected
// Slack channel via the same transport a real lead alert uses (postToSlack),
// so one click proves token + channel + bot access end to end.
//
// Deliberately BYPASSES the notifications_live mute: that flag gates NEW-LEAD
// notifications (see notifyNewLeadSlack), not every message Bee Hub posts —
// and a muted location's owner still needs to be able to prove the pipe
// before cutover. Deliberately NOT logged to notification_log — see
// lib/slack-test.ts for both rationales.
//
// Authorization: super_admin / admin always; owner only for their own
// location. Mirrors /api/locations/[id]/slack-disconnect.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { postToSlack } from '@/lib/slack-bot'
import { buildSlackTestMessage, slackTestFailureMessage } from '@/lib/slack-test'

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

  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id, slack_channel_name')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr || !loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  const result = await postToSlack(locationUuid, buildSlackTestMessage(loc.name))

  if (!result.ok) {
    // Owner-actionable copy, never a bare Slack error code. 400 for the
    // not-connected states (a setup gap, not a send failure), 502 when Slack
    // itself refused the post.
    const status = result.skipped ? 400 : 502
    return NextResponse.json({ error: slackTestFailureMessage(result) }, { status })
  }

  const channel = loc.slack_channel_name
    ? (String(loc.slack_channel_name).startsWith('#') ? loc.slack_channel_name : `#${loc.slack_channel_name}`)
    : 'your Slack channel'
  return NextResponse.json({
    success: true,
    message: `Test message sent to ${channel} — go check Slack.`,
  })
}
