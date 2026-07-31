// @vitest-environment happy-dom
// ─────────────────────────────────────────────────────────────
// Inbox per-section card navigation (issue 134 follow-up, Ankur).
//
// A row click hands its SECTION's displayed row ids to the profile as
// siblings, so the card's ‹ › chevrons page card-to-card within that
// section — New, Attempting, and Needs-transfer each walk their OWN
// on-screen order and stop at the section's edge (same scoping decision
// as the grouped client list's bands, for the same reason).
//
// THE STALE-SIBLING DECISION (capture at open): the sibling list is a
// snapshot of the section at open time. Rows soft-remove on disposition
// (issues 89/119 — isSoftRemovedFromInbox), so the snapshot CAN go stale
// mid-walk; the accepted failure mode is "chevron shows a lead that has
// since left the list", never "shows nothing" — the profile fetches by
// id and soft removals are flags, not deletes. Capture-at-open is
// deliberate over live recompute: the section derivation is Inbox-local
// state, and a live list would drop the OPEN lead from its own walk the
// moment a logged call re-derives it New→Attempting, killing both
// chevrons mid-worklist.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import InboxScreen from '@/components/hive/InboxScreen'
import HiveShell from '@/components/hive/HiveShell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell', email: 'sarah@email.com', phone: '(561) 555-0199',
  locationId: 'loc-uuid-1', created: daysAgo(3), // < 30d, no outreach → New
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  paidAmount: 0, paused: false, source: 'webform', outreachTimeline: [], ...over,
})
const reachOut = (n: number) => [{ id: `t-${n}`, type: 'reach_out', occurred_at: daysAgo(n) }]

// Fixture set: raw array order is scrambled AND alphabet-reversed relative to
// the displayed order (default sort = newest first), so "raw order" and
// "displayed order" disagree — the regression the grouped list already fixed.
//   New section displayed:        Amy (1d) → Cleo (3d) → Bev (5d)
//   Attempting section displayed: Walt (2d)
const AMY  = person({ id: 'new-amy',  name: 'Amy Newest',  created: daysAgo(1) })
const BEV  = person({ id: 'new-bev',  name: 'Bev Oldest',  created: daysAgo(5) })
const CLEO = person({ id: 'new-cleo', name: 'Cleo Middle', created: daysAgo(3) })
const WALT = person({ id: 'att-walt', name: 'Walt Working', created: daysAgo(2), outreachTimeline: reachOut(2) })
const PEOPLE = [BEV, WALT, AMY, CLEO]

// Needs-transfer queue (separate transferPeople array), same scrambling.
const TRA = person({ id: 'tr-ann', name: 'Ann Unrouted', created: daysAgo(2), atLocOther: true, locationId: null })
const TRB = person({ id: 'tr-zoe', name: 'Zoe Unrouted', created: daysAgo(1), atLocOther: true, locationId: null })
const TRANSFER_PEOPLE = [TRA, TRB] // displayed: Zoe (1d) → Ann (2d)

const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
const profilePayload = (id: string, name: string) => ({
  client: {
    id, name, first_name: name.split(' ')[0], last_name: name.split(' ')[1] || '',
    email: 'x@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(3), source: 'webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Boulder',
  },
  referred_us: [], contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})
const NAMES: Record<string, string> = Object.fromEntries(
  [...PEOPLE, ...TRANSFER_PEOPLE].map(p => [p.id, p.name]))
const installFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const prof = u.match(/\/api\/clients\/([^/]+)\/profile/)
    if (prof) return jsonRes(profilePayload(prof[1], NAMES[prof[1]] || 'Unknown'))
    if (/\/api\/leads\/[^/]+$/.test(u) && opts.method === 'PATCH') return jsonRes({ lead: {} })
    if (u.includes('/api/touchpoints') && opts.method === 'POST') return jsonRes({ touchpoint: { id: 'tp-1' } }, 201)
    return jsonRes({})
  }))
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const rowByName = (host: Element, name: string) =>
  [...host.querySelectorAll('.bee-inbox-row')].find(r => (r.textContent || '').includes(name)) as HTMLElement

beforeEach(() => {
  installFetch()
  document.body.innerHTML = ''
  ;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
})
afterEach(() => {
  vi.unstubAllGlobals()
  ;(globalThis as any).__BEE_TEST_WIDTH__ = undefined
})

