// @vitest-environment happy-dom
//
// Clients at scale, slice 3 — Show more on the Client List, and the real
// client total on Home (lib/client-search.ts browseClients,
// app/api/clients/browse, ClientGroupedList.jsx, shared/clientTotal.js,
// BeeHub.jsx Home tiles, lib/hub-all-overview.ts).
//
// The two to prove hardest: COMPLETE when asked for (pressing Show more to the
// end lists every client, once), and UNTOUCHED for everyone else (a location
// that loaded in full renders byte-for-byte what it did and asks nothing).
//   1) opening Nurturing on a cut-off location shows a page, not everything
//   2) Show more appends the next page and says how many remain
//   3) to the end: every client, no duplicates, none missing — at 18,830 too
//   4) a row that is not Nurturing is not shown in Nurturing
//   5) a fully-loaded location: no Show more, no query, same HTML as before
//   6) a search is slice 1's behaviour; clearing it returns to the same place
//   7) Home's Everyone equals the Client List's total, exact on a cut-off
//      location, and says so when it cannot be counted
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

import { browseClients, CLIENT_BROWSE_PAGE } from '@/lib/client-search'
import { buildAllOverview } from '@/lib/hub-all-overview'
import { clientTotal as clientTotalUntyped } from '@/components/hive/shared/clientTotal'
// clientTotal.js is an untyped pure JS module; typed here at the boundary.
const clientTotal = clientTotalUntyped as (a: { listedCount: number; leadsTruncated: boolean; clientsCutoff: { loadedBackTo: string | null; notListed: number | null } | null }) => number | null
import ClientGroupedList, { NO_CLIENT_BROWSE, CLIENT_SEARCH_DEBOUNCE_MS } from '@/components/hive/ClientGroupedList'
import App from '@/components/BeeHub'
import { fakeDb, type Call } from '@/lib/fake-postgrest.test.harness'
import { completeLoadFingerprints, completeLoadProps } from '@/lib/client-list-fingerprint.test.harness'

const LOC_A = '11111111-1111-4111-8111-111111111111'
const LOC_B = '22222222-2222-4222-8222-222222222222'
const CUT = '2025-01-06T15:31:01.000Z'
const OLD = '2024-11-15T18:21:06.000Z'
const NEW = '2026-03-01T10:00:00.000Z'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// ═══ the server: browseClients ═══════════════════════════════════════════════
const lead = (over: any) => ({
  id: over.id, name: over.id, first_name: null, last_name: null, email: 'a@x.com', phone: '610-555-0000',
  location_uuid: LOC_A, location_id: 'loc_a', is_junk: null, archived_at: null,
  created_at: OLD, import_source: 'jobber_initial', stage: 'Nurturing', addresses: [], paid_amount: 0,
  ...over,
})
function serverWorld() {
  const names = ['Abel', 'abel lower', 'Bea "Quote" Smith', 'Carl, Jr.', 'Dee (Mobile)', 'Eve\\Back', 'Fay', 'Fay', 'Gus', 'Hal', null, null, '']
  const leads = names.map((name, i) => lead({ id: uuid(i + 1), name }))
  leads.push(
    lead({ id: uuid(50), name: 'Newer Nell', created_at: NEW }),                    // the page already holds her
    lead({ id: uuid(51), name: 'Cut Tie', created_at: CUT }),                       // exactly on the cut-off
    lead({ id: uuid(60), name: 'Junked Joe', is_junk: true }),
    lead({ id: uuid(61), name: 'Archived Ann', archived_at: OLD }),
    lead({ id: uuid(70), name: 'Elsewhere Ed', location_uuid: LOC_B, location_id: 'loc_b' }),
  )
  return {
    leads, engagements: [], touchpoints: [], lookups: [], lead_tags: [], lead_notes: [], lead_contacts: [],
    assessments: [], service_requests: [], quotes: [], jobs: [], invoices: [], lead_assignees: [], partners: [],
  } as Record<string, any[]>
}
async function walk(db: any, limit: number) {
  const pages: any[][] = []
  let after: any = null
  for (let i = 0; i < 50; i++) {
    const r = await browseClients(db, { locationUuid: LOC_A, olderThan: CUT, after, limit })
    pages.push(r.people)
    after = r.next
    if (!after) break
  }
  return pages
}

