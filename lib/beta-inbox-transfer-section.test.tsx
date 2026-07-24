// @vitest-environment happy-dom
//
// Inbox "Needs transfer" section — corp/admin routes loc_other global-form
// leads to a real location, from a section that sits ABOVE New/Attempting.
// Since Fix 2 Phase 2 the queue arrives on its OWN prop (transferPeople),
// fetched outside the selected location scope — server-side scoping loads one
// location and loc_other is never that location, so deriving it from `people`
// meant the queue silently emptied the moment any location was picked.
//
// Pins:
//   · the section renders when the queue is non-empty, ABOVE New/Attempting,
//     and it renders in EVERY scope (the Phase 2 property); it is absent for a
//     non-elevated viewer because HiveScreen hands them an empty queue
//   · a loc_other lead shows its ORIGIN (city, ST zip · project · from global
//     form) and is EXCLUDED from New (it appears once, in Needs transfer)
//   · the row's ONLY action is the Route pill — no log-call / Send-to-Jobber
//     / ··· cluster, since none of those apply to a lead being routed away —
//     and it opens the same TransferLeadModal the card does
//
// Option A (this pass): the queue was a card in the SAME stack as the selected
// location's leads, separated by a 3px edge accent — so unrouted leads read as
// that location's new leads sitting on top of its list. It now has its own
// tinted CORPORATE container with a header that says whose they are, the
// location's own New section is named for the location, and the row action
// reads "Route" (they have no home to be moved FROM) in the sand family rather
// than the teal action accent. Presentation only — the second describe below
// pins that the write is byte-identical.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import { T } from '@/components/hive/shared/tokens'

// The DOM normalizes colors (hex in → rgb() out), so compare a token to a
// rendered value by pushing the token through the same normalizer.
const asRendered = (prop: 'background' | 'color', value: string) => {
  const probe = document.createElement('div')
  probe.style[prop] = value
  return probe.style[prop]
}

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  phoneNormalized: '5615550199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3),
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  atLocOther: false,
  originCity: null, originState: null, originZip: null, project: '',
  ...over,
})

const locOtherLead = (over: any = {}) => person({
  name: 'Global Lead', locationId: 'loc-other-uuid', atLocOther: true,
  originCity: 'Austin', originState: 'TX', originZip: '78701', project: 'Garage',
  ...over,
})

