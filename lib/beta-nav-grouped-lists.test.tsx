// @vitest-environment happy-dom
// ─────────────────────────────────────────────────────────────
// Clients nav restructure + grouped color-band list views (2026-07-18),
// plus the collapsible-bands + tab-badge refinement (2026-07-19).
//
//   1) Nav shows exactly THREE tabs, each with a count badge:
//      Inbox (New) · Engagements · Client List. Engagements badge = open
//      engagements (the value the removed corner text showed).
//   2) Engagements opens on Board; the Board|List sub-toggle persists
//      (bee_hive_eng_view) and List rehydrates. The corner "Open
//      engagements · N" text is gone.
//   3) The List lens groups by stage in board order; the Client List groups
//      by status. Colors come from CHIP_STYLES (same source the board uses).
//   4) COLLAPSIBLE bands: start collapsed, remember each group's choice per
//      view (bee_hive_eng_collapsed / bee_hive_clients_collapsed, separate
//      memory). Collapsed renders NO rows. Row click opens the same detail.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import HiveShell from '@/components/hive/HiveShell'
import EngagementGroupedList from '@/components/hive/EngagementGroupedList'
import ClientGroupedList from '@/components/hive/ClientGroupedList'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const eng = (over: any = {}) => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  client_id: 'c1', client_name: 'Pat Tester', location_uuid: 'loc-uuid-1',
  title: 'Garage organization', stage: 'Request', created_at: daysAgo(3),
  stage_entered_at: daysAgo(3), nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0, repeat_count: 1,
  quotes: [], jobs: [], invoices: [], ...over,
})

const ENGAGEMENTS = [
  eng({ id: 'req-1', stage: 'Request', client_name: 'Ada Request' }),
  eng({ id: 'est-1', stage: 'Estimate', client_name: 'Ben Estimate', quotes: [{ id: 'q1', status: 'sent', total: 500, sent_at: daysAgo(2) }] }),
  eng({ id: 'job-1', stage: 'Job in Progress', client_name: 'Cy Job' }),
  eng({ id: 'fin-1', stage: 'Final Processing', client_name: 'Deb Final' }),
]

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Ida Fixture', email: 'ida@x.com', phone: '555',
  locationId: 'loc-uuid-1', created: daysAgo(3), paidAmount: 0, paused: false,
  jobberRef: null, source: 'webform', outreachTimeline: [], ...over,
})
const PEOPLE = [
  person({ id: 'new-1', name: 'Nora New', created: daysAgo(2) }),        // New
  person({ id: 'past-1', name: 'Pete Past', paidAmount: 900, created: daysAgo(400) }), // Past
]
const LOCATIONS = [{ id: 'loc-uuid-1', name: 'Portland' }]

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return {
    host,
    rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next) }) },
    unmount: async () => { await act(async () => root.unmount()); host.remove() },
  }
}

const okJson = (body: any) => ({ ok: true, status: 200, json: async () => body })

// A band header is a role=button labelled "<Label> group"; its parent div is
// the band container (holding the rows). Helpers to drive/inspect collapse.
const bandHeader = (host: Element, label: string) => host.querySelector(`[aria-label="${label} group"]`) as HTMLElement | null
const bandOf = (host: Element, label: string) => bandHeader(host, label)?.parentElement as HTMLElement | null
const rowsInBand = (host: Element, label: string) => bandOf(host, label)?.querySelectorAll('.bee-grp-row') ?? []
const clickEl = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

// happy-dom v20 ships no localStorage — stub one so the persisted lens /
// engView / collapse state hydrates for real instead of being swallowed.
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

beforeEach(() => { vi.stubGlobal('localStorage', lsMock); lsStore.clear() })
afterEach(() => { vi.unstubAllGlobals(); lsStore.clear() })

// ── 1) nav labels + badges ──────────────────────────────────────
describe('nav — exactly three tabs with count badges', () => {
  it('renders Inbox (New) · Engagements · Client List, and no standalone Board/List/Clients tab', () => {
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)
    expect(html).toContain('Inbox (New)')
    expect(html).toContain('Engagements')
    expect(html).toContain('Client List')
    expect(html).not.toContain('>Clients<')
  })

  it('each tab shows a count badge; Engagements badge = open engagements, Client List = total clients', () => {
    // 4 open engagements, 2 clients (Nora=New, Pete=Past → inbox counts New+Attempting = 1).
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)
    expect(html).toMatch(/Engagements<span[^>]*>4<\/span>/)
    expect(html).toMatch(/Client List<span[^>]*>2<\/span>/)
    expect(html).toMatch(/Inbox \(New\)<span[^>]*>1<\/span>/)
  })

  it('the "Open engagements · N" corner text is gone', () => {
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)
    expect(html).not.toContain('Open engagements')
  })
})

