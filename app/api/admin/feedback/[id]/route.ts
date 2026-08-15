// app/api/admin/feedback/[id]/route.ts
//
// PATCH /api/admin/feedback/[id] — triage update. Body: { status?, admin_response? }.
//   - super_admin / admin: can patch any feedback item.
//   - owner / manager: can patch ONLY items belonging to their own location.
//   - everyone else: 403.
//
// When admin_response is provided (non-empty), admin_response_at is stamped to
// now(). updated_at is maintained by the feedback_items_updated_at trigger.
//
// ─── THE REPLY NOW SENDS (issue 233) ──────────────────────────────────
// The triage box has always said "shown to the submitter"; nothing was ever
// sent, and the only surface that rendered a reply was a tab behind a footer
// link in the help panel. Forty-seven replies reached nobody. A NEW reply now
// emails the person who filed the item (lib/feedback-reply-email).
//
// THE SEND RULES, and why each one is a rule:
//
//   1. A NEW OR CHANGED REPLY SENDS. Re-saving the identical text does not —
//      an admin who reopens an item, changes only the status and hits Save must
//      not re-send last week's reply. The comparison is against the stored
//      value, trimmed, so whitespace-only edits are not "new".
//   2. A STATUS CHANGE WITH NO NEW REPLY SENDS NOTHING. Deliberate. "Planned"
//      arriving by email with no words around it is noise to a franchise owner,
//      and triage moves statuses far more often than it writes replies — 47
//      replies against six statuses' worth of movement. If we want the
//      submitter told about a status move, the way to tell them is to write
//      them a sentence, which is rule 1.
//   3. CLEARING A REPLY SENDS NOTHING. Deleting text is not a message.
//   4. REPLYING TO YOURSELF SENDS NOTHING. owner/manager can patch their own
//      location's items, including the ones they filed themselves — and in
//      production an owner has already used the reply box to add a note to his
//      own report. Mailing someone their own words back is a bug, not a
//      notification.
//   5. A MAIL FAILURE NEVER FAILS THE SAVE. The row is already written when the
//      send runs. The outcome rides back on the response as `reply_email` so
//      triage can say "saved, but the email didn't go" instead of pretending.
//
// notification_log records the send by construction — logging is hooked inside
// sendEmailDirect, so this rail lands in the notebook exactly like invites and
// drips, with email_kind 'feedback_reply'.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { sendFeedbackReplyEmail } from '@/lib/feedback-reply-email'
import { FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'

export const runtime = 'nodejs'

const ELEVATED_ROLES = ['super_admin', 'admin']
const LOCATION_SCOPED_ROLES = ['owner', 'manager']
const VALID_STATUSES = new Set([
  'submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined',
])

// What the caller is told about the notification attempt. 'skipped' carries the
// reason so the UI can be specific ("no email on file") rather than silent.
type ReplyEmailOutcome =
  | { sent: true; to: string }
  | { sent: false; skipped: string }
  | { sent: false; error: string }

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  const isElevatedCaller = !!caller && ELEVATED_ROLES.includes(caller.role)
  const isLocationScopedCaller =
    !!caller && LOCATION_SCOPED_ROLES.includes(caller.role) && !!caller.location_id
  if (!isElevatedCaller && !isLocationScopedCaller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  // The BEFORE state, loaded for every caller now — not just the
  // location-scoped ones. The ownership check still needs it, and so does the
  // send decision: "is this reply new?" is only answerable against the reply
  // that was already there.
  const { data: target } = await supabaseService
    .from('feedback_items')
    .select('id, location_id, user_id, type, title, status, admin_response')
    .eq('id', id)
    .single()
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // owner/manager may only touch feedback for their own location.
  if (isLocationScopedCaller && target.location_id !== caller!.location_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { status?: string; admin_response?: string | null }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, any> = {}

  if (body.status !== undefined) {
    if (!VALID_STATUSES.has(String(body.status))) {
      return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
    }
    patch.status = body.status
  }

  // The reply as it will be stored, and whether it is genuinely new. Both are
  // computed BEFORE the update so the post-write send has something to compare
  // against — the update overwrites the old value.
  let newReplyText: string | null = null
  if (body.admin_response !== undefined) {
    const resp = body.admin_response === null ? null : String(body.admin_response).trim()
    if (resp) {
      patch.admin_response = resp
      patch.admin_response_at = new Date().toISOString()
      // Rule 1: changed text only. Rule 3 falls out of this branch not running.
      if (resp !== String(target.admin_response || '').trim()) newReplyText = resp
    } else {
      // Empty/null clears the response.
      patch.admin_response = null
      patch.admin_response_at = null
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_fields_to_update' }, { status: 400 })
  }

  const statusChanged = patch.status !== undefined && patch.status !== target.status

  const { data: row, error } = await supabaseService
    .from('feedback_items')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    console.error('[admin feedback PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const replyEmail = await maybeSendReply({
    newReplyText,
    statusChanged,
    callerId: caller!.id,
    target,
    newStatus: patch.status ?? target.status,
  })

  // reply_email is ADDITIVE — the row shape callers already merge into their
  // list is unchanged, so a client that ignores this key behaves exactly as
  // before.
  return NextResponse.json({ ...row, reply_email: replyEmail })
}

// The whole send decision in one place, returning a description of what
// happened rather than throwing. Rules 2-5 live here.
async function maybeSendReply(args: {
  newReplyText: string | null
  statusChanged: boolean
  callerId: string
  target: { user_id: string; location_id: string | null; title: string; type: string }
  newStatus: string
}): Promise<ReplyEmailOutcome | null> {
  const { newReplyText, statusChanged, callerId, target, newStatus } = args

  // Rule 2 + rule 3: nothing to say → say nothing. Returning null (rather than
  // a skip reason) marks "no notification was ever in question", which is the
  // ordinary case and shouldn't read as a suppressed send in the UI.
  if (!newReplyText) return null

  // Rule 4.
  if (target.user_id === callerId) return { sent: false, skipped: 'replied_to_own_item' }

  const { data: submitter } = await supabaseService
    .from('hub_users')
    .select('email, full_name, first_name')
    .eq('id', target.user_id)
    .single()

  const to = submitter?.email?.trim()
  if (!to) return { sent: false, skipped: 'no_submitter_email' }

  const result = await sendFeedbackReplyEmail({
    to,
    recipientName: submitter?.full_name || submitter?.first_name || null,
    itemTitle: target.title,
    itemType: target.type,
    replyText: newReplyText,
    // Only name the status when it moved in this same save — see the email
    // module's statusLabel note.
    statusLabel: statusChanged ? (FEEDBACK_STATUS_PLAIN[newStatus] || null) : null,
    locationId: target.location_id,
  })

  // Rule 5 — the save already happened; report, never escalate.
  if (!result.success) {
    console.error('[admin feedback PATCH] reply email failed:', result.error)
    return { sent: false, error: result.error }
  }
  return { sent: true, to }
}
