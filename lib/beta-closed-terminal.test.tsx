// @vitest-environment happy-dom
//
// Terminal-stage surfaces regression (board closed rail + the shared
// closed vocabulary). The flat EngagementList's chip/sort describes that
// used to live here were retired with the component (#136):
//   B) Board closed rail: collapsed by default; each All/Won/Lost
//      segment fetches its OWN count-capped, most-recently-closed-first
//      window (limit=40 → server .range(); stage=won|lost narrows
//      server-side like the List) and caches it — revisiting a segment
//      never refetches. NO date-window predicate anywhere: the old
//      one-mixed-window design starved Won behind 40 import-stamped
//      losses (NW Arkansas: 88 historical wins rendered "Empty").
//   C) Won/Lost bind to the AUDITED stage strings 'Closed Won' /
//      'Closed Lost' (prod audit 2026-07-04) via CLOSED_STAGE_FILTERS —
//      never closed_reason, which is asymmetric ('won'/'stale_on_import').
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'fs'
import EngagementBoard from '@/components/hive/EngagementBoard'
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
// Stage-aware, like the real route: stage=won|lost narrows server-side.
const fetchMock = vi.fn(async (url: any) => {
  fetchCalls.push(String(url))
  const stage = new URLSearchParams(String(url).split('?')[1] || '').get('stage')
  const rows = stage === 'won' ? CLOSED_ROWS.filter(r => r.stage === CLOSED_WON)
    : stage === 'lost' ? CLOSED_ROWS.filter(r => r.stage === CLOSED_LOST)
    : CLOSED_ROWS
  const total = stage === 'won' ? 680 : stage === 'lost' ? 695 : 1375
  return {
    ok: true,
    json: async () => ({ rows, total, offset: 0, limit: 40 }),
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

  it('Part 5: the collapsed rail reads as a real column — filled NEUTRAL token bg, not transparent', () => {
    const html = renderToString(
      <EngagementBoard engagements={OPEN_ENGAGEMENTS as any} closedCount={1375} />
    )
    // The rail button carries the gray-family (closed/past) token fill —
    // neutral, never red/green — so it doesn't wash into the warm canvas.
    const railStyle = html.match(/aria-label="Expand closed engagements"[^>]*style="([^"]*)"/)?.[1] || ''
    expect(railStyle).toContain('background:#F1EFE8')
    expect(railStyle).not.toContain('background:transparent')
  })

  it('each segment fetches its OWN server-narrowed capped window; revisits hit the cache', async () => {
    const container = mount(
      <EngagementBoard engagements={OPEN_ENGAGEMENTS as any} closedCount={1375} />
    )
    expect(fetchMock).not.toHaveBeenCalled()

    await fire(container.querySelector('[aria-label="Expand closed engagements"]')!)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchCalls[0]).toContain('closed=1')
    expect(fetchCalls[0]).toContain('limit=40') // explicit cap → server .range()
    expect(fetchCalls[0]).toContain('offset=0')
    expect(fetchCalls[0]).not.toContain('stage=') // 'all' = both stages

    // All window rendered: all three closed cards + the List hand-off line.
    expect(container.textContent).toContain('Wonnie Winner')
    expect(container.textContent).toContain('Lossie Loser')
    expect(container.textContent).toContain('Showing 3 most recent')
    expect(container.textContent).toContain('view all in List')

    // Won: its OWN server-narrowed window (same stage param as the List),
    // count-capped — NEVER a date predicate.
    const wonSeg = segButtons(container).find(b => (b.textContent || '') === 'Won')!
    await fire(wonSeg)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchCalls[1]).toContain('closed=1')
    expect(fetchCalls[1]).toContain('stage=won')
    expect(fetchCalls[1]).toContain('limit=40')
    expect(container.textContent).toContain('Wonnie Winner')
    expect(container.textContent).toContain('Vic Victory')
    expect(container.textContent).not.toContain('Lossie Loser')

    // Lost: same treatment, its own narrowed window.
    const lostSeg = segButtons(container).find(b => (b.textContent || '') === 'Lost')!
    await fire(lostSeg)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchCalls[2]).toContain('stage=lost')
    expect(container.textContent).toContain('Lossie Loser')
    expect(container.textContent).not.toContain('Wonnie Winner')

    // Revisiting fetched segments rides the cache — no new requests.
    await fire(segButtons(container).find(b => (b.textContent || '') === 'Won')!)
    await fire(segButtons(container).find(b => (b.textContent || '') === 'All')!)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // No request ever carries a date-window predicate — the bound is the
    // count cap + closed_at DESC ordering (server-side), nothing else.
    for (const u of fetchCalls) {
      expect(u).not.toMatch(/closed_at|since|from=|month|after|start/)
    }

    // Pipeline control collapses back to the rail.
    await fire(container.querySelector('[aria-label="Collapse to pipeline"]')!)
    expect(container.querySelector('[aria-label="Expand closed engagements"]')).toBeTruthy()
  })

  it('REGRESSION (NW Arkansas): 40 import-stamped recent losses no longer starve Won — historical wins from prior months surface', async () => {
    // The real failure shape: the mixed recency window is 100% Closed
    // Lost stamped with the import moment; every Closed Won carries a
    // REAL historical closed_at (months/years back). The old in-memory
    // narrowing rendered Won "Empty"; per-segment fetch must not.
    const staleLosses = Array.from({ length: 40 }, (_, i) =>
      eng({ stage: CLOSED_LOST, client_name: `Stale Lost ${i}`, closed_at: daysAgo(0), closed_reason: 'stale_on_import' }))
    const historicalWins = [
      eng({ stage: CLOSED_WON, client_name: 'Hattie Historical', closed_at: daysAgo(95), closed_reason: 'won' }),  // 3+ months back
      eng({ stage: CLOSED_WON, client_name: 'Yolanda Yesteryear', closed_at: daysAgo(400), closed_reason: 'won' }), // prior year
    ]
    const nwaMock = vi.fn(async (url: any) => {
      const stage = new URLSearchParams(String(url).split('?')[1] || '').get('stage')
      const rows = stage === 'won' ? historicalWins : stage === 'lost' ? staleLosses : staleLosses
      const total = stage === 'won' ? 88 : stage === 'lost' ? 76 : 164
      return { ok: true, json: async () => ({ rows, total, offset: 0, limit: 40 }) } as any
    })
    vi.stubGlobal('fetch', nwaMock)

    const container = mount(
      <EngagementBoard engagements={[] as any} closedCount={164} locFilter="loc-nwa-uuid" />
    )
    await fire(container.querySelector('[aria-label="Expand closed engagements"]')!)
    // Mixed window is all losses — the honest 'All' view.
    expect(container.textContent).toContain('Stale Lost 0')
    expect(container.textContent).not.toContain('Hattie Historical')

    // Won segment: historical closes appear despite ranking far past the
    // mixed window — and the location scope rides the request unchanged.
    await fire(segButtons(container).find(b => (b.textContent || '') === 'Won')!)
    const wonCall = nwaMock.mock.calls.map(c => String(c[0])).find(u => u.includes('stage=won'))!
    expect(wonCall).toContain('location_uuid=loc-nwa-uuid')
    expect(container.textContent).toContain('Hattie Historical')
    expect(container.textContent).toContain('Yolanda Yesteryear')
    expect(container.textContent).not.toContain('Stale Lost 0')
    // Bounded: the cap line reflects the segment's own total (88 wins).
    expect(container.textContent).toContain('Showing 2 most recent')
  })

  it('closed cards carry the won/lost left-edge cue via the semantic tokens', () => {
    const won = renderToString(<Card accent="var(--text-success, #1D9E75)">w</Card>)
    const lost = renderToString(<Card accent="var(--text-danger, #791F1F)">l</Card>)
    expect(won).toContain('border-left:3px solid var(--text-success')
    expect(lost).toContain('border-left:3px solid var(--text-danger')
  })
})
