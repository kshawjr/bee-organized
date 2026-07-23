// @vitest-environment happy-dom
//
// THE UNROUTED TRANSFER QUEUE MUST RENDER ON 'ALL LOCATIONS'.
//
// 'all' is the CORPORATE scope, and unrouted (loc_other) leads belong to no
// location — so 'all' is the one scope that exists to work them. The queue
// being present when scoped to Kansas City and absent on 'all' is backwards.
//
// This has now broken twice, and both times silently, because every surface
// downstream self-gates on emptiness: an empty queue is indistinguishable from
// "no work" at the render layer. What failed was always UPSTREAM of the render.
//
//   Phase 4  — stopped loading the people graph on 'all' (overviewOnly), while
//              the server's transfer-queue block still took a shortcut that
//              FILTERED that graph on 'all'. It filtered an always-empty array.
//   Phase 4b — fixed the Inbox so the prompt no longer swallowed the queue, and
//              verified the render with a MOUNT that injected a non-empty
//              `transferPeople` prop. That is why it passed while prod was
//              broken: the mount proved the render, and the break was in the
//              PRODUCTION of the prop the mount was handing itself.
//
// So this file covers the whole chain, not one link:
//
//   server:   transferQueueSource  — WHERE the rows come from on each scope
//   identity: viewAsIdentityFor / isElevatedRole — who counts as corporate
//   gate:     visibleTransferQueue — the client elevation gate
//   render:   HiveShell mounted on 'all' — the container actually appears
//
// and the mount composes the REAL functions above rather than restating their
// logic, so a change to any link fails here instead of passing on a stub.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { transferQueueSource, LOC_OTHER_SLUG } from '@/lib/hub-scope'
import { viewAsIdentityFor, isElevatedRole, visibleTransferQueue } from '@/lib/view-as-identity'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/clients',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ targets: [] }) })) as any

import HiveShell from '@/components/hive/HiveShell'

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const KC_UUID = KC
const now = Date.now()

// ── 1. THE SERVER: where the rows come from ──────────────────────────────────
describe('transferQueueSource — the queue is fetched on every scope', () => {
  it("REGRESSION: elevated on 'all' must QUERY, never filter the (empty) graph", () => {
    // The exact break. On 'all' an elevated user loads counts only — no people —
    // so filtering initialPeople yields [] and the routing queue disappears from
    // the corporate scope. It has to run its own bounded loc_other query.
    expect(transferQueueSource({
      overviewOnly: true, scopeLocationUuid: null, locationSlug: null,
    })).toBe('query')
  })

  it("no people loaded means QUERY even if a slug rides along", () => {
    // Guards the shape of the fix: overviewOnly wins over every other input,
    // because it is the flag that says whether initialPeople exists at all.
    expect(transferQueueSource({
      overviewOnly: true, scopeLocationUuid: null, locationSlug: LOC_OTHER_SLUG,
    })).toBe('query')
  })

  it('scoped to a real location QUERIES — loc_other is never that location', () => {
    // The scoped path Kevin sees working today. Must not regress.
    expect(transferQueueSource({
      overviewOnly: false, scopeLocationUuid: KC_UUID, locationSlug: 'kansas-city',
    })).toBe('query')
  })

  it('scoped to loc_other ITSELF filters the graph it already loaded', () => {
    // The one case where re-querying would be pure waste: the selected scope IS
    // loc_other, so its rows are already in initialPeople via the same mapper.
    expect(transferQueueSource({
      overviewOnly: false, scopeLocationUuid: 'loc-other-uuid', locationSlug: LOC_OTHER_SLUG,
    })).toBe('filter-loaded')
  })

  it('unscoped WITH people loaded still filters (the non-elevated path)', () => {
    // A franchise user with a null location_id keeps the unscoped load they
    // have always had. overviewOnly is elevated-only, so it is false here.
    expect(transferQueueSource({
      overviewOnly: false, scopeLocationUuid: null, locationSlug: null,
    })).toBe('filter-loaded')
  })
})

// ── 2. IDENTITY: who counts as corporate ─────────────────────────────────────
describe('view-as identity — a corp target stays elevated', () => {
  it('a CORPORATE user (Leslie) stays elevated and lands on all locations', () => {
    // Both halves matter: corp has no one location, so 'all' is her real
    // working scope — and it is exactly the scope the queue must render on.
    const next = viewAsIdentityFor({ id: 'u-leslie', name: 'Leslie', role: 'corporate' })
    expect(next.role).toBe('corporate')
    expect(isElevatedRole(next.role)).toBe(true)
    expect(next.locFilter).toBe('all')
  })

  it('a FRANCHISE owner drops to franchise, pinned to their own location', () => {
    const next = viewAsIdentityFor({ id: 'u-kc', name: 'KC Owner', role: 'owner', locationId: KC })
    expect(next.role).toBe('franchise')
    expect(isElevatedRole(next.role)).toBe(false)
    expect(next.locFilter).toBe(KC)
  })

  it('super_admin (Kevin, not impersonating) is elevated', () => {
    expect(isElevatedRole('super_admin')).toBe(true)
  })
})

