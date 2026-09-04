// @vitest-environment node
//
// The Inbox rule (Kevin, 2026-09-03), built 2026-09-04.
//
//   An enquiry is in the Inbox until Send to Jobber, a Network move, or a
//   close. No 30-day clock. Founding an engagement does not remove anyone.
//   New vs Attempting = a reach-out logged since the enquiry.
//
// Pins, in Kevin's words:
//   · an enquiry with no exit stays in the Inbox at any age
//   · each of the three exits removes them
//   · founding an engagement does not
//   · a bare Jobber client id is not an exit
//   · a Network add is not an exit
//   · dismiss holds without being an exit
//   · New versus Attempting keys on a reach-out since the enquiry
//   · the badge and the list agree by construction
//   · oldest first in the New section
//
// Plus: the one shared helper (lib/enquiry-exit.ts) is what BOTH the Inbox
// derivation and the auto-close read, and the mapper ships the facts it needs.
import { describe, it, expect } from 'vitest'
import { enquiryState, factsFromRows, WEBFORM_RESUBMISSION_LABEL } from '@/lib/enquiry-exit'
import { deriveClientStatus, enquiryDateOf, isBackAgain, enquiryStateOf } from '@/components/hive/shared/clientStatus'
import { isInboxCountable } from '@/components/hive/shared/inboxCountable'
import { isSoftRemovedFromInbox } from '@/components/hive/shared/inboxSoftRemoval'
import { mapLeadToPerson } from '@/lib/people-mapper'
import { rollUpEngagements } from '@/lib/engagement-rollup'

const NOW = new Date('2026-09-04T12:00:00.000Z').getTime()
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString()

const facts = (over: Partial<Parameters<typeof enquiryState>[0]> = {}) => ({
  createdAt: daysAgo(400),
  importSource: 'manual',
  jobberRequestId: null,
  jobberJobId: null,
  resubmissionAts: [] as string[],
  reachOutAts: [] as string[],
  jobberWorkAts: [] as string[],
  networkMoved: false,
  closedAts: [] as string[],
  isJunk: false,
  ...over,
})

// A Person the way the hub page ships it: the mapper, fed raw rows.
const person = (row: any = {}, joined: any = {}) =>
  mapLeadToPerson(
    {
      id: 'L1', name: 'Ashley Devoto', email: 'a@example.com', phone: '', location_id: 'loc_nova', location_uuid: 'uuid-nova',
      created_at: daysAgo(400), import_source: 'manual', is_junk: false, ...row,
    } as any,
    joined,
  )

