// @vitest-environment node
//
// issue 233 — ONE open count, and the three queues derived from it.
//
// What these pin, and why each mattered enough to pin:
//
//   1. THE COUNT RECONCILIATION. Two numbers were shown to the same person on
//      the same load: the dashboard card and nav badge counted 'submitted' only
//      (17), the screen header counted "not shipped/declined" (28). There is
//      now one function, and everything reads it. The fixture below is the real
//      production distribution, so the numbers in these assertions are the
//      numbers that were on Kevin's screen.
//   2. THE STALE QUEUE. It did not exist. Eleven items sat in
//      under_review/planned, three of them quiet for 58 days, counted by
//      neither number as anything needing attention.
//   3. CARDS + inHand === open, ALWAYS. The failure mode being prevented is the
//      original one: a set of headline numbers that don't add up to the header,
//      so the screen is once again showing two truths.
import { describe, it, expect } from 'vitest'
import {
  summarizeFeedbackQueues, feedbackQueueOf, isStaleFeedback, isClosedFeedback,
  isAnsweredButUnmoved, feedbackAgeDays, FEEDBACK_STALE_DAYS,
} from '@/lib/feedback-queues'

const NOW = new Date('2026-08-14T12:00:00Z').getTime()
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString()

// One row, defaulting to "touched when it was created" — the untouched case.
const item = (o: Partial<{ status: string; createdDays: number; touchedDays: number; admin_response: string | null }>) => ({
  status: o.status ?? 'submitted',
  created_at: daysAgo(o.createdDays ?? 1),
  updated_at: daysAgo(o.touchedDays ?? o.createdDays ?? 1),
  admin_response: o.admin_response ?? null,
})

// The production shape on the day this was built: 63 items — 34 shipped,
// 17 submitted, 7 under_review, 4 planned, 1 declined, 0 in_progress. All 11
// under_review/planned were last touched 14-19 days earlier; the oldest
// untouched submission was 12 days old.
const PROD_SHAPE = [
  ...Array.from({ length: 34 }, () => item({ status: 'shipped', createdDays: 30, touchedDays: 20 })),
  ...Array.from({ length: 16 }, () => item({ status: 'submitted', createdDays: 5 })),
  item({ status: 'submitted', createdDays: 12 }), // the oldest untouched one
  ...Array.from({ length: 7 }, () => item({ status: 'under_review', createdDays: 40, touchedDays: 14 })),
  ...Array.from({ length: 4 }, () => item({ status: 'planned', createdDays: 58, touchedDays: 19 })),
  item({ status: 'declined', createdDays: 24, touchedDays: 24 }),
]

describe('one open count — the reconciliation', () => {
  it('open is everything not shipped/declined: 28, not the 17 the badge used to show', () => {
    const s = summarizeFeedbackQueues(PROD_SHAPE, NOW)
    expect(s.total).toBe(63)
    expect(s.open).toBe(28)
    expect(s.closed).toBe(35) // 34 shipped + 1 declined
  })

  it('the three cards plus the in-hand remainder ALWAYS equal open', () => {
    const s = summarizeFeedbackQueues(PROD_SHAPE, NOW)
    const { new: fresh, stale, working, inHand } = s.counts
    expect(fresh + stale + working + inHand).toBe(s.open)
    // And on today's data specifically: 17 waiting, 11 gone quiet, 0 in flight.
    expect(fresh).toBe(17)
    expect(stale).toBe(11)
    expect(working).toBe(0)
    expect(inHand).toBe(0)
  })

  it('stays reconciled after triage moves an item into the remainder', () => {
    // The moment someone reviews something, it leaves 'new' and lands in
    // 'inHand' — the case that would have re-created two disagreeing numbers if
    // the remainder weren't counted.
    const after = [...PROD_SHAPE.slice(1), item({ status: 'under_review', createdDays: 5, touchedDays: 0 })]
    const s = summarizeFeedbackQueues(after, NOW)
    expect(s.counts.inHand).toBe(1)
    expect(s.counts.new + s.counts.stale + s.counts.working + s.counts.inHand).toBe(s.open)
  })

  it('reports the oldest untouched submission so the card can say how long', () => {
    expect(summarizeFeedbackQueues(PROD_SHAPE, NOW).oldestNewDays).toBe(12)
  })

  it('reports the worst stale gap', () => {
    expect(summarizeFeedbackQueues(PROD_SHAPE, NOW).oldestStaleDays).toBe(19)
  })
})

