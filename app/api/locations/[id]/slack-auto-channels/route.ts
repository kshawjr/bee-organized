// app/api/locations/[id]/slack-auto-channels/route.ts
//
// The switch on Settings › Slack: "Make a Slack channel for every new job".
// lib/job-channel-auto.ts holds the rules; this route is the door.
//
//   GET  → { setUp, on, since, capped, cap, reconnected, canSet }
//          One database read, NO Slack call.
//   POST { on: boolean } → turn it on or off.
//
// WHO MAY SET IT: the people who can reconnect Slack — super_admin, admin,
// and the OWNER of this location (the same check as slack-invite and
// slack-disconnect). A manager can see it and cannot change it.
//
// TURNING IT ON is refused HERE unless the location has reconnected Slack
// for job channels, whatever the browser sent: a greyed switch is a courtesy,
// this is the lock. Turning it on makes nothing and reads no job — it only
// stamps the time, and only jobs Jobber creates after that time can get a
// channel. Turning it OFF is always allowed (it can only make less happen).
//
// slack_bot_token is read server-side only and never in a response.

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { readLocationSlackFull } from '@/lib/engagement-bees'
import { AUTO_CHANNEL_DAILY_CAP, canSetAutoChannels, capStillOn, readAutoSwitch, setAutoSwitch } from '@/lib/job-channel-auto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isElevated = (role: unknown) => role === 'super_admin' || role === 'admin'
const canSee = (hubUser: { role?: string | null; location_id?: string | null }, locationUuid: string) =>
  isElevated(hubUser.role) || hubUser.location_id === locationUuid

async function answer(locationUuid: string, canSet: boolean) {
  const sw = await readAutoSwitch(supabaseService, locationUuid)
  if (!sw.setUp) return NextResponse.json({ setUp: false })
  if ('error' in sw) return NextResponse.json({ error: "Couldn't load this setting." }, { status: 500 })
  const slack = await readLocationSlackFull(supabaseService, locationUuid)
  return NextResponse.json({
    setUp: true,
    on: !!sw.onSince,
    since: sw.onSince,
    capped: !!sw.onSince && capStillOn(sw.cappedAt),
    cap: AUTO_CHANNEL_DAILY_CAP,
    connected: slack.connected,
    reconnected: slack.connected && slack.canManageChannels,
    canSet,
  })
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'invalid_location_id' }, { status: 400 })
    if (!canSee(hubUser, params.id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    return await answer(params.id, canSetAutoChannels(hubUser, params.id))
  } catch (err: any) {
    console.error('[/api/locations/[id]/slack-auto-channels GET] error:', err?.message || err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'invalid_location_id' }, { status: 400 })
    if (!canSetAutoChannels(hubUser, params.id)) return NextResponse.json({ error: 'forbidden', message: 'Only the location’s owner can change this.' }, { status: 403 })
    const block = await readOnlyWriteBlock(hubUser, params.id)
    if (block) return block

    const body = await req.json().catch(() => null)
    if (!body || typeof body.on !== 'boolean') return NextResponse.json({ error: 'invalid_body', message: 'Say on: true or on: false.' }, { status: 400 })

    const r = await setAutoSwitch(supabaseService, params.id, body.on)
    if (!r.ok) {
      if (r.reason === 'not_reconnected') return NextResponse.json({ error: 'not_reconnected', message: 'Reconnect Slack first. Bee Hub can’t make channels for this location yet.' }, { status: 409 })
      if (r.reason === 'not_set_up_yet') return NextResponse.json({ error: 'not_set_up_yet', message: 'This isn’t available yet.' }, { status: 409 })
      return NextResponse.json({ error: 'save_failed', message: 'That didn’t save. Try again.' }, { status: 500 })
    }
    console.log(`[slack-auto-channels] location=${params.id} on=${body.on} by=${hubUser.id}`)
    return await answer(params.id, true)
  } catch (err: any) {
    console.error('[/api/locations/[id]/slack-auto-channels POST] error:', err?.message || err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
