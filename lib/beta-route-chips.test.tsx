// @vitest-environment happy-dom
//
// Piece 2 (20 Oct 2026): Bee Hub's Needs-transfer row shows the SAME routing
// suggestion as Other's Slack card, from the same function.
//   A. suggestRoutesForLeads — one map read for many leads; the Slack card's
//      suggestRouteForLead is that function with one id, so the two surfaces
//      give identical answers
//   B. GET /api/route-suggestions — corporate only, the suggestion + each
//      hive's location id
//   C. the row: chips with miles, the highlighted one filled, a claimed zip
//      named outright, "Another location…", No coverage
//   D. one press → 5-second "Moving to Lincoln… Undo" → the move; Undo or
//      leaving cancels it and nothing is sent
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const h = vi.hoisted(() => ({
  leads: [] as any[],
  leadError: null as any,
  locs: [] as any[],
  role: 'admin',
  batchCalls: [] as any[],
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      let ids: string[] | null = null
      let eqId: string | null = null
      const b: any = {}
      b.select = () => b
      b.in = (_c: string, v: string[]) => { ids = v; return b }
      b.eq = (_c: string, v: string) => { eqId = v; return b }
      const rows = () => (table === 'leads' ? h.leads : table === 'locations' ? h.locs : []).filter((r: any) =>
        (ids ? ids.includes(r.id) || ids.includes(r.location_id) : true) && (eqId ? r.id === eqId : true))
      b.maybeSingle = async () => ({ data: h.leadError ? null : rows()[0] ?? null, error: h.leadError })
      b.single = b.maybeSingle
      b.then = (res: any, rej: any) => Promise.resolve({ data: h.leadError ? null : rows(), error: h.leadError }).then(res, rej)
      return b
    },
  },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'hu-leslie' } } }) },
    from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: { id: 'hu-leslie', role: h.role }, error: null }); return b },
  })),
}))
// The map: the REAL ranking over the real territory snapshot, counted.
vi.mock('@/lib/zip-proximity', async (orig) => {
  const real: any = await orig()
  const { readFileSync: rf } = await import('node:fs')
  const { join: j } = await import('node:path')
  const snap = JSON.parse(rf(j(process.cwd(), 'lib/fixtures/zip-proximity-snapshot.json'), 'utf8'))
  const coords = new Map(Object.entries(snap.coords as Record<string, any[]>).map(([z, [lat, lng, state, states]]) => [z, { lat, lng, state, states }]))
  return {
    ...real,
    nearestLocationsForZips: vi.fn(async (items: any[], limit: number) => {
      h.batchCalls.push({ n: items.length, limit })
      return items.map((it) => real.rankNearestLocations({ zip: it.zip, leadState: it.state, coords, claims: snap.claims, limit }))
    }),
  }
})

import { suggestRoutesForLeads, suggestRouteForLead } from '@/lib/route-suggestion'
import { GET as SUGGEST } from '@/app/api/route-suggestions/route'
import InboxScreen, { ROUTE_UNDO_MS, routeChipLabel } from '@/components/hive/InboxScreen'

const L = (id: string, zip: string | null, location_id = 'loc_other') => ({ id, zip, state: null, location_id })

beforeEach(() => {
  h.leads = [L('beatrice', '68310'), L('riverside', '92503'), L('reno', '89509'), L('nozip', null), L('moved', '68310', 'loc_lincoln')]
  h.leadError = null
  h.locs = [
    { id: 'uuid-lincoln', location_id: 'loc_lincoln' }, { id: 'uuid-omaha', location_id: 'loc_omaha' }, { id: 'uuid-kc', location_id: 'loc_kc' },
    { id: 'uuid-reno', location_id: 'loc_reno' },
  ]
  h.role = 'admin'
  h.batchCalls = []
})

