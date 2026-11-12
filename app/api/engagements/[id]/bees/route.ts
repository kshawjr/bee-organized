// app/api/engagements/[id]/bees/route.ts
//
// Which bees are on this job (Slack job channels, slice 3, part A).
//   GET                 → { setUp, bees, roster, slack, canAddBees }
//   POST   { bee_id }   → put a bee on the job (idempotent)
//   DELETE ?bee_id=…    → take them off (stamps removed_at — never a delete)
// POST and DELETE answer { bees, slack_sync }: slack_sync is null when the
// job has no live channel (silent), else a BeeSlackOutcome the panel turns
// into one line (components/hive/shared/BeeSlackStatus.jsx).
//
// BEES ARE NOT ASSIGNEES: this never touches engagement_assignees or Jobber.
// The assignment is the truth — a Slack failure never rolls it back.
// Only bees of the engagement's OWN location may be assigned, for every
// role including admin (a bee is a location's roster entry).
// slack_bot_token is read server-side only and never in a response.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { canManageBees } from '@/lib/location-bees'
import {
  assignBee, mirrorBee, readBeeRow, readEngagementBees, readLocationSlackFull, unassignBee, storeProblems,
  beesTableMissing, type BeeSlackOutcome, type EngagementForBees,
} from '@/lib/engagement-bees'
import { canReconnectSlack, gateEngagement, isUuid, publicChannel } from '@/lib/engagement-bees-gate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_SET_UP = { error: 'not_set_up_yet', message: 'Bees on jobs isn’t switched on yet.' }

async function answer(eng: EngagementForBees, slack_sync: BeeSlackOutcome | null) {
  const read = await readEngagementBees(supabaseService, eng)
  const bees = 'assigned' in read ? read.assigned : []
  return NextResponse.json({ bees, slack_sync: slack_sync && slack_sync.status !== 'ok' ? slack_sync : null })
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await gateEngagement(params.id)
    if (g.res) return g.res
    const { eng, hubUser } = g
    const read = await readEngagementBees(supabaseService, eng)
    if (!read.setUp) return NextResponse.json({ setUp: false })
    if ('error' in read) {
      console.error('[engagements/[id]/bees GET] read failed:', read.error)
      return NextResponse.json({ error: 'Couldn’t load the bees on this job.' }, { status: 500 })
    }
    const slack = await readLocationSlackFull(supabaseService, eng.location_uuid)
    return NextResponse.json({
      setUp: true,
      bees: read.assigned,
      roster: read.roster,
      slack: {
        connected: slack.connected,
        canManageChannels: slack.canManageChannels,
        // Can THIS person reconnect Slack? Only then is the reconnect line shown.
        canReconnect: canReconnectSlack(hubUser, eng.location_uuid),
        channelsSetUp: eng.channelColumns,
        channel: publicChannel(eng),
        closed: !!eng.closed_at,
        // What the unattended sweep couldn't do when this job reopened.
        reconcile: eng.slack_channel_problems,
      },
      canAddBees: canManageBees(hubUser, eng.location_uuid),
    })
  } catch (err: any) {
    console.error('[engagements/[id]/bees GET] error:', err?.message || err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

async function write(req: NextRequest, id: string, action: 'add' | 'remove', beeId: unknown) {
  const g = await gateEngagement(id)
  if (g.res) return g.res
  const { eng, hubUser } = g
  const block = await readOnlyWriteBlock(hubUser, eng.location_uuid)
  if (block) return block
  if (!isUuid(beeId)) return NextResponse.json({ error: 'bee_id_required' }, { status: 400 })

  const bee = await readBeeRow(supabaseService, beeId as string)
  // The bee must be on THIS engagement's location's roster — checked here,
  // not only in the picker, and for admins too.
  if (!bee || bee.location_uuid !== eng.location_uuid) {
    return NextResponse.json({ error: 'bee_wrong_location', message: 'That bee isn’t on this location’s list.' }, { status: 400 })
  }
  if (action === 'add' && bee.is_active === false) {
    return NextResponse.json({ error: 'bee_removed', message: `${bee.name} was removed from your bees — bring them back in Settings › Team and Seats first.` }, { status: 400 })
  }

  const done = action === 'add'
    ? await assignBee(supabaseService, eng.id, bee.id)
    : await unassignBee(supabaseService, eng.id, bee.id)
  if (!done.ok) {
    if (beesTableMissing(done.error)) return NextResponse.json(NOT_SET_UP, { status: 409 })
    console.error(`[engagements/[id]/bees ${action}] write failed:`, done.error)
    return NextResponse.json({ error: 'save_failed', message: 'Couldn’t save — try again.' }, { status: 500 })
  }

  // Bee Hub has the answer. Now Slack, if the job has a live channel.
  let slack_sync: BeeSlackOutcome | null = null
  if (eng.slack_channel_id) {
    if (eng.slack_channel_archived_at) {
      slack_sync = { status: 'archived' }
    } else {
      const slack = await readLocationSlackFull(supabaseService, eng.location_uuid)
      if (slack.connected && slack.token) {
        slack_sync = await mirrorBee(supabaseService, {
          token: slack.token, locationUuid: eng.location_uuid, engagementId: eng.id,
          channelId: eng.slack_channel_id, channelName: eng.slack_channel_name, bee, action,
        })
      } else {
        slack_sync = { status: 'unavailable', bee: bee.name, action }
      }
    }
  }
  // The owner acted on this bee by hand: any stored reconcile line about
  // them is superseded by this answer.
  const stored = eng.slack_channel_problems
  if (stored && stored.items.some(p => p.bee_id === bee.id) && slack_sync?.status !== 'channel_gone') {
    const items = stored.items.filter(p => p.bee_id !== bee.id)
    await storeProblems(supabaseService, eng.id, items.length ? { ...stored, items } : null)
  }
  return answer(eng, slack_sync)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({}))
    return await write(req, params.id, 'add', body?.bee_id)
  } catch (err: any) {
    console.error('[engagements/[id]/bees POST] error:', err?.message || err)
    return NextResponse.json({ error: 'save_failed', message: 'Couldn’t save — try again.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const beeId = new URL(req.url).searchParams.get('bee_id')
    return await write(req, params.id, 'remove', beeId)
  } catch (err: any) {
    console.error('[engagements/[id]/bees DELETE] error:', err?.message || err)
    return NextResponse.json({ error: 'save_failed', message: 'Couldn’t save — try again.' }, { status: 500 })
  }
}
