// app/api/locations/[id]/bees/[beeId]/route.ts
//
// PATCH one bee. Body (any of):
//   { name }            rename
//   { email }           new email → the Slack answer is cleared and asked
//                       again (an old id must never outlive the email it
//                       was found by)
//   { active: false }   remove — is_active false + removed_at. NEVER a delete.
//   { active: true }    bring back the same row
//   { recheck: true }   "Check again" — one users.lookupByEmail
//
// No DELETE: a bee row is never deleted (migrations/location_bees.sql).
// Who: as GET/POST /api/locations/[id]/bees. A Slack failure never fails
// the save. slack_bot_token never leaves the server.

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
const failed = () => NextResponse.json({ error: 'save_failed', message: "Couldn't save — try again." }, { status: 500 })

export async function PATCH(req: NextRequest, { params }: { params: { id: string; beeId: string } }) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser) return NextResponse.json({ error: 'No hub user profile' }, { status: 403 })
    if (!UUID_RE.test(params.id) || !UUID_RE.test(params.beeId)) {
      return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
    }
    if (!canManageBees(hubUser, params.id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    const block = await readOnlyWriteBlock(hubUser, params.id)
    if (block) return block

    const body = await req.json().catch(() => ({}))

    // The bee must belong to THIS location — the URL's location is the one
    // the permission check passed for.
    const { data: rows, error: readErr } = await supabaseService
      .from('location_bees')
      .select(BEE_COLUMNS)
      .eq('location_uuid', params.id)
    if (readErr) { console.error('[bees PATCH] read failed:', readErr.message); return failed() }
    const all = (rows || []) as BeeRow[]
    const bee = all.find(b => b.id === params.beeId)
    if (!bee) return NextResponse.json({ error: 'not_found', message: 'That bee isn’t on this location’s list.' }, { status: 404 })

    const now = new Date().toISOString()
    const patch: Record<string, any> = {}

    if (body?.name !== undefined) {
      const name = cleanName(body.name)
      if (!name) return NextResponse.json({ error: 'name_required', message: 'Add their name.' }, { status: 400 })
      if (name !== bee.name) patch.name = name
    }

    let emailChanged = false
    if (body?.email !== undefined) {
      const email = cleanEmail(body.email)
      if (!email) return NextResponse.json({ error: 'email_invalid', message: 'That email doesn’t look right — check it and try again.' }, { status: 400 })
      if (email !== bee.email) {
        const clash = all.find(b => b.id !== bee.id && emailKey(b.email) === emailKey(email))
        if (clash) return NextResponse.json({ error: 'duplicate', message: duplicateMessage(clash) }, { status: 409 })
        patch.email = email
        if (emailKey(email) !== emailKey(bee.email)) {
          emailChanged = true
          patch.slack_user_id = null
          patch.slack_checked_at = null
        }
      }
    }

    if (body?.active === false && bee.is_active !== false) {
      patch.is_active = false
      patch.removed_at = now
    } else if (body?.active === true && bee.is_active === false) {
      patch.is_active = true
      patch.removed_at = null
    }

    let saved = bee
    if (Object.keys(patch).length) {
      patch.updated_at = now
      const { data, error } = await supabaseService
        .from('location_bees')
        .update(patch)
        .eq('id', bee.id)
        .select(BEE_COLUMNS)
        .single()
      if (error?.code === '23505') {
        return NextResponse.json({ error: 'duplicate', message: `Someone with ${patch.email} is already on your bees.` }, { status: 409 })
      }
      if (error || !data) { console.error('[bees PATCH] update failed:', error?.message); return failed() }
      saved = data as BeeRow
    }

    // Slack: on "Check again", on a new email, or a bee brought back who
    // was never checked. Never for a removed bee.
    const wantsCheck = saved.is_active !== false
      && (body?.recheck === true || emailChanged || (patch.is_active === true && !saved.slack_checked_at))
    const slack = await readLocationSlack(supabaseService, params.id)
    let check: string | null = null
    if (wantsCheck && slack.connected) {
      const r = await checkBeeAgainstSlack(supabaseService, saved, slack)
      saved = r.bee
      check = r.check
    }

    return NextResponse.json({
      ok: true,
      bee: toPublicBee(saved),
      slackConnected: slack.connected,
      ...(check ? { slackCheck: check } : {}),
    })
  } catch (err: any) {
    console.error('[bees PATCH] error:', err?.message || err)
    return failed()
  }
}
