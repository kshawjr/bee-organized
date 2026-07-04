// @vitest-environment happy-dom
//
// Terminal-stage surfaces regression (board closed rail + list won/lost
// filters + the pill-free secondary-header typography):
//   A) List filter segments render in the board's SECTION_LABEL type
//      treatment — NO pill background/radius; active = 2px underline.
//      List column headers: sentence case (no uppercase), sort carets
//      still render, sort handler still fires on click.
//   B) Board closed rail: collapsed by default; expands on click with
//      ONE capped fetch (limit=40 → server .range()); the All/Won/Lost
//      toggle filters the loaded window in memory — NO further fetch.
//   C) Won/Lost bind to the AUDITED stage strings 'Closed Won' /
//      'Closed Lost' (prod audit 2026-07-04) via CLOSED_STAGE_FILTERS —
//      never closed_reason, which is asymmetric ('won'/'stale_on_import').
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'fs'
import EngagementBoard from '@/components/hive/EngagementBoard'
import EngagementList from '@/components/hive/EngagementList'
import Card from '@/components/ui/Card'
import { CLOSED_STAGE_FILTERS, CLOSED_WON, CLOSED_LOST, ENGAGEMENT_STAGES } from '@/components/hive/shared/stageConfig'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

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

const OPEN_ENGAGEMENTS = [
  eng({ stage: 'Request', client_name: 'Rita Request' }),
  eng({ stage: 'Estimate', client_name: 'Ed Estimate', quotes: [{ id: 'q1', status: 'sent', total: 500, sent_at: daysAgo(2) }] }),
]

const CLOSED_ROWS = [
  eng({ stage: CLOSED_WON, client_name: 'Wonnie Winner', closed_at: daysAgo(1), closed_reason: 'won' }),
  eng({ stage: CLOSED_LOST, client_name: 'Lossie Loser', closed_at: daysAgo(2), closed_reason: 'stale_on_import' }),
  eng({ stage: CLOSED_WON, client_name: 'Vic Victory', closed_at: daysAgo(3), closed_reason: 'won' }),
]

let fetchCalls: string[] = []
const fetchMock = vi.fn(async (url: any) => {
  fetchCalls.push(String(url))
  return {
    ok: true,
    json: async () => ({ rows: CLOSED_ROWS, total: 1375, offset: 0, limit: 40 }),
  } as any
})

// happy-dom v20 ships no localStorage — stub one so useStoredState's
// write-through path runs for real instead of being try/catch-swallowed.
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

