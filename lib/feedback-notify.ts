// lib/feedback-notify.ts
//
// The submitter-email decision for a feedback item, shared by the two places a
// team reply can arrive:
//   · the admin triage save (app/api/admin/feedback/[id]/route.ts), whose
//     header holds the full SEND RULES (issues 233, 236, 247);
//   · a ClickUp close (lib/clickup-sync) — task 868mm1h7z. 35 of 43 owners
//     never open Bee Desk, so a reply with no email reaches nobody.
// Moved here verbatim from the route so both paths make exactly the same
// decision with exactly the same guards; the one widening is that callerId may
// be null, for a reply that no Bee Hub user typed (rule 4, notifying yourself,
// then has nobody to compare against and never applies).

import { supabaseService } from './supabase-service'
import { sendFeedbackReplyEmail } from './feedback-reply-email'
import { FEEDBACK_STATUS_PLAIN } from './feedback-queues'
import { isInternalItem } from './feedback-internal'

// What the caller is told about the notification attempt. 'skipped' carries the
// reason so the UI can be specific ("no email on file") rather than silent.
// `kind` names WHICH email went (issue 236) so triage's confirmation line can
// say "we emailed your reply" or "we told them it's fixed" without guessing
// from what happens to be in its own textarea — the route is the only party
// that knows, since it compares against the stored reply.
export type ReplyEmailKind = 'reply' | 'shipped'
export type ReplyEmailOutcome =
  | { sent: true; to: string; kind: ReplyEmailKind }
  | { sent: false; skipped: string }
  | { sent: false; error: string }

// The whole send decision in one place, returning a description of what
// happened rather than throwing. Rules 2-5 live here.
//
// ONE RAIL, TWO REASONS TO USE IT (issue 236). The shipped announcement does
// not get its own path: it enters here, passes the same own-item and
// no-address guards in the same order, builds through the same module and rides
// the same never-fatal send. What the announcement changes is the ENTRY
// CONDITION and the copy — nothing about the delivery.
export async function maybeNotifySubmitter(args: {
  newReplyText: string | null
  statusChanged: boolean
  shippedNow: boolean
  callerId: string | null
  target: { user_id: string; location_id: string | null; title: string; type: string; is_internal?: unknown }
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

  // ─── RULE 6: AN INTERNAL ITEM NOTIFIES NOBODY (issue 247 step 2) ────
  // Above rule 4, because rule 4 only covers the case where the replier IS the
  // submitter. Both cases this catches are ones rule 4 lets through:
  //
  //   · KEVIN FILES, SOMEONE ELSE SHIPS IT. rule 4 compares user_id to the
  //     caller; a corporate admin marking Kevin's internal item Fixed is not
  //     Kevin, so the issue-236 announcement fires and mails him owner-facing
  //     prose ("the thing you reported is fixed") about a Jobber token race.
  //     Noise, in a voice written for franchise owners.
  //
  //   · AN OWNER'S REPORT IS LATER FLIPPED INTERNAL. Worse, and the reason this
  //     is a guard rather than a preference: the submitter is still the owner,
  //     so the announcement mails THEM — about an item that is now hidden from
  //     every owner-facing read. The mail deep-links to /?feedback=1, they
  //     follow it, and the item they were just told about is not there. We would
  //     have advertised something we had removed. (Step 2 does not build that
  //     flip — see the route header — but the guard must not depend on that
  //     staying true.)
  //
  // A skip reason rather than null: a null means "no notification was ever in
  // question", and triage should see that we deliberately held one back.
  if (isInternalItem(target)) return { sent: false, skipped: 'internal_item' }

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
