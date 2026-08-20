// app/api/mailchimp/audiences/route.ts
//
// The audience picker's two operations, kept in ONE file so they cannot drift
// on the authorization rule they share:
//
//   GET  — list the connected account's audiences (Mailchimp GET /lists)
//   POST — save the chosen one to mailchimp_list_id + mailchimp_list_name
//
// Both run the SAME resolveMailchimpTarget gate as connect/callback: super_admin
// may name a location, admin/owner get their own and the param is ignored,
// everyone else is 403.
//
// ── ZERO AUDIENCES IS AN ANSWER, NOT AN ERROR ───────────────────────────────
// GET returns { audiences: [] } with 200 for an account that has none. The card
// needs to tell that owner to go create one in Mailchimp, and it can only do
// that if "none" is distinguishable from "the call failed" — an empty dropdown
// would be the one outcome that explains nothing.
//
// The access token is read server-side and NEVER returned. Only the audience
// id/name/count cross the wire.
//
// This route does not read the leads table, and it does not sync anything.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { listAudiences } from '@/lib/mailchimp'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'

export const runtime = 'nodejs'

type Gate =
  | { ok: true; locationUuid: string; token: string; dc: string }
  | { ok: false; res: NextResponse }

// Session → authorization → the stored credential, in the one order that never
// leaks: an unauthorized caller is rejected before any token is read.
async function gate(requested: string | null): Promise<Gate> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }

  const target = await resolveMailchimpTarget(supabase, user.id, requested)
  if (!target.ok) {
    const fail = targetFailureResponse(target.reason)
    return { ok: false, res: NextResponse.json({ error: fail.error }, { status: fail.status }) }
  }

  const { data: loc, error } = await supabaseService
    .from('locations')
    .select('id, mailchimp_access_token, mailchimp_server_prefix, mailchimp_connected')
    .eq('id', target.locationUuid)
    .maybeSingle()

  if (error || !loc) {
    return { ok: false, res: NextResponse.json({ error: 'location not found' }, { status: 404 }) }
  }
  // A row missing either half of the credential is not connected, whatever the
  // flag says. The callback makes that pairing atomic, so this is a guard
  // against hand-edited rows rather than a state the flow can produce.
  if (!loc.mailchimp_connected || !loc.mailchimp_access_token || !loc.mailchimp_server_prefix) {
    return { ok: false, res: NextResponse.json({ error: 'not_connected' }, { status: 409 }) }
  }

  return {
    ok: true,
    locationUuid: target.locationUuid,
    token: loc.mailchimp_access_token,
    dc: loc.mailchimp_server_prefix,
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const g = await gate(searchParams.get('location_id'))
  if (!g.ok) return g.res

  const result = await listAudiences(g.token, g.dc)
  if (!result.ok) {
    console.error('[mailchimp-audiences] list failed —', result.error)
    return NextResponse.json({ error: 'lists_failed', detail: result.error }, { status: 502 })
  }

  // 200 with an empty array when the account genuinely has no audiences.
  return NextResponse.json({ audiences: result.audiences })
}

export async function POST(request: NextRequest) {
  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const g = await gate(body?.location_id ?? null)
  if (!g.ok) return g.res

  const listId = typeof body?.list_id === 'string' ? body.list_id.trim() : ''
  if (!listId) {
    return NextResponse.json({ error: 'list_id required' }, { status: 400 })
  }

  // The NAME is taken from Mailchimp, never from the request body. A client-
  // supplied label could disagree with the id it accompanies, and the card
  // would then show an owner the wrong audience name over the right id — the
  // exact kind of quiet mismatch that gets discovered by a mis-sent campaign.
  // This also validates that the id is one the account actually owns.
  const result = await listAudiences(g.token, g.dc)
  if (!result.ok) {
    console.error('[mailchimp-audiences] list failed during save —', result.error)
    return NextResponse.json({ error: 'lists_failed', detail: result.error }, { status: 502 })
  }
  const chosen = result.audiences.find((a) => a.id === listId)
  if (!chosen) {
    return NextResponse.json({ error: 'unknown_audience' }, { status: 400 })
  }

  const { error: writeErr } = await supabaseService
    .from('locations')
    .update({
      mailchimp_list_id: chosen.id,
      mailchimp_list_name: chosen.name,
      updated_at: new Date().toISOString(),
    })
    .eq('id', g.locationUuid)

  if (writeErr) {
    console.error('[mailchimp-audiences] save failed:', writeErr)
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }

  // Picking an audience does NOT start a sync and does not touch
  // mailchimp_sync_live — it records a choice and nothing else.
  return NextResponse.json({ list_id: chosen.id, list_name: chosen.name })
}
