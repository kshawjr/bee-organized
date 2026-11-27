// app/api/mailchimp/review/route.ts
//
// MAILCHIMP SLICE 5 (FL-75, 2026-11-24): the "Who goes to Mailchimp" screen.
//
//   GET  — everything the screen shows: the big number, the groups, the list
//          of people new to Mailchimp, phone-match suggestions. READ ONLY:
//          Bee Hub by select, Mailchimp by GET (lib/mailchimp-review-load.ts).
//   POST — save one choice (lib/mailchimp-review-choices.ts). Writes only
//          the mailchimp_review_choices table.
//
// NOTHING IS SENT TO MAILCHIMP from this route, and it does not read or
// change the sending switch or the first-sync confirmation. Sending (slice 6)
// will use the saved choices; until then they are only kept.
//
// Same resolveMailchimpTarget gate as every other Mailchimp route:
// super_admin may name a location, admin/owner get their own (the param is
// ignored), everyone else is refused.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'
import { loadReview } from '@/lib/mailchimp-review-load'
import { saveChoice } from '@/lib/mailchimp-review-choices'

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
  return { ok: true as const, locationUuid: t.locationUuid, userId: user.id }
}

export async function GET(request: NextRequest) {
  const t = await target(new URL(request.url).searchParams.get('location_id'))
  if (!t.ok) return t.res
  // withHeld: the big number leaves out anyone the sending code would hold
  // back (Mailchimp refused them, or they are archived in Mailchimp).
  const r = await loadReview(t.locationUuid, { withHeld: true })
  if (!r.ok) return NextResponse.json({ error: r.reason, words: r.words }, { status: r.reason === 'beehub_read_failed' ? 500 : 409 })
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }) }
  const t = await target(typeof body?.location_id === 'string' ? body.location_id : null)
  if (!t.ok) return t.res
  const r = await saveChoice(t.locationUuid, t.userId, { scope: body?.scope, key: body?.key, choice: body?.choice ?? null })
  if (!r.ok) return NextResponse.json({ error: r.error, words: r.words }, { status: r.status })
  return NextResponse.json({ ok: true })
}
