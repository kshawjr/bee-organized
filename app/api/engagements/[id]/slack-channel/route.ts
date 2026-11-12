// app/api/engagements/[id]/slack-channel/route.ts
//
// PATCH { clear_problems: true } → the owner tapped Got it on the lines the
// sweep stored when this job reopened (slack_channel_problems → null).
//
// POST → "Put this job in Slack". Makes ONE public channel named
// <client>-<project type> (lib/engagement-bees slackJobChannelName), stores
// its id and name on the engagement, invites the bees on the job and the
// location's owner(s), and posts one opening message linking back here.
// Never automatic — only this button press makes a channel.
//
// Refuses BEFORE calling Slack when the channel columns or the bee tables
// don't exist yet, so no channel is ever made that Bee Hub can't remember.
// A second press (or a double click) returns the channel already made.
// slack_bot_token is read server-side only and never in a response.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { createJobChannel, readEngagementBees, readLocationSlackFull, storeProblems } from '@/lib/engagement-bees'
import { gateEngagement } from '@/lib/engagement-bees-gate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const REFUSALS: Record<string, [number, string]> = {
  not_set_up_yet: [409, 'Job channels aren’t switched on yet.'],
  not_ready: [409, 'Reconnect Slack to turn on channels for your jobs.'],
  closed: [400, 'This job is closed, so it can’t get a new channel.'],
  scope_lost: [409, 'Slack no longer lets Bee Hub make channels. Reconnect Slack in Settings to turn it back on.'],
  name_unavailable: [409, 'Slack already has channels with this job’s name. Rename one in Slack, then try again.'],
  slack_unavailable: [502, 'Slack didn’t answer — nothing was made. Try again shortly.'],
  store_failed: [500, 'Couldn’t save the channel — try again.'],
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await gateEngagement(params.id)
    if (g.res) return g.res
    const { eng, hubUser } = g
    const block = await readOnlyWriteBlock(hubUser, eng.location_uuid)
    if (block) return block

    const slack = await readLocationSlackFull(supabaseService, eng.location_uuid)
    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://beehive.beeorganized.com').replace(/\/$/, '')
    const r = await createJobChannel(supabaseService, { eng, slack, baseUrl })
    if (!r.ok) {
      const [status, message] = REFUSALS[r.reason] || [500, 'Couldn’t make the channel — try again.']
      return NextResponse.json({ error: r.reason, message }, { status })
    }
    const read = await readEngagementBees(supabaseService, eng)
    return NextResponse.json({
      ok: true,
      already: r.already,
      channel: { id: r.channel.id, name: r.channel.name, archived: false },
      bees: 'assigned' in read ? read.assigned : [],
      // Bees who could not be added, then owners who could not — the panel
      // shows one line for each. Never silent.
      problems: [...r.problems, ...(r.ownerProblems || [])],
      owners: r.owners,
    })
  } catch (err: any) {
    console.error('[engagements/[id]/slack-channel POST] error:', err?.message || err)
    return NextResponse.json({ error: 'failed', message: 'Couldn’t make the channel — try again.' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await gateEngagement(params.id)
    if (g.res) return g.res
    const { eng, hubUser } = g
    const block = await readOnlyWriteBlock(hubUser, eng.location_uuid)
    if (block) return block
    const body = await req.json().catch(() => ({}))
    if (body?.clear_problems !== true) return NextResponse.json({ error: 'nothing_to_do' }, { status: 400 })
    if (!eng.channelColumns) return NextResponse.json({ ok: true })
    await storeProblems(supabaseService, eng.id, null)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[engagements/[id]/slack-channel PATCH] error:', err?.message || err)
    return NextResponse.json({ error: 'failed', message: 'Couldn’t clear that — try again.' }, { status: 500 })
  }
}