describe('lib/enquiry-exit — the one shared helper', () => {
  it('an enquiry with no exit is open at any age (400 days here)', () => {
    const st = enquiryState(facts())
    expect(st).toMatchObject({ isEnquiry: true, open: true, exit: null, reachedSince: false })
  })

  it('exit 1: a request, quote or job dated after the enquiry', () => {
    expect(enquiryState(facts({ jobberWorkAts: [daysAgo(10)] })).exit).toBe('jobber')
    // Work that predates the enquiry is old history, not an exit.
    expect(enquiryState(facts({ createdAt: daysAgo(30), jobberWorkAts: [daysAgo(200)] })).exit).toBe(null)
    // A stamped request / job id counts when there was no resubmission.
    expect(enquiryState(facts({ jobberRequestId: 'jr-1' })).exit).toBe('jobber')
    expect(enquiryState(facts({ jobberJobId: 'jj-1' })).exit).toBe('jobber')
  })

  it('a bare Jobber client id is NOT an exit (the import stamps one on adopted website leads)', () => {
    // Nothing in the facts carries the client id at all — it has no say.
    const st = enquiryState(facts())
    expect(st.open).toBe(true)
  })

  it('exit 2: a Network MOVE; an "add" is not an exit', () => {
    expect(enquiryState(facts({ networkMoved: true })).exit).toBe('network')
    expect(enquiryState(facts({ networkMoved: false })).exit).toBe(null)
    // factsFromRows: is_customer true (an add) does not set networkMoved.
    const f = factsFromRows({ lead: { created_at: daysAgo(3), import_source: 'manual' }, networkMoved: false })
    expect(f.networkMoved).toBe(false)
  })

  it('exit 3: a close after the enquiry; a close BEFORE a resubmission is not one; junk is', () => {
    expect(enquiryState(facts({ closedAts: [daysAgo(5)] })).exit).toBe('closed')
    // Jobber client closed Lost on import in July, form again in August: open.
    const st = enquiryState(facts({ importSource: 'jobber_initial', closedAts: [daysAgo(60)], resubmissionAts: [daysAgo(20)] }))
    expect(st).toMatchObject({ isEnquiry: true, open: true, exit: null })
    expect(st.enquiryAt).toBe(new Date(daysAgo(20)).getTime())
    expect(enquiryState(facts({ isJunk: true })).exit).toBe('junk')
  })

  it('exit 4: no email AND no phone leaves the worklist but not the auto-close — open stays true, inbox is false', () => {
    const st = enquiryState(facts({ email: '', phone: null }))
    expect(st).toMatchObject({ isEnquiry: true, exit: null, open: true, reachable: false, inbox: false })
    expect(enquiryState(facts({ email: 'a@b.c' })).inbox).toBe(true)
    expect(enquiryState(facts({ phone: '555' })).inbox).toBe(true)
  })

  it('a Jobber-originated lead with no resubmission is not an enquiry at all', () => {
    const st = enquiryState(facts({ importSource: 'jobber_webhook' }))
    expect(st.isEnquiry).toBe(false)
    expect(st.open).toBe(false)
  })

  it('New vs Attempting: a reach-out since the enquiry, not within any window', () => {
    expect(enquiryState(facts({ reachOutAts: [daysAgo(300)] })).reachedSince).toBe(true)
    // Reached before the form came in again → not since THIS enquiry.
    expect(enquiryState(facts({ resubmissionAts: [daysAgo(10)], reachOutAts: [daysAgo(30)] })).reachedSince).toBe(false)
  })

  it('factsFromRows assembles from raw rows: resubmissions, reach-outs, child rows, closes', () => {
    const f = factsFromRows({
      lead: { created_at: daysAgo(100), import_source: 'jobber_initial', jobber_request_id: 'jr-old' },
      touchpoints: [
        { kind: 'system', label: WEBFORM_RESUBMISSION_LABEL, occurred_at: daysAgo(10) },
        { kind: 'reach_out', occurred_at: daysAgo(5) },
        { kind: 'system', label: 'Transferred in', occurred_at: daysAgo(90) },
      ],
      service_requests: [{ requested_at: daysAgo(95), created_at: daysAgo(95) }],
      quotes: [{ created_at: daysAgo(94) }],
      jobs: [],
      engagements: [{ stage: 'Closed Won', closed_at: daysAgo(80) }, { stage: 'Request', closed_at: null }],
      networkMoved: false,
    })
    expect(f.resubmissionAts).toEqual([daysAgo(10)])
    expect(f.reachOutAts).toEqual([daysAgo(5)])
    expect(f.jobberWorkAts).toEqual([daysAgo(95), daysAgo(94)])
    expect(f.closedAts).toEqual([daysAgo(80)])
    // …and the state: the old request id is ignored because she resubmitted; open, Attempting.
    expect(enquiryState(f)).toMatchObject({ isEnquiry: true, open: true, reachedSince: true })
  })
})