describe('browseClients — the older clients, a page at a time', () => {
  it('walks every client on or before the cut-off exactly once, whatever the page size', async () => {
    const w = serverWorld()
    const want = w.leads
      .filter(l => l.location_uuid === LOC_A && l.is_junk !== true && l.archived_at == null && l.created_at <= CUT)
      .map(l => l.id).sort()
    expect(want.length).toBe(14)
    for (const limit of [1, 2, 3, 5, 14, 500]) {
      const { db } = fakeDb(w)
      const pages = await walk(db, limit)
      const got = pages.flat().map(p => p.id)
      expect(new Set(got).size, `limit ${limit}: duplicates`).toBe(got.length)
      expect([...got].sort(), `limit ${limit}: missing`).toEqual(want)
      for (const pg of pages) expect(pg.length).toBeLessThanOrEqual(limit)
      // and not one request more than the pages there are
      expect(pages.length, `limit ${limit}: page count`).toBe(Math.ceil(14 / limit))
    }
  })

  it('pages by name, nameless clients last; names with quotes, commas, brackets and backslashes do not break the cursor', async () => {
    const { db } = fakeDb(serverWorld())
    const names = (await walk(db, 2)).flat().map(p => p.name)
    // (the page-load mapper shows a missing name as "(unnamed)")
    const named = names.filter(n => n !== '(unnamed)')
    expect(named.length).toBe(11)
    expect(named).toEqual([...named].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(names.slice(-2)).toEqual(['(unnamed)', '(unnamed)'])
    expect(names).toContain('Bea "Quote" Smith')
    expect(names).toContain('Eve\\Back')
  })

  it('only this location, not junk, not archived, nothing newer than the cut-off — on every read', async () => {
    const { db, calls } = fakeDb(serverWorld())
    const ids = (await walk(db, 3)).flat().map(p => p.id)
    for (const bad of [uuid(50), uuid(60), uuid(61), uuid(70)]) expect(ids).not.toContain(bad)
    expect(ids).toContain(uuid(51))   // inclusive: imports share timestamps
    const reads = calls.filter((c: Call) => c.table === 'leads')
    expect(reads.length).toBeGreaterThan(3)
    for (const c of reads) {
      expect(c.filters).toContain(`eq:location_uuid:${LOC_A}`)
      expect(c.filters).toContain('not:is_junk:is:true')
      expect(c.filters).toContain('is:archived_at:null')
      expect(c.filters.some(f => f.startsWith('lte:created_at:'))).toBe(true)
    }
    expect(CLIENT_BROWSE_PAGE).toBe(500)
  })

  it('without a cut-off date it returns nothing at all', async () => {
    const db = { from: () => { throw new Error('must not query') } }
    expect(await browseClients(db, { locationUuid: LOC_A, olderThan: '' })).toEqual({ people: [], next: null })
    expect(await browseClients(db, { locationUuid: LOC_A, olderThan: 'not a date' })).toEqual({ people: [], next: null })
  })
})

// The route, called directly.
const session = vi.hoisted(() => ({ role: 'owner', location_id: '', user: true as boolean, db: null as any }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user ? { id: 'u1' } : null } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'u1', role: session.role, location_id: session.location_id }, error: null }) }) }) }),
  }),
}))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => session.db.from(t) } }))

describe('GET /api/clients/browse, called directly', () => {
  const call = async (qs: string) => {
    const { GET } = await import('@/app/api/clients/browse/route')
    const res = await GET(new Request(`http://x/api/clients/browse?${qs}`))
    return { status: res.status, body: await res.json() }
  }
  let calls: Call[]
  beforeEach(() => {
    const f = fakeDb(serverWorld()); session.db = f.db; calls = f.calls
    session.role = 'owner'; session.location_id = LOC_A; session.user = true
  })
  const cut = `olderThan=${encodeURIComponent(CUT)}`

  it("another location's id is a 403 and nothing is read; lite_user browses their own", async () => {
    expect((await call(`${cut}&location=${LOC_B}`)).status).toBe(403)
    expect(calls.length).toBe(0)
    session.role = 'lite_user'
    const r = await call(cut)
    expect(r.status).toBe(200)
    expect(r.body.people.length).toBe(14)
    expect(r.body.people.every((p: any) => p.locationId === LOC_A)).toBe(true)
  })

  it('needs the cut-off date, a signed-in user and a well-formed cursor', async () => {
    expect((await call('')).status).toBe(400)
    expect((await call(`${cut}&afterId=nope`)).status).toBe(400)
    session.user = false
    expect((await call(cut)).status).toBe(401)
  })

  it('the cursor carries on from the row it names', async () => {
    const first = (await call(cut)).body.people
    const third = first[2]
    const rest = (await call(`${cut}&afterId=${third.id}&afterName=${encodeURIComponent(third.name)}`)).body.people
    expect(rest.map((p: any) => p.id)).toEqual(first.slice(3).map((p: any) => p.id))
  })
})