const installFetch = () => {
  const mock = vi.fn(async (url: any) => {
    if (String(url).includes('/api/locations/transfer-targets')) {
      return { ok: true, status: 200, json: async () => ({ targets: [
        { id: 'dest-active', name: 'Boulder', slug: 'boulder-01', lifecycle_status: 'active', owner_name: 'Dana Lee' },
      ] }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  ;(globalThis as any).fetch = mock as any
  return mock
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const flush = async () => {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => { installFetch() })

const sectionLabels = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('p'))
    .map(p => (p.textContent || ''))
    .filter(t => /Not yet routed|^New ·|New ·|Attempting ·/.test(t))

describe('Inbox — Needs transfer section', () => {
  it('renders the section ABOVE New when a loc_other lead is in scope', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person()]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const text = host.textContent || ''
    expect(text).toContain('Needs transfer')
    // ordering: the unrouted queue's header precedes the New banner in the DOM
    const labels = sectionLabels(host)
    const transferIdx = labels.findIndex(t => t.includes('Not yet routed'))
    const newIdx = labels.findIndex(t => t.startsWith('New'))
    expect(transferIdx).toBeGreaterThanOrEqual(0)
    expect(newIdx).toBeGreaterThan(transferIdx)
    await unmount()
  })

  it('shows the loc_other lead origin, and excludes it from New (New counts only the normal lead)', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person({ name: 'Normal New' })]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    expect(host.textContent).toContain('Austin, TX 78701')
    expect(host.textContent).toContain('from global form')
    // New section shows count of 1 (only the normal lead) — the loc_other
    // lead lives solely under Needs transfer.
    const newLabel = Array.from(host.querySelectorAll('p')).map(p => p.textContent || '').find(t => t.startsWith('New ·'))
    expect(newLabel).toContain('New · 1 ·')
    await unmount()
  })

  it('is ABSENT for a franchise-scoped view (HiveScreen sends an empty queue)', async () => {
    // The gate moved: it used to be "a franchise scope never contains
    // loc_other rows". Now the queue is fetched OUTSIDE the location scope, so
    // the gate is the empty array HiveScreen passes for a non-elevated viewer
    // (which also covers view-as, where the server session is still elevated
    // and the prop would otherwise arrive populated).
    const { host, unmount } = await mount(
      <InboxScreen people={[person(), person({ name: 'Another' })]} transferPeople={[]} engagements={[]} locFilter="loc-uuid-1" />,
    )
    expect(host.textContent).not.toContain('Needs transfer')
    await unmount()
  })

  it('SURVIVES a location scope — the Phase 2 property', async () => {
    // THE regression this whole change exists to prevent. Before Fix 2 Phase 2
    // the queue was filtered out of the location-scoped people array, so
    // picking any real location silently emptied Leslie's routing queue: the
    // unrouted leads still existed, the surface just stopped mentioning them.
    // A loc_other lead's locationId can NEVER equal the selected location, so
    // if this ever renders empty the queue has been re-coupled to the scope.
    const { host, unmount } = await mount(
      <InboxScreen
        people={[person()]}
        transferPeople={[locOtherLead()]}
        engagements={[]}
        locFilter="loc-uuid-1"
      />,
    )
    expect(host.textContent).toContain('Needs transfer')
    expect(host.textContent).toContain('Austin, TX 78701')
    await unmount()
  })

  it('does not double-render on an all-locations load (row in BOTH arrays)', async () => {
    // On 'all' the server leaves loc_other rows in `people` AND ships them in
    // transferPeople. The people loop drops them so they appear exactly once.
    const dupe = locOtherLead({ name: 'Only Once' })
    const { host, unmount } = await mount(
      <InboxScreen people={[dupe, person()]} transferPeople={[dupe]} engagements={[]} locFilter="all" />,
    )
    const rows = Array.from(host.querySelectorAll('.bee-inbox-row'))
      .filter(r => (r.textContent || '').includes('Only Once'))
    expect(rows).toHaveLength(1)
    await unmount()
  })

  it('opens the transfer modal from the row Transfer pill', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const transferBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Route')
    expect(transferBtn).toBeTruthy()
    await act(async () => { transferBtn!.click() })
    await flush()
    const dlg = document.querySelector('[role="dialog"][aria-label="Transfer lead"]')
    expect(dlg).toBeTruthy()
    await unmount()
  })

  it('opens the pill modal for the CORRECT lead when several await transfer', async () => {
    const target = locOtherLead({ name: 'Second Lead', originCity: 'Reno', originState: 'NV', originZip: '89501' })
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead({ name: 'First Lead' }), target]} engagements={[]} locFilter="all" />,
    )
    const rows = Array.from(host.querySelectorAll('.bee-inbox-row'))
      .filter(r => (r.textContent || '').includes('Lead'))
    const targetRow = rows.find(r => (r.textContent || '').includes('Second Lead'))
    expect(targetRow).toBeTruthy()
    const pill = Array.from(targetRow!.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Route')
    await act(async () => { pill!.click() })
    await flush()
    const dlg = document.querySelector('[role="dialog"][aria-label="Transfer lead"]')
    expect(dlg).toBeTruthy()
    // The modal is bound to the row that was clicked, not the first in the list.
    expect(dlg!.textContent).toContain('Second Lead')
    expect(dlg!.textContent).not.toContain('First Lead')
    await unmount()
  })

  it('renders the two corporate dispositions and ONLY those — no log-call / Send-to-Jobber / ··· on a transfer row', async () => {
    // The section used to render ONE action per row (Route). "No coverage" is a
    // deliberate SECOND disposition beside it — the exception to routing. The
    // normal cluster stays absent: a lead no location owns still isn't ours to
    // call or push to Jobber.
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const row = Array.from(host.querySelectorAll('.bee-inbox-row'))
      .find(r => (r.textContent || '').includes('Global Lead'))
    expect(row).toBeTruthy()
    const labels = Array.from(row!.querySelectorAll('button')).map(b => b.getAttribute('aria-label'))
    expect(labels).toEqual(['No coverage', 'Route'])
    expect(labels).not.toContain('Log call')
    expect(labels).not.toContain('Send to Jobber')
    expect(labels).not.toContain('More')
    await unmount()
  })

  it('leaves the normal row cluster intact (the pill is transfer-only)', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person({ name: 'Normal New' })]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const row = Array.from(host.querySelectorAll('.bee-inbox-row'))
      .find(r => (r.textContent || '').includes('Normal New'))
    const labels = Array.from(row!.querySelectorAll('button')).map(b => b.getAttribute('aria-label'))
    expect(labels).toContain('Log call')
    expect(labels).toContain('Send to Jobber')
    expect(labels).toContain('More')
    expect(labels).not.toContain('Route')
    // The corporate dispositions are transfer-row only — a normal lead the
    // location owns is never offered "No coverage".
    expect(labels).not.toContain('No coverage')
    await unmount()
  })

  it('styles the pill from tokens — CORPORATE sand fill, pill radius, compact', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const pill = Array.from(host.querySelectorAll('button'))
      .find(b => b.getAttribute('aria-label') === 'Route') as HTMLButtonElement
    expect(pill.style.borderRadius).toBe(T.radius.pill)
    // Sand, NOT the teal action accent: every other green control in the Inbox
    // acts on a lead this location owns, and this one does the opposite.
    expect(pill.style.background).toBe(asRendered('background', T.corp.fill))
    expect(pill.style.color).toBe(asRendered('color', T.corp.onFill))
    expect(pill.style.background).not.toBe(asRendered('background', T.accent.fg))
    // Compact — a row control, not a call-to-action bar.
    expect(pill.style.fontSize).toBe('13px')
    expect(pill.style.padding).toBe('7px 13px')
    // Label + arrow.
    expect(pill.textContent).toContain('Route')
    expect(pill.querySelector('svg')).toBeTruthy()
    await unmount()
  })
})

