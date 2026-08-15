// app/api/admin/feedback/[id]/route.ts
//
// PATCH /api/admin/feedback/[id] — triage update. Body: { status?, admin_response? }.
//   - super_admin / admin: can patch any feedback item.
//   - owner / manager: can patch ONLY items belonging to their own location,
//     and ONLY items that are not internal (issue 247 step 1 — an internal item
//     may carry their location tag, so the location test alone would let them
//     mark our own engineering backlog Fixed). Internal ids answer 404, not
//     403, so a guessed id cannot even confirm the row exists.
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
//   2. A STATUS CHANGE WITH NO NEW REPLY SENDS NOTHING — EXCEPT FIXED.
//      Deliberate. "Planned" arriving by email with no words around it is noise
//      to a franchise owner, and triage moves statuses far more often than it
//      writes replies — 47 replies against six statuses' worth of movement. If
//      we want the submitter told about a middle move, the way to tell them is
//      to write them a sentence, which is rule 1.
//
//      Shipped is the exception (issue 236) and it is the only one. It is the
//      news the person has been waiting for, it is self-explanatory in a way no
//      middle status is — "the thing you reported is fixed" needs no
//      accompanying sentence to mean something — and it is the one status where
//      staying quiet is itself the wrong message: the reporter goes on believing
//      the bug is live, works around it, and learns that reporting things leads
//      nowhere. Rule 2a below is the transition test.
//
//   2a. INTO shipped, not AT shipped. The send fires when the status MOVES to
//      'shipped' from something else. Re-saving an already-shipped item —
//      correcting its title, adding a note, walking past it with next/previous
//      — mints nothing. Without this an item could be announced repeatedly.
//
//   2b. DECLINED IS NOT SHIPPED, and stays under rule 2. A decline is a
//      refusal, and an unexplained refusal is the one message most likely to
//      end someone's willingness to report anything again: "Not planned",
//      alone, in their inbox, with no reason and nobody's name on it. Where
//      Fixed carries its own explanation, Declined's explanation is exactly the
//      part a bare status change omits. So declining still requires someone to
//      write the sentence — and when they do, rule 1 sends it with "We've also
//      marked it: Not planned" attached, which is the same news delivered by a
//      person. Silence here is recoverable; a curt no is not.
//   3. CLEARING A REPLY SENDS NOTHING. Deleting text is not a message.
//   4. NOTIFYING YOURSELF SENDS NOTHING. owner/manager can patch their own
//      location's items, including the ones they filed themselves — and in
//      production an owner has already used the reply box to add a note to his
//      own report. Mailing someone their own words back is a bug, not a
//      notification. The guard sits above BOTH sends, so marking your own item
//      Fixed mails you nothing either.
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
import { isInternalItem, withInternalFallback } from '@/lib/feedback-internal'

export const runtime = 'nodejs'

const ELEVATED_ROLES = ['super_admin', 'admin']
const LOCATION_SCOPED_ROLES = ['owner', 'manager']
// The BEFORE-state columns, named once so the pre-migration fallback select
// (without is_internal) and the normal one cannot drift apart.
const TARGET_COLS = 'id, location_id, user_id, type, title, status, admin_response'
const VALID_STATUSES = new Set([
  'submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined',
])

// What the caller is told about the notification attempt. 'skipped' carries the
// reason so the UI can be specific ("no email on file") rather than silent.
// `kind` names WHICH email went (issue 236) so triage's confirmation line can
// say "we emailed your reply" or "we told them it's fixed" without guessing
// from what happens to be in its own textarea — the route is the only party
// that knows, since it compares against the stored reply.
type ReplyEmailKind = 'reply' | 'shipped'
type ReplyEmailOutcome =
  | { sent: true; to: string; kind: ReplyEmailKind }
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
  const { data: target } = await withInternalFallback<any>(
    async (withInternal) =>
      await supabaseService
        .from('feedback_items')
        .select(withInternal ? `${TARGET_COLS}, is_internal` : TARGET_COLS)
        .eq('id', id)
        .single(),
  )
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // ─── INTERNAL ITEMS DO NOT EXIST FOR AN OWNER (issue 247 step 1) ────
  // Checked BEFORE the location test, and the order is load-bearing: an
  // internal item is very likely tagged with THIS owner's location — that tag
  // is the point, it is how an overlap becomes visible — so the location test
  // would PASS it through and hand them a status control and a reply box on our
  // own engineering backlog.
  //
  // 404, not 403. A 403 would confirm that an item exists here which they may
  // not touch, i.e. that internal work about their location exists — the exact
  // fact this flag hides. An unknown id and an internal id must be
  // indistinguishable. Elevated callers never reach this branch.
  if (isLocationScopedCaller && isInternalItem(target)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

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
  // Rule 2a: INTO shipped. Computed against the BEFORE row, like newReplyText,
  // and false when the item was already shipped or when this save did not touch
  // the status at all.
  const shippedNow = patch.status === 'shipped' && target.status !== 'shipped'

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

  const replyEmail = await maybeNotifySubmitter({
    newReplyText,
    statusChanged,
    shippedNow,
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
//
// ONE RAIL, TWO REASONS TO USE IT (issue 236). The shipped announcement does
// not get its own path: it enters here, passes the same own-item and
// no-address guards in the same order, builds through the same module and rides
// the same never-fatal send. What the announcement changes is the ENTRY
// CONDITION and the copy — nothing about the delivery.
async function maybeNotifySubmitter(args: {
  newReplyText: string | null
  statusChanged: boolean
  shippedNow: boolean
  callerId: string
  target: { user_id: string; location_id: string | null; title: string; type: string }
  newStatus: string
}): Promise<ReplyEmailOutcome | null> {
  const { newReplyText, statusChanged, shippedNow, callerId, target, newStatus } = args

  // Rules 2 + 2a + 3: nothing to say → say nothing. A new reply is something to
  // say; so is "it's fixed". Everything else — a middle status, a decline
  // without words (rule 2b), a cleared reply, a re-save of an already-shipped
  // item — is not. Returning null (rather than a skip reason) marks "no
  // notification was ever in question", the ordinary case, which shouldn't read
  // as a suppressed send in the UI.
  if (!newReplyText && !shippedNow) return null

  // Which of the two this is. A save that ships AND writes a reply is a reply —
  // the words lead, and the status rides along as "We've also marked it: Fixed"
  // rather than becoming a second email.
  const kind: ReplyEmailKind = newReplyText ? 'reply' : 'shipped'

  // Rule 4 — above both sends.
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
    replyText: newReplyText || '',
    // Only name the status when it moved in this same save — see the email
    // module's statusLabel note. Ignored by the announcement build, where the
    // status is not an aside but the whole message.
    statusLabel: statusChanged ? (FEEDBACK_STATUS_PLAIN[newStatus] || null) : null,
    shipped: shippedNow,
    locationId: target.location_id,
  })

  // Rule 5 — the save already happened; report, never escalate.
  if (!result.success) {
    console.error('[admin feedback PATCH] submitter email failed:', result.error)
    return { sent: false, error: result.error }
  }
  return { sent: true, to, kind }
}
