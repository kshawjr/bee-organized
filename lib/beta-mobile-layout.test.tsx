// Beta mobile-layout regression: renders the shell + beta surfaces with
// the mobile branch forced (globalThis.__BEE_TEST_WIDTH__ seeds
// useIsMobile, since renderToString never runs effects) and asserts the
// 2026-07-04 mobile rules hold:
//   - shell chrome STACKS: tab pills on one nowrap scroll line, the
//     open-engagements counter + 'Back to classic' on a second compact
//     11px line (nothing shares a line with the pills → nothing overlaps)
//   - chip strips stay single-line horizontal scrollers (nowrap)
//   - overlays are bottom sheets with contained overscroll
// Born from Kevin's 2026-07-04 mobile screenshots (overlapping shell row).
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import HiveShell from '@/components/hive/HiveShell'
import EngagementList from '@/components/hive/EngagementList'
import ClientDirectory from '@/components/hive/ClientDirectory'
import PersonCard from '@/components/hive/PersonCard'
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
afterEach(() => setWidth(undefined))

describe('beta mobile layout', () => {
  it('mobile shell stacks: pills scroll on row 1, counter + escape hatch on a compact row 2', () => {
    setWidth(390)
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)

    // Row 1: a nowrap horizontal scroller holding the four tab pills.
    const strip = html.match(/<div style="([^"]*overflow-x:auto[^"]*)">(.*?)<\/div>/)
    expect(strip, 'tab strip scroll container missing').toBeTruthy()
    for (const label of ['Inbox', 'Board', 'List', 'Clients']) expect(strip![2]).toContain(label)

    // Row 2: counter left + Back to classic right in a space-between line,
    // 11px quiet — and NOT inside the pill strip.
    const metaLine = html.match(/<div style="[^"]*justify-content:space-between[^"]*">(.*?)<\/div>/)
    expect(metaLine, 'compact meta line missing').toBeTruthy()
    expect(metaLine![1]).toContain('Open engagements')
    expect(metaLine![1]).toContain('Back to classic')
    expect(metaLine![1]).toContain('font-size:11px')
    expect(strip![2]).not.toContain('Open engagements')
    expect(strip![2]).not.toContain('Back to classic')

    // Nothing in the shell header may wrap (wrap = the old collision).
    expect(html.slice(0, html.indexOf('Back to classic'))).not.toContain('flex-wrap:wrap')
  })

  it('desktop shell keeps the single top row (counter inline, 12px)', () => {
    const html = renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)
    expect(html).toContain('Open engagements')
    expect(html).toContain('Back to classic')
    expect(html).toMatch(/font-size:12px[^"]*"[^>]*>Open engagements/)
  })

  it('directory chip row is a single-line nowrap scroller with the filter pill beside it', () => {
    setWidth(390)
    const html = renderToString(<ClientDirectory people={PEOPLE as any} engagements={ENGAGEMENTS as any} />)
    const strip = html.match(/<div style="([^"]*overflow-x:auto[^"]*)">/)
    expect(strip, 'chip scroll strip missing').toBeTruthy()
    expect(strip![1]).toContain('flex-wrap:nowrap')
    expect(html).toMatch(/Filter(s| &(amp;)? sort)/)
  })

  it('list chip row WRAPS (both collapse groups can expand at once) — never an off-screen scroller', () => {
    setWidth(390)
    const list = renderToString(<EngagementList engagements={ENGAGEMENTS as any} closedCount={2} />)
    // The wrap-mode strip carries the two-axis gap; assert it wraps and
    // dropped the horizontal scroller.
    const strip = list.match(/<div style="([^"]*gap:2px 14px[^"]*)">/)
    expect(strip, 'wrapping chip strip missing').toBeTruthy()
    expect(strip![1]).toContain('flex-wrap:wrap')
    expect(strip![1]).not.toContain('overflow-x:auto')
    expect(list).toMatch(/Filter(s| &(amp;)? sort)/)
    // Mobile list = two-line rows, never the desktop sort-header grid.
    expect(list).not.toContain('class="bee-sort-header"')
  })

  it('mobile overlay is a bottom sheet with contained overscroll', () => {
    setWidth(390)
    const html = renderToString(<PersonCard person={PEOPLE[0] as any} onClose={() => {}} />)
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
      renderToString(<EngagementList engagements={ENGAGEMENTS as any} closedCount={2} />),
      renderToString(<ClientDirectory people={PEOPLE as any} engagements={ENGAGEMENTS as any} />),
      renderToString(<PersonCard person={PEOPLE[0] as any} onClose={() => {}} />),
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
