// @vitest-environment happy-dom
// People-side 'Client' (won) status — the derivation must consider
// ENGAGEMENT OUTCOMES, not just the (mostly-NULL) leads.client_status
// column. Covers:
//   - a client with a Closed Won engagement derives 'Client', NOT
//     Nurturing — even with no paid roll-up and nothing stored
//   - both won inputs work: the hydrated person.wonEngagements roll-up
//     (hub-page sweep) AND the live wonClientIds set (session close),
//     so the status never depends on the backfill having run
//   - precedence: no_contact > Active (open engagement) > Client (won)
//     > Past > nurture funnel; won beats New/Attempting/Nurturing
//   - clients with only Closed Lost / no won engagement keep the
//     existing nurture-funnel derivation
//   - mapper: won_summary joined data → person.wonEngagements (null
//     when absent)
//   - ClientGroupedList buckets a won client into the 'Client' band; a
//     session Closed Won engagement in the prop flips the band without
//     wonEngagements (the flat ClientDirectory variant retired, #136)
//   - InboxScreen: a won client never appears in the worklist (they are
//     a customer, not front-of-funnel)
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { deriveClientStatus, enquiryDateOf, isBackAgain, CLIENT_STATUS_ORDER, CLIENT_STATUS_META } from '@/components/hive/shared/clientStatus'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'
import { mapLeadToPerson } from '@/lib/people-mapper'
import ClientGroupedList from '@/components/hive/ClientGroupedList'
import InboxScreen from '@/components/hive/InboxScreen'
import { rollUpEngagements } from '@/lib/engagement-rollup'

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'p-won-1',
  name: 'Dana Whitfield',
  email: 'dana@email.com',
  phone: '(479) 555-0142',
  locationId: 'loc-uuid-1',
  created: daysAgo(200), // aged out of New
  paidAmount: null,      // the import join gap: won but no paid roll-up
  outreachTimeline: [],
  jobs: [],
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  wonEngagements: null,
  engagementCount: 0, // issue 187: raw lead, no engagement on record (default)
  ...over,
})

const WON = { count: 2, value: 4400, lastClosedAt: daysAgo(40) }

describe('deriveClientStatus — Client (won) status', () => {
  it('a client with a Closed Won engagement derives Client, not Nurturing (NULL client_status path)', () => {
    const p = person({ wonEngagements: { count: 1, value: 0, lastClosedAt: daysAgo(90) } })
    expect(deriveClientStatus(p, new Set(), now)).toBe('Client')
  })

  it('the live wonClientIds set alone flips to Client (no roll-up, no backfill)', () => {
    const p = person() // wonEngagements null
    expect(deriveClientStatus(p, new Set(), now, new Set([p.id]))).toBe('Client')
    expect(deriveClientStatus(p, new Set(), now)).toBe('New') // control: an open enquiry, no exit, no clock
  })

  it('won beats the whole nurture funnel: New, Attempting, and NULL-everything', () => {
    // would-be New (recent, no outreach) — the win closed AFTER the enquiry,
    // which is exit 3. (A win that predates a NEW enquiry is old history: that
    // person is back in the Inbox, by the rule.)
    const fresh = person({ created: daysAgo(3), wonEngagements: { ...WON, lastClosedAt: daysAgo(1) } })
    expect(deriveClientStatus(fresh, new Set(), now)).toBe('Client')
    // would-be Attempting (recent reach_out)
    const worked = person({
      wonEngagements: WON,
      outreachTimeline: [{ type: 'reach_out', occurred_at: daysAgo(5) }],
    })
    expect(deriveClientStatus(worked, new Set(), now)).toBe('Client')
  })

  it('won beats Past (paid roll-up present) but an OPEN engagement still reads Active', () => {
    const paid = person({ paidAmount: 1200, wonEngagements: WON })
    expect(deriveClientStatus(paid, new Set(), now)).toBe('Client')
    // repeat business: won before, open engagement now → Active (in motion)
    expect(deriveClientStatus(paid, new Set([paid.id]), now)).toBe('Active')
  })

  it('no_contact still outranks everything — a won row with no reachable info needs fixing', () => {
    const dark = person({ email: '', phone: '', wonEngagements: WON })
    expect(deriveClientStatus(dark, new Set(), now)).toBe('no_contact')
  })

  it('a RAW lead (no engagement on record) is an open enquiry at any age: New, or Attempting once called', () => {
    // No clock (Inbox rule, 2026-09-03): a 200-day-old untouched lead is still
    // New — nothing ever took it out (Sarah Watts stays a real Inbox lead).
    expect(deriveClientStatus(person({ created: daysAgo(3) }), new Set(), now)).toBe('New')
    expect(deriveClientStatus(person({
      outreachTimeline: [{ type: 'reach_out', occurred_at: daysAgo(5) }],
    }), new Set(), now)).toBe('Attempting')
    expect(deriveClientStatus(person(), new Set(), now)).toBe('New')
  })

  it('Client is a first-class status: in the order, the meta, and the green chip family', () => {
    expect(CLIENT_STATUS_ORDER).toContain('Client')
    expect(CLIENT_STATUS_META.Client).toEqual({ label: 'Client', styleKey: 'Client' })
    expect(CHIP_STYLES['Client']).toBeTruthy()
    expect(CHIP_STYLES['Client']).toEqual(CHIP_STYLES.green)
  })
})

