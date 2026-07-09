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
//   - ClientDirectory renders the green 'Client' chip + the won-history
//     detail line ("$4,400 · 2 Jobs"); a session Closed Won engagement
//     in the prop flips the row without wonEngagements
//   - InboxScreen: a won client never appears in the worklist (they are
//     a customer, not front-of-funnel)
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { deriveClientStatus, CLIENT_STATUS_ORDER, CLIENT_STATUS_META } from '@/components/hive/shared/clientStatus'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'
import { mapLeadToPerson } from '@/lib/people-mapper'
import ClientDirectory from '@/components/hive/ClientDirectory'
import InboxScreen from '@/components/hive/InboxScreen'

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
    expect(deriveClientStatus(p, new Set(), now)).toBe('Nurturing') // control
  })

  it('won beats the whole nurture funnel: New, Attempting, and NULL-everything', () => {
    // would-be New (recent, no outreach)
    const fresh = person({ created: daysAgo(3), wonEngagements: WON })
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

  it('only Closed Lost / no won engagement → existing nurture funnel, unchanged', () => {
    expect(deriveClientStatus(person({ created: daysAgo(3) }), new Set(), now)).toBe('New')
    expect(deriveClientStatus(person({
      outreachTimeline: [{ type: 'reach_out', occurred_at: daysAgo(5) }],
    }), new Set(), now)).toBe('Attempting')
    expect(deriveClientStatus(person(), new Set(), now)).toBe('Nurturing')
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

describe('ClientDirectory — Client rows', () => {
  it('renders the Client chip with the won-history detail line ($ value · jobs)', () => {
    const p = person({
      wonEngagements: WON,
      jobs: [{ id: 'j1' }, { id: 'j2' }],
    })
    const html = renderToString(
      <ClientDirectory people={[p as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('Dana Whitfield')
    expect(html).toContain('>Client<')
    expect(html).toContain('$4,400 · 2 Jobs')
  })

  it('a session Closed Won engagement flips the row to Client without a roll-up or reload', () => {
    const p = person() // no wonEngagements — pre-sweep person, just closed
    const html = renderToString(
      <ClientDirectory people={[p as any]} engagements={[{ id: 'e1', client_id: p.id, stage: 'Closed Won' } as any]} locFilter="all" />
    )
    expect(html).toContain('>Client<')
    // and the terminal row must NOT read as an open engagement
    expect(html).not.toContain('Open Engagement')
  })

  it('a won client is out of the Nurturing pool (falls to Client even when aged + never booked)', () => {
    const p = person({ wonEngagements: WON })
    expect(deriveClientStatus(p, new Set(), now)).not.toBe('Nurturing')
    const html = renderToString(
      <ClientDirectory people={[p as any]} engagements={[]} locFilter="all" />
    )
    expect(html).not.toContain('Never Booked') // the Nurturing detail line
  })
})

describe('InboxScreen — won clients are not front-of-funnel', () => {
  it('a recently-created won client does not appear in the worklist', () => {
    const wonFresh = person({ created: daysAgo(2), wonEngagements: WON })
    const lead = person({ id: 'p-lead-1', name: 'Riley Fontaine', created: daysAgo(2) })
    const html = renderToString(
      <InboxScreen people={[wonFresh as any, lead as any]} engagements={[]} locFilter="all" />
    )
    expect(html).toContain('Riley Fontaine') // control: real lead shows
    expect(html).not.toContain('Dana Whitfield')
  })
})
