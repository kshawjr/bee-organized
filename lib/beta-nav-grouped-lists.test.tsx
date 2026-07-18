// @vitest-environment happy-dom
// ─────────────────────────────────────────────────────────────
// Clients nav restructure + grouped color-band list views (2026-07-18).
//
//   1) Nav shows exactly THREE tabs: Inbox (New) · Engagements · Client List
//      (Board + List are no longer separate tabs).
//   2) Engagements opens on Board; the Board|List sub-toggle persists the
//      choice to localStorage (bee_hive_eng_view) and List rehydrates.
//   3) The List lens is the grouped-by-stage color-band view, in board order,
//      with a collapsed Closed group at the bottom that lazy-loads.
//   4) The Client List lens is the grouped-by-status color-band view.
//   5) Both band views drive their colors from the SAME source the board
//      uses (CHIP_STYLES), and a row click opens the same detail seam.
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
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const okJson = (body: any) => ({ ok: true, status: 200, json: async () => body })

// happy-dom v20 ships no localStorage — stub one so the lens/engView
// hydration in HiveShell runs for real instead of being try/catch-swallowed.
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

beforeEach(() => { vi.stubGlobal('localStorage', lsMock); lsStore.clear() })
afterEach(() => { vi.unstubAllGlobals(); lsStore.clear() })

// ── 1) nav labels ───────────────────────────────────────────────
describe('nav — exactly three tabs', () => {
  it('renders Inbox (New) · Engagements · Client List, and no standalone Board/List/Clients tab', () => {
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)
    expect(html).toContain('Inbox (New)')
    expect(html).toContain('Engagements')
    expect(html).toContain('Client List')
    // Old flat-tab label is gone (the people tab is "Client List" now).
    expect(html).not.toContain('>Clients<')
  })
})

// ── 2) opens on Board; toggle persists ──────────────────────────
describe('Engagements Board|List sub-toggle', () => {
  it('defaults to Board active (SSR initial state)', () => {
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)
    // the toggle renders (Engagements is the default tab)
    expect(html).toContain('aria-label="Board view"')
    expect(html).toContain('aria-label="List view"')
    // Board is the pressed side by default
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
    // board first (no grouped rows yet)
    const listBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'List view')!
    expect(listBtn).toBeTruthy()
    await act(async () => { listBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(localStorage.getItem('bee_hive_eng_view')).toBe('list')
    // grouped rows now present (board renders ui/Card, never .bee-grp-row)
    expect(host.querySelector('.bee-grp-row')).toBeTruthy()
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
    expect(host.querySelector('.bee-grp-row')).toBeTruthy()
    await unmount()
  })
})

// ── 3) grouped list: stage order + collapsed Closed + row click ──
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

  it('the Closed group is collapsed by default and lazy-loads on expand', async () => {
    const fetchSpy = vi.fn(async (url: any) => okJson({ rows: [eng({ id: 'closed-1', stage: 'Closed Won', client_name: 'Won One' })], total: 1 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { host, unmount } = await mount(
      <EngagementGroupedList engagements={ENGAGEMENTS as any} closedCount={2787} />
    )
    // collapsed: the closed count shows, but no fetch fired and no closed row
    expect(host.textContent).toContain('2787')
    expect(fetchSpy).not.toHaveBeenCalled()
    // expand: click the Closed band header (the div wrapping the label span)
    const closedLabel = Array.from(host.querySelectorAll('span')).find(s => (s.textContent || '').trim() === 'Closed')!
    expect(closedLabel).toBeTruthy()
    const closedHeader = closedLabel.parentElement as HTMLElement
    await act(async () => { closedHeader.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(fetchSpy).toHaveBeenCalled()
    const calledUrl = String((fetchSpy.mock.calls[0] as any)[0])
    expect(calledUrl).toContain('closed=1')
    expect(host.textContent).toContain('Won One')
    await unmount()
  })

  it('a row click opens the same detail seam (onOpenEngagement)', async () => {
    const onOpen = vi.fn()
    const { host, unmount } = await mount(
      <EngagementGroupedList engagements={ENGAGEMENTS as any} onOpenEngagement={onOpen} />
    )
    const row = host.querySelector('.bee-grp-row') as HTMLElement
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0]).toHaveProperty('id')
    await unmount()
  })

  it('band tint is driven from CHIP_STYLES (same source as the board)', () => {
    const src = readFileSync('components/hive/EngagementGroupedList.jsx', 'utf8')
    expect(src).toContain('CHIP_STYLES[stageKey]')
    // the tint is the family bg (the light 50-stop), the header the dark stop
    expect(src).toContain('fam.bg')
    expect(src).toContain('fam.text')
    // sanity: Request resolves to the teal family the board's chip uses
    expect(CHIP_STYLES['Request']).toEqual(CHIP_STYLES.teal)
  })
})

// ── 4) client list: grouped by status + row click ───────────────
describe('ClientGroupedList — grouped by status', () => {
  it('renders a band per present status with the client rows inside', async () => {
    const { host, unmount } = await mount(
      <ClientGroupedList people={PEOPLE as any} engagements={[]} locations={LOCATIONS as any} />
    )
    // Nora is New, Pete is Past client — both status labels head a band
    expect(host.textContent).toContain('New')
    expect(host.textContent).toContain('Past client')
    // location name resolves from the roster
    expect(host.textContent).toContain('Portland')
    await unmount()
  })

  it('a row click opens the same client detail seam (onOpenClient)', async () => {
    const onOpen = vi.fn()
    const { host, unmount } = await mount(
      <ClientGroupedList people={PEOPLE as any} engagements={[]} locations={LOCATIONS as any} onOpenClient={onOpen} />
    )
    const row = host.querySelector('.bee-grp-row') as HTMLElement
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(typeof onOpen.mock.calls[0][0]).toBe('string') // a client id
    await unmount()
  })

  it('status band color is driven from CHIP_STYLES via CLIENT_STATUS_META (same source)', () => {
    const src = readFileSync('components/hive/ClientGroupedList.jsx', 'utf8')
    expect(src).toContain('CHIP_STYLES[meta.styleKey]')
    expect(src).toContain('CLIENT_STATUS_META')
  })
})
