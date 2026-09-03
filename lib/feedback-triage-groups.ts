// lib/feedback-triage-groups.ts
//
// The two triage queues the redesigned corporate screen renders, and the
// fixed type order inside them. Pure, server-safe, and READ-ONLY over the
// row shape — nothing here changes how an item is stored, patched or mailed.
//
// ─── WHY TWO QUEUES AND NOT THREE CARDS ───────────────────────────────
// The issue 233 cards (Not looked at yet / Going stale / Being worked on)
// partitioned open items by STATUS. Kevin could not scan them: three counts,
// five filters and a colour per status all competed for the eye, and the
// question he actually asks on a phone is simpler than any of them —
//
//   "Whose turn is it?"
//
// So the list is grouped by who is waiting:
//
//   Needs an answer   nobody from the team has replied yet, OR the owner
//                     wrote back and the last word is theirs. Either way the
//                     next move is ours.
//   Waiting on them   the team spoke last and the item is still open. We
//                     asked something, or told them something, and they have
//                     not come back.
//
// Closed items (answered / shipped / declined) are NOT a queue. They sit
// behind a "Show N closed" line at the bottom, hidden by default.
//
// Internal items never land in "Waiting on them": there is nobody on the
// other end to wait on, so an internal item with a team note is still ours.
//
// The three-card arithmetic in lib/feedback-queues is NOT replaced — the nav
// badge, the admin dashboard card and the Slack nudge still read
// summarizeFeedbackQueues, and its `open` count is the number the header
// here shows. This module only decides how the screen ARRANGES those rows.
//
// ─── THE CLOCK ────────────────────────────────────────────────────────
// "Longest waiting first" means longest in THIS queue. An item nobody has
// answered has been waiting since it was filed; an item the owner wrote back
// on has been waiting since their reply; an item we replied to has been
// waiting on them since our reply. So the age is measured from the LAST WORD
// in the thread, falling back to the filing date when there is no thread.
// That is also the age a queue header reports for its oldest item, and the
// age that turns the header red past TRIAGE_OVERDUE_DAYS.

import { buildFeedbackThread, type FeedbackThreadItem } from './feedback-replies'
import { isClosedFeedback, feedbackAgeDays, FEEDBACK_STALE_DAYS } from './feedback-queues'

/** A queue header turns red once its oldest item has waited this long. */
export const TRIAGE_OVERDUE_DAYS = FEEDBACK_STALE_DAYS

/**
 * The FIXED type order inside every queue. Kevin's order, not the issue 306
 * work rank (which put hazard second): bugs, then questions, then ideas,
 * then hazards, then decisions. Anything outside the vocabulary sorts last
 * so an unknown value can never push a known bug down the page.
 */
export const TRIAGE_GROUP_TYPE_ORDER = ['bug', 'question', 'feature', 'hazard', 'decision'] as const

export type TriageQueueKey = 'needs' | 'waiting' | 'closed'

export interface TriageGroupItem extends FeedbackThreadItem {
  id: string
  type?: string | null
  created_at?: string | null
  updated_at?: string | null
  is_internal?: boolean | null
}

export interface TriageTypeSection<T> {
  /** The type value, or 'other' for anything outside the vocabulary. */
  type: string
  items: T[]
}

export interface TriageQueue<T> {
  key: TriageQueueKey
  label: string
  count: number
  /** Age in days of the longest-waiting item, or null when the queue is empty. */
  oldestDays: number | null
  /** True when oldestDays has crossed TRIAGE_OVERDUE_DAYS. */
  overdue: boolean
  sections: TriageTypeSection<T>[]
  /** The queue's rows in render order — sections flattened. */
  items: T[]
}

export const TRIAGE_QUEUE_LABEL: Record<TriageQueueKey, string> = {
  needs: 'Needs an answer',
  waiting: 'Waiting on them',
  closed: 'Closed',
}

export function triageGroupTypeRank(type: string | null | undefined): number {
  const i = (TRIAGE_GROUP_TYPE_ORDER as readonly string[]).indexOf(String(type || ''))
  return i === -1 ? TRIAGE_GROUP_TYPE_ORDER.length : i
}