describe('deriveClientStatus — the Inbox rule on a mapped Person', () => {
  it('an enquiry with no exit is New at any age; a reach-out since makes it Attempting', () => {
    const p = person()
    expect(deriveClientStatus(p, new Set(), NOW, new Set())).toBe('New')
    const reached = person({}, { touchpoints: [{ id: 't1', kind: 'reach_out', occurred_at: daysAgo(200) }] })
    expect(deriveClientStatus(reached, new Set(), NOW, new Set())).toBe('Attempting')
  })

  it('a reach-out logged THIS SESSION (layered onto outreachTimeline) flips New → Attempting live', () => {
    const p = person()
    p.outreachTimeline = [...p.outreachTimeline, { id: 'live', type: 'reach_out', occurred_at: daysAgo(0) }]
    expect(deriveClientStatus(p, new Set(), NOW, new Set())).toBe('Attempting')
  })

  it('founding an engagement does not remove anyone: an open manual engagement stays New', () => {
    const p = person()
    // openClientIds is what Active used to key on — it no longer outranks an open enquiry.
    expect(deriveClientStatus(p, new Set(['L1']), NOW, new Set())).toBe('New')
  })

  it('each exit removes them: request/quote/job, Network move, close', () => {
    expect(deriveClientStatus(person({}, { service_requests: [{ created_at: daysAgo(1) }] }), new Set(['L1']), NOW, new Set())).toBe('Active')
    expect(deriveClientStatus(person({}, { network_moved: true }), new Set(), NOW, new Set())).toBe('Nurturing')
    expect(deriveClientStatus(person({}, { last_closed_at: daysAgo(2) }), new Set(), NOW, new Set())).toBe('Nurturing')
    expect(deriveClientStatus(person({}, { last_closed_at: daysAgo(2), won_summary: { count: 1, value: 300, lastClosedAt: daysAgo(2) } }), new Set(), NOW, new Set())).toBe('Client')
  })

  it('a bare Jobber client id is not an exit: an adopted website lead stays New', () => {
    const p = person({ jobber_client_id: 'JC-123' })
    expect(p.jobberRef).toBe('JC-123')
    expect(deriveClientStatus(p, new Set(), NOW, new Set())).toBe('New')
  })

  it('a stamped request id IS exit 1; a fresh send this session (REQ-… ref) is exit 1 before the refetch', () => {
    expect(deriveClientStatus(person({ jobber_request_id: 'jr-9' }), new Set(), NOW, new Set())).toBe('Nurturing')
    const p = person()
    p.jobberRef = 'REQ-optimistic'
    expect(deriveClientStatus(p, new Set(), NOW, new Set())).toBe('Nurturing')
  })

  it('a close this session (the Inbox passes closedLostIds) removes them before the refetch', () => {
    const p = person()
    expect(deriveClientStatus(p, new Set(), NOW, new Set(), { closedIds: new Set(['L1']) })).toBe('Nurturing')
  })

  it('a Jobber-originated client with no resubmission is never New: West Raleigh\'s rows leave', () => {
    const p = person({ import_source: 'jobber_webhook', created_at: daysAgo(3), jobber_client_id: 'JC-1' })
    expect(deriveClientStatus(p, new Set(), NOW, new Set())).toBe('Nurturing')
    expect(deriveClientStatus(p, new Set(['L1']), NOW, new Set())).toBe('Active')
  })

  it('a returning client (Jobber origin) who fills in the form again is New from the form; the chip is Back again', () => {
    const p = person(
      { import_source: 'jobber_initial', created_at: daysAgo(400), jobber_client_id: 'JC-1' },
      { touchpoints: [{ id: 't', kind: 'system', label: WEBFORM_RESUBMISSION_LABEL, occurred_at: daysAgo(4) }], last_closed_at: daysAgo(200) },
    )
    expect(deriveClientStatus(p, new Set(), NOW, new Set())).toBe('New')
    expect(isBackAgain(p)).toBe(true)
    expect(enquiryDateOf(p)).toBe(daysAgo(4))
    // A fresh lead's duplicate form is NOT "Back again": no history with us.
    const fresh = person({}, { touchpoints: [{ id: 't', kind: 'system', label: WEBFORM_RESUBMISSION_LABEL, occurred_at: daysAgo(1) }] })
    expect(isBackAgain(fresh)).toBe(false)
  })

  it('no 30-day clock anywhere: created 400 days ago with nothing else is New, not Nurturing', () => {
    expect(deriveClientStatus(person({ created_at: daysAgo(400) }), new Set(), NOW, new Set())).toBe('New')
  })

  it('an unreachable enquiry is no_contact, never New, and does not count for the badge (exit 4)', () => {
    const dark = person({ email: '', phone: '' })
    expect(deriveClientStatus(dark, new Set(), NOW, new Set())).toBe('no_contact')
    expect(isInboxCountable(dark, new Set(), new Set(), NOW)).toBe(false)
  })

  it('exited people keep the directory bands: no_contact, Active, Client, Past, Nurturing', () => {
    const exited = (row: any = {}, joined: any = {}) => person({ import_source: 'jobber_initial', ...row }, joined)
    expect(deriveClientStatus(exited({ email: '', phone: '' }), new Set(), NOW, new Set())).toBe('no_contact')
    expect(deriveClientStatus(exited(), new Set(['L1']), NOW, new Set())).toBe('Active')
    expect(deriveClientStatus(exited(), new Set(), NOW, new Set(['L1']))).toBe('Client')
    expect(deriveClientStatus(exited({ paid_amount: 120 }), new Set(), NOW, new Set())).toBe('Past')
    expect(deriveClientStatus(exited(), new Set(), NOW, new Set())).toBe('Nurturing')
  })
})