// ═══ the screen ══════════════════════════════════════════════════════════════
const person = (id: string, name: string, over: any = {}) => ({
  id, name, email: `${id}@x.com`, phone: '610-555-0000', locationId: LOC_A, created: NEW,
  tagIds: [], outreachTimeline: [], importSource: 'jobber_initial', ...over,
})
const pad = (n: number, w = 5) => String(n).padStart(w, '0')
// Loaded and older clients interleave through the alphabet, as real ones do.
const loadedNurturing = (n: number) => Array.from({ length: n }, (_, i) => person(`L${pad(i)}`, `Client ${pad(i * 3 + 1)} loaded`))
const olderClients = (n: number) => Array.from({ length: n }, (_, i) => person(`S${pad(i)}`, `Client ${pad(i)} older`, { created: OLD }))

// A stand-in for GET /api/clients/browse over `server`, `pageSize` at a time.
function browseServer(server: any[], pageSize: number, opts: { failOn?: number[] } = {}) {
  const sorted = [...server].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
  const seen: URL[] = []
  const fn = vi.fn(async (input: any) => {
    const url = new URL(String(input), 'http://x')
    if (url.pathname === '/api/clients/search') return { ok: true, status: 200, json: async () => ({ people: [], total: 0, capped: false }) }
    if (url.pathname !== '/api/clients/browse') throw new Error(`unexpected request ${url.pathname}`)
    seen.push(url)
    if (opts.failOn?.includes(seen.length)) return { ok: false, status: 500, json: async () => ({}) }
    const afterId = url.searchParams.get('afterId'), afterName = url.searchParams.get('afterName')
    const from = afterId ? sorted.findIndex(p => p.name > afterName! || (p.name === afterName && p.id > afterId)) : 0
    const page = from < 0 ? [] : sorted.slice(from, from + pageSize)
    const more = from >= 0 && from + pageSize < sorted.length
    const last = page[page.length - 1]
    return { ok: true, status: 200, json: async () => ({ people: page, next: more ? { id: last.id, name: last.name } : null }) }
  })
  return { fn, seen }
}

