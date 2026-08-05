// @vitest-environment happy-dom
// issue 187 — Closed Lost clients fall back into the Inbox.
//
// THE BUG: deriveClientStatus decided Inbox membership from lead AGE and
// recent outreach, not engagement outcome. Closing a client's only engagement
// to Closed Lost dropped them from openClientIds (the non-terminal set) but,
// with no won/paid history and a recent created_at, they derived straight back
// to 'New' — reappearing in the Inbox and the nav badge (both read the SAME
// derivation, via isInboxCountable → deriveClientStatus).
//
// THE FIX: person.engagementCount (all-engagements hydration roll-up). Past the
// open/won/paid checks, engagementCount > 0 means every engagement is a Closed
// Lost one — a decision someone made — so age must not re-derive them into
// New/Attempting. They settle to Nurturing instead: off the front-of-funnel,
// uncounted by the badge, still on the board in the marketable pool.
//
// Distinguishing closed-until-something-new from closed-FOREVER:
//   · engagementCount 0 (raw lead, no engagement — Sarah Watts) → untouched.
//   · a NEW/reopened engagement is OPEN → openClientIds → 'Active' first.
//   · Closed Won → 'Client' first; some-open-some-closed → 'Active' first.
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
  created: daysAgo(2), // fresh → would derive 'New' by age
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

const noOpen = new Set<string>()
const noWon = new Set<string>()

describe('issue 187 — settled-lost derivation', () => {
  it('a client whose only engagement is Closed Lost does NOT derive New or Attempting', () => {
    // engagementCount 1, not in openClientIds, no won, no paid → all-Closed-Lost.
    const lost = person({ engagementCount: 1 })
    expect(deriveClientStatus(lost, noOpen, now, noWon)).toBe('Nurturing')
  })

  it('age does not override the close: fresh created_at still settles', () => {
    const freshlyLost = person({ created: daysAgo(1), engagementCount: 1 })
    const s = deriveClientStatus(freshlyLost, noOpen, now, noWon)
    expect(s).not.toBe('New')
    expect(s).toBe('Nurturing')
  })

  it('recent outreach does not override the close either (settled beats Attempting)', () => {
    const lostButCalled = person({
      engagementCount: 1,
      outreachTimeline: [{ type: 'reach_out', occurred_at: daysAgo(3) }],
    })
    const s = deriveClientStatus(lostButCalled, noOpen, now, noWon)
    expect(s).not.toBe('Attempting')
    expect(s).toBe('Nurturing')
  })

  it('the nav badge / Inbox count does NOT count a settled-lost client', () => {
    const lost = person({ engagementCount: 1 })
    // isInboxCountable is the shared predicate behind BOTH the HiveShell badge
    // and the "N hidden by filters" strip — one assertion covers both surfaces.
    expect(isInboxCountable(lost, noOpen, noWon, now)).toBe(false)
    // control: the same row with no engagement on record IS countable (New).
    expect(isInboxCountable(person({ engagementCount: 0 }), noOpen, noWon, now)).toBe(true)
  })
})

describe('issue 187 — closed-UNTIL-something-new, never closed-forever', () => {
  it('a NEW/reopened engagement (OPEN) returns them to the worklist as Active', () => {
    const lost = person({ engagementCount: 1 })
    // Something new happened: an open engagement now exists for this client, so
    // openClientIds carries them → 'Active' (in motion), out of the settled band.
    const openIds = new Set([lost.id])
    expect(deriveClientStatus(lost, openIds, now, noWon)).toBe('Active')
  })

  it('a genuinely NEW lead (no engagement) still lands in the Inbox as New', () => {
    // The other comeback path: a brand-new lead row has engagementCount 0, so
    // the settled rule never applies and age derives 'New' — a real Inbox item.
    const brandNew = person({ engagementCount: 0, created: daysAgo(1) })
    expect(deriveClientStatus(brandNew, noOpen, now, noWon)).toBe('New')
    expect(isInboxCountable(brandNew, noOpen, noWon, now)).toBe(true)
  })
})

describe('issue 187 — cases that must stay exactly as they are', () => {
  it('Closed Won is unchanged (won outranks the settled rule)', () => {
    // via the live wonClientIds set...
    const wonLive = person({ engagementCount: 1 })
    expect(deriveClientStatus(wonLive, noOpen, now, new Set([wonLive.id]))).toBe('Client')
    // ...and via the hydrated roll-up.
    const wonRollup = person({ engagementCount: 1, wonEngagements: { count: 1, value: 0, lastClosedAt: daysAgo(20) } })
    expect(deriveClientStatus(wonRollup, noOpen, now, noWon)).toBe('Client')
  })

  it('some terminal + some open → still Active (only ALL-terminal settles)', () => {
    // Two engagements on record, one still open → openClientIds carries them.
    const mixed = person({ engagementCount: 2 })
    expect(deriveClientStatus(mixed, new Set([mixed.id]), now, noWon)).toBe('Active')
  })

  it('a lost client with paid history is Past, not Nurturing (Past outranks)', () => {
    const lostButPaid = person({ engagementCount: 1, paidAmount: 900 })
    expect(deriveClientStatus(lostButPaid, noOpen, now, noWon)).toBe('Past')
  })

  it('a client with NO engagement is unaffected by the settled rule', () => {
    // Sarah Watts: raw lead, nothing to close. Derives New/Attempting/Nurturing
    // by age+activity exactly as before the fix.
    expect(deriveClientStatus(person({ engagementCount: 0, created: daysAgo(2) }), noOpen, now, noWon)).toBe('New')
    expect(deriveClientStatus(person({ engagementCount: 0, created: daysAgo(200) }), noOpen, now, noWon)).toBe('Nurturing')
  })
})

describe('issue 187 — the mapper carries engagement_count → engagementCount', () => {
  const row: any = { id: 'l-9', location_id: 'loc-1', name: 'Jay Brunker', created_at: daysAgo(2) }
  it('maps the sweep count through, defaulting to 0 when absent', () => {
    expect(mapLeadToPerson(row, { engagement_count: 3 }).engagementCount).toBe(3)
    expect(mapLeadToPerson(row, {}).engagementCount).toBe(0)
  })
})

describe('issue 187 — board + Inbox agree with the derivation', () => {
  // The closed engagement is NOT in the open-only engagements prop (it settled
  // in a prior session / server-side auto-close — Lynette's KC cases). The
  // durable signal is person.engagementCount, so both surfaces read correctly
  // from person alone.
  it('the board buckets a settled-lost client under Nurturing, not New', () => {
    const lost = person({ engagementCount: 1 })
    const html = renderToString(
      <ClientGroupedList people={[lost as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('aria-label="Nurturing group"')
    expect(html).not.toContain('aria-label="New group"')
  })

  it('the Inbox worklist does not show a settled-lost client', () => {
    const lost = person({ engagementCount: 1 })
    const rawLead = person({ id: 'p-raw-1', name: 'Sarah Watts', engagementCount: 0, created: daysAgo(1) })
    const html = renderToString(
      <InboxScreen people={[lost as any, rawLead as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('Sarah Watts')   // control: a real raw lead still shows
    expect(html).not.toContain('Mary Sifain') // the settled-lost client is gone
  })
})
