// @vitest-environment happy-dom
//
// The unrouted queue, ten at a time (30 Sept 2026).
//
// "Corporate · Not yet routed" at the top of the Inbox used to load the 50
// newest loc_other leads and nothing more. Zip routing took the queue from
// ~30 a month to ~190, so a backlog over 50 became possible — and the OLDEST
// leads would have dropped silently off the bottom.
//
// Kevin's decision: don't show more at once. Ten at a time, forward and back,
// with the true total. Pinned here:
//   · ten rows, with the true total shown
//   · paging forward and back
//   · more than fifty waiting are ALL reachable (the load has no cap)
//   · oldest first — the longest wait is page 1, whatever the Inbox sort says
//   · the zip shows on the row
//   · a zip that matches a location shows which, and the picker opens on it
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))

import InboxScreen from '@/components/hive/InboxScreen'
import {
  fetchTransferQueueRows,
  pageOfQueue,
  TRANSFER_QUEUE_PAGE_SIZE,
} from '@/lib/transfer-queue'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// ── a stand-in for the leads table that behaves like Supabase ───────────────
// Honours the filters, the order, .range() AND .limit(), and — like the real
// thing — never returns more than 1,000 rows in one response.
function leadsTable(rows: any[]) {
  const reads: Array<{ ops: [string, any[]][] }> = []
  const from = (table: string) => {
    const call = { ops: [] as [string, any[]][] }
    reads.push(call)
    const b: any = {}
    for (const m of ['select', 'eq', 'not', 'is', 'order', 'range', 'limit', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.then = (res: any, rej: any) => {
      let out = rows.filter(r => table === 'leads')
      for (const [m, a] of call.ops) {
        if (m === 'eq') out = out.filter(r => r[a[0]] === a[1])
        if (m === 'not' && a[1] === 'is') out = out.filter(r => r[a[0]] !== a[2])
        if (m === 'is') out = out.filter(r => (r[a[0]] ?? null) === a[1])
      }
      const orders = call.ops.filter(([m]) => m === 'order').map(([, a]) => a)
      out = [...out].sort((x, y) => {
        for (const [col, opt] of orders) {
          const d = String(x[col]).localeCompare(String(y[col]))
          if (d) return opt?.ascending === false ? -d : d
        }
        return 0
      })
      const range = call.ops.find(([m]) => m === 'range')?.[1]
      const limit = call.ops.find(([m]) => m === 'limit')?.[1]?.[0]
      if (range) out = out.slice(range[0], range[1] + 1)
      if (limit != null) out = out.slice(0, limit)
      out = out.slice(0, 1000)
      return Promise.resolve({ data: out, error: null }).then(res, rej)
    }
    return b
  }
  return { sb: { from }, reads }
}

const iso = (minutesAgo: number) => new Date(Date.UTC(2026, 8, 30, 12, 0, 0) - minutesAgo * 60000).toISOString()
// n leads waiting at loc_other: lead 1 has waited longest.
const waiting = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `lead-${String(i + 1).padStart(5, '0')}`,
  location_id: 'loc_other', is_junk: false, archived_at: null,
  created_at: iso((n - i) * 7),
}))