// ── 3. THE GATE ──────────────────────────────────────────────────────────────
describe('visibleTransferQueue — elevation decided on the client', () => {
  it('passes the queue through for an elevated viewer', () => {
    expect(visibleTransferQueue([{ id: 'a' }], { isElevated: true })).toHaveLength(1)
  })

  it('withholds it from a franchise viewer even when the prop IS populated', () => {
    // The view-as over-exposure case: the server session is still super_admin,
    // so the prop arrives full regardless of who is being impersonated.
    expect(visibleTransferQueue([{ id: 'a' }], { isElevated: false })).toEqual([])
  })
})

// ── 4. THE RENDER: mounted on 'all', through the real chain ──────────────────
let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

const locOther = (o: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Global Lead', email: 'g@x.com', phone: '(561) 555-0199',
  locationId: 'loc-other-uuid', created: new Date(now - 3 * 86400000).toISOString(),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  outreachTimeline: [], atLocOther: true,
  originCity: 'Austin', originState: 'TX', originZip: '78701', project: 'Garage',
  ...o,
})

// Mount HiveShell on 'all' for a given VIEWER, running the queue through the
// same gate App/HiveScreen run it through. The test never decides visibility
// itself — isElevatedRole + visibleTransferQueue do, exactly as in production.
async function mountAsViewer(role: string, transferPeople: any[]) {
  const isElevated = isElevatedRole(role)
  const props = {
    engagements: [], people: [],
    transferPeople: visibleTransferQueue(transferPeople, { isElevated }),
    locFilter: 'all',
    locationRequired: true,        // 'all' loads no records — the 4b prompt state
    onOpenLocationPicker: vi.fn(),
    locations: [{ id: KC, name: 'Kansas City' }],
    locationUsers: [], currentUserId: 'u1', currentLocationUuid: null,
    closedCount: 0, closedWonCount: 0,
    initialIntent: { tab: 'inbox' },
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(React.createElement(HiveShell as any, props)) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  const inboxTab = Array.from(host.querySelectorAll('button')).find(b => /inbox/i.test(b.textContent || ''))
  if (inboxTab) await act(async () => { (inboxTab as HTMLButtonElement).click() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

describe("the Inbox on 'All Locations' renders the queue for corporate identities", () => {
  it('SUPER_ADMIN (Kevin) sees the container and its rows on all', async () => {
    const host = await mountAsViewer('super_admin', [locOther()])
    // The container itself, not just the text — Option A gave the queue its own
    // corporate shell, and the id is what the Home card deep-links to.
    expect(host.querySelector('#bee-inbox-sec-transfer')).toBeTruthy()
    expect(host.textContent).toContain('Not yet routed')
    expect(host.textContent).toContain('Global Lead')
  })

  it('CORPORATE under view-as (Leslie) sees it too — same scope, same rows', async () => {
    // Driven from the picker's real output, so a change to viewAsIdentityFor
    // that de-elevates corp targets fails HERE rather than in prod.
    const leslie = viewAsIdentityFor({ id: 'u-leslie', name: 'Leslie', role: 'corporate' })
    expect(leslie.locFilter).toBe('all')
    const host = await mountAsViewer(leslie.role, [locOther()])
    expect(host.querySelector('#bee-inbox-sec-transfer')).toBeTruthy()
    expect(host.textContent).toContain('Global Lead')
  })

  it('the prompt sits BELOW the queue, it does not replace it', async () => {
    // Phase 4b's property: 'all' still asks for a location for New/Attempting,
    // but the cross-location queue stays. Both must be on screen at once.
    const host = await mountAsViewer('super_admin', [locOther()])
    expect(host.querySelector('#bee-inbox-sec-transfer')).toBeTruthy()
    expect(host.textContent).toContain('The inbox works one location at a time')
  })

  it('FRANCHISE under view-as sees NOTHING, even with rows in hand', async () => {
    // The constraint that must survive the fix. Rows are passed in; the gate
    // is what withholds them.
    const host = await mountAsViewer('franchise', [locOther()])
    expect(host.querySelector('#bee-inbox-sec-transfer')).toBeNull()
    expect(host.textContent).not.toContain('Global Lead')
    expect(host.textContent).not.toContain('Not yet routed')
  })

  it('an EMPTY queue renders no container — the gate is rows, not role', async () => {
    // Elevation alone must not conjure an empty corporate shell on every load.
    const host = await mountAsViewer('super_admin', [])
    expect(host.querySelector('#bee-inbox-sec-transfer')).toBeNull()
    expect(host.textContent).toContain('The inbox works one location at a time')
  })
})