// ── the Option A container: the queue is its own thing, and the location's
//    own section says whose it is ───────────────────────────────────────────
describe('Inbox — the unrouted queue reads as CORPORATE, not as this location', () => {
  const shell = (host: HTMLElement) => host.querySelector('#bee-inbox-sec-transfer') as HTMLElement

  it('wraps the queue in its own tinted container with the corporate header', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person()]} transferPeople={[locOtherLead()]} engagements={[]}
        locFilter="loc-uuid-1" locations={[{ id: 'loc-uuid-1', name: 'Kansas City' }]} />,
    )
    const sec = shell(host)
    expect(sec).toBeTruthy()
    // A container, not a bare section: its own tint, border and radius.
    expect(sec.style.background).toBe(asRendered('background', T.corp.bg))
    expect(sec.style.border).toContain(asRendered('color', T.corp.border))
    expect(sec.style.borderRadius).toBe(T.radius.card)
    // Header names the OWNER first, then the count.
    const text = (sec.textContent || '')
    expect(text).toContain('Corporate · Not yet routed · 1')
    await unmount()
  })

  it('explains what unrouted MEANS in plain language, not our vocabulary', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const text = shell(host).textContent || ''
    expect(text).toContain("These leads don't belong to any location yet")
    expect(text).toContain('Route them to assign an owner')
    await unmount()
  })

  it('the container carries the grouping — rows sit on a light card INSIDE it', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const sec = shell(host)
    const row = sec.querySelector('.bee-inbox-row') as HTMLElement
    expect(row).toBeTruthy()
    // The rows' card is a descendant of the tinted shell, and it is light —
    // the tint is the grouping, the rows are not individually tinted.
    const card = row.parentElement as HTMLElement
    expect(sec.contains(card)).toBe(true)
    expect(card.style.background).toBe(asRendered('background', T.surface.raised))
    await unmount()
  })

  it('the sand family is distinct from the action green AND from urgency red', async () => {
    // A CATEGORY marker, not an urgency marker: it must not borrow the tone
    // Home's needs-attention cards use, or it reads as "these are overdue".
    expect(T.corp.fill).not.toBe(T.accent.fg)
    expect(T.corp.fill).not.toBe(T.state.success.fg)
    expect(T.corp.fill).not.toBe(T.state.danger.fg)
    expect(T.corp.fill).not.toBe(T.state.danger.strong)
    expect(T.corp.bg).not.toBe(T.surface.raised)
    expect(T.corp.bg).not.toBe(T.surface.canvas)
  })

  it("names the LOCATION on its own New section — '<Location> · New · N'", async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person(), person({ name: 'Second' })]} transferPeople={[locOtherLead()]}
        engagements={[]} locFilter="loc-uuid-1" locations={[{ id: 'loc-uuid-1', name: 'Kansas City' }]} />,
    )
    const label = Array.from(host.querySelectorAll('p')).map(p => p.textContent || '')
      .find(t => t.includes('New ·'))
    expect(label).toContain('Kansas City · New · 2')
    await unmount()
  })

  it('does NOT render a location New header on "all" — there is no location section there', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]}
        locationRequired locFilter="all" locations={[{ id: 'loc-uuid-1', name: 'Kansas City' }]} />,
    )
    // The queue is there; the location's own section (and its name) is not.
    expect(host.textContent).toContain('Corporate · Not yet routed')
    expect(host.textContent).not.toContain('Kansas City')
    expect(host.querySelector('#bee-inbox-sec-new')).toBeNull()
    await unmount()
  })

  it('falls back to a bare "New" when the roster cannot resolve the scope id', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person()]} transferPeople={[]} engagements={[]}
        locFilter="loc-uuid-1" locations={[{ id: 'some-other-loc', name: 'Boulder' }]} />,
    )
    const label = Array.from(host.querySelectorAll('p')).map(p => p.textContent || '')
      .find(t => t.includes('New ·'))
    expect(label).toContain('New · 1 ·')
    expect(label).not.toContain('Boulder')
    await unmount()
  })

  it('still hits the SAME endpoint with the SAME payload — this was a relabel', async () => {
    // The whole change is presentation. If the verb swap ever moved the write,
    // this is where it shows up.
    const fetchMock = installFetch()
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead({ id: 'lead-77' })]} engagements={[]} locFilter="all" />,
    )
    const pill = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Route')
    await act(async () => { pill!.click() })
    await flush()
    const dest = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Boulder'))
    await act(async () => { dest!.click() })
    await flush()
    const confirm = Array.from(document.querySelectorAll('button')).find(b => /^Transfer to /.test(b.textContent || ''))
    expect(confirm).toBeTruthy()
    await act(async () => { (confirm as HTMLButtonElement).click() })
    await flush()
    const call = fetchMock.mock.calls.find(c => String(c[0]).startsWith('/api/leads/'))
    expect(call).toBeTruthy()
    expect(String(call![0])).toBe('/api/leads/lead-77/transfer')
    expect((call![1] as any).method).toBe('POST')
    expect(JSON.parse((call![1] as any).body)).toEqual({ destination_location_id: 'dest-active' })
    await unmount()
  })
})
