// app/api/mailchimp/import/route.ts
//
// MAILCHIMP SLICE 7 (FL-75, 2026-11-26): "Who comes in from Mailchimp".
//
//   GET  — the review: who would be created, held, skipped. READ ONLY
//          (Bee Hub by select, Mailchimp by GET).
//   POST — { location_id, member_ids, count }: bring in the ticked people.
//          Plans again first; if anything changed, nobody is brought in.
//
// NOTHING IS SENT: no email, drip, Slack, notification, Jobber send, and
// nothing to Mailchimp. Pilot locations only (lib/mailchimp-pull-pilot.ts).
// Same resolveMailchimpTarget gate as every other Mailchimp route.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'
import { reviewModel, importChosen } from '@/lib/mailchimp-pull-review'
import { pullAllowed } from '@/lib/mailchimp-pull-pilot'

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
  const url = new URL(request.url)
  const t = await target(url.searchParams.get('location_id'))
  if (!t.ok) return t.res
  // ?available=1 — only "is this switched on here?", nothing read.
  if (url.searchParams.get('available') === '1') return NextResponse.json({ available: pullAllowed(t.locationUuid) }, { headers: { 'Cache-Control': 'no-store' } })
  const r = await reviewModel(t.locationUuid)
  if (!r.ok) return NextResponse.json({ error: r.reason, words: r.words }, { status: r.status })
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }) }
  const t = await target(typeof body?.location_id === 'string' ? body.location_id : null)
  if (!t.ok) return t.res
  const r = await importChosen(t.locationUuid, body?.member_ids, body?.count, t.userId)
  if (!r.ok) return NextResponse.json({ error: r.reason, words: r.words, ...('model' in r ? { model: r.model } : {}) }, { status: r.status })
  return NextResponse.json(r)
}
