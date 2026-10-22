// @vitest-environment happy-dom
// Beta mobile-layout regression: renders the shell + beta surfaces with
// the mobile branch forced (globalThis.__BEE_TEST_WIDTH__ seeds
// useIsMobile, since renderToString never runs effects) and asserts the
// 2026-07-04 mobile rules hold:
//   - shell chrome STACKS: tab pills on one nowrap scroll line, the
//     open-engagements counter on a second compact 11px line (nothing
//     shares a line with the pills → nothing overlaps). (Classic retired
//     2026-07-18 — the "Back to classic" hatch that used to share row 2
//     with the counter is gone; the compact-row layout is otherwise intact.)
//   - chip strips stay single-line horizontal scrollers (nowrap)
//   - overlays are bottom sheets with contained overscroll
// Born from Kevin's 2026-07-04 mobile screenshots (overlapping shell row).
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import HiveShell from '@/components/hive/HiveShell'
import EngagementGroupedList from '@/components/hive/EngagementGroupedList'
import ClientGroupedList from '@/components/hive/ClientGroupedList'
import OverlayShell from '@/components/hive/OverlayShell'
import { FilterPopover } from '@/components/hive/shared/FilterPopover'

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const eng = (over: any = {}) => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  client_id: 'c1',
  client_name: 'Pat Tester',
  location_uuid: 'loc-uuid-1',
  title: 'Garage organization',
  stage: 'Request',
  created_at: daysAgo(3),
  stage_entered_at: daysAgo(3),
  nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0,
  repeat_count: 1,
  quotes: [], jobs: [], invoices: [],
  ...over,
})

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Ida Fixture',
  email: 'ida@x.com', phone: '555',
  locationId: 'loc-uuid-1',
  created: daysAgo(3),
  paidAmount: 0, paused: false,
  jobberRef: null, source: 'webform',
  outreachTimeline: [],
  ...over,
})

const ENGAGEMENTS = [
  eng({ stage: 'Request' }),
  eng({ stage: 'Estimate', quotes: [{ id: 'q1', status: 'sent', total: 500, sent_at: daysAgo(2) }] }),
  eng({ stage: 'Job in Progress', jobs: [{ id: 'j1', status: 'upcoming', scheduled_start: new Date(now + 5 * 86400000).toISOString() }] }),
]
const PEOPLE = [person(), person({ id: 'c1' })]

const setWidth = (w: number | undefined) => { (globalThis as any).__BEE_TEST_WIDTH__ = w }
afterEach(() => { setWidth(undefined); vi.unstubAllGlobals() })

// The shell's first paint is the Inbox for an owner with no saved choice
// (2026-10-21), so the board's toolbar only appears once a saved Engagements
// lens hydrates, which renderToString never does. These two tests mount in
// the browser with that lens saved, and flatten the browser's "a: b;" style
// text to the server's "a:b" so the layout patterns read the same.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const renderBoardShell = async () => {
  const ls = new Map<string, string>([['bee_hive_beta_lens', 'engagements']])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
    setItem: (k: string, v: string) => { ls.set(k, String(v)) },
    removeItem: (k: string) => { ls.delete(k) },
  })
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ rows: [], total: 0 }) }))
  // useIsMobile re-reads window.innerWidth after mount; match the seeded width.
  const width = (globalThis as any).__BEE_TEST_WIDTH__
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: typeof width === 'number' ? width : 1200 })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />) })
  const html = host.innerHTML.replace(/style="([^"]*)"/g, (_m, css) =>
    `style="${css.replace(/:\s+/g, ':').replace(/;\s*/g, ';').replace(/;$/, '')}"`)
  await act(async () => root.unmount())
  host.remove()
  return html
}

