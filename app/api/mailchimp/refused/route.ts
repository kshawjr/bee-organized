// app/api/mailchimp/refused/route.ts
//
// FL-75 slice 6 (2026-11-26): the people Mailchimp refused, for the Mailchimp
// screen's "N people couldn't be added" list (lib/mailchimp-refusals.ts).
//
//   GET  — who was refused: each address still on a live record here (never
//          the Recycle Bin), what Mailchimp said, and whether it will be sent
//          again. Reads only; nothing is sent to Mailchimp.
//   POST — { email_key, action }:
//            'retry'     Try again: the next sync sends this address once more
//            'leave_out' Leave out: the person is unticked for Mailchimp (the
//                        same untick the review screen saves; undone there)
//          "Edit address" is not here: the screen saves the new address
//          through the client record's own route (PATCH /api/leads/[id]), so
//          Jobber and the no-marketing checks behave as for any edit.
//
// A "no" from Mailchimp (unsubscribed, bounced, deleted, compliance) is never
// on this list and has no Try again: it is on the no-marketing list.
//
// Same resolveMailchimpTarget gate as every other Mailchimp route.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'
import { listRefused, requestRetry } from '@/lib/mailchimp-refusals'
import { saveChoice } from '@/lib/mailchimp-review-choices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const r = await listRefused(t.locationUuid)
  if (!r.ok) return NextResponse.json({ error: 'read_failed', words: 'Who Mailchimp refused couldn’t be read. Please try again.' }, { status: 500 })
  return NextResponse.json({ ready: r.ready, people: r.people.map((p) => ({
    email_key: p.email_key, email: p.email, records: p.records,
    kind: p.kind, mailchimp_said: p.mailchimp_said, mailchimp_code: p.mailchimp_code,
    refused_count: p.refused_count, first_refused_at: p.first_refused_at, last_refused_at: p.last_refused_at,
    held: p.held, retry_requested: !!p.retry_requested_at,
  })) })
}

export async function POST(request: NextRequest) {
  let body: any = {}
  try { body = await request.json() } catch { /* nothing */ }
  const key = typeof body?.email_key === 'string' ? body.email_key.trim().toLowerCase() : ''
  if (!key || !['retry', 'leave_out'].includes(body?.action)) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  const t = await target(body?.location_id ?? null)
  if (!t.ok) return t.res
  if (body.action === 'retry') {
    const ok = await requestRetry(t.locationUuid, key, new Date().toISOString())
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_saved', words: 'Try again couldn’t be saved. Please try once more.' }, { status: 500 })
  }
  const s = await saveChoice(t.locationUuid, t.userId, { scope: 'person', key, choice: 'out' })
  return s.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: s.error, words: s.words }, { status: s.status })
}
