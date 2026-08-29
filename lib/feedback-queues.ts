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
  answered: 'Answered',
  shipped: 'Fixed',
  declined: 'Not planned',
}

// Terminal statuses. A decision was made; the item is off the books.
// 'answered' is terminal too: it is the truthful ending for anything resolved
// with words where nothing shipped — a question above all, but legal on any
// type, because owners mislabel and the answer closes the item either way.
// Being in this list is what keeps the open count honest: an answered question
// must not ring the backlog forever for lack of an ending it could wear.
export const CLOSED_FEEDBACK_STATUSES = ['answered', 'shipped', 'declined'] as const

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
  // The two the "have they seen it?" derivation reads (issue 306). Optional
  // like the rest: a fixture that omits them is treated as "never replied,
  // never seen", which is what a row without them means.
  admin_response_at?: string | null
  reply_seen_at?: string | null
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

// ─── "HAVE THEY SEEN WHAT WE WROTE?" (issue 306) ──────────────────────
//
// NO NEW COLUMN. Five owners waited seven weeks on shipped work because
// nothing separated "answered and confirmed" from "answered and never heard
// back" — but every fact needed to tell them apart is already stored:
// admin_response (we wrote), admin_response_at (when), reply_seen_at (when
// they opened it, stamped by POST /api/feedback/seen, the column's only
// writer). The state is DERIVED here rather than persisted, so it cannot go
// stale against the two timestamps that define it and the status CHECK
// constraint is left alone.
//
// hasFeedbackReply is the same test OwnerFeedbackScreen's hasReply makes; the
// timestamp comparison below is the kernel of its isUnreadReply, which now
// calls this instead of keeping a second copy. One definition, two readings:
//   · the OWNER asks "is this news to me?"      → their own item, unseen
//   · TRIAGE asks "are they still waiting?"     → anyone's item, unseen
// Null-tolerant: OwnerFeedbackScreen's hasReply, which now delegates here, was
// called on possibly-absent items and must keep behaving that way.
export function hasFeedbackReply(item: FeedbackQueueItem | null | undefined): boolean {
  return !!(item?.admin_response && String(item.admin_response).trim())
}

// Has the reply gone unseen since it was last WRITTEN? A timestamp compare,
// not a boolean, so a SECOND reply on an already-read item counts as unseen
// again — the case a `reply_seen_at IS NULL` test would silently miss.
//
// Says nothing about whether a reply exists; callers pair it with
// hasFeedbackReply. On its own an item with no reply at all is trivially
// "unseen", which is not a state anyone should act on.
export function isReplyUnseen(item: FeedbackQueueItem): boolean {
  const repliedAt = item.admin_response_at
  if (!repliedAt) return !item.reply_seen_at
  if (!item.reply_seen_at) return true
  return new Date(item.reply_seen_at).getTime() < new Date(repliedAt).getTime()
}

// THE MISSING STATE, derived: we answered, and they have not opened it.
// "Waiting on them" — as opposed to an unanswered item, which is waiting on
// us, and an answered-and-seen item, which is waiting on nobody.
//
// Deliberately status-independent. The seven-week case was SHIPPED work, but
// an owner can be left hanging on any status, and a shipped item they HAVE
// read needs nothing from anyone. What decides it is whether the words
// reached them, not where the item sits in the pipeline.
export function isAwaitingConfirmation(item: FeedbackQueueItem): boolean {
  return hasFeedbackReply(item) && isReplyUnseen(item)
}

// ─── THE WORK ORDER (issue 306) ───────────────────────────────────────
//
// Kevin opens this screen and works down it, so the order has to put what
// matters at the top rather than what arrived last.
//
// TYPE FIRST. "Bugs before features" is the brief; the vocabulary has four
// values now (issue 247 step 2), so the rule is written as an explicit rank
// rather than a two-way test. bug and hazard lead because both mean something
// is wrong — a hazard is a bug that has not happened yet. decision blocks
// somebody else's work. feature is the only one where doing nothing today
// costs nothing. An unrecognised type sorts last: it cannot be reasoned about,
// so it must not push a known bug down the page.
//
// With only bug and feature present this degenerates to exactly the brief.
//
// question SLOTS BETWEEN hazard AND decision. The rank orders by the cost of
// doing nothing today: bug and hazard mean something is (or is about to be)
// broken; a question means a PERSON is standing still waiting for words —
// often blocked ("will editing an address mess up Jobber?" blocks the edit) —
// and is usually minutes to clear; a decision blocks us; a feature costs
// nothing today. Above decision because the person waiting on a question is a
// paying owner, and the person waiting on a decision is us.
export const TRIAGE_TYPE_RANK: Record<string, number> = {
  bug: 0, hazard: 1, question: 2, decision: 3, feature: 4,
}
export const TRIAGE_TYPE_RANK_UNKNOWN = 9

export function triageTypeRank(type: string | null | undefined): number {
  const rank = TRIAGE_TYPE_RANK[String(type || '')]
  return rank === undefined ? TRIAGE_TYPE_RANK_UNKNOWN : rank
}

// Oldest first WITHIN each type band. Which clock counts depends on the view:
//   'created' — how long the reporter has been waiting (the default question)
//   'touched' — how long the item has been quiet, the reason the stale queue
//               exists (issue 233). Kept as an option rather than replaced,
//               because on that queue last-touch IS the age that matters.
export type TriageAgeKey = 'created' | 'touched'

function ageStamp(item: FeedbackQueueItem, key: TriageAgeKey): number {
  const iso = key === 'touched' ? (item.updated_at || item.created_at) : item.created_at
  const t = iso ? new Date(iso).getTime() : NaN
  // An unparseable date sorts LAST within its band rather than to the top: a
  // broken timestamp must never be read as "waiting the longest".
  return Number.isNaN(t) ? Infinity : t
}

// Pure, non-mutating. Returns a new array; ties keep their incoming order.
export function sortForTriage<T extends FeedbackQueueItem & { type?: string | null }>(
  items: T[],
  ageKey: TriageAgeKey = 'created',
): T[] {
  return [...(items || [])].sort((a, b) => {
    const rank = triageTypeRank(a.type) - triageTypeRank(b.type)
    if (rank !== 0) return rank
    return ageStamp(a, ageKey) - ageStamp(b, ageKey)
  })
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