describe('the load — everything waiting, no cap', () => {
  it('more than fifty waiting are ALL loaded (60 of 60)', async () => {
    const { sb } = leadsTable(waiting(60))
    const out = await fetchTransferQueueRows(sb)
    expect(out.error).toBeNull()
    expect(out.truncated).toBe(false)
    expect(out.rows).toHaveLength(60)
  })

  it('oldest first — the lead that has waited longest comes back first', async () => {
    const { sb, reads } = leadsTable(waiting(60))
    const out = await fetchTransferQueueRows(sb)
    expect(out.rows[0].id).toBe('lead-00001')
    expect(out.rows[59].id).toBe('lead-00060')
    expect(reads[0].ops.filter(([m]) => m === 'order').map(([, a]) => a)).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })

  it("keeps walking past Supabase's 1,000-row ceiling (2,300 of 2,300, three reads)", async () => {
    const { sb, reads } = leadsTable(waiting(2300))
    const out = await fetchTransferQueueRows(sb)
    expect(out.rows).toHaveLength(2300)
    expect(new Set(out.rows.map(r => r.id)).size).toBe(2300)
    expect(reads).toHaveLength(3)
  })

  it('only loc_other, and never junk or archived (the shared active-lead rule)', async () => {
    const rows = [
      ...waiting(3),
      { id: 'junk', location_id: 'loc_other', is_junk: true, archived_at: null, created_at: iso(1) },
      { id: 'archived', location_id: 'loc_other', is_junk: false, archived_at: iso(1), created_at: iso(1) },
      { id: 'elsewhere', location_id: 'loc_dallas', is_junk: false, archived_at: null, created_at: iso(1) },
    ]
    const out = await fetchTransferQueueRows(leadsTable(rows).sb)
    expect(out.rows.map(r => r.id)).toEqual(['lead-00001', 'lead-00002', 'lead-00003'])
  })

  it('a failed read reports the error rather than an empty queue that looks healthy', async () => {
    const sb = { from: () => { const b: any = {}; for (const m of ['select', 'eq', 'not', 'is', 'order', 'range']) b[m] = () => b; b.then = (r: any) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r); return b } }
    const out = await fetchTransferQueueRows(sb)
    expect(out.error).toEqual({ message: 'boom' })
    expect(out.rows).toEqual([])
  })

  it('the page load uses it — no row limit and no slice on the queue any more (source pin)', () => {
    const src = readFileSync('app/_hub-page.tsx', 'utf8')
    const block = src.slice(src.indexOf('let initialTransferPeople'), src.indexOf('/clients/[id] passes initialSelectedLeadId'))
    expect(block).toContain('await fetchTransferQueueRows(supabaseService)')
    expect(block).not.toMatch(/\.limit\(/)
    expect(block).not.toMatch(/\.slice\(0,/)
    expect(readFileSync('lib/hub-scope.ts', 'utf8')).not.toMatch(/export const TRANSFER_QUEUE_MAX/)
  })
})

describe('pageOfQueue — which ten are on screen', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => i + 1)

  it('ten at a time, with the true total', () => {
    expect(TRANSFER_QUEUE_PAGE_SIZE).toBe(10)
    const p = pageOfQueue(sixty, 0)
    expect(p.rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(p).toMatchObject({ total: 60, pages: 6, from: 1, to: 10, hasPrev: false, hasNext: true })
  })

  it('every one of sixty is on exactly one page', () => {
    const seen: number[] = []
    for (let i = 0; i < pageOfQueue(sixty, 0).pages; i++) seen.push(...pageOfQueue(sixty, i).rows)
    expect(seen).toEqual(sixty)
  })

  it('a short last page, and no Next after it', () => {
    const p = pageOfQueue(sixty.slice(0, 23), 2)
    expect(p.rows).toEqual([21, 22, 23])
    expect(p).toMatchObject({ from: 21, to: 23, total: 23, hasPrev: true, hasNext: false })
  })

  it('clamps: routing the last lead on the last page steps back instead of going blank', () => {
    const p = pageOfQueue(sixty.slice(0, 20), 2) // page 3 no longer exists
    expect(p.page).toBe(1)
    expect(p.rows).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    expect(pageOfQueue([], 4)).toMatchObject({ rows: [], page: 0, pages: 1, total: 0, from: 0, to: 0 })
    expect(pageOfQueue(sixty, -3).page).toBe(0)
  })
})

// ── the screen ──────────────────────────────────────────────────────────────
const now = Date.now()
const lead = (i: number, over: any = {}) => ({
  id: `q-${String(i).padStart(3, '0')}`,
  name: `Waiting ${String(i).padStart(3, '0')}`,
  email: `w${i}@x.com`, phone: '', phoneNormalized: '',
  locationId: 'loc-other-uuid',
  // lead 1 has waited longest
  created: new Date(now - (500 - i) * 3600000).toISOString(),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  outreachTimeline: [], atLocOther: true,
  originCity: null, originState: null, originZip: null, project: '',
  ...over,
})
// Handed over NEWEST first on purpose — the screen must put them in order.
const queue = (n: number) => Array.from({ length: n }, (_, i) => lead(n - i))

const TARGETS = [
  { id: 'uuid-lkn', name: 'Lake Norman', slug: 'loc_lakenorman', lifecycle_status: 'active', owner_name: 'Dana Lee' },
  { id: 'uuid-omaha', name: 'Omaha', slug: 'loc_omaha', lifecycle_status: 'onboarding', owner_name: null },
  { id: 'uuid-cden', name: 'Central Denver', slug: 'loc_centraldenver', lifecycle_status: 'active', owner_name: 'A' },
]
beforeEach(() => {
  ;(globalThis as any).fetch = vi.fn(async (url: any) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('/api/locations/transfer-targets') ? { targets: TARGETS } : {}),
  }))
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const flush = async () => { await act(async () => { await Promise.resolve() }); await act(async () => { await Promise.resolve() }) }
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })

const section = (host: HTMLElement) => host.querySelector('#bee-inbox-sec-transfer') as HTMLElement
const rowNames = (host: HTMLElement) =>
  Array.from(section(host).textContent!.matchAll(/Waiting \d{3}/g)).map(m => m[0])
    .filter((v, i, a) => a.indexOf(v) === i)
const pagerText = (host: HTMLElement) => host.querySelector('[data-testid="transfer-pager"]')?.textContent || ''
const pagerBtn = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll('[data-testid="transfer-pager"] button')).find(b => b.textContent === label) as HTMLButtonElement
// The row's "Another location…" — opens the transfer window.
const routeButtons = (host: HTMLElement) => section(host).querySelectorAll('button[aria-label="Another location"]')