// ── 2) opens on Board; toggle persists ──────────────────────────
describe('Engagements Board|List sub-toggle', () => {
  it('defaults to Board active (SSR initial state)', () => {
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)
    expect(html).toContain('aria-label="Board view"')
    expect(html).toContain('aria-label="List view"')
    expect(html).toMatch(/aria-pressed="true" aria-label="Board view"/)
    expect(html).toMatch(/aria-pressed="false" aria-label="List view"/)
  })

  it('clicking List persists bee_hive_eng_view=list and swaps to the grouped list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).includes('/api/engagements')) return okJson({ rows: [], total: 0 })
      return okJson({})
    }))
    const { host, unmount } = await mount(
      <HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} locations={LOCATIONS as any} />
    )
    const listBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'List view')!
    expect(listBtn).toBeTruthy()
    await clickEl(listBtn)
    expect(localStorage.getItem('bee_hive_eng_view')).toBe('list')
    // grouped list present via its band headers (the board has none)
    expect(bandHeader(host, 'Request')).toBeTruthy()
    await unmount()
  })

  it('a stored List preference rehydrates on mount', async () => {
    localStorage.setItem('bee_hive_eng_view', 'list')
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).includes('/api/engagements')) return okJson({ rows: [], total: 0 })
      return okJson({})
    }))
    const { host, unmount } = await mount(
      <HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} locations={LOCATIONS as any} />
    )
    expect(bandHeader(host, 'Request')).toBeTruthy()
    await unmount()
  })
})

// ── 3) grouped list: order, colors, detail seam ─────────────────
describe('EngagementGroupedList — grouped by stage in board order', () => {
  it('bands appear in board order and the Closed group is last', async () => {
    const { host, unmount } = await mount(
      <EngagementGroupedList engagements={ENGAGEMENTS as any} closedCount={2787} />
    )
    const labels = Array.from(host.querySelectorAll('span'))
      .map(s => (s.textContent || '').trim())
      .filter(t => ['Request', 'Estimate', 'Job in progress', 'Final processing', 'Closed'].includes(t))
    expect(labels).toEqual(['Request', 'Estimate', 'Job in progress', 'Final processing', 'Closed'])
    await unmount()
  })

  it('a row click opens the same detail seam (onOpenEngagement) — after expanding its band', async () => {
    const onOpen = vi.fn()
    const { host, unmount } = await mount(
      <EngagementGroupedList engagements={ENGAGEMENTS as any} onOpenEngagement={onOpen} />
    )
    // collapsed by default → no rows yet
    expect(host.querySelector('.bee-grp-row')).toBeFalsy()
    await clickEl(bandHeader(host, 'Request')!)
    const row = bandOf(host, 'Request')!.querySelector('.bee-grp-row') as HTMLElement
    expect(row).toBeTruthy()
    await clickEl(row)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0]).toHaveProperty('id')
    await unmount()
  })

  it('band tint is driven from CHIP_STYLES (same source as the board)', () => {
    const src = readFileSync('components/hive/EngagementGroupedList.jsx', 'utf8')
    expect(src).toContain('CHIP_STYLES[stageKey]')
    expect(src).toContain('fam.bg')
    expect(src).toContain('fam.text')
    expect(CHIP_STYLES['Request']).toEqual(CHIP_STYLES.teal)
  })
})

