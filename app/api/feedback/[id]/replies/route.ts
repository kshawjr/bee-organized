// app/api/feedback/[id]/replies/route.ts
//
// POST /api/feedback/[id]/replies — the SUBMITTER writes back into the
// conversation on their own feedback item. Body: { body: string }.
//
// WHY THE SUBMITTER ONLY, whatever their role. Several open items need a
// question answered by the person who filed them (b18d0b18 is unactionable
// without one), and until now their only way to answer was replying to the
// notification email — which lands in a mailbox outside Bee Hub where triage
// never sees it. This puts the answer on the item itself.
//
//   · A colleague at the same location can READ the thread on the owner
//     screen but does not speak in it — the conversation belongs to the person
//     who filed the report, the same scoping reply_seen_at already has.
//   · The TEAM side does not reply here either: team replies go through
//     PATCH /api/admin/feedback/[id], because that route owns the email send
//     rules — a team reply written here would silently skip the notification
//     the owner is owed. One door per voice.
//
// NO EMAIL LEAVES THIS ROUTE. An owner's reply surfaces to triage as the
// "They replied — needs an answer" marker on the list (derived from the thread,
// lib/feedback-replies.awaitingTeamReply). Deliberate: notifying admins by
// email would be a NEW sending path, and new sending paths are shown to Kevin
// before they ship.
//
// REPLYING MARKS THE THREAD SEEN. You cannot answer a reply you have not read,
// so reply_seen_at is stamped alongside the insert — same scope guard as
// POST /api/feedback/seen (own rows only), and a failure there is swallowed:
// the banner showing once more is a better failure than losing the reply.
//
// BEFORE THE MIGRATION RUNS (migrations/feedback_replies.sql is HELD; Kevin
// runs it) the insert fails with a missing-table error. That returns a calm
// 503, not a 500 — the words the user typed are still in their textarea and
// the UI says to try again later. A write must not pretend to succeed.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { withInternalFallback, isInternalItem } from '@/lib/feedback-internal'
import { isMissingRepliesTable, MAX_FEEDBACK_REPLY_CHARS } from '@/lib/feedback-replies'

export const runtime = 'nodejs'

const ELEVATED_ROLES = ['super_admin', 'admin']

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  const { data: target } = await withInternalFallback<any>(
    async (withInternal) =>
      await supabaseService
        .from('feedback_items')
        .select(withInternal ? 'id, user_id, is_internal' : 'id, user_id')
        .eq('id', id)
        .single(),
  )
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const isElevated = ELEVATED_ROLES.includes(caller.role)

  // An internal item does not exist for a non-elevated caller — 404, never 403,
  // for the same reason as the triage PATCH: an unknown id and an internal id
  // must be indistinguishable.
  if (!isElevated && isInternalItem(target)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // The submitter's door, and only theirs — see the header. This is also what
  // makes a cross-location caller fail: someone else's item is not yours.
  if (target.user_id !== caller.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { body?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const text = String(body.body ?? '').trim()
  if (text.length < 1 || text.length > MAX_FEEDBACK_REPLY_CHARS) {
    return NextResponse.json(
      { error: `body_must_be_1_${MAX_FEEDBACK_REPLY_CHARS}_chars` },
      { status: 400 },
    )
  }

  // author_role is a snapshot of the VOICE, not a join — an elevated submitter
  // replying on their own (internal) item speaks as the team; everyone else
  // here is the owner side by construction.
  const { data: row, error } = await supabaseService
    .from('feedback_replies')
    .insert({
      feedback_item_id: id,
      author_id: caller.id,
      author_role: isElevated ? 'team' : 'owner',
      body: text,
    })
    .select('*')
    .single()

  if (error || !row) {
    if (isMissingRepliesTable(error)) {
      console.warn('[feedback replies POST] feedback_replies table missing — migration pending')
      return NextResponse.json({ error: 'replies_not_available_yet' }, { status: 503 })
    }
    console.error('[feedback replies POST]', error)
    return NextResponse.json(
      { error: (error as { message?: string })?.message || 'insert_failed' },
      { status: 500 },
    )
  }

  // Replying implies having read what was there. Own rows only — the same
  // guard as /api/feedback/seen — and never fatal.
  const { error: seenErr } = await supabaseService
    .from('feedback_items')
    .update({ reply_seen_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', caller.id)
  if (seenErr) console.warn('[feedback replies POST] seen stamp failed:', (seenErr as { message?: string })?.message)

  return NextResponse.json(row, { status: 201 })
}