describe('Show more on the Client List', () => {
  let host: HTMLDivElement, root: any
  const mount = async (props: any) => { await act(async () => { root.render(<ClientGroupedList {...props} />) }) }
  const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
  const header = (label: string) => host.querySelector(`[aria-label="${label} group"]`) as HTMLElement | null
  const headerCount = (label: string) => Number((header(label)?.textContent || '').split('·')[1]?.replace(/[^0-9]/g, '') || 0)
  const headerSum = () => Array.from(host.querySelectorAll('[aria-label$=" group"]'))
    .reduce((s, h) => s + Number((h.textContent || '').split('·')[1].replace(/[^0-9]/g, '')), 0)
  const band = (label: string) => header(label)!.parentElement as HTMLElement
  const rowNames = (label = 'Nurturing') => Array.from(band(label).querySelectorAll('.bee-grp-row p[title]')).map(p => p.getAttribute('title')!)
  const open = async (label = 'Nurturing') => { await act(async () => { header(label)!.click() }); await flush() }
  const more = async () => { await act(async () => { (host.querySelector('[data-testid="clients-show-more"]') as HTMLElement).click() }); await flush() }
  const countLine = () => host.querySelector('[data-testid="clients-browse-count"]')?.textContent
  const type = async (value: string) => {
    const input = host.querySelector('input[aria-label="Search clients"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const cutOffProps = (loaded: any[], older: any[], over: any = {}) => ({
    people: loaded, engagements: [], locFilter: LOC_A, locations: [], tags: [], searchLocationId: LOC_A,
    leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: older.length }, ...over,
  })

  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })

  it('opening Nurturing shows a page of names, not all of them — and nothing is fetched until it is opened', async () => {
    const loaded = loadedNurturing(40), older = olderClients(100)
    const srv = browseServer(older, 25); (globalThis as any).fetch = srv.fn
    await mount(cutOffProps(loaded, older))
    expect(srv.fn).not.toHaveBeenCalled()
    expect(headerCount('Nurturing')).toBe(140)
    expect(host.querySelector('[data-testid="clients-nurturing-browse-hint"]')).not.toBeNull()
    await open()
    expect(srv.seen.length).toBe(1)
    expect(srv.seen[0].searchParams.get('olderThan')).toBe(CUT)
    expect(srv.seen[0].searchParams.get('location')).toBe(LOC_A)
    expect(srv.seen[0].searchParams.has('afterId')).toBe(false)
    const shown = rowNames()
    // the 25 fetched, plus the loaded ones up to the same point in the alphabet
    expect(shown.filter(n => n.endsWith('older')).length).toBe(25)
    // …which is the loaded clients before "Client 00024 older", and no others
    const loadedShown = shown.filter(n => n.endsWith('loaded'))
    expect(loadedShown).toEqual(loaded.map(p => p.name).filter(n => n.localeCompare('Client 00024 older') <= 0).sort((a, b) => a.localeCompare(b)))
    expect(loadedShown.length).toBe(8)
    expect(shown.length).toBe(33)
    expect(shown).toEqual([...shown].sort((a, b) => a.localeCompare(b)))
    expect(headerCount('Nurturing')).toBe(140)
    expect(countLine()).toBe(`Showing ${shown.length} of 140 · ${140 - shown.length} more`)
  })

  it('Show more appends the next page under what is already there, and says how many remain', async () => {
    const loaded = loadedNurturing(40), older = olderClients(100)
    const srv = browseServer(older, 25); (globalThis as any).fetch = srv.fn
    await mount(cutOffProps(loaded, older))
    await open()
    const first = rowNames()
    await more()
    const second = rowNames()
    expect(second.length).toBeGreaterThan(first.length)
    expect(second.slice(0, first.length)).toEqual(first)          // appended, never reshuffled
    expect(srv.seen[1].searchParams.get('afterId')).toBe('S00024')  // carried on from the last row
    expect(countLine()).toBe(`Showing ${second.length} of 140 · ${140 - second.length} more`)
    expect(headerCount('Nurturing')).toBe(140)
  })

  it('pressed to the end it lists every client: no duplicates, none missing, and then no button', async () => {
    const loaded = loadedNurturing(40), older = olderClients(100)
    const srv = browseServer(older, 25); (globalThis as any).fetch = srv.fn
    await mount(cutOffProps(loaded, older))
    await open()
    let presses = 0
    while (host.querySelector('[data-testid="clients-show-more"]')) { await more(); if (++presses > 20) throw new Error('never ended') }
    const all = rowNames()
    expect(all.length).toBe(140)
    expect(new Set(all).size).toBe(140)
    expect([...all].sort()).toEqual([...loaded, ...older].map(p => p.name).sort())
    expect(srv.seen.length).toBe(4)    // 100 older clients, 25 at a time — and not one request more
    expect(host.querySelector('[data-testid="clients-browse-end"]')!.textContent).toBe("That's everyone — all 140 are showing.")
    expect(headerCount('Nurturing')).toBe(140)
  })

  it('at Philadelphia Suburbs size: the first open is a page, and the end is all 18,830 — once each', async () => {
    const loaded = loadedNurturing(4906), older = olderClients(13924)
    const srv = browseServer(older, CLIENT_BROWSE_PAGE); (globalThis as any).fetch = srv.fn
    await mount(cutOffProps(loaded, older))
    expect(headerCount('Nurturing')).toBe(18830)
    await open()
    const firstPage = band('Nurturing').querySelectorAll('.bee-grp-row').length
    expect(firstPage).toBeGreaterThanOrEqual(500)
    expect(firstPage).toBeLessThan(1000)                       // a page — not 18,830, not 4,906
    expect(band('Nurturing').querySelectorAll('.bee-grp-row-lazy').length).toBe(firstPage)   // off-screen rows are skipped by the browser
    let presses = 0, slowest = 0
    while (host.querySelector('[data-testid="clients-show-more"]')) {
      const t = performance.now(); await more(); slowest = Math.max(slowest, performance.now() - t)
      if (++presses > 40) throw new Error('never ended')
    }
    const ids = Array.from(band('Nurturing').querySelectorAll('.bee-grp-row p[title]')).map(p => p.getAttribute('title')!)
    expect(ids.length).toBe(18830)
    expect(new Set(ids).size).toBe(18830)
    expect(srv.seen.length).toBe(28)                           // 13,924 / 500, rounded up
    expect(headerCount('Nurturing')).toBe(18830)
    ;(globalThis as any).__BROWSE_SLOWEST_PRESS_MS__ = Math.round(slowest)
  }, 240000)

  it('a client who is not Nurturing is shown in their own band, never in Nurturing — and the total does not move', async () => {
    const loaded = loadedNurturing(6)
    const older = olderClients(10)
    older[2] = { ...older[2], wonEngagements: { count: 1, value: 500, lastClosedAt: OLD } }   // became a Client since the page loaded
    older[5] = { ...older[5], id: 'S-open' }                                                     // has an open job
    const srv = browseServer(older, 4); (globalThis as any).fetch = srv.fn
    await mount(cutOffProps(loaded, older, { engagements: [{ id: 'e1', client_id: 'S-open', stage: 'Request' }] }))
    expect(headerSum()).toBe(16)
    await open()
    while (host.querySelector('[data-testid="clients-show-more"]')) { await more(); expect(headerSum()).toBe(16) }
    expect(rowNames()).not.toContain(older[2].name)
    expect(rowNames()).not.toContain(older[5].name)
    expect(rowNames().length).toBe(14)
    expect(headerCount('Nurturing')).toBe(14)
    expect(headerCount('Client')).toBe(1)
    expect(headerCount('Active')).toBe(1)
    await open('Client')
    expect(rowNames('Client')).toEqual([older[2].name])
  })

  it('a client the server sends twice, or that the page already holds, is listed once', async () => {
    const loaded = loadedNurturing(5), older = olderClients(8)
    const dupes = [...older, { ...loaded[1] }, { ...older[3] }]
    const srv = browseServer(dupes, 5); (globalThis as any).fetch = srv.fn   // 5: the repeat lands inside one page
    await mount(cutOffProps(loaded, older))
    await open()
    while (host.querySelector('[data-testid="clients-show-more"]')) await more()
    expect(rowNames().length).toBe(13)
    expect(new Set(rowNames()).size).toBe(13)
    expect(headerCount('Nurturing')).toBe(13)
  })

  it('a failed page keeps what is showing, says so, and Try again carries on from the same place', async () => {
    const loaded = loadedNurturing(8), older = olderClients(20)
    const srv = browseServer(older, 5, { failOn: [2] }); (globalThis as any).fetch = srv.fn
    await mount(cutOffProps(loaded, older))
    await open()
    const before = rowNames()
    await more()
    expect(rowNames()).toEqual(before)
    expect(host.querySelector('[data-testid="clients-browse-failed"]')!.textContent).toContain("Couldn't load more just now")
    expect(host.querySelector('[data-testid="clients-show-more"]')!.textContent).toBe('Try again')
    await more()
    expect(host.querySelector('[data-testid="clients-browse-failed"]')).toBeNull()
    expect(rowNames().length).toBeGreaterThan(before.length)
    expect(srv.seen[2].searchParams.get('afterId')).toBe(srv.seen[1].searchParams.get('afterId'))
  })

  it('a search is its own thing — no Show more — and clearing it returns to the same place without asking again', async () => {
    const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, CLIENT_SEARCH_DEBOUNCE_MS + 30)) }) }
    const loaded = loadedNurturing(40), older = olderClients(100)
    const srv = browseServer(older, 25); (globalThis as any).fetch = srv.fn
    await mount(cutOffProps(loaded, older))
    await open(); await more()
    const place = rowNames(), line = countLine(), browseCalls = srv.seen.length
    expect(browseCalls).toBe(2)

    await type('00007 older')
    await settle()
    expect(host.querySelector('[data-testid="clients-show-more"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-browse"]')).toBeNull()
    expect(rowNames()).toEqual(['Client 00007 older'])            // a browsed-in client, found in hand
    expect(srv.fn.mock.calls.some((c: any[]) => String(c[0]).includes('/api/clients/search'))).toBe(true)

    await type('')
    await settle()
    expect(rowNames()).toEqual(place)
    expect(countLine()).toBe(line)
    expect(srv.seen.length).toBe(browseCalls)                     // nothing re-fetched
  })

  it('held by the shell: leaving the list and coming back keeps the place', async () => {
    const loaded = loadedNurturing(10), older = olderClients(30)
    const srv = browseServer(older, 10); (globalThis as any).fetch = srv.fn
    // A stand-in for HiveShell: it owns the place, and shows the list or not.
    let setLens: any, held: any
    function Shell() {
      const [lens, set] = React.useState('clients')
      const [b, setB] = React.useState(NO_CLIENT_BROWSE)
      setLens = set; held = b
      return lens === 'clients' ? <ClientGroupedList {...cutOffProps(loaded, older)} browse={b} onBrowseChange={setB} /> : <p>Inbox</p>
    }
    await act(async () => { root.render(<Shell />) })
    await open(); await more()
    const place = rowNames()
    expect(held.people.length).toBe(20)
    await act(async () => { setLens('inbox') })       // off to the Inbox…
    expect(host.querySelector('.bee-grp-row')).toBeNull()
    await act(async () => { setLens('clients') })     // …and back
    await flush()
    await open()
    expect(rowNames()).toEqual(place)
    expect(srv.seen.length).toBe(2)
  })

  it('a row click hands the profile the rows on screen in that band, in order', async () => {
    const loaded = loadedNurturing(6), older = olderClients(9)
    const srv = browseServer(older, 3); (globalThis as any).fetch = srv.fn
    const onOpenClient = vi.fn()
    await mount(cutOffProps(loaded, older, { onOpenClient }))
    await open()
    const rows = Array.from(band('Nurturing').querySelectorAll('.bee-grp-row')) as HTMLElement[]
    await act(async () => { rows[1].click() })
    const [id, siblings] = onOpenClient.mock.calls[0]
    expect(siblings.length).toBe(rows.length)
    expect(siblings[1]).toBe(id)
  })

  // ── untouched for everyone else ──────────────────────────────────────────
  it('a location that loaded in full: no Show more, no request of any kind, and the same HTML as before this change', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a fully-loaded location must not ask the server anything') })
    ;(globalThis as any).fetch = fetchSpy
    const before = JSON.parse(readFileSync('lib/__fixtures__/client-list-complete.before.json', 'utf8'))
    const now = await completeLoadFingerprints()
    expect(now.collapsed).toBe(before.collapsed)
    expect(now.expanded).toBe(before.expanded)
    expect(now.rows).toBe(before.rows)
    expect(fetchSpy).not.toHaveBeenCalled()

    // and at size: every row of an opened band is on the page, as it always was
    const many = loadedNurturing(1200)
    await mount({ ...completeLoadProps(), people: many, engagements: [] })
    await open()
    expect(band('Nurturing').querySelectorAll('.bee-grp-row').length).toBe(1200)
    expect(host.querySelector('[data-testid="clients-browse"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-show-more"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-nurturing-browse-hint"]')).toBeNull()
    expect(host.querySelector('.bee-grp-row-lazy')).toBeNull()
    expect(host.querySelector('style')!.textContent).not.toContain('content-visibility')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a cut-off location the page could not count gets no Show more either — it says the list is partial', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no') }); (globalThis as any).fetch = fetchSpy
    await mount({ people: loadedNurturing(5), engagements: [], locFilter: LOC_A, locations: [], tags: [], leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: null } })
    await open()
    expect(rowNames().length).toBe(5)
    expect(host.querySelector('[data-testid="clients-show-more"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-list-partial"]')).not.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the shell holds the place and hands it to the list', () => {
    const shell = readFileSync('components/hive/HiveShell.jsx', 'utf8')
    expect(shell).toContain('const [clientBrowse, setClientBrowse] = useState(NO_CLIENT_BROWSE)')
    expect(shell).toContain('          browse={clientBrowse}\n          onBrowseChange={setClientBrowse}\n')
  })
})

