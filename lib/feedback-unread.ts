// lib/feedback-unread.ts
//
// THE HELP BADGE COUNT (ClickUp 868mm1h81). One meaning and nothing else:
// replies to YOUR OWN reports that you have not opened.
//
// A row counts when all of these hold:
//   · it is the viewer's own item (user_id) — not merely their location's. Two
//     people at one location have separate counts; a location-wide number would
//     show one person a figure that is partly someone else's mail.
//   · it carries a team reply (admin_response present and not blank)
//   · that reply is unseen — isReplyUnseen, the SAME test the card's green
//     "New" marker uses (components/feedback/FeedbackCard isUnreadReply). It is
//     reply_seen_at IS NULL, widened by one case: a second reply written after
//     the owner read the first is unread again. Without that widening the badge
//     would read 0 while the card says New.
//   · it is not internal
//
// Not open items, not items waiting on them, not status changes without words.
// The badge and the card must agree, because the card is the only place the
// badge can be cleared: every row counted here is a card that shows New and
// clears on a tap or "Got it". A count that included anything the screen
// cannot clear would never go out.

import { hasFeedbackReply, isReplyUnseen } from './feedback-queues'

export interface UnreadCandidate {
  user_id?: string | null
  is_internal?: boolean | null
  admin_response?: string | null
  admin_response_at?: string | null
  reply_seen_at?: string | null
}

export function isCountedUnread(row: UnreadCandidate | null | undefined, userId: string | null | undefined): boolean {
  if (!row || !userId || row.user_id !== userId) return false
  if (row.is_internal === true) return false
  return hasFeedbackReply(row) && isReplyUnseen(row)
}

export function countUnreadReplies(rows: UnreadCandidate[] | null | undefined, userId: string | null | undefined): number {
  return (rows || []).filter(r => isCountedUnread(r, userId)).length
}