/**
 * Which queue an item belongs to. Total over every row: closed rows go to
 * 'closed', every open row lands in exactly one of the other two.
 */
export function triageQueueOf(item: TriageGroupItem): TriageQueueKey {
  if (isClosedFeedback(item.status)) return 'closed'
  if (item.is_internal === true) return 'needs'
  const thread = buildFeedbackThread(item)
  if (thread.length === 0) return 'needs'
  return thread[thread.length - 1].authorRole === 'team' ? 'waiting' : 'needs'
}

/**
 * The timestamp the item has been waiting since — the last word in the
 * thread, or the filing date when nobody has said anything. An undated legacy
 * reply falls back to admin_response_at, then to created_at, so a row with a
 * broken clock reads as old rather than brand new.
 */
export function triageWaitingSince(item: TriageGroupItem): string | null {
  const thread = buildFeedbackThread(item)
  const last = thread.length ? thread[thread.length - 1] : null
  return last?.createdAt || (last ? item.admin_response_at : null) || item.created_at || null
}

export function triageWaitingDays(item: TriageGroupItem, now: number = Date.now()): number | null {
  return feedbackAgeDays(triageWaitingSince(item), now)
}

function waitStamp(item: TriageGroupItem): number {
  const iso = triageWaitingSince(item)
  const t = iso ? new Date(iso).getTime() : NaN
  // Unparseable → sorts LAST within its type: a broken timestamp must never
  // be read as "waiting the longest".
  return Number.isNaN(t) ? Infinity : t
}

/** Longest waiting first. Pure; ties keep their incoming order. */
export function sortLongestWaitingFirst<T extends TriageGroupItem>(items: T[]): T[] {
  return [...(items || [])].sort((a, b) => waitStamp(a) - waitStamp(b))
}

function buildQueue<T extends TriageGroupItem>(
  key: TriageQueueKey,
  rows: T[],
  now: number,
): TriageQueue<T> {
  const byType = new Map<string, T[]>()
  for (const r of rows) {
    const t = triageGroupTypeRank(r.type) === TRIAGE_GROUP_TYPE_ORDER.length ? 'other' : String(r.type)
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t)!.push(r)
  }
  const typeKeys = Array.from(byType.keys()).sort((a, b) => {
    const ra = a === 'other' ? TRIAGE_GROUP_TYPE_ORDER.length : triageGroupTypeRank(a)
    const rb = b === 'other' ? TRIAGE_GROUP_TYPE_ORDER.length : triageGroupTypeRank(b)
    return ra - rb
  })
  const sections = typeKeys.map(t => ({ type: t, items: sortLongestWaitingFirst(byType.get(t)!) }))
  const items = sections.reduce<T[]>((acc, s) => acc.concat(s.items), [])

  let oldestDays: number | null = null
  for (const r of rows) {
    const d = triageWaitingDays(r, now)
    if (d != null && (oldestDays == null || d > oldestDays)) oldestDays = d
  }
  return {
    key,
    label: TRIAGE_QUEUE_LABEL[key],
    count: rows.length,
    oldestDays,
    overdue: oldestDays != null && oldestDays >= TRIAGE_OVERDUE_DAYS,
    sections,
    items,
  }
}

export interface TriageGrouping<T> {
  needs: TriageQueue<T>
  waiting: TriageQueue<T>
  closed: TriageQueue<T>
}

/**
 * Arrange rows into the two queues plus the closed group. Filtering (type,
 * location, search) happens BEFORE this call — pass the rows you intend to
 * show and this only orders them.
 */
export function groupFeedbackForTriage<T extends TriageGroupItem>(
  items: T[],
  now: number = Date.now(),
): TriageGrouping<T> {
  const needs: T[] = []
  const waiting: T[] = []
  const closed: T[] = []
  for (const it of items || []) {
    const q = triageQueueOf(it)
    if (q === 'closed') closed.push(it)
    else if (q === 'waiting') waiting.push(it)
    else needs.push(it)
  }
  return {
    needs: buildQueue('needs', needs, now),
    waiting: buildQueue('waiting', waiting, now),
    closed: buildQueue('closed', closed, now),
  }
}
