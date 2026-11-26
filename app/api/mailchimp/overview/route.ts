// app/api/mailchimp/overview/route.ts
//
// FL-75 slice 6 (2026-11-25): what the Mailchimp connection screen shows —
// never synced / synced / on hold (lib/mailchimp-overview.ts).
//
//   GET  — read only. Mailchimp is asked by GET only (the audience's size and
//          the flows). Nothing is sent; the token never leaves the server.
//   POST — { reviewed: true } records that the owner pressed Done on "Who goes
//          to Mailchimp" (locations.mailchimp_review_done_at). Writes nothing
//          else, sends nothing. If the date did not land it says so, in words
//          the screen shows as they are.
//
// Neither decides anything about sending: the sending code reads the switch
// and the flows again, itself, right before it sends.
//
// Same resolveMailchimpTarget guard as every other Mailchimp route.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'
import { loadOverview, markReviewed, REVIEW_NOT_SAVED_WORDS } from '@/lib/mailchimp-overview'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function target(requested: string | null) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  const t = await resolveMailchimpTarget(supabase, user.id, requested)
  if (!t.ok) {
    const fail = targetFailureResponse(t.reason)
    return { ok: false as const, res: NextResponse.json({ error: fail.error }, { status: fail.status }) }
  }
  return { ok: true as const, locationUuid: t.locationUuid }
}

export async function GET(request: NextRequest) {
  const t = await target(new URL(request.url).searchParams.get('location_id'))
  if (!t.ok) return t.res
  const r = await loadOverview(t.locationUuid)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === 'location_not_found' ? 404 : 409 })
  const o = r.overview
  return NextResponse.json({
    live: o.live, synced: o.synced, reviewed: o.reviewed, audience_count: o.audienceCount,
    last_synced_at: o.lastSyncedAt, flows: o.flows, how_to_pause: o.howToPause,
  })
}

export async function POST(request: NextRequest) {
  let body: any = {}
  try { body = await request.json() } catch { /* nothing */ }
  if (body?.reviewed !== true) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  const t = await target(body?.location_id ?? null)
  if (!t.ok) return t.res
  const ok = await markReviewed(t.locationUuid)
  return ok ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'not_saved', words: REVIEW_NOT_SAVED_WORDS }, { status: 500 })
}
