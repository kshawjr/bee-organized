// lib/feedback-unopened.ts
//
// The DECISION behind the unopened-reply alert — the one of the three built
// alerts (lib/feedback-nudge) that is actually wired, because it was written
// for the failure that actually happened: answered work sitting unread for
// seven weeks while every screen said "Replied".
//
// WHAT COUNTS AS UNOPENED. A non-internal item carrying a team reply whose
// reply_seen_at has never caught up with admin_response_at (the same
// timestamp compare as isReplyUnseen — a SECOND reply on an already-read item
// counts as unread again), where the reply is at least UNOPENED_REPLY_DAYS
// old. Status-independent ON PURPOSE, and verified against the staleness
// blind spot the brief has: staleness only applies to picked-up items, but
// this reads every row — submitted, answered, shipped alike — so a closed
// item with an unread answer (the seven-week case was SHIPPED work) is
// exactly what it catches. Live production at wiring time: 14 such items, 12
// of them closed.
//
// WHEN IT FIRES — twice-never, by construction rather than by memory of
// individual items:
//
//   1. THE STOCK, ONCE. The first time this decision ever runs with a
//      standing backlog (no posted unopened-alert row exists in digest_runs),
//      it fires for the whole set. Without this, "crossed since last run"
//      semantics would silently skip every item that was already over the
//      threshold when the alert shipped — the 14 that are the reason it
//      exists.
//   2. A NEW CROSSING, ONCE. After that, it fires only when an item's
//      crossing moment (reply written + 21 days) falls inside the window
//      since the previous cron run. Each item has exactly one crossing
//      moment, and consecutive runs' windows do not overlap — so no item can
//      fire twice. The window is "since the last brief run" (recorded every
//      run, posted or suppressed), so weekends and downtime widen it
//      automatically instead of dropping crossings into a gap.
//
// KNOWN HONEST LIMITS, stated rather than hidden:
//   · "Opened" means the owner's feedback screen LOADED since the reply was
//     written — that is what stamps reply_seen_at. An owner who read the
//     answer in the email but never clicked through counts as unopened. The
//     alert is therefore really "the answer never landed IN THE APP", which
//     for a 21-day-old reply is still worth a human glance.
//   · If the Slack post fails, the failed attempt is recorded posted:false
//     and does not count as "alerted before" — the stock retries next run.
//     A crossing missed during an outage is gone (its moment leaves the
//     window); the stock rule does not resurrect it.

import { isReplyUnseen } from './feedback-queues'
import { UNOPENED_REPLY_DAYS, type UnopenedReplyEvent } from './feedback-nudge'

const DAY_MS = 86_400_000

export interface UnopenedCandidate {
  id?: string | null
  is_internal?: boolean | null
  admin_response?: string | null
  admin_response_at?: string | null
  reply_seen_at?: string | null
}

export interface UnopenedDecision {
  /** Null when nothing should post this run. */
  event: UnopenedReplyEvent | null
  /** Standing unopened count (threshold-old and older), for the log line. */
  count: number
  /** How many crossed the threshold inside this run's window. */
  crossedCount: number
  reason: string
}

const stamp = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

export function decideUnopenedAlert(args: {
  items: UnopenedCandidate[]
  /** ran_at of the PREVIOUS brief run — the start of this run's window. */
  lastCheckedAt: string | null
  /** Does a POSTED unopened-alert row already exist (ever)? */
  alertedBefore: boolean
  now?: number
}): UnopenedDecision {
  const now = args.now ?? Date.now()
  const threshold = UNOPENED_REPLY_DAYS * DAY_MS
  const windowStart = stamp(args.lastCheckedAt)

  let count = 0
  let oldestDays = 0
  let crossedCount = 0
  for (const i of args.items || []) {
    if (!i || i.is_internal === true) continue
    if (!(i.admin_response && String(i.admin_response).trim())) continue
    const repliedAt = stamp(i.admin_response_at)
    if (repliedAt == null) continue
    if (!isReplyUnseen(i)) continue
    const age = now - repliedAt
    if (age < threshold) continue
    count++
    const days = Math.floor(age / DAY_MS)
    if (days > oldestDays) oldestDays = days
    // The crossing moment is fixed per item; windows never overlap, so an
    // item is "crossed" in at most one run's window, ever.
    const crossingMoment = repliedAt + threshold
    if (windowStart != null && crossingMoment > windowStart && crossingMoment <= now) crossedCount++
  }

  if (count === 0) {
    return { event: null, count, crossedCount, reason: 'nothing unopened past the threshold' }
  }
  if (!args.alertedBefore) {
    return {
      event: { kind: 'unopened-reply', count, oldestDays },
      count, crossedCount,
      reason: 'first run with a standing backlog — the one-time stock alert',
    }
  }
  if (crossedCount > 0) {
    return {
      event: { kind: 'unopened-reply', count, oldestDays },
      count, crossedCount,
      reason: `${crossedCount} newly crossed ${UNOPENED_REPLY_DAYS} days this window`,
    }
  }
  return { event: null, count, crossedCount, reason: 'standing set already alerted; nothing newly crossed' }
}