// ═══ A. one function ═════════════════════════════════════════════
describe('A. suggestRoutesForLeads — the one function both surfaces read', () => {
  it('reads the map ONCE for the whole page, and builds each lead\'s card', async () => {
    const m = await suggestRoutesForLeads(['beatrice', 'riverside', 'reno', 'nozip'])
    expect(h.batchCalls).toEqual([{ n: 4, limit: 60 }])
    expect(m.get('beatrice')!.options.map((o) => o.label)).toEqual(['Lincoln · 19 mi', 'Omaha · 60 mi', 'Kansas City · 131 mi'])
    expect(m.get('beatrice')!.highlight).toBe('loc_lincoln')
    expect(m.get('riverside')!.highlight).toBeNull()
    expect(m.get('reno')!.kind).toBe('claimed')
    expect(m.get('nozip')!.kind).toBe('no_zip')
  })

  it('a lead no longer in Other, or not found → null, and it costs no map read', async () => {
    const m = await suggestRoutesForLeads(['moved', 'ghost'])
    expect(m.get('moved')).toBeNull()
    expect(m.get('ghost')).toBeNull()
    expect(h.batchCalls).toEqual([])
  })

  it('the Slack card\'s suggestRouteForLead gives exactly the row\'s answer', async () => {
    const row = (await suggestRoutesForLeads(['beatrice'])).get('beatrice')
    const card = await suggestRouteForLead('beatrice')
    expect(card).toEqual(row)
  })

  it('both surfaces are wired to it (source pins)', () => {
    const lib = readFileSync(join(process.cwd(), 'lib/route-suggestion.ts'), 'utf8')
    const card = lib.slice(lib.indexOf('export async function suggestRouteForLead('))
    expect(card).toContain('await suggestRoutesForLeads([leadId])')
    expect(card).not.toContain('nearestLocationsForZip')
    expect(readFileSync(join(process.cwd(), 'app/api/route-suggestions/route.ts'), 'utf8')).toContain('await suggestRoutesForLeads(ids)')
  })

  it('a failed lead read throws — never a suggestion from half a picture', async () => {
    h.leadError = { message: 'down' }
    await expect(suggestRoutesForLeads(['beatrice'])).rejects.toThrow('lead read failed: down')
  })
})

// ═══ B. the read ═════════════════════════════════════════════════
const get = (ids: string) => SUGGEST({ nextUrl: new URL(`https://x.example/api/route-suggestions?ids=${ids}`) } as any)

describe('B. GET /api/route-suggestions', () => {
  it('returns each lead\'s suggestion and the location id each suggested hive\'s move needs', async () => {
    const res = await get('beatrice,reno,moved')
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.suggestions.beatrice.options[0].label).toBe('Lincoln · 19 mi')
    expect(j.suggestions.moved).toBeNull()
    expect(j.locations).toMatchObject({ loc_lincoln: 'uuid-lincoln', loc_omaha: 'uuid-omaha', loc_kc: 'uuid-kc', loc_reno: 'uuid-reno' })
  })
  it('a non-corporate user → 403', async () => {
    h.role = 'owner'
    expect((await get('beatrice')).status).toBe(403)
  })
  it('no ids → empty, no reads', async () => {
    expect(await (await get('')).json()).toEqual({ suggestions: {}, locations: {} })
    expect(h.batchCalls).toEqual([])
  })
  it('more than 50 ids → 400', async () => {
    expect((await get(Array.from({ length: 51 }, (_, i) => `id${i}`).join(','))).status).toBe(400)
  })
  it('a failed read → 503', async () => {
    h.leadError = { message: 'down' }
    expect((await get('beatrice')).status).toBe(503)
  })
})

// ═══ C/D. the row ════════════════════════════════════════════════
const leadRow = (over: any = {}) => ({
  id: 'beatrice', name: 'Beatrice Lead', email: 'b@example.com', phone: null, phoneNormalized: null,
  locationId: 'uuid-other', atLocOther: true, created: new Date().toISOString(), isJunk: false,
  snoozeUntil: null, inboxDismissedAt: null, jobberRef: null, outreachTimeline: [], originZip: '68310', ...over,
})
const SUGGESTIONS = async () => {
  const m = await suggestRoutesForLeads(['beatrice', 'reno', 'riverside', 'nozip'])
  return { suggestions: Object.fromEntries(m), locations: Object.fromEntries(h.locs.map((l) => [l.location_id, l.id])) }
}

let calls: { url: string; init: any }[] = []
let transferReply: any = { ok: true, status: 200, body: { success: true } }
let suggestReply: any = null
const installFetch = () => {
  calls = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.startsWith('/api/route-suggestions')) return { ok: suggestReply.ok ?? true, status: suggestReply.status ?? 200, json: async () => suggestReply.body }
    if (u.includes('/transfer')) return { ok: transferReply.ok, status: transferReply.status, json: async () => transferReply.body }
    if (u.includes('/api/locations/transfer-targets')) return { ok: true, status: 200, json: async () => ({ targets: [] }) }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve() }) }