describe('people-mapper — won_summary → person.wonEngagements', () => {
  const row: any = { id: 'l-1', location_id: 'loc-1', name: 'Dana', created_at: daysAgo(200) }
  it('ships the roll-up when present, null when absent', () => {
    expect(mapLeadToPerson(row, { won_summary: WON }).wonEngagements).toEqual(WON)
    expect(mapLeadToPerson(row, {}).wonEngagements).toBeNull()
  })
})

describe('ClientGroupedList — Client band', () => {
  it('buckets a won client into the Client band (hydrated wonEngagements roll-up)', () => {
    const p = person({
      wonEngagements: WON,
      jobs: [{ id: 'j1' }, { id: 'j2' }],
    })
    const html = renderToString(
      <ClientGroupedList people={[p as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('aria-label="Client group"')
    expect(html).not.toContain('aria-label="Nurturing group"')
  })

  it('a session Closed Won engagement flips the band to Client without a roll-up or reload', () => {
    const p = person() // no wonEngagements — pre-sweep person, just closed
    const html = renderToString(
      <ClientGroupedList people={[p as any]} engagements={[{ id: 'e1', client_id: p.id, stage: 'Closed Won' } as any]} locFilter="all" />
    )
    expect(html).toContain('aria-label="Client group"')
    // and the terminal engagement must NOT read as open (no Active band)
    expect(html).not.toContain('aria-label="Active group"')
  })

  it('a won client is out of the Nurturing pool (falls to Client even when aged + never booked)', () => {
    const p = person({ wonEngagements: WON })
    expect(deriveClientStatus(p, new Set(), now)).not.toBe('Nurturing')
    const html = renderToString(
      <ClientGroupedList people={[p as any]} engagements={[]} locFilter="all" />
    )
    expect(html).not.toContain('aria-label="Nurturing group"')
  })
})

// issue 207 — every rendered status band carries its one-line definition, and
// the copy matches the verified derivation rules (a won client's band says
// "paid for work", an aged never-booked client's Nurturing band says "no job on
// the go", and neither claims the row came from the Jobber import).
describe('ClientGroupedList — status definitions (issue 207)', () => {
  it('renders the four owner-facing definitions under their bands', () => {
    // one client in each of New, Nurturing, Active, Client
    const fresh   = person({ id: 'c-new',  name: 'Ada New',    created: daysAgo(2) })                 // New (an open enquiry)
    const aged    = person({ id: 'c-nurt', name: 'Bo Nurture', created: daysAgo(200), importSource: 'jobber_initial' }) // Nurturing (a Jobber client, never booked)
    const active  = person({ id: 'c-act',  name: 'Cy Active',  created: daysAgo(200), importSource: 'jobber_initial', jobberRef: '77' }) // Active (open engagement below)
    const wonC    = person({ id: 'c-won',  name: 'Di Client',  created: daysAgo(200), wonEngagements: WON }) // Client
    const html = renderToString(
      <ClientGroupedList
        people={[fresh, aged, active, wonC] as any}
        engagements={[{ id: 'e1', client_id: 'c-act', stage: 'Requested' } as any]}
        locFilter="all"
      />
    )
    expect(html).toContain('Just arrived, and nobody')                 // New (apostrophe HTML-escaped downstream)
    expect(html).toContain('No job on the go right now')               // Nurturing
    expect(html).toContain('The same people as your Engagements board') // Active
    expect(html).toContain('been paid for work')                      // Client
    // and the copy stays honest — Nurturing must NOT claim import provenance
    expect(html).not.toContain('import')
  })

  it('the Active definition rides the Active band, not Nurturing', () => {
    const active = person({ id: 'c-act', name: 'Cy Active', created: daysAgo(200), importSource: 'jobber_initial', jobberRef: '77' })
    const html = renderToString(
      <ClientGroupedList
        people={[active] as any}
        engagements={[{ id: 'e1', client_id: 'c-act', stage: 'Quoted' } as any]}
        locFilter="all"
      />
    )
    expect(html).toContain('aria-label="Active group"')
    expect(html).toContain('a request, assessment, quote or job under way')
    expect(html).not.toContain('aria-label="Nurturing group"')
  })
})

describe('InboxScreen — won clients are not front-of-funnel', () => {
  it('a won client (the win closed AFTER their enquiry) does not appear in the worklist', () => {
    const wonFresh = person({ created: daysAgo(200), wonEngagements: WON })
    const lead = person({ id: 'p-lead-1', name: 'Riley Fontaine', created: daysAgo(2) })
    const html = renderToString(
      <InboxScreen people={[wonFresh as any, lead as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('Riley Fontaine') // control: real lead shows
    expect(html).not.toContain('Dana Whitfield')
  })
})

// ─── "Back again" under the Inbox rule (2026-09-04) ─────────────────────────
//
// Natalie Miller, Seattle: Jobber-imported Apr 2025, one Closed Won engagement
// (paid), then the website form again → a 'Webform resubmission' touchpoint.
// The rule: the form is a new ENQUIRY; she is in the Inbox from the form until
// Send to Jobber, a Network move, or a close — no clock, and the Request
// engagement the intake founds does not remove her. The chip keys on the
// resubmission touchpoint itself (isBackAgain), not on any derivation.
const RESUB_AT = daysAgo(2)
const natalie = (over: any = {}) => person({
  id: 'p-natalie',
  name: 'Natalie Miller',
  created: daysAgo(514),          // the lead row is old — that is the point
  importSource: 'jobber_initial',
  paidAmount: 1179.93,
  wonEngagements: { count: 1, value: 1179.93, lastClosedAt: '2025-04-25T12:00:00Z' },
  engagementCount: 2,
  jobberRef: '105014594',
  outreachTimeline: [{ id: 't-resub', type: 'system', label: 'Webform resubmission', occurred_at: RESUB_AT }],
  ...over,
})
const NATALIE_OPEN = new Set(['p-natalie'])

describe('deriveClientStatus — "Back again": a returning website enquiry is in the Inbox until an exit', () => {
  it('no reach-out since the form → New, anchored on the ENQUIRY (the resubmission), not the 2025 lead row', () => {
    expect(deriveClientStatus(natalie(), NATALIE_OPEN, now)).toBe('New')
    expect(enquiryDateOf(natalie())).toBe(RESUB_AT)
    // a reach-out BEFORE the form is old news — still New
    const stale = natalie({ outreachTimeline: [...natalie().outreachTimeline, { type: 'reach_out', occurred_at: daysAgo(10) }] })
    expect(deriveClientStatus(stale, NATALIE_OPEN, now)).toBe('New')
  })

  it('a reach-out on/after the form → Attempting', () => {
    const p = natalie({ outreachTimeline: [...natalie().outreachTimeline, { type: 'reach_out', occurred_at: daysAgo(1) }] })
    expect(deriveClientStatus(p, NATALIE_OPEN, now)).toBe('Attempting')
  })

  it('the founded Request engagement does not remove her; a second open engagement does not either (no clock, no exception)', () => {
    expect(deriveClientStatus(natalie(), NATALIE_OPEN, now)).toBe('New')
    expect(deriveClientStatus(natalie(), new Set(), now)).toBe('New')
  })

  it('an enquiry 31 days old is still New — there is no 30-day window', () => {
    const old = natalie({ outreachTimeline: [{ id: 't', type: 'system', label: 'Webform resubmission', occurred_at: daysAgo(31) }] })
    expect(deriveClientStatus(old, NATALIE_OPEN, now)).toBe('New')
  })

  it('a close this session (the live wonClientIds set) is exit 3 → Client, before the refetch', () => {
    expect(deriveClientStatus(natalie(), new Set(), now, new Set(['p-natalie']))).toBe('Client')
  })

  it('a send this session (optimistic REQ- ref) is exit 1 → she leaves the funnel and reads Active with the engagement open', () => {
    expect(deriveClientStatus(natalie({ jobberRef: 'REQ-1' }), NATALIE_OPEN, now)).toBe('Active')
  })

  it('the same Jobber client WITHOUT a resubmission is not an enquiry: Active on the Board only', () => {
    expect(deriveClientStatus(natalie({ outreachTimeline: [] }), NATALIE_OPEN, now)).toBe('Active')
    expect(deriveClientStatus(natalie({ outreachTimeline: [] }), new Set(), now)).toBe('Client')
  })

  it('isBackAgain keys on the resubmission touchpoint plus history with us — a fresh lead\'s duplicate form is not Back again', () => {
    expect(isBackAgain(natalie())).toBe(true)
    expect(isBackAgain(natalie({ outreachTimeline: [] }))).toBe(false)
    const fresh = person({ id: 'p-fresh', importSource: 'manual', wonEngagements: null, paidAmount: null,
      outreachTimeline: [{ type: 'system', label: 'Webform resubmission', occurred_at: daysAgo(1) }] })
    expect(isBackAgain(fresh)).toBe(false)
  })
})

describe('rollUpEngagements — last_closed_at (exit 3) alongside the existing roll-ups', () => {
  const REQ = { id: 'e-req', stage: 'Request', created_at: '2026-09-01T20:06:19Z' }
  const WON_E = { id: 'e-won', stage: 'Closed Won', created_at: '2025-04-07T16:17:00Z', closed_at: '2025-04-25T00:00:00Z', total_paid: 1179.93 }
  const LOST = { id: 'e-lost', stage: 'Closed Lost', created_at: '2026-07-01T00:00:00Z', closed_at: '2026-08-10T21:29:04Z' }

  it('carries the newest terminal close, whichever way it closed', () => {
    const r = rollUpEngagements([WON_E, REQ, LOST])
    expect(r.engagement_count).toBe(3)
    expect(r.won_summary?.count).toBe(1)
    expect(r.last_closed_at).toBe('2026-08-10T21:29:04Z')
    expect(rollUpEngagements([REQ]).last_closed_at).toBeNull()
    expect(rollUpEngagements(null).last_closed_at).toBeNull()
  })
})

describe('mapper — joined.last_closed_at / network_moved → person.enquiryFacts', () => {
  const row = { id: 'l1', location_uuid: 'loc', location_id: 'loc_x', name: 'N', created_at: '2025-04-07T00:00:00Z', import_source: 'jobber_initial' } as any

  it('the facts ride the person; absent joins read as no exit', () => {
    const p = mapLeadToPerson(row, { last_closed_at: '2026-08-10T21:29:04Z', network_moved: true })
    expect(p.enquiryFacts).toMatchObject({ importSource: 'jobber_initial', closedAts: ['2026-08-10T21:29:04Z'], networkMoved: true })
    expect(mapLeadToPerson(row, {}).enquiryFacts).toMatchObject({ closedAts: [], networkMoved: false })
    expect((mapLeadToPerson(row, {}) as any).openEnquiry).toBeUndefined()
  })
})

describe('InboxScreen — a "Back again" row', () => {
  const OPEN_ENG = [{ id: 'e-req', client_id: 'p-natalie', stage: 'Request', created_at: daysAgo(2) } as any]

  it('shows Natalie in Working with the Back again chip and the one history line', () => {
    const p = natalie({ outreachTimeline: [...natalie().outreachTimeline, { type: 'reach_out', occurred_at: daysAgo(1) }] })
    const html = renderToString(
      <InboxScreen people={[p as any]} engagements={OPEN_ENG} locFilter="all" />
    )
    expect(html).toContain('Natalie Miller')
    expect(html).toContain('Back again')
    expect(html).toContain('Worked with you Apr 2025')
    expect(html).not.toContain('No request details yet')
    // nothing else on that line: no value, no project type
    expect(html).not.toContain('1,179')
  })

  it('a form message wins the request-detail slot over the history line', () => {
    const p = natalie({ jobDetail: 'Garage and basement this time' })
    const html = renderToString(
      <InboxScreen people={[p as any]} engagements={OPEN_ENG} locFilter="all" />
    )
    expect(html).toContain('Garage and basement this time')
    expect(html).not.toContain('Worked with you')
    expect(html).toContain('Back again')
  })

  it('without a resubmission the same Jobber client stays off the worklist', () => {
    const html = renderToString(
      <InboxScreen people={[natalie({ outreachTimeline: [] }) as any]} engagements={OPEN_ENG} locFilter="all" />
    )
    expect(html).not.toContain('Natalie Miller')
    expect(html).not.toContain('Back again')
  })
})