beforeEach(() => {
  fetchCalls = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  return container
}
const click = (node: Element) => new MouseEvent('click', { bubbles: true, cancelable: true })
async function fire(node: Element) {
  await act(async () => { node.dispatchEvent(click(node)) })
}
const segButtons = (container: Element) => [...container.querySelectorAll('button.bee-flt-seg')] as HTMLElement[]

describe('terminal stage vocabulary (audited against prod)', () => {
  it('won/lost bind to the exact stage strings, matching the terminal ENGAGEMENT_STAGES', () => {
    expect(CLOSED_STAGE_FILTERS.won).toEqual(['Closed Won'])
    expect(CLOSED_STAGE_FILTERS.lost).toEqual(['Closed Lost'])
    expect(CLOSED_STAGE_FILTERS.closed).toEqual(['Closed Won', 'Closed Lost'])
    const terminals = ENGAGEMENT_STAGES.filter(s => s.terminal).map(s => s.key)
    expect(terminals).toEqual(CLOSED_STAGE_FILTERS.closed)
  })

  it('the closed API route uses the shared vocabulary and a bounded .range() — never a bare .select()', () => {
    const src = readFileSync('app/api/engagements/route.ts', 'utf8')
    expect(src).toContain('CLOSED_STAGE_FILTERS')
    expect(src).toMatch(/\.range\(/)
    // No hardcoded terminal stage literals left in the query path.
    expect(src).not.toMatch(/\.in\('stage',\s*\[/)
  })
})

describe('list filter segments — board typography, no pills, underline active', () => {
  it('renders plain-text segments with SECTION_LABEL type and no pill background', () => {
    const html = renderToString(
      <EngagementList engagements={OPEN_ENGAGEMENTS as any} closedCount={1375} closedWonCount={680} />
    )
    const segs = [...html.matchAll(/<button class="bee-flt-seg"[^>]*style="([^"]*)"/g)].map(m => m[1])
    expect(segs.length).toBeGreaterThanOrEqual(8) // Open + 4 stages + Closed/Won/Lost
    for (const s of segs) {
      expect(s).not.toContain('border-radius:20px')
      expect(s).not.toContain('background:#fff')
      expect(s).toContain('font-size:12px')
      expect(s).toContain('font-weight:500')
    }
    // Active (Open by default) signals with the 2px --text-primary underline.
    const underlined = segs.filter(s => s.includes('border-bottom:2px solid var(--text-primary'))
    expect(underlined.length).toBe(1)
  })

  it('adds divider + Closed/Won/Lost segments with semantic token colors and counts', () => {
    const html = renderToString(
      <EngagementList engagements={OPEN_ENGAGEMENTS as any} closedCount={1375} closedWonCount={680} />
    )
    expect(html).toMatch(/aria-hidden="true" style="width:1px/) // the divider rule
    expect(html).toContain('var(--text-success')
    expect(html).toContain('var(--text-danger')
    // SSR puts a comment node between the middot and the count.
    expect(html).toMatch(/· (<!-- -->)?1375/)                   // Closed count
    expect(html).toMatch(/· (<!-- -->)?680/)                    // Won count
    expect(html).toMatch(/· (<!-- -->)?695/)                    // Lost = closed − won
  })

  it('column headers are sentence case with sort carets intact', () => {
    const html = renderToString(
      <EngagementList engagements={OPEN_ENGAGEMENTS as any} closedCount={0} closedWonCount={0} />
    )
    const headers = [...html.matchAll(/<button class="bee-sort-header"[^>]*style="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)]
    expect(headers.length).toBe(6) // Client/Engagement/Stage/Status/Value/Activity
    for (const [, style, inner] of headers) {
      expect(style).not.toContain('text-transform:uppercase')
      expect(style).not.toContain('letter-spacing')
      expect(style).toContain('font-size:12px')
      expect(inner).toContain('<svg') // sort caret still renders
    }
    expect(html).toContain('>Client<')
    expect(html).not.toContain('>CLIENT<')
  })

  it('sort handler still fires on header click', async () => {
    const container = mount(
      <EngagementList engagements={OPEN_ENGAGEMENTS as any} closedCount={0} closedWonCount={0} />
    )
    const valueHeader = [...container.querySelectorAll('button.bee-sort-header')]
      .find(b => (b.textContent || '').startsWith('Value'))!
    expect(valueHeader).toBeTruthy()
    await fire(valueHeader)
    const stored = JSON.parse(lsMock.getItem('bee_hive_list_sort') || 'null')
    expect(stored?.col).toBe('value')
    expect(stored?.dir).toBe('desc')
  })

  it('Won/Lost filters query the server with the narrowed stage param', async () => {
    const container = mount(
      <EngagementList engagements={OPEN_ENGAGEMENTS as any} closedCount={1375} closedWonCount={680} />
    )
    const wonSeg = segButtons(container).find(b => (b.textContent || '').startsWith('Won'))!
    await fire(wonSeg)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchCalls[0]).toContain('closed=1')
    expect(fetchCalls[0]).toContain('stage=won')
    expect(container.textContent).toContain('Wonnie Winner')

    const lostSeg = segButtons(container).find(b => (b.textContent || '').startsWith('Lost'))!
    await fire(lostSeg)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchCalls[1]).toContain('stage=lost')
  })
})

describe('board closed rail', () => {
  it('is collapsed by default — vertical rail, no fetch, no expanded chrome', () => {
    const html = renderToString(
      <EngagementBoard engagements={OPEN_ENGAGEMENTS as any} closedCount={1375} />
    )
    expect(html).toContain('aria-label="Expand closed engagements"')
    expect(html).toContain('writing-mode:vertical-rl')
    expect(html).not.toContain('view all in List')
    expect(html).not.toContain('aria-label="Collapse to pipeline"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('expands on click with ONE capped fetch; the All/Won/Lost toggle never refetches', async () => {
    const container = mount(
      <EngagementBoard engagements={OPEN_ENGAGEMENTS as any} closedCount={1375} />
    )
    expect(fetchMock).not.toHaveBeenCalled()

    await fire(container.querySelector('[aria-label="Expand closed engagements"]')!)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchCalls[0]).toContain('closed=1')
    expect(fetchCalls[0]).toContain('limit=40') // explicit cap → server .range()
    expect(fetchCalls[0]).toContain('offset=0')

    // Window rendered: all three closed cards + the List hand-off line.
    expect(container.textContent).toContain('Wonnie Winner')
    expect(container.textContent).toContain('Lossie Loser')
    expect(container.textContent).toContain('Showing 3 most recent')
    expect(container.textContent).toContain('view all in List')

    // Won: in-memory narrowing, NO new request.
    const wonSeg = segButtons(container).find(b => (b.textContent || '') === 'Won')!
    await fire(wonSeg)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Wonnie Winner')
    expect(container.textContent).toContain('Vic Victory')
    expect(container.textContent).not.toContain('Lossie Loser')

    // Lost: same window, still no new request.
    const lostSeg = segButtons(container).find(b => (b.textContent || '') === 'Lost')!
    await fire(lostSeg)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Lossie Loser')
    expect(container.textContent).not.toContain('Wonnie Winner')

    // Pipeline control collapses back to the rail.
    await fire(container.querySelector('[aria-label="Collapse to pipeline"]')!)
    expect(container.querySelector('[aria-label="Expand closed engagements"]')).toBeTruthy()
  })

  it('closed cards carry the won/lost left-edge cue via the semantic tokens', () => {
    const won = renderToString(<Card accent="var(--text-success, #1D9E75)">w</Card>)
    const lost = renderToString(<Card accent="var(--text-danger, #791F1F)">l</Card>)
    expect(won).toContain('border-left:3px solid var(--text-success')
    expect(lost).toContain('border-left:3px solid var(--text-danger')
  })
})