// ═══ Home: Everyone ══════════════════════════════════════════════════════════
describe('the client total — one sum for Home and the Client List', () => {
  it('a complete load is the clients in hand; a cut-off load adds the server count; a failed count is null, never a short number', () => {
    expect(clientTotal({ listedCount: 312, leadsTruncated: false, clientsCutoff: null })).toBe(312)
    expect(clientTotal({ listedCount: 5007, leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: 13924 } })).toBe(18931)
    expect(clientTotal({ listedCount: 5007, leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: null } })).toBeNull()
    expect(clientTotal({ listedCount: 5007, leadsTruncated: true, clientsCutoff: null })).toBeNull()
    expect(clientTotal({ listedCount: 5000, leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: 0 } })).toBe(5000)
  })
})

describe("Home's Everyone tile", () => {
  const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
  const homePerson = (id: string) => ({
    id, name: `Client ${id}`, email: `${id}@x.com`, phone: '2155550100', locationId: LOC_A, created: '2024-03-01T10:00:00.000Z',
    isJunk: false, tags: [], tagIds: [], invoices: [], jobs: [], quotes: [], touchpoints: [], outreachTimeline: [], importSource: 'jobber_initial',
  })
  const people = Array.from({ length: 24 }, (_, i) => homePerson(`h${i}`))
  const engagements = [{ id: 'e1', client_id: 'h0', stage: 'Request', location_uuid: LOC_A, quotes: [], assessments: [] }]
  const overview = (over: any = {}) => ({
    newUncontacted: { count: 0, oldestDays: 0 }, estimateFollowUps: { count: 0, oldestDays: 0 }, upcomingAssessments: [],
    agingInvoices: { count: 0, total: 0, oldestDays: 0 }, openEngagementsCount: 1, activeClientsCount: 1, newThisWeekCount: 0,
    outstandingTotal: 0, leadCount: 99, truncated: false, ...over,
  })
  const appProps = (over: any = {}) => ({
    initialRoute: 'home', initialRole: 'franchise', initialFranchiseRole: 'owner', initialLocFilter: LOC_A,
    initialScopeLocationId: LOC_A, initialAllOverview: null,
    initialLocations: [{ id: LOC_A, name: 'Philadelphia Suburbs', state: 'PA', crmStatus: 'active' }, { id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
    initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
    initialPeople: people, initialBinPeople: [], initialTransferPeople: [], initialEngagements: engagements,
    initialPartners: [], initialCompanies: [], initialGuideSlides: [], initialManualSlides: [], initialTierPrices: [],
    currentUser: { id: 'u-1', email: 'owner@x.com', name: 'Owner', role: 'owner', locationId: LOC_A },
    currentLocation: { id: LOC_A, name: 'Location', jobber_connected: false, jobber_account_id: null, last_sync_status: null, token_expiry: null },
    currentSubscription: null, ...over,
  })
  let cleanup: Array<() => void> = []
  afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })
  beforeEach(() => { (globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) })
  async function mountHome(props: any) {
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { root.render(React.createElement(App as any, props)) })
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
    return host
  }
  const tile = (host: HTMLElement) => host.querySelector('[data-testid="home-everyone"]') as HTMLElement
  // The tile is a button now (it opens the client list), so its number is a
  // marked span, not the first paragraph.
  const tileValue = (host: HTMLElement) => tile(host).querySelector('[data-tile-value]')!.textContent
  // The Client List's own total for the same data: its band headers, added up.
  async function listTotal(props: any) {
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ClientGroupedList people={people} engagements={engagements} locFilter={LOC_A} locations={[]} tags={[]} {...props} />) })
    const sum = Array.from(host.querySelectorAll('[aria-label$=" group"]'))
      .reduce((s, h) => s + Number((h.textContent || '').split('·')[1].replace(/[^0-9]/g, '')), 0)
    await act(async () => root.unmount()); host.remove()
    return sum
  }

  it('at a cut-off location it is exact — and equals the Client List', async () => {
    const cutoff = { loadedBackTo: CUT, notListed: 18907 }
    const host = await mountHome(appProps({ initialLeadsTruncated: true, initialClientsCutoff: cutoff, initialScopedOverview: overview() }))
    expect(tileValue(host)).toBe('18,931')                 // 24 in hand + 18,907 counted on the server
    expect(tile(host).textContent).toContain('Clients')          // renamed from "Everyone" 2026-11-13
    expect(tile(host).textContent).not.toContain('Everyone')
    expect(await listTotal({ leadsTruncated: true, clientsCutoff: cutoff })).toBe(18931)
    // it sits right after Active clients
    expect(tile(host).previousElementSibling!.textContent).toContain('Active clients')
  })

  it('at a location that loaded in full it is the clients loaded — and equals the Client List', async () => {
    const host = await mountHome(appProps({ initialLeadsTruncated: false }))
    expect(tileValue(host)).toBe('24')
    expect(await listTotal({ leadsTruncated: false, clientsCutoff: null })).toBe(24)
  })

  it('a count that could not be established says so instead of showing the short number', async () => {
    const host = await mountHome(appProps({ initialLeadsTruncated: true, initialClientsCutoff: { loadedBackTo: CUT, notListed: null }, initialScopedOverview: overview() }))
    expect(tileValue(host)).toBe('—')
    expect(tile(host).textContent).toContain("Couldn't be counted just now")
    expect(tile(host).textContent).not.toContain('24')
  })

  it('when Home is fed the All Locations numbers it uses the server client count, or says it could not be counted', async () => {
    // Corporate on All Locations sees System health, not these tiles. The tiles
    // read the overview only for a franchise role handed one (the view-as case).
    const all = (ov: any) => appProps({ initialLocFilter: 'all', initialScopeLocationId: null, initialPeople: [], initialEngagements: [], initialAllOverview: ov })
    expect(tileValue(await mountHome(all(overview({ clientCount: 48012 }))))).toBe('48,012')
    const failed = await mountHome(all(overview({ clientCount: null })))
    expect(tileValue(failed)).toBe('—')
    expect(tile(failed).textContent).not.toContain('99')   // never the other (junk-only) lead count
  })

  it('Home adds it up with the shared function, over the same client list the Client List bands', () => {
    const hub = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(hub).toContain('everyoneCount: clientTotal({ listedCount: scopedPeopleH.length, leadsTruncated, clientsCutoff }),')
    expect(hub).toContain("everyoneCount: typeof ov.clientCount === 'number' ? ov.clientCount : null,")
  })
})