// ── 4) collapsible bands (Engagements) ──────────────────────────
describe('EngagementGroupedList — collapsible bands', () => {
  it('first load: every band collapsed (chevron-right, counts shown, NO rows)', async () => {
    const { host, unmount } = await mount(
      <EngagementGroupedList engagements={ENGAGEMENTS as any} closedCount={2787} />
    )
    // headers + counts render…
    expect(bandHeader(host, 'Request')!.getAttribute('aria-expanded')).toBe('false')
    expect(host.textContent).toContain('2787')
    // …but no rows, and the chevron is not rotated to the open (down) state
    expect(host.querySelectorAll('.bee-grp-row').length).toBe(0)
    expect(host.innerHTML).not.toContain('rotate(90deg)')
    await unmount()
  })

  it('toggling expands a band; reload remembers it expanded, others collapsed', async () => {
    const first = await mount(<EngagementGroupedList engagements={ENGAGEMENTS as any} />)
    await clickEl(bandHeader(first.host, 'Estimate')!)
    expect(bandHeader(first.host, 'Estimate')!.getAttribute('aria-expanded')).toBe('true')
    expect(rowsInBand(first.host, 'Estimate').length).toBe(1) // Ben Estimate
    // persisted to the Engagements-specific store
    expect(JSON.parse(lsStore.get('bee_hive_eng_collapsed') || '{}')).toMatchObject({ Estimate: true })
    await first.unmount()

    // remount (same storage) → Estimate expanded, Request still collapsed
    const second = await mount(<EngagementGroupedList engagements={ENGAGEMENTS as any} />)
    expect(bandHeader(second.host, 'Estimate')!.getAttribute('aria-expanded')).toBe('true')
    expect(rowsInBand(second.host, 'Estimate').length).toBe(1)
    expect(bandHeader(second.host, 'Request')!.getAttribute('aria-expanded')).toBe('false')
    expect(rowsInBand(second.host, 'Request').length).toBe(0)
    await second.unmount()
  })

  it('the Closed group folds into the same collapse mechanism and lazy-loads on expand', async () => {
    const fetchSpy = vi.fn(async () => okJson({ rows: [eng({ id: 'closed-1', stage: 'Closed Won', client_name: 'Won One' })], total: 1 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { host, unmount } = await mount(
      <EngagementGroupedList engagements={ENGAGEMENTS as any} closedCount={2787} />
    )
    // collapsed: count shows, nothing fetched
    expect(fetchSpy).not.toHaveBeenCalled()
    await clickEl(bandHeader(host, 'Closed')!)
    await act(async () => { await Promise.resolve() })
    const url = String((fetchSpy.mock.calls[0] as any)[0])
    expect(url).toContain('closed=1')
    expect(host.textContent).toContain('Won One')
    await unmount()
  })
})

// ── 5) client list: grouping, detail seam, collapse ─────────────
describe('ClientGroupedList — grouped by status, collapsible', () => {
  it('renders a band header per present status; rows appear only when expanded', async () => {
    const { host, unmount } = await mount(
      <ClientGroupedList people={PEOPLE as any} engagements={[]} locations={LOCATIONS as any} />
    )
    // headers render collapsed (Nora=New, Pete=Past client)
    expect(bandHeader(host, 'New')).toBeTruthy()
    expect(bandHeader(host, 'Past client')).toBeTruthy()
    expect(host.querySelectorAll('.bee-grp-row').length).toBe(0)
    // expand New → Nora + her location surface
    await clickEl(bandHeader(host, 'New')!)
    expect(bandOf(host, 'New')!.textContent).toContain('Nora New')
    expect(bandOf(host, 'New')!.textContent).toContain('Portland')
    await unmount()
  })

  it('a row click opens the same client detail seam (onOpenClient)', async () => {
    const onOpen = vi.fn()
    const { host, unmount } = await mount(
      <ClientGroupedList people={PEOPLE as any} engagements={[]} locations={LOCATIONS as any} onOpenClient={onOpen} />
    )
    await clickEl(bandHeader(host, 'New')!)
    const row = bandOf(host, 'New')!.querySelector('.bee-grp-row') as HTMLElement
    await clickEl(row)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(typeof onOpen.mock.calls[0][0]).toBe('string')
    await unmount()
  })

  it('Client List collapse memory is INDEPENDENT of Engagements (separate stores)', async () => {
    const { host, unmount } = await mount(
      <ClientGroupedList people={PEOPLE as any} engagements={[]} locations={LOCATIONS as any} />
    )
    await clickEl(bandHeader(host, 'New')!)
    // writes the clients store, never the engagements store
    expect(JSON.parse(lsStore.get('bee_hive_clients_collapsed') || '{}')).toMatchObject({ New: true })
    expect(lsStore.get('bee_hive_eng_collapsed')).toBeUndefined()
    await unmount()
  })

  it('status band color is driven from CHIP_STYLES via CLIENT_STATUS_META (same source)', () => {
    const src = readFileSync('components/hive/ClientGroupedList.jsx', 'utf8')
    expect(src).toContain('CHIP_STYLES[meta.styleKey]')
    expect(src).toContain('CLIENT_STATUS_META')
  })
})
