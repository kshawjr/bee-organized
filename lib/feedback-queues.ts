// lib/feedback-queues.ts
//
// ONE definition of "open feedback", and the three triage queues derived from
// it. Issue 233.
//
// WHY THIS MODULE EXISTS. Before it, two different numbers were shown to the
// same person on the same screen-load:
//   · the admin dashboard's action-required card and the nav badge counted
//     status='submitted' only  → 17
//   · the Feedback screen header counted "not shipped/declined" → 28
// Neither number covered the actual backlog: eleven items parked in
// under_review/planned, three of them filed 58 days earlier, were counted by
// the first as "handled" and by the second only as an undifferentiated part of
// 28. Nothing anywhere said "these have gone quiet".
//
// THE CHOSEN DEFINITION IS THE WIDER ONE:
//
//   open = status NOT IN (shipped, declined)
//
// An item is closed when someone decided it — shipped it or declined it.
// Everything else is still owed an answer, which is what "open" has to mean if
// the number is going to be trusted. The narrow definition (submitted only)
// reported 17 while 11 more sat untouched for weeks; a count that goes DOWN
// when you start work and only goes down again when you finish it is a count
// that hides the middle, and the middle is where this backlog lives.
//
// THE THREE QUEUES PARTITION `open` — they are not overlapping slices:
//
//   new     status='submitted'                      — nobody has looked yet
//   stale   under_review|planned, untouched ≥14d    — started, then went quiet
//   working status='in_progress'                    — actively being worked
//   inHand  under_review|planned, touched <14d      — the remainder
//
// `inHand` is the honesty valve. Without it the three headline queues would not
// sum to the header count the moment anyone triages something, and the screen
// would be back to showing two numbers that disagree. It renders as a quiet
// line rather than a fourth card because it needs no action today — but it is
// always counted, so cards + inHand === open, exactly, always.
//
// Every consumer (the screen header, the queue cards, the nav badge, the admin
// dashboard card) reads its number from summarizeFeedbackQueues. That is the
// mechanism that keeps them equal — not a convention anyone has to remember.

export const FEEDBACK_STALE_DAYS = 14

// Plain-English status labels (issue 126's owner-facing vocabulary). They live
// HERE, in a server-safe module, because the reply email needs them too and
// components/feedback/feedbackShared.jsx is a 'use client' file an API route
// must not import. feedbackShared re-exports this map, so there is still
// exactly one home for the words — this one.
export const FEEDBACK_STATUS_PLAIN: Record<string, string> = {
  submitted: 'New',
  under_review: 'Looking at it',
  planned: 'Planned',
  in_progress: 'In progress',
  shipped: 'Fixed',
  declined: 'Not planned',
}

// Terminal statuses. A decision was made; the item is off the books.
export const CLOSED_FEEDBACK_STATUSES = ['shipped', 'declined'] as const

// The two statuses that mean "picked up, not finished". These are the ones that
// can go stale — 'submitted' can't (it has never been touched, so its age is
// already what the "new" queue reports) and 'in_progress' shouldn't (it is a
// claim that someone is on it; if that claim rots, it rots as a lie we can't
// detect from data alone).
const STALLABLE_STATUSES = ['under_review', 'planned'] as const

export type FeedbackQueueKey = 'new' | 'stale' | 'working' | 'inHand'

export interface FeedbackQueueItem {
  status?: string | null
  created_at?: string | null
  updated_at?: string | null
  admin_response?: string | null
}

export function isClosedFeedback(status: string | null | undefined): boolean {
  return (CLOSED_FEEDBACK_STATUSES as readonly string[]).includes(String(status || ''))
}

// Whole days between `iso` and `now`. Returns null for a missing/unparseable
// timestamp so callers can distinguish "no age" from "zero days old" — a row
// with a broken date must never be silently counted as brand new.
export function feedbackAgeDays(
  iso: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.floor((now - then) / 86400000)
}

// Last-touch age. updated_at is maintained by the feedback_items trigger, so it
// moves on every triage write; created_at is the fallback for a row that
// predates the trigger or a fixture that omits it.
export function feedbackLastTouchDays(
  item: FeedbackQueueItem,
  now: number = Date.now(),
): number | null {
  return feedbackAgeDays(item.updated_at || item.created_at, now)
}

// "Started, then went quiet." Deliberately keyed on LAST TOUCH, not on age: an
// item filed 58 days ago and answered yesterday is not stale, and an item filed
// last week and ignored since the day it arrived is.
export function isStaleFeedback(item: FeedbackQueueItem, now: number = Date.now()): boolean {
  if (!(STALLABLE_STATUSES as readonly string[]).includes(String(item.status || ''))) return false
  const days = feedbackLastTouchDays(item, now)
  return days != null && days >= FEEDBACK_STALE_DAYS
}

// Which queue an item belongs to — or null when it is closed. Total function
// over open items: every open item lands in exactly one queue.
export function feedbackQueueOf(
  item: FeedbackQueueItem,
  now: number = Date.now(),
): FeedbackQueueKey | null {
  const status = String(item.status || '')
  if (isClosedFeedback(status)) return null
  if (status === 'submitted') return 'new'
  if (status === 'in_progress') return 'working'
  return isStaleFeedback(item, now) ? 'stale' : 'inHand'
}

// An item that was ANSWERED but whose status was never moved off 'submitted'.
// It reads as untouched everywhere — it keeps ringing the "nobody has looked at
// this" queue — while a written reply sits on it. One item in production has
// been in this state for twelve days. Surfaced on the row so it is visible
// without opening anything.
export function isAnsweredButUnmoved(item: FeedbackQueueItem): boolean {
  return !!(item.admin_response && String(item.admin_response).trim()) && item.status === 'submitted'
}

export interface FeedbackQueueSummary {
  /** Items not shipped/declined. THE open count — header, badge, dashboard. */
  open: number
  /** Items shipped/declined — hidden by default behind the "Show N closed" toggle. */
  closed: number
  total: number
  counts: Record<FeedbackQueueKey, number>
  /** Age in days of the oldest item nobody has looked at, or null if none. */
  oldestNewDays: number | null
  /** Last-touch age of the longest-quiet stale item, or null if none. */
  oldestStaleDays: number | null
}

export function summarizeFeedbackQueues(
  items: FeedbackQueueItem[],
  now: number = Date.now(),
): FeedbackQueueSummary {
  const counts: Record<FeedbackQueueKey, number> = { new: 0, stale: 0, working: 0, inHand: 0 }
  let open = 0
  let closed = 0
  let oldestNewDays: number | null = null
  let oldestStaleDays: number | null = null

  for (const item of items || []) {
    const queue = feedbackQueueOf(item, now)
    if (!queue) {
      closed++
      continue
    }
    open++
    counts[queue]++
    if (queue === 'new') {
      const age = feedbackAgeDays(item.created_at, now)
      if (age != null && (oldestNewDays == null || age > oldestNewDays)) oldestNewDays = age
    } else if (queue === 'stale') {
      const quiet = feedbackLastTouchDays(item, now)
      if (quiet != null && (oldestStaleDays == null || quiet > oldestStaleDays)) oldestStaleDays = quiet
    }
  }

  return { open, closed, total: (items || []).length, counts, oldestNewDays, oldestStaleDays }
}
