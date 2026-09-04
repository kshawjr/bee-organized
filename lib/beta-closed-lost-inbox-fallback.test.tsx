// @vitest-environment happy-dom
// issue 187 — Closed Lost clients must not fall back into the Inbox.
//
// THE ORIGINAL BUG: deriveClientStatus decided Inbox membership from lead AGE
// and recent outreach, not engagement outcome. Closing a client's only
// engagement dropped them from openClientIds but, with no won/paid history and
// a recent created_at, they derived straight back to 'New'.
//
// UNDER THE INBOX RULE (Kevin, 2026-09-03; lib/enquiry-exit.ts): a close AFTER
// the enquiry is exit 3. The person leaves the Inbox and the badge because the
// enquiry was closed — not because of an engagement count, and never because
// of age. person.enquiryFacts.closedAts (from the hub-page sweep's
// last_closed_at, or the single-lead refetch's rollUpEngagements) is what the
// derivation reads. A reopen clears the close, so the enquiry is open again
// and the person is back in the Inbox — closed-until-something-new.
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { isInboxCountable } from '@/components/hive/shared/inboxCountable'
import { mapLeadToPerson } from '@/lib/people-mapper'
import ClientGroupedList from '@/components/hive/ClientGroupedList'
import InboxScreen from '@/components/hive/InboxScreen'

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

// A would-be 'New' lead: fresh created_at, contactable, no won/paid — exactly
// the row that used to fall back into the Inbox once closed.
const person = (over: any = {}) => ({
  id: 'p-lost-1',
  name: 'Mary Sifain',
  email: 'mary@email.com',
  phone: '(561) 555-0148',
  locationId: 'loc-uuid-pb',
  created: daysAgo(2),
  importSource: 'manual',
  paidAmount: null,
  outreachTimeline: [],
  jobs: [],
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  wonEngagements: null,
  engagementCount: 0,
  ...over,
})
// The facts the mapper ships: a Closed Lost AFTER the enquiry.
const closedLost = (over: any = {}) => person({
  engagementCount: 1,
  enquiryFacts: {
    createdAt: daysAgo(2), importSource: 'manual', jobberRequestId: null, jobberJobId: null,
    resubmissionAts: [], jobberWorkAts: [], networkMoved: false, closedAts: [daysAgo(1)],
  },
  ...over,
})

const noOpen = new Set<string>()
const noWon = new Set<string>()

describe('issue 187 — a close after the enquiry is exit 3', () => {
  it('a client whose only engagement is Closed Lost does NOT derive New or Attempting', () => {
    expect(deriveClientStatus(closedLost(), noOpen, now, noWon)).toBe('Nurturing')
  })

  it('age is irrelevant: a close one day after a fresh enquiry still settles', () => {
    const s = deriveClientStatus(closedLost({ created: daysAgo(1) }), noOpen, now, noWon)
    expect(s).not.toBe('New')
    expect(s).toBe('Nurturing')
  })

  it('outreach after the close does not reopen the enquiry (a call is not an exit and not an entry)', () => {
    const lostButCalled = closedLost({ outreachTimeline: [{ type: 'reach_out', occurred_at: daysAgo(0.5) }] })
    const s = deriveClientStatus(lostButCalled, noOpen, now, noWon)
    expect(s).not.toBe('Attempting')
    expect(s).toBe('Nurturing')
  })

  it('the nav badge / Inbox count does NOT count a closed client', () => {
    expect(isInboxCountable(closedLost(), noOpen, noWon, now)).toBe(false)
    expect(isInboxCountable(person(), noOpen, noWon, now)).toBe(true) // control
  })

  it('a close this session (before the refetch) settles through the Inbox\'s closedIds', () => {
    expect(deriveClientStatus(person(), noOpen, now, noWon, { closedIds: new Set(['p-lost-1']) })).toBe('Nurturing')
  })
})

describe('issue 187 — closed-UNTIL-something-new, never closed-forever', () => {
  it('a reopen clears the close: the enquiry is open again and the person is back in the Inbox as New', () => {
    // reopen/route.ts nulls closed_at, so the refetched facts carry no close.
    const reopened = closedLost({ enquiryFacts: { ...closedLost().enquiryFacts, closedAts: [] } })
    expect(deriveClientStatus(reopened, new Set(['p-lost-1']), now, noWon)).toBe('New')
  })

  it('a new website enquiry AFTER the close is a new enquiry: New, the old close does not count', () => {
    const backAgain = closedLost({
      enquiryFacts: { ...closedLost().enquiryFacts, resubmissionAts: [daysAgo(0.5)] },
      outreachTimeline: [{ type: 'system', label: 'Webform resubmission', occurred_at: daysAgo(0.5) }],
    })
    expect(deriveClientStatus(backAgain, noOpen, now, noWon)).toBe('New')
  })

  it('a genuinely NEW lead (no engagement) still lands in the Inbox as New', () => {
    expect(deriveClientStatus(person(), noOpen, now, noWon)).toBe('New')
    expect(isInboxCountable(person(), noOpen, noWon, now)).toBe(true)
  })
})

describe('issue 187 — the other bands are unchanged for an exited person', () => {
  it('Closed Won → Client (won outranks the pool)', () => {
    const won = closedLost({ wonEngagements: { count: 1, value: 900, lastClosedAt: daysAgo(1) } })
    expect(deriveClientStatus(won, noOpen, now, noWon)).toBe('Client')
    expect(deriveClientStatus(closedLost(), noOpen, now, new Set(['p-lost-1']))).toBe('Client')
  })

  it('a closed enquiry with another engagement open → Active', () => {
    expect(deriveClientStatus(closedLost(), new Set(['p-lost-1']), now, noWon)).toBe('Active')
  })

  it('a lost client with paid history is Past, not Nurturing (Past outranks)', () => {
    expect(deriveClientStatus(closedLost({ paidAmount: 450 }), noOpen, now, noWon)).toBe('Past')
  })

  it('an open enquiry with paid history is still New — history is not an exit', () => {
    expect(deriveClientStatus(person({ paidAmount: 450 }), noOpen, now, noWon)).toBe('New')
  })
})

describe('issue 187 — the mapper carries the close', () => {
  const row: any = { id: 'l-1', location_id: 'loc-1', name: 'Mary', email: 'mary@email.com', phone: '', created_at: daysAgo(2), import_source: 'manual' }
  it('joined.last_closed_at → enquiryFacts.closedAts; engagement_count still maps through', () => {
    const p = mapLeadToPerson(row, { engagement_count: 1, last_closed_at: daysAgo(1) })
    expect(p.engagementCount).toBe(1)
    expect(p.enquiryFacts.closedAts).toEqual([daysAgo(1)])
    expect(mapLeadToPerson(row, {}).engagementCount).toBe(0)
    expect(deriveClientStatus(p, noOpen, now, noWon)).toBe('Nurturing')
  })
})

describe('issue 187 — board + Inbox agree with the derivation', () => {
  it('the board buckets a closed client under Nurturing, not New', () => {
    const html = renderToString(
      <ClientGroupedList people={[closedLost() as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('aria-label="Nurturing group"')
    expect(html).not.toContain('aria-label="New group"')
  })

  it('the Inbox worklist does not show a closed client', () => {
    const html = renderToString(
      <InboxScreen people={[closedLost() as any, person({ id: 'p-live', name: 'Riley Fontaine' }) as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('Riley Fontaine') // control: a live lead shows
    expect(html).not.toContain('Mary Sifain')
  })
})
