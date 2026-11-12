// app/api/locations/[id]/bees/route.ts
//
// The bee roster for one location (Settings › Team and Seats, the Bees half). lib/location-bees.ts
// holds the rules; this route is the door.
//
//   GET  → { bees: PublicBee[], slackConnected }
//          Reads the cache only — NO Slack call on a page load.
//   POST { name, email } → add a bee, or bring back a removed one with the
//          same email (same row: one per person per location, ever). Then
//          ONE users.lookupByEmail when Slack is connected and the row has
//          no answer yet. The save never waits on, or fails with, Slack.
//
// Who: owner / manager of THIS location, super_admin, admin — the
// app/api/tags/own check (lib/location-bees canManageBees). Writes are
// blocked on a paused location like every franchise write.
//
// slack_bot_token is read server-side only and never in a response.

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import {
  BEE_COLUMNS, type BeeRow, canManageBees, checkBeeAgainstSlack, cleanEmail, cleanName,
  duplicateMessage, emailKey, readLocationSlack, toPublicBee,
} from '@/lib/location-bees'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function gate(locationUuid: string) {
  await requireAuth()
  const hubUser = await getHubUser()
  if (!hubUser) return { res: NextResponse.json({ error: 'No hub user profile' }, { status: 403 }) }
  if (!UUID_RE.test(locationUuid)) return { res: NextResponse.json({ error: 'invalid_location_id' }, { status: 400 }) }
  if (!canManageBees(hubUser, locationUuid)) return { res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  return { hubUser }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await gate(params.id)
    if (g.res) return g.res
    const { data, error } = await supabaseService
      .from('location_bees')
      .select(BEE_COLUMNS)
      .eq('location_uuid', params.id)
      .order('name', { ascending: true })
    if (error) {
      console.error('[/api/locations/[id]/bees GET] read failed:', error.message)
      return NextResponse.json({ error: "Couldn't load your bees." }, { status: 500 })
    }
    const slack = await readLocationSlack(supabaseService, params.id)
    // The location's name, so the heading can say WHOSE bees these are even
    // when the screen was not handed one (an admin looking at a location).
    // Best effort: a failed read leaves the plain heading.
    let locationName: string | null = null
    try {
      const { data: loc } = await supabaseService.from('locations').select('name').eq('id', params.id).maybeSingle()
      locationName = typeof loc?.name === 'string' && loc.name.trim() ? loc.name.trim() : null
    } catch { /* plain heading */ }
    return NextResponse.json({ bees: ((data || []) as BeeRow[]).map(toPublicBee), slackConnected: slack.connected, locationName })
  } catch (err: any) {
    console.error('[/api/locations/[id]/bees GET] error:', err?.message || err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await gate(params.id)
    if (g.res) return g.res
    const block = await readOnlyWriteBlock(g.hubUser, params.id)
    if (block) return block

    const body = await req.json().catch(() => ({}))
    const name = cleanName(body?.name)
    const email = cleanEmail(body?.email)
    if (!name) return NextResponse.json({ error: 'name_required', message: 'Add their name.' }, { status: 400 })
    if (!email) return NextResponse.json({ error: 'email_invalid', message: 'That email doesn’t look right — check it and try again.' }, { status: 400 })

    // A location has tens of bees, not thousands: read them and compare the
    // same way the unique index does (lower(email)).
    const { data: existingRows, error: readErr } = await supabaseService
      .from('location_bees')
      .select(BEE_COLUMNS)
      .eq('location_uuid', params.id)
    if (readErr) {
      console.error('[/api/locations/[id]/bees POST] read failed:', readErr.message)
      return NextResponse.json({ error: 'save_failed', message: "Couldn't save — try again." }, { status: 500 })
    }
    const existing = ((existingRows || []) as BeeRow[]).find(b => emailKey(b.email) === emailKey(email))
    if (existing && existing.is_active !== false) {
      return NextResponse.json({ error: 'duplicate', message: duplicateMessage(existing) }, { status: 409 })
    }

    const now = new Date().toISOString()
    let saved: BeeRow
    let reactivated = false
    if (existing) {
      // Back again: the same row, so their Slack id and history survive.
      const { data, error } = await supabaseService
        .from('location_bees')
        .update({ name, email, is_active: true, removed_at: null, updated_at: now })
        .eq('id', existing.id)
        .select(BEE_COLUMNS)
        .single()
      if (error || !data) {
        console.error('[/api/locations/[id]/bees POST] reactivate failed:', error?.message)
        return NextResponse.json({ error: 'save_failed', message: "Couldn't save — try again." }, { status: 500 })
      }
      saved = data as BeeRow
      reactivated = true
    } else {
      const { data, error } = await supabaseService
        .from('location_bees')
        .insert({ location_uuid: params.id, name, email })
        .select(BEE_COLUMNS)
        .single()
      if (error?.code === '23505') {
        // Someone added the same email a moment ago.
        return NextResponse.json({ error: 'duplicate', message: `Someone with ${email} is already on your bees.` }, { status: 409 })
      }
      if (error || !data) {
        console.error('[/api/locations/[id]/bees POST] insert failed:', error?.message)
        return NextResponse.json({ error: 'save_failed', message: "Couldn't save — try again." }, { status: 500 })
      }
      saved = data as BeeRow
    }

    // The bee is saved. Slack is a bonus from here on.
    const slack = await readLocationSlack(supabaseService, params.id)
    let check: string | null = null
    if (slack.connected && !saved.slack_checked_at) {
      const r = await checkBeeAgainstSlack(supabaseService, saved, slack)
      saved = r.bee
      check = r.check
    }

    return NextResponse.json({
      ok: true,
      reactivated,
      bee: toPublicBee(saved),
      slackConnected: slack.connected,
      ...(check ? { slackCheck: check } : {}),
    })
  } catch (err: any) {
    console.error('[/api/locations/[id]/bees POST] error:', err?.message || err)
    return NextResponse.json({ error: 'save_failed', message: "Couldn't save — try again." }, { status: 500 })
  }
}