describe('Inbox — the unrouted queue shows ten at a time', () => {
  it('ten rows, with the true total shown', async () => {
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={queue(23)} engagements={[]} locFilter="all" />)
    expect(routeButtons(host)).toHaveLength(10)
    expect(section(host).textContent).toContain('Not yet routed · 23')
    expect(pagerText(host)).toContain('Showing 1–10 of 23')
    await unmount()
  })

  it('oldest first: page 1 is the ten who have waited longest', async () => {
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={queue(23)} engagements={[]} locFilter="all" />)
    expect(rowNames(host)).toEqual(Array.from({ length: 10 }, (_, i) => `Waiting ${String(i + 1).padStart(3, '0')}`))
    await unmount()
  })

  it('paging forward and back', async () => {
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={queue(23)} engagements={[]} locFilter="all" />)
    expect(pagerBtn(host, 'Previous').disabled).toBe(true)
    await click(pagerBtn(host, 'Next'))
    expect(pagerText(host)).toContain('Showing 11–20 of 23')
    expect(rowNames(host)[0]).toBe('Waiting 011')
    await click(pagerBtn(host, 'Next'))
    expect(pagerText(host)).toContain('Showing 21–23 of 23')
    expect(rowNames(host)).toEqual(['Waiting 021', 'Waiting 022', 'Waiting 023'])
    expect(pagerBtn(host, 'Next').disabled).toBe(true)
    await click(pagerBtn(host, 'Previous'))
    expect(pagerText(host)).toContain('Showing 11–20 of 23')
    await click(pagerBtn(host, 'Previous'))
    expect(pagerText(host)).toContain('Showing 1–10 of 23')
    expect(rowNames(host)[0]).toBe('Waiting 001')
    await unmount()
  })

  it('more than fifty waiting are all reachable — every one of 60 comes up, once', async () => {
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={queue(60)} engagements={[]} locFilter="all" />)
    expect(section(host).textContent).toContain('Not yet routed · 60')
    const seen: string[] = [...rowNames(host)]
    while (!pagerBtn(host, 'Next').disabled) {
      await click(pagerBtn(host, 'Next'))
      expect(routeButtons(host).length).toBeLessThanOrEqual(10)
      seen.push(...rowNames(host))
    }
    expect(seen).toHaveLength(60)
    expect(new Set(seen).size).toBe(60)
    expect(seen[59]).toBe('Waiting 060')
    await unmount()
  })

  it('ten or fewer: no pager at all — nothing to page', async () => {
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={queue(10)} engagements={[]} locFilter="all" />)
    expect(routeButtons(host)).toHaveLength(10)
    expect(host.querySelector('[data-testid="transfer-pager"]')).toBeNull()
    await unmount()
  })
})

// ── the zip, and who it would have matched ──────────────────────────────────
// The old separate zip hint (zipHintFor / fetchZipHintMatches / attachZipHints)
// was retired 20 Oct 2026: the row now shows the Slack card's own suggestion
// (beta-route-chips.test.tsx). These pin that it is gone.
describe('the old zip hint is retired', () => {
  it('lib/transfer-queue no longer exports it, and the page load no longer attaches it', async () => {
    const mod: any = await import('@/lib/transfer-queue')
    expect(mod.zipHintFor).toBeUndefined()
    expect(mod.fetchZipHintMatches).toBeUndefined()
    expect(mod.attachZipHints).toBeUndefined()
    const src = readFileSync('app/_hub-page.tsx', 'utf8')
    expect(src).not.toContain('attachZipHints')
    expect(src).not.toContain('fetchZipHintMatches')
  })
})

describe('Inbox — the row says where the lead is', () => {
  const one = (over: any) => [lead(1, { name: 'Zip Lead', project: 'Garage', ...over })]

  it('the zip shows on the row', async () => {
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={one({ originZip: '28078' })} engagements={[]} locFilter="all" />)
    expect(section(host).textContent).toContain('28078 · Garage · from global form')
    await unmount()
  })

  it('the row never shows the old "→ Location" hint, whatever the zip', async () => {
    const people = [lead(1, { name: 'A', originZip: '68102' }), lead(2, { name: 'B', originZip: '80202' })]
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={people} engagements={[]} locFilter="all" />)
    const text = section(host).textContent!
    expect(text).not.toContain('→')
    expect(text).not.toContain('no location has this zip')
    expect(text).not.toContain('not live yet')
    await unmount()
  })

  it('"Another location…" opens the picker with nothing pre-selected — a person chooses', async () => {
    const { host, unmount } = await mount(<InboxScreen people={[]} transferPeople={one({ originZip: '28078' })} engagements={[]} locFilter="all" />)
    await click(routeButtons(host)[0])
    await flush()
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0)
    await unmount()
  })
})