describe('the stale queue catches what went quiet', () => {
  it(`under_review untouched for ${FEEDBACK_STALE_DAYS} days is stale; 13 days is not`, () => {
    expect(isStaleFeedback(item({ status: 'under_review', createdDays: 40, touchedDays: 14 }), NOW)).toBe(true)
    expect(isStaleFeedback(item({ status: 'under_review', createdDays: 40, touchedDays: 13 }), NOW)).toBe(false)
  })

  it('planned counts too — both "picked up, not finished" statuses can rot', () => {
    expect(feedbackQueueOf(item({ status: 'planned', createdDays: 58, touchedDays: 19 }), NOW)).toBe('stale')
  })

  it('keys on LAST TOUCH, not age — an old item answered yesterday is not stale', () => {
    expect(isStaleFeedback(item({ status: 'under_review', createdDays: 58, touchedDays: 1 }), NOW)).toBe(false)
  })

  it('submitted is never "stale" — it belongs to the untouched queue by definition', () => {
    expect(feedbackQueueOf(item({ status: 'submitted', createdDays: 90 }), NOW)).toBe('new')
  })

  it('in_progress is never stale — it lands in the being-worked-on queue', () => {
    expect(feedbackQueueOf(item({ status: 'in_progress', createdDays: 90, touchedDays: 90 }), NOW)).toBe('working')
  })

  it('closed items belong to no queue at all', () => {
    expect(feedbackQueueOf(item({ status: 'shipped', createdDays: 90, touchedDays: 90 }), NOW)).toBeNull()
    expect(feedbackQueueOf(item({ status: 'declined', createdDays: 90, touchedDays: 90 }), NOW)).toBeNull()
    expect(isClosedFeedback('shipped')).toBe(true)
    expect(isClosedFeedback('under_review')).toBe(false)
  })
})

describe('answered but never moved', () => {
  it('flags a reply written against an item still marked New', () => {
    expect(isAnsweredButUnmoved(item({ status: 'submitted', admin_response: 'Found it — fixed next week' }))).toBe(true)
  })

  it('is not flagged once the status moves, or when there is no reply', () => {
    expect(isAnsweredButUnmoved(item({ status: 'planned', admin_response: 'Found it' }))).toBe(false)
    expect(isAnsweredButUnmoved(item({ status: 'submitted' }))).toBe(false)
    expect(isAnsweredButUnmoved(item({ status: 'submitted', admin_response: '   ' }))).toBe(false)
  })
})

describe('degenerate inputs never produce a confident wrong number', () => {
  it('a broken timestamp yields no age rather than "0 days old"', () => {
    expect(feedbackAgeDays('not-a-date', NOW)).toBeNull()
    expect(feedbackAgeDays(null, NOW)).toBeNull()
    // …and an unparseable last-touch cannot make an item stale.
    expect(isStaleFeedback({ status: 'planned', created_at: 'nonsense', updated_at: 'nonsense' }, NOW)).toBe(false)
  })

  it('an empty list is all zeroes, not NaN', () => {
    const s = summarizeFeedbackQueues([], NOW)
    expect(s).toMatchObject({ open: 0, closed: 0, total: 0, oldestNewDays: null, oldestStaleDays: null })
    expect(s.counts).toEqual({ new: 0, stale: 0, working: 0, inHand: 0 })
  })
})