describe('dismiss holds; the badge and the list agree by construction', () => {
  it('dismiss and snooze hide the row without changing its status', () => {
    const dismissed = person({ inbox_dismissed_at: daysAgo(1) })
    expect(deriveClientStatus(dismissed, new Set(), NOW, new Set())).toBe('New')
    expect(isSoftRemovedFromInbox(dismissed, NOW)).toBe(true)
    expect(isInboxCountable(dismissed, new Set(), new Set(), NOW)).toBe(false)
    // Un-dismiss (the null write) and the same person counts again — no exit happened.
    const back = person({ inbox_dismissed_at: null })
    expect(isInboxCountable(back, new Set(), new Set(), NOW)).toBe(true)
  })

  it('isInboxCountable is the one predicate: New/Attempting from deriveClientStatus AND not soft-removed', () => {
    const p = person()
    const s = deriveClientStatus(p, new Set(), NOW, new Set())
    expect(isInboxCountable(p, new Set(), new Set(), NOW)).toBe(s === 'New' || s === 'Attempting')
    const sent = person({ jobber_request_id: 'jr-1' })
    expect(isInboxCountable(sent, new Set(), new Set(), NOW)).toBe(false)
  })
})

describe('the mapper ships the facts; the roll-up ships the close', () => {
  it('person.enquiryFacts carries created, source, ids, resubmissions, child-row dates, close and Network move', () => {
    const p = person(
      { jobber_request_id: null, jobber_job_id: 'jj-2' },
      {
        touchpoints: [{ id: 't', kind: 'system', label: WEBFORM_RESUBMISSION_LABEL, occurred_at: daysAgo(9) }],
        service_requests: [{ created_at: daysAgo(50) }], quotes: [{ created_at: daysAgo(40) }], jobs: [{ created_at: daysAgo(30) }],
        last_closed_at: daysAgo(60), network_moved: true,
      },
    )
    expect(p.enquiryFacts).toMatchObject({
      importSource: 'manual', jobberJobId: 'jj-2', resubmissionAts: [daysAgo(9)],
      jobberWorkAts: [daysAgo(50), daysAgo(40), daysAgo(30)], closedAts: [daysAgo(60)], networkMoved: true,
    })
    expect(enquiryStateOf(p).exit).toBe('network')
  })

  it('rollUpEngagements carries last_closed_at (the newest terminal close) alongside won_summary', () => {
    const r = rollUpEngagements([
      { stage: 'Closed Lost', closed_at: daysAgo(30) },
      { stage: 'Closed Won', closed_at: daysAgo(10), total_paid: 200 },
      { stage: 'Request', closed_at: null },
    ])
    expect(r.last_closed_at).toBe(daysAgo(10))
    expect(r.won_summary?.count).toBe(1)
    expect(r.engagement_count).toBe(3)
    expect((r as any).open_enquiry).toBeUndefined()
  })
})
