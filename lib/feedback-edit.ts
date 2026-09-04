// lib/feedback-edit.ts
//
// "May the person who filed this report still change it, and may they still
// take it back?" — the two owner-side rules, in one place, so the screen and
// the route cannot disagree about where the line is.
//
// THE LINE FOR EDIT IS THE LINE THE REPLY BOX ALREADY DRAWS. Kevin's ruling is
// "edit until the team replies, then it locks and the owner adds a reply
// instead". That sentence names ONE moment, so it is spent once:
// threadInvitesReply (lib/feedback-replies) is already the test for "has the
// team said something, or has this been decided" — it is what puts the reply
// box on the card. Reusing it makes the ruling literally true rather than
// approximately true:
//
//     for the submitter, EXACTLY ONE of {edit, reply} is ever offered.
//
// There is no window where a report is locked with nothing to do instead, and
// none where both are open and an edit could rewrite the thing a reply is
// about. That invariant is pinned by a test, not by care.
//
// WHY NOT hasFeedbackReply. It reads admin_response ALONE. Production has 48
// replied entries whose reply exists only in that column (they predate
// feedback_replies) and, the other way, an admin who CLEARS a reply nulls the
// column while the authored thread row survives. Only the built thread sees
// both, so only the built thread may decide this.
//
// WHAT DOES *NOT* LOCK AN EDIT, and why each was considered:
//   · A STATUS MOVE ON ITS OWN. Triage moves statuses far more often than it
//     writes words — the reply-email rules in the triage PATCH exist because
//     of exactly that ratio — and "under review" is not the team replying, it
//     is the team filing. Locking on it would close the window on most reports
//     within a day, for no message the owner ever saw. The closed statuses are
//     the exception and they are not an exception to this rule: they are
//     already inside threadInvitesReply, because an ending IS the team saying
//     something.
//   · SOMEONE OPENING IT. Nothing records that, and nothing should for this
//     purpose. reply_seen_at is the owner's read of OUR reply, not ours of
//     theirs; there is no read receipt on the team side and inventing one
//     would make the lock fire on a mis-click.
//
// DELETE HAS NO SUCH GATE — deliberately, and it is Kevin's ruling. Withdrawing
// a report is not editing the record of a conversation; it is ending one. An
// owner may delete at any point in the life of their own entry.

import { threadInvitesReply, type FeedbackThreadItem } from './feedback-replies'

export const MAX_FEEDBACK_TITLE_CHARS = 100
export const MAX_FEEDBACK_DESCRIPTION_CHARS = 2000

/** The route's refusal code, and the word the screen puts on the lock. */
export const EDIT_LOCKED = 'edit_locked_after_reply'

// Has the window closed? Item-only — says nothing about WHO is asking.
export function feedbackEditLocked(item: FeedbackThreadItem | null | undefined): boolean {
  return threadInvitesReply(item)
}

// May THIS viewer edit? The submitter, before the window closes. A colleague at
// the same location reads the card and never edits it — the same scoping the
// reply box and reply_seen_at already have.
export function ownerCanEdit(
  item: (FeedbackThreadItem & { user_id?: string | null }) | null | undefined,
  viewerId: string | null | undefined,
): boolean {
  if (!item || !viewerId || item.user_id !== viewerId) return false
  return !feedbackEditLocked(item)
}

// May THIS viewer delete? The submitter, always. Kept as a named function
// rather than an inline comparison so the screen, the route and the tests all
// answer the question the same way — and so the asymmetry with ownerCanEdit is
// visible in one file instead of implied across three.
export function ownerCanDelete(
  item: { user_id?: string | null } | null | undefined,
  viewerId: string | null | undefined,
): boolean {
  return !!item && !!viewerId && item.user_id === viewerId
}
