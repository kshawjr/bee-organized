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
//   · the row's ONLY action is the Transfer pill — no log-call / Send-to-Jobber
//     / ··· cluster, since none of those apply to a lead being routed away —
//     and it opens the same TransferLeadModal the card does
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
    .filter(t => /Needs transfer|^New ·|New ·|Attempting ·/.test(t))

describe('Inbox — Needs transfer section', () => {
  it('renders the section ABOVE New when a loc_other lead is in scope', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person()]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const text = host.textContent || ''
    expect(text).toContain('Needs transfer')
    // ordering: the Needs-transfer banner precedes the New banner in the DOM
    const labels = sectionLabels(host)
    const transferIdx = labels.findIndex(t => t.includes('Needs transfer'))
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
    const transferBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Transfer')
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
    const pill = Array.from(targetRow!.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Transfer')
    await act(async () => { pill!.click() })
    await flush()
    const dlg = document.querySelector('[role="dialog"][aria-label="Transfer lead"]')
    expect(dlg).toBeTruthy()
    // The modal is bound to the row that was clicked, not the first in the list.
    expect(dlg!.textContent).toContain('Second Lead')
    expect(dlg!.textContent).not.toContain('First Lead')
    await unmount()
  })

  it('renders the pill as the ONLY action — no log-call / Send-to-Jobber / ··· on a transfer row', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const row = Array.from(host.querySelectorAll('.bee-inbox-row'))
      .find(r => (r.textContent || '').includes('Global Lead'))
    expect(row).toBeTruthy()
    const labels = Array.from(row!.querySelectorAll('button')).map(b => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Transfer'])
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
    expect(labels).not.toContain('Transfer')
    await unmount()
  })

  it('styles the pill from tokens — accent fill, pill radius, compact', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const pill = Array.from(host.querySelectorAll('button'))
      .find(b => b.getAttribute('aria-label') === 'Transfer') as HTMLButtonElement
    expect(pill.style.borderRadius).toBe(T.radius.pill)
    // Filled accent, not a ghost: accent fill + the accent's onFill ink.
    expect(pill.style.background).toBe(asRendered('background', T.accent.fg))
    expect(pill.style.color).toBe(asRendered('color', T.accent.onFill))
    // Compact — a row control, not a call-to-action bar.
    expect(pill.style.fontSize).toBe('13px')
    expect(pill.style.padding).toBe('7px 13px')
    // Arrow + label.
    expect(pill.textContent).toContain('Transfer')
    expect(pill.querySelector('svg')).toBeTruthy()
    await unmount()
  })
})