describe('beta mobile layout', () => {
  it('mobile shell stacks: pills scroll on row 1, Board/List toggle on row 2', async () => {
    setWidth(390)
    const html = await renderBoardShell()

    // Row 1: a nowrap horizontal scroller holding the three tab pills
    // (nav restructure 2026-07-18 — Board+List merged into Engagements).
    const strip = html.match(/<div style="([^"]*overflow-x:auto[^"]*)">(.*?)<\/div>/)
    expect(strip, 'tab strip scroll container missing').toBeTruthy()
    for (const label of ['Inbox (New Leads)', 'Engagements in Jobber']) expect(strip![2]).toContain(label)

    // Row 2: the Board/List sub-toggle, right-aligned (Engagements is the
    // default tab). The "Open engagements" corner text was REMOVED 2026-07-19
    // (its count is now the Engagements tab badge). Classic hatch already gone.
    expect(html).not.toContain('Open engagements')
    expect(html).toContain('aria-label="Board view"')
    // A browser mount carries other right-aligned rows the server render
    // did not, so look for the one holding the toggle, not just the first.
    const toggleRow = [...html.matchAll(/<div style="[^"]*justify-content:flex-end[^"]*">(.*?)<\/div>/g)]
      .find(m => m[1].includes('aria-label="Engagements view"'))
    expect(toggleRow, 'toggle row missing').toBeTruthy()
    expect(toggleRow![1]).toContain('aria-label="Engagements view"')
    expect(html).not.toContain('Back to classic')

    // The pill strip itself never wraps (wrap = the old collision).
    expect(strip![1]).not.toContain('flex-wrap:wrap')
  })

  it('desktop shell keeps the single top row, no corner counter', async () => {
    const html = await renderBoardShell()
    // Corner "Open engagements · N" text removed 2026-07-19.
    expect(html).not.toContain('Open engagements')
    expect(html).not.toContain('Back to classic') // Classic retired 2026-07-18
    // The Board/List toggle rides the right cluster instead.
    expect(html).toContain('aria-label="Engagements view"')
  })

  it('mobile overlay is a bottom sheet with contained overscroll', () => {
    setWidth(390)
    const html = renderToString(<OverlayShell isMobile onClose={() => {}}><div /></OverlayShell>)
    expect(html).toContain('border-radius:16px 16px 0 0') // T.radius.card sheet corners
    expect(html).toContain('overscroll-behavior:contain')
    expect(html).toContain('-webkit-overflow-scrolling:touch')
    // Header close affordance rides every sheet (aria-labelled X).
    expect(html).toMatch(/<button[^>]*aria-label="Close"[^>]*class="bee-sheet-close"|<button[^>]*class="bee-sheet-close"[^>]*aria-label="Close"/)
  })

  // iOS sheet geometry (the 2026-07-04 offscreen-header root cause): a vh
  // maxHeight resolves against iOS's LARGE viewport while the bottom
  // anchor sits at the VISIBLE bottom — the sheet's height cap must come
  // from the .bee-sheet class (vh fallback + dvh override + safe-area
  // padding), never from an inline vh value.
  it('sheet + modal height caps are dvh-based classes, never inline vh', () => {
    setWidth(390)
    const sheetHtml = renderToString(
      <OverlayShell isMobile onClose={() => {}}><div style={{ height: '2000px' }} /></OverlayShell>
    )
    const sheetTag = sheetHtml.match(/<div[^>]*class="bee-sheet"[^>]*>/)
    expect(sheetTag, 'sheet must carry the bee-sheet class').toBeTruthy()
    expect(sheetTag![0]).not.toMatch(/\d(vh|vw|dvh)/)
    expect(sheetHtml).toContain('.bee-sheet { max-height: 90vh; max-height: 90dvh; padding-bottom: env(safe-area-inset-bottom, 0px); }')

    const modalHtml = renderToString(
      <OverlayShell isMobile={false} onClose={() => {}}><div /></OverlayShell>
    )
    expect(modalHtml).toMatch(/<div[^>]*class="bee-overlay-modal"/)
    expect(modalHtml).toContain('.bee-overlay-modal { max-height: 88vh; max-height: 88dvh; }')
  })

  it('no beta surface sizes itself with inline viewport units (dvh pairs live in style blocks)', () => {
    setWidth(390)
    const rendered = [
      renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />),
      renderToString(<EngagementGroupedList engagements={ENGAGEMENTS as any} closedCount={2} />),
      renderToString(<ClientGroupedList people={PEOPLE as any} engagements={ENGAGEMENTS as any} />),
      renderToString(<OverlayShell isMobile onClose={() => {}}><div /></OverlayShell>),
      renderToString(<FilterPopover open count={0} onClear={() => {}}>x</FilterPopover>),
    ].join('\n')
    const offenders = [...rendered.matchAll(/style="([^"]*)"/g)]
      .map(m => m[1])
      .filter(s => /\d(vh|vw)/.test(s))
    expect(offenders, `inline viewport units found: ${JSON.stringify(offenders)}`).toEqual([])
    // FilterPopover carries its own dvh-capped class.
    expect(rendered).toContain('.bee-filter-pop { max-height: 62vh; max-height: 62dvh; }')
  })
})