// ── siblings: displayed order, per section ─────────────────────
describe('InboxScreen — row click hands the section displayed order as siblings', () => {
  it('a New row passes the New section in DISPLAYED (newest-first) order, not raw array order', async () => {
    const onOpen = vi.fn()
    const m = await mount(<InboxScreen people={PEOPLE} engagements={[]} locFilter="all" onOpenPerson={onOpen} />)
    await click(rowByName(m.host, 'Cleo Middle'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0].id).toBe('new-cleo')
    // raw order starts with Bev; the screen (and so the walk) starts with Amy
    expect(onOpen.mock.calls[0][1]).toEqual(['new-amy', 'new-cleo', 'new-bev'])
    await m.unmount()
  })

  it('siblings never cross a section boundary — New excludes Attempting and transfer ids', async () => {
    const onOpen = vi.fn()
    const m = await mount(
      <InboxScreen people={PEOPLE} transferPeople={TRANSFER_PEOPLE} engagements={[]} locFilter="all" onOpenPerson={onOpen} />
    )
    await click(rowByName(m.host, 'Amy Newest'))
    const sibs = onOpen.mock.calls[0][1]
    expect(sibs).toEqual(['new-amy', 'new-cleo', 'new-bev'])
    expect(sibs).not.toContain('att-walt')
    expect(sibs).not.toContain('tr-ann')
    await m.unmount()
  })

  it('a one-row section (Attempting) hands a length-1 list; HiveShell nulls it so the chevrons hide (source pin)', async () => {
    const onOpen = vi.fn()
    const m = await mount(<InboxScreen people={PEOPLE} engagements={[]} locFilter="all" onOpenPerson={onOpen} />)
    await click(rowByName(m.host, 'Walt Working'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-walt' }), ['att-walt'])
    // chevrons-hidden on ≤1 is HiveShell's gate (pinned mounted in beta-card-layout)
    const shell = readFileSync('components/hive/HiveShell.jsx', 'utf8')
    expect(shell).toContain('Array.isArray(siblings) && siblings.length > 1 ? siblings : null')
    await m.unmount()
  })

  it('the Needs-transfer section gets chevrons too — its own displayed order, never New/Attempting ids', async () => {
    const onOpen = vi.fn()
    const m = await mount(
      <InboxScreen people={PEOPLE} transferPeople={TRANSFER_PEOPLE} engagements={[]} locFilter="all" onOpenPerson={onOpen} />
    )
    await click(rowByName(m.host, 'Ann Unrouted'))
    // transfer queue displayed newest-first: Zoe (1d) → Ann (2d)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'tr-ann' }), ['tr-zoe', 'tr-ann'])
    expect(onOpen.mock.calls[0][1]).not.toContain('new-amy')
    await m.unmount()
  })
})

// ── the stale-sibling decision, asserted end-to-end ────────────
describe('HiveShell — mid-walk disposition (capture-at-open, the decided behavior)', () => {
  it('dismissing a sibling mid-walk keeps it walkable: Next lands on the dismissed lead and RENDERS it (never blank)', async () => {
    const m = await mount(
      <HiveShell engagements={[]} people={[AMY, CLEO]} locFilter="all" locations={[]} />
    )
    // into the Inbox lens
    const inboxTab = [...m.host.querySelectorAll('button')].find(b => (b.textContent || '').includes('Inbox'))!
    await click(inboxTab)
    await act(async () => { await Promise.resolve() })

    // open Amy (first of New: Amy 1d → Cleo 3d) — siblings captured here
    await click(rowByName(m.host, 'Amy Newest'))
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    const next = m.host.querySelector('button[aria-label="Next client"]') as HTMLButtonElement
    expect(next, 'chevrons should render for a 2-row section').toBeTruthy()
    expect(next.disabled).toBe(false)

    // dismiss Cleo through her row's ··· menu (the list is mounted under the overlay)
    const cleoRow = rowByName(m.host, 'Cleo Middle')
    await click(cleoRow.querySelector('button[aria-label="More"]')!)
    const dismiss = [...document.querySelectorAll('[data-bee-row-menu] button')]
      .find(b => (b.textContent || '').trim() === 'Dismiss')!
    expect(dismiss).toBeTruthy()
    await click(dismiss)
    await act(async () => { await Promise.resolve() })
    // the dismissal really soft-removed her row from the list…
    expect(rowByName(m.host, 'Cleo Middle')).toBeFalsy()

    // …but the captured walk still reaches her: Next opens Cleo's profile
    await click(m.host.querySelector('button[aria-label="Next client"]')!)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect((globalThis.fetch as any).mock.calls.some(
      (c: any[]) => String(c[0]).includes('/api/clients/new-cleo/profile'),
    )).toBe(true)
    // renders the lead — the accepted failure mode is "shows a lead no longer
    // in the list", asserted here as real content, not a blank card
    const overlay = m.host.querySelector('.bee-overlay-modal') as HTMLElement
    expect(overlay?.textContent).toContain('Cleo Middle')
    await m.unmount()
  })
})