describe('the All Locations client count', () => {
  const world = () => ({
    leads: [
      lead({ id: uuid(1) }), lead({ id: uuid(2) }), lead({ id: uuid(3), location_uuid: LOC_B }),
      lead({ id: uuid(4), archived_at: OLD }), lead({ id: uuid(5), is_junk: true }),
    ],
    engagements: [], touchpoints: [], invoices: [], assessments: [], quotes: [], jobs: [], service_requests: [], partners: [],
  } as Record<string, any[]>)

  it('counts the active surface through the shared predicate — archived and junk out — for the tenant or one location', async () => {
    const t = fakeDb(world())
    const tenant = await buildAllOverview(t.db, [], Date.now(), null)
    expect(tenant.clientCount).toBe(3)
    expect(tenant.leadCount).toBe(4)        // the older count still includes the archived client
    const one = await buildAllOverview(fakeDb(world()).db, [], Date.now(), { uuid: LOC_A, slug: 'loc_a' })
    expect(one.clientCount).toBe(2)
    const code = readFileSync('lib/hub-all-overview.ts', 'utf8')
    expect(code).toContain("await onLeads(applyLeadActiveFilter(db.from('leads').select('id', { count: 'exact', head: true })))")
  })

  it('a failed count is null, not zero', async () => {
    const { db } = fakeDb(world())
    const real = db.from
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    ;(db as any).from = (table: string) => {
      const b = real(table)
      if (table !== 'leads') return b
      const origSelect = b.select
      b.select = (cols: string, opts?: any) => {
        const out = origSelect(cols, opts)
        // the third head count on leads is Everyone
        if (opts?.head && ++n === 3) out.then = (res: any) => Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(res)
        return out
      }
      return b
    }
    const ov = await buildAllOverview(db, [], Date.now(), null)
    expect(ov.clientCount).toBeNull()
    errs.mockRestore()
  })
})