const mount = async (people: any[], extra: any = {}) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<InboxScreen people={[]} transferPeople={people} engagements={[]} locFilter="all" {...extra} />) })
  await flush()
  return { host, root, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const chips = (host: HTMLElement) => Array.from(host.querySelectorAll('[data-bee-route-chip]')) as HTMLButtonElement[]
const transferPosts = () => calls.filter((c) => c.url.includes('/transfer') && c.init?.method === 'POST')

describe('C. the row shows the card\'s suggestion', () => {
  beforeEach(async () => { suggestReply = { body: await SUGGESTIONS() }; transferReply = { ok: true, status: 200, body: { success: true } }; installFetch() })

  it('three chips with miles, in order; the highlighted one filled; then Another location… and No coverage', async () => {
    const { host, unmount } = await mount([leadRow()])
    const c = chips(host)
    expect(c.map((b) => b.textContent)).toEqual(['Lincoln · 19 mi', 'Omaha · 60 mi', 'Kansas City · 131 mi'])
    expect(c.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    // filled = no outline + a fill; the others are outlined with no fill
    expect(c[0].style.border).not.toContain('solid')
    expect(c[0].style.background).not.toBe('transparent')
    expect(c[1].style.border).toContain('solid')
    expect(c[1].style.background).toBe('transparent')
    const row = host.querySelector('.bee-inbox-row')!
    const labels = Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('aria-label')).filter(Boolean)
    expect(labels).toEqual(['Another location', 'No coverage'])
    await unmount()
  })

  it('a near-tie fills nothing', async () => {
    const { host, unmount } = await mount([leadRow({ id: 'riverside', originZip: '92503' })])
    expect(chips(host).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false'])
    await unmount()
  })

  it('a claimed zip is named outright', async () => {
    const { host, unmount } = await mount([leadRow({ id: 'reno', originZip: '89509' })])
    const c = chips(host)
    expect(c.map((b) => b.textContent)).toEqual(['Reno · their zip'])
    expect(c[0].getAttribute('aria-pressed')).toBe('true')
    expect(c[0].title).toBe("Zip 89509 is on Reno's list")
    await unmount()
  })

  it('no zip → no chips; Another location… and No coverage remain', async () => {
    const { host, unmount } = await mount([leadRow({ id: 'nozip', originZip: null })])
    expect(chips(host)).toEqual([])
    expect(host.querySelector('[data-bee-route-other]')).toBeTruthy()
    await unmount()
  })

  it('one read for the page on screen, and not again on a re-render', async () => {
    const { host, root, unmount } = await mount([leadRow(), leadRow({ id: 'reno', originZip: '89509' })])
    await act(async () => { root.render(<InboxScreen people={[]} transferPeople={[leadRow(), leadRow({ id: 'reno', originZip: '89509' })] as any} engagements={[]} locFilter="all" />) })
    await flush()
    const reads = calls.filter((c) => c.url.startsWith('/api/route-suggestions'))
    expect(reads).toHaveLength(1)
    expect(decodeURIComponent(reads[0].url)).toBe('/api/route-suggestions?ids=beatrice,reno')
    expect(chips(host).length).toBe(4)
    await unmount()
  })

  it('while loading it says so; if the read fails there are no chips, never a guess', async () => {
    let release: any
    ;(globalThis as any).fetch = vi.fn(() => new Promise((r) => { release = r }))
    const { host, unmount } = await mount([leadRow()])
    expect(host.querySelector('[data-bee-route-loading]')!.textContent).toBe('Finding closest hives…')
    await act(async () => { release({ ok: false, status: 503, json: async () => ({ error: 'suggestion_failed' }) }) })
    await flush()
    expect(host.querySelector('[data-bee-route-loading]')).toBeNull()
    expect(chips(host)).toEqual([])
    expect(host.querySelector('[data-bee-route-other]')).toBeTruthy()
    await unmount()
  })

  it('a read-only view fetches nothing', async () => {
    const { unmount } = await mount([leadRow()], { readOnly: true })
    expect(calls.filter((c) => c.url.startsWith('/api/route-suggestions'))).toEqual([])
    await unmount()
  })

  it('routeChipLabel: the card\'s label, or the claimant named', () => {
    expect(routeChipLabel('nearby', { name: 'Lincoln', label: 'Lincoln · 19 mi' })).toBe('Lincoln · 19 mi')
    expect(routeChipLabel('claimed', { name: 'Reno', label: 'Reno' })).toBe('Reno · their zip')
  })
})

describe('D. one press → 5 seconds to undo → the move', () => {
  beforeEach(async () => {
    suggestReply = { body: await SUGGESTIONS() }
    transferReply = { ok: true, status: 200, body: { success: true } }
    installFetch()
  })
  afterEach(() => { vi.useRealTimers() })

  it('the wait is five seconds', () => {
    expect(ROUTE_UNDO_MS).toBe(5000)
  })

  it('press Lincoln → "Moving to Lincoln… Undo"; nothing sent until the 5 seconds run out; then the move, the row goes, a toast', async () => {
    const setToast = vi.fn()
    const { host, unmount } = await mount([leadRow()], { setToast })
    vi.useFakeTimers()
    await act(async () => { chips(host)[0].click() })
    expect(host.querySelector('[data-bee-route-pending]')!.textContent).toContain('Moving to Lincoln…')
    expect(host.querySelector('[data-bee-route-undo]')!.textContent).toBe('Undo')
    expect(chips(host)).toEqual([])
    await act(async () => { vi.advanceTimersByTime(ROUTE_UNDO_MS - 1) })
    expect(transferPosts()).toEqual([])
    await act(async () => { vi.advanceTimersByTime(1) })
    vi.useRealTimers()
    await flush()
    expect(transferPosts()).toHaveLength(1)
    expect(transferPosts()[0].url).toBe('/api/leads/beatrice/transfer')
    expect(JSON.parse(transferPosts()[0].init.body)).toEqual({ destination_location_id: 'uuid-lincoln' })
    expect(Array.from(host.querySelectorAll('.bee-inbox-row')).some((r) => (r.textContent || '').includes('Beatrice Lead'))).toBe(false)
    expect(setToast).toHaveBeenCalledWith({ kind: 'success', msg: 'Beatrice Lead transferred to Lincoln' })
    await unmount()
  })

  it('after a move the page changes, but leads already fetched are not fetched again', async () => {
    const { host, unmount } = await mount([leadRow(), leadRow({ id: 'reno', name: 'Reno Lead', originZip: '89509' })])
    vi.useFakeTimers()
    await act(async () => { chips(host)[0].click() })
    await act(async () => { vi.advanceTimersByTime(ROUTE_UNDO_MS) })
    vi.useRealTimers()
    await flush()
    expect(transferPosts()).toHaveLength(1)
    expect(calls.filter((c) => c.url.startsWith('/api/route-suggestions'))).toHaveLength(1)
    expect(chips(host).map((b) => b.textContent)).toEqual(['Reno · their zip'])
    await unmount()
  })

  it('Undo within the 5 seconds → nothing is ever sent, and the chips come back', async () => {
    const { host, unmount } = await mount([leadRow()])
    vi.useFakeTimers()
    await act(async () => { chips(host)[1].click() })
    expect(host.querySelector('[data-bee-route-pending]')!.textContent).toContain('Moving to Omaha…')
    await act(async () => { (host.querySelector('[data-bee-route-undo]') as HTMLButtonElement).click() })
    await act(async () => { vi.advanceTimersByTime(ROUTE_UNDO_MS * 3) })
    vi.useRealTimers()
    await flush()
    expect(transferPosts()).toEqual([])
    expect(chips(host).length).toBe(3)
    await unmount()
  })

  it('leaving the Inbox during the countdown cancels the move', async () => {
    const { host, unmount } = await mount([leadRow()])
    vi.useFakeTimers()
    await act(async () => { chips(host)[0].click() })
    await unmount()
    await act(async () => { vi.advanceTimersByTime(ROUTE_UNDO_MS * 2) })
    vi.useRealTimers()
    await flush()
    expect(transferPosts()).toEqual([])
  })

  it('a refused move (in Jobber) says why on the row; the chips come back; the row stays', async () => {
    transferReply = { ok: false, status: 409, body: { error: 'lead_in_jobber' } }
    const { host, unmount } = await mount([leadRow()])
    vi.useFakeTimers()
    await act(async () => { chips(host)[0].click() })
    await act(async () => { vi.advanceTimersByTime(ROUTE_UNDO_MS) })
    vi.useRealTimers()
    await flush()
    const err = host.querySelector('[data-bee-route-error]')!
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toMatch(/^Couldn't move: .+/)
    expect(chips(host).length).toBe(3)
    expect(host.textContent).toContain('Beatrice Lead')
    await unmount()
  })

  it('a second press during the countdown changes nothing — one move per lead', async () => {
    const { host, unmount } = await mount([leadRow()])
    vi.useFakeTimers()
    await act(async () => { chips(host)[0].click() })
    // the chips are gone while counting down, so there is nothing to press;
    // the pending notice is the only control
    expect(chips(host)).toEqual([])
    await act(async () => { vi.advanceTimersByTime(ROUTE_UNDO_MS) })
    vi.useRealTimers()
    await flush()
    expect(transferPosts()).toHaveLength(1)
    await unmount()
  })

  it('"Another location…" still opens the full transfer window', async () => {
    const { host, unmount } = await mount([leadRow()])
    await act(async () => { (host.querySelector('[data-bee-route-other]') as HTMLButtonElement).click() })
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(transferPosts()).toEqual([])
    await unmount()
  })
})
