// @vitest-environment happy-dom
//
// A location's territory on its own pages — CORPORATE EDITS, OWNERS VIEW.
//
// Everything below runs the REAL handlers and the REAL panel over one fake
// table, with a switchable signed-in caller:
//   A. THE SERVER REFUSES AN OWNER'S WRITE — every write the location page can
//      make (add, move, remove, resolve), sent as the owner of that very
//      location, is 403 and leaves the table byte-for-byte unchanged. Pinned
//      hardest: a hidden button is not a permission.
//   B. the read: who may see a location's territory, and what they get
//   C. the panel: corporate sees controls and edits; an owner sees the list,
//      the conflicts in words, the not-live note, and no controls
//   D. it is mounted on both location pages, where the brief asked
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── fixture ─────────────────────────────────────────────────────
const DENVER = { id: '11111111-1111-4111-8111-111111111111', name: 'Denver', location_id: 'loc_denver', lifecycle_status: 'onboarding' }
const CENTRAL = { id: '22222222-2222-4222-8222-222222222222', name: 'Central Denver', location_id: 'loc_centraldenver', lifecycle_status: 'onboarding' }
const WEST = { id: '33333333-3333-4333-8333-333333333333', name: 'West Denver', location_id: 'loc_westdenver', lifecycle_status: 'onboarding' }
const OMAHA = { id: '44444444-4444-4444-8444-444444444444', name: 'Omaha', location_id: 'loc_omaha', lifecycle_status: 'active' }
const OTHER = { id: '55555555-5555-4555-8555-555555555555', name: 'Other', location_id: 'loc_other', lifecycle_status: 'active' }

const seedRows = () => [
  { id: 'd1', zip: '80111', location_uuid: DENVER.id },
  { id: 'd2', zip: '80203', location_uuid: DENVER.id }, // ← also Central Denver
  { id: 'd3', zip: '80126', location_uuid: DENVER.id }, // ← also West Denver
  { id: 'd4', zip: '80015', location_uuid: DENVER.id },
  { id: 'c1', zip: '80203', location_uuid: CENTRAL.id },
  { id: 'c2', zip: '80202', location_uuid: CENTRAL.id },
  { id: 'w1', zip: '80126', location_uuid: WEST.id },
  { id: 'o1', zip: '68007', location_uuid: OMAHA.id },
  { id: 'o2', zip: '68005', location_uuid: OMAHA.id },
]

// ── fake Supabase (session + service share the table) ───────────
const h = vi.hoisted(() => ({
  state: { caller: null as any, rows: [] as any[], locations: [] as any[], next: 1 },
}))

const makeBuilder = (table: string, client: 'session' | 'service') => {
  const ctx: any = { op: 'select', filters: [], orders: [], range: null, payload: null, opts: undefined }
  const b: any = {}
  b.select = (_c?: any, opts?: any) => { ctx.opts = opts; return b }
  b.eq = (c: string, v: any) => { ctx.filters.push(['eq', c, v]); return b }
  b.in = (c: string, v: any[]) => { ctx.filters.push(['in', c, v]); return b }
  b.order = (c: string, o: any = {}) => { ctx.orders.push([c, o.ascending !== false]); return b }
  b.range = (a: number, z: number) => { ctx.range = [a, z]; return b }
  b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
  b.update = (p: any) => { ctx.op = 'update'; ctx.payload = p; return b }
  b.delete = () => { ctx.op = 'delete'; return b }
  const match = (r: any) => ctx.filters.every(([k, c, v]: any) => (k === 'eq' ? r[c] === v : v.includes(r[c])))
  const run = () => {
    if (table === 'hub_users') return { data: h.state.caller, error: null }
    if (table === 'locations') {
      let out = h.state.locations.filter(match)
      for (const [c, asc] of ctx.orders) out = [...out].sort((x: any, y: any) => (x[c] < y[c] ? -1 : 1) * (asc ? 1 : -1))
      return { data: out, error: null }
    }
    if (ctx.op === 'insert') {
      const row = { id: `n${h.state.next++}`, updated_at: 't', ...ctx.payload }
      h.state.rows.push(row)
      return { data: row, error: null }
    }
    if (ctx.op === 'update') {
      const hit = h.state.rows.filter(match)
      hit.forEach((r: any) => Object.assign(r, ctx.payload))
      return { data: hit[0] ?? null, error: null }
    }
    if (ctx.op === 'delete') {
      const gone = h.state.rows.filter(match)
      h.state.rows = h.state.rows.filter((r: any) => !match(r))
      return { data: gone, error: null }
    }
    let out = h.state.rows.filter(match)
    const count = out.length
    for (const [c, asc] of [...ctx.orders].reverse()) out = [...out].sort((x: any, y: any) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1))
    if (ctx.range) out = out.slice(ctx.range[0], ctx.range[1] + 1)
    return { data: out.slice(0, 1000), error: null, count: ctx.opts?.count === 'exact' ? count : null }
  }
  const one = () => Promise.resolve(run()).then((r: any) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }))
  b.single = one
  b.maybeSingle = one
  b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
  return b
}

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => makeBuilder(t, 'service') } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.caller ? { id: h.state.caller.id } : null } }) },
    from: (t: string) => makeBuilder(t, 'session'),
  }),
}))

import * as TerritoryRoute from '@/app/api/locations/[id]/zips/route'
import { GET as TERRITORY } from '@/app/api/locations/[id]/zips/route'
import { POST, PATCH, DELETE } from '@/app/api/admin/location-zips/route'
import { POST as RESOLVE } from '@/app/api/admin/location-zips/resolve/route'
import LocationZipsPanel from '@/components/admin/LocationZipsPanel'

const as = (role: string, location_id: string | null = null) => {
  h.state.caller = { id: `u-${role}`, role, location_id }
}
const CORPORATE = () => as('admin')
const DENVER_OWNER = () => as('owner', DENVER.id)
const DENVER_MANAGER = () => as('manager', DENVER.id)

beforeEach(() => {
  h.state.rows = seedRows()
  h.state.locations = [CENTRAL, DENVER, OMAHA, OTHER, WEST]
  h.state.next = 1
  h.state.caller = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const jreq = (body?: any, url = 'http://x/api/admin/location-zips') =>
  ({ json: async () => body, nextUrl: new URL(url) }) as any
const read = (id: string) => TERRITORY({} as any, { params: { id } })
const snapshot = () => JSON.stringify(h.state.rows)

// The four writes the location page can make, each aimed at the caller's OWN
// location — the most sympathetic case for letting an owner through.
const OWN_LOCATION_WRITES: [string, () => Promise<Response>][] = [
  ['add a zip to Denver', () => POST(jreq({ zip: '80016', location_uuid: DENVER.id }))],
  ['move a Denver zip to Omaha', () => PATCH(jreq({ id: 'd1', location_uuid: OMAHA.id }))],
  ['move a Central Denver zip INTO Denver', () => PATCH(jreq({ id: 'c2', location_uuid: DENVER.id }))],
  ['remove a Denver zip', () => DELETE(jreq(undefined, 'http://x/api/admin/location-zips?id=d4'))],
  ['resolve 80203 in Denver’s favour', () => RESOLVE(jreq({ zip: '80203', location_uuid: DENVER.id }))],
  ['resolve 80126 in Denver’s favour', () => RESOLVE(jreq({ zip: '80126', location_uuid: DENVER.id }))],
]

// ═══ A. the server refuses — pinned hardest ═══════════════════════
describe('A. an owner’s write is refused by the SERVER, from the location page’s entry point', () => {
  it.each(OWN_LOCATION_WRITES)('owner of Denver: %s → 403, table unchanged', async (_label, write) => {
    DENVER_OWNER()
    const before = snapshot()
    const res = await write()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden')
    expect(snapshot()).toBe(before)
  })

  it.each(OWN_LOCATION_WRITES)('manager of Denver: %s → 403, table unchanged', async (_label, write) => {
    DENVER_MANAGER()
    const before = snapshot()
    expect((await write()).status).toBe(403)
    expect(snapshot()).toBe(before)
  })

  it.each([['lite_user'], ['viewer'], ['']])('role %j: every write → 403', async (role) => {
    as(role, DENVER.id)
    const before = snapshot()
    for (const [, write] of OWN_LOCATION_WRITES) expect((await write()).status).toBe(403)
    expect(snapshot()).toBe(before)
  })

  it('the location route itself has NO write method — it can only be read', () => {
    const handlers = Object.keys(TerritoryRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))
    expect(handlers).toEqual(['GET'])
  })

  it('the SAME writes succeed for corporate (the gate is the role, not the request)', async () => {
    CORPORATE()
    expect((await POST(jreq({ zip: '80016', location_uuid: DENVER.id }))).status).toBe(201)
    expect((await RESOLVE(jreq({ zip: '80203', location_uuid: DENVER.id }))).status).toBe(200)
    expect(h.state.rows.filter((r) => r.zip === '80203').map((r) => r.location_uuid)).toEqual([DENVER.id])
  })

  it('the panel, mounted as the owner, has nothing to press — and forcing the call anyway is still 403', async () => {
    DENVER_OWNER()
    const { host, writes } = await mountPanel(DENVER.id)
    expect(host.querySelectorAll('button, input, select')).toHaveLength(0)
    // What the corporate controls on this page would send, sent by the owner:
    const before = snapshot()
    const r = await fetch('/api/admin/location-zips', { method: 'POST', body: JSON.stringify({ zip: '80016', location_uuid: DENVER.id }) } as any)
    expect(r.status).toBe(403)
    expect(writes).toHaveLength(1)
    expect(snapshot()).toBe(before)
  })
})

// ═══ B. the read ══════════════════════════════════════════════════
describe('B. GET /api/locations/[id]/zips — who sees a territory', () => {
  it('owner of Denver sees Denver: can_edit false, count, conflicts with names; onboarding takes its zips (20 Oct)', async () => {
    DENVER_OWNER()
    const res = await read(DENVER.id)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.can_edit).toBe(false)
    expect(j.locations).toBeUndefined() // no picker for a viewer
    expect(j.count).toBe(4)
    expect(j.not_live_routes_to_other).toBe(false)
    expect(j.conflicts).toEqual([
      { zip: '80126', claimants: [{ location_uuid: DENVER.id, name: 'Denver' }, { location_uuid: WEST.id, name: 'West Denver' }] },
      { zip: '80203', claimants: [{ location_uuid: CENTRAL.id, name: 'Central Denver' }, { location_uuid: DENVER.id, name: 'Denver' }] },
    ])
  })

  it('a PAUSED location still says its zips go to Other', async () => {
    h.state.locations = [CENTRAL, { ...DENVER, lifecycle_status: 'paused' }, OMAHA, OTHER, WEST]
    DENVER_OWNER()
    const j = await (await read(DENVER.id)).json()
    expect(j.not_live_routes_to_other).toBe(true)
  })

  it('a manager of Denver may read it too', async () => {
    DENVER_MANAGER()
    expect((await read(DENVER.id)).status).toBe(200)
  })

  it('an owner cannot read ANOTHER location’s territory', async () => {
    DENVER_OWNER()
    expect((await read(OMAHA.id)).status).toBe(403)
  })

  it.each([['lite_user'], ['viewer']])('%s at Denver cannot read it', async (role) => {
    as(role, DENVER.id)
    expect((await read(DENVER.id)).status).toBe(403)
  })

  it('no session → 401', async () => {
    expect((await read(DENVER.id)).status).toBe(401)
  })

  it('corporate reads any location with can_edit true and the picker list (no loc_other)', async () => {
    CORPORATE()
    const j = await (await read(OMAHA.id)).json()
    expect(j.can_edit).toBe(true)
    expect(j.conflicts).toEqual([])
    expect(j.not_live_routes_to_other).toBe(false)
    expect(j.locations.map((l: any) => l.location_id)).not.toContain('loc_other')
  })
})

// ═══ C. the panel ═════════════════════════════════════════════════
let writes: any[] = []
async function mountPanel(locationId: string) {
  writes = []
  vi.stubGlobal('confirm', () => true)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    let res: Response
    const m = /^\/api\/locations\/([^/]+)\/zips$/.exec(url)
    if (m && method === 'GET') res = await TERRITORY({} as any, { params: { id: decodeURIComponent(m[1]) } })
    else {
      writes.push({ method, url, body: body ?? null })
      const r = jreq(body, 'http://x' + url)
      res = url.endsWith('/resolve') ? await RESOLVE(r)
        : method === 'POST' ? await POST(r)
        : method === 'PATCH' ? await PATCH(r)
        : await DELETE(r)
    }
    return { ok: res.status < 400, status: res.status, json: () => res.json() }
  }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<LocationZipsPanel locationId={locationId} />) })
  for (let i = 0; i < 6; i++) await act(async () => {})
  return { host, writes }
}
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}) }
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }); await settle() }
const btnText = (host: Element, text: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
const setValue = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const chips = (host: Element) =>
  Array.from(host.querySelectorAll('[data-testid="zip-chips"] > span')).map((s) => s.firstChild?.textContent)

describe('C1. an owner sees the list and no controls', () => {
  it('their zips, sorted, and how many', async () => {
    DENVER_OWNER()
    const { host } = await mountPanel(DENVER.id)
    expect(host.querySelector('[data-testid="territory-count"]')!.textContent).toBe('4 zips')
    expect(chips(host)).toEqual(['80015', '80111', '80126', '80203'])
  })

  it('no controls at all: no add, no remove, no move, no resolve', async () => {
    DENVER_OWNER()
    const { host } = await mountPanel(DENVER.id)
    expect(host.querySelector('[data-testid="territory-controls"]')).toBeNull()
    expect(host.querySelectorAll('button, input, select')).toHaveLength(0)
    expect(host.textContent).not.toContain('Give to')
    expect(host.textContent).toContain('Territory changes go through corporate.')
  })

  it('a conflicted zip is visible to the owner, with what it means', async () => {
    DENVER_OWNER()
    const { host } = await mountPanel(DENVER.id)
    const box = host.querySelector('[data-testid="territory-conflicts"]')!
    expect(box.textContent).toContain('2 zips are also claimed by another location.')
    expect(box.textContent).toContain('Leads from them go to Leslie at corporate, not to Denver, until corporate decides who covers them.')
    expect(box.textContent).toContain('80203')
    expect(box.textContent).toContain('Central Denver vs Denver')
    expect(box.textContent).toContain('80126')
    expect(box.textContent).toContain('Denver vs West Denver')
    const marked = Array.from(host.querySelectorAll('[data-conflict="true"]')).map((s) => s.firstChild?.textContent).sort()
    expect(marked).toEqual(['80126', '80203'])
  })

  it('one conflict reads in the singular', async () => {
    h.state.rows = h.state.rows.filter((r) => r.id !== 'w1') // 80126 no longer shared
    DENVER_OWNER()
    const { host } = await mountPanel(DENVER.id)
    expect(host.querySelector('[data-testid="territory-conflicts"]')!.textContent).toContain('1 zip is also claimed by another location.Leads from it go to Leslie')
  })

  it('a paused location says its zips go to Leslie', async () => {
    h.state.locations = [CENTRAL, { ...DENVER, lifecycle_status: 'paused' }, OMAHA, OTHER, WEST]
    DENVER_OWNER()
    const { host } = await mountPanel(DENVER.id)
    expect(host.querySelector('[data-testid="territory-not-live"]')!.textContent)
      .toBe('Denver isn’t taking new leads right now, so leads from these zips go to Leslie at corporate.')
  })

  it('an onboarding location shows no not-live note — its zips come to it (20 Oct)', async () => {
    DENVER_OWNER()
    const { host } = await mountPanel(DENVER.id)
    expect(host.querySelector('[data-testid="territory-not-live"]')).toBeNull()
  })

  it('a live location with no conflicts shows neither note', async () => {
    as('owner', OMAHA.id)
    const { host } = await mountPanel(OMAHA.id)
    expect(host.querySelector('[data-testid="territory-not-live"]')).toBeNull()
    expect(host.querySelector('[data-testid="territory-conflicts"]')).toBeNull()
    expect(chips(host)).toEqual(['68005', '68007'])
  })

  it('someone the read refuses (owner of ANOTHER location) sees nothing at all', async () => {
    DENVER_OWNER()
    const { host } = await mountPanel(OMAHA.id)
    expect(host.querySelector('[data-testid="location-territory"]')).toBeNull()
    expect(host.textContent).toBe('')
  })

  it.each([[{}], [{ zips: [] }], [null], [{ location: { id: 'x', name: 'X' }, zips: 'nope', conflicts: [] }]])(
    'a malformed reply %j is one line of text, never a crash that blanks the host page',
    async (reply) => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => reply })))
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => { root.render(<div>page above<LocationZipsPanel locationId={DENVER.id} />page below</div>) })
      await settle()
      expect(host.textContent).toContain('page above')
      expect(host.textContent).toContain('page below')
      expect(host.textContent).toContain('Couldn’t load this location’s zips (unexpected response).')
    },
  )

  it('a demo / mock location id never calls the server', async () => {
    DENVER_OWNER()
    const { host } = await mountPanel('loc_kc')
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0)
    expect(host.textContent).toBe('')
  })
})

// ── ONE CARD (2026-11-13, layout approved by Kevin) ───────────────────────
// The zips and corporate's controls used to be two cards. They are one: the
// zips, then — for corporate only — a hairline, a gold "Change this
// territory" label, the Zip box and Add on one row, and "Move a zip to
// another location" above its box. Only the layout moved: every request the
// controls make is pinned, unchanged, in C2 below.
describe('C1b. the territory is ONE card', () => {
  const cardsIn = (host: HTMLElement) => {
    const root = host.querySelector('[data-testid="location-territory"]') as HTMLElement
    return Array.from(root.children) as HTMLElement[]
  }
  const hasBorder = (el: HTMLElement) => !!el.style.border && el.style.border !== 'none'

  it('corporate: one card holding the zips and the controls, in the approved order', async () => {
    CORPORATE()
    const { host } = await mountPanel(DENVER.id)
    const cards = cardsIn(host)
    expect(cards.length, 'one card, not two').toBe(1)
    const card = cards[0]
    expect(hasBorder(card)).toBe(true)
    const controls = card.querySelector('[data-testid="territory-controls"]') as HTMLElement
    const chips = card.querySelector('[data-testid="zip-chips"]') as HTMLElement
    expect(chips && controls).toBeTruthy()
    // Chips first, then the controls — inside the same card.
    expect(chips.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The controls are not a card of their own: no box, just a hairline above.
    expect(controls.style.borderTop).not.toBe('')
    expect(controls.style.borderRadius).toBe('')
    expect(controls.style.background).toBe('')
    expect(controls.style.borderBottom).toBe(''); expect(controls.style.borderLeft).toBe('')
    // Label, then Zip + Add on one row, then "Move a zip to another location" above its box.
    const label = controls.querySelector('[data-testid="territory-change-label"]') as HTMLElement
    const zip = controls.querySelector('input[aria-label="Zip code"]') as HTMLElement
    const add = btnText(controls, 'Add')! as HTMLElement
    const move = Array.from(controls.querySelectorAll('div')).find(d => d.textContent === 'Move a zip to another location') as HTMLElement
    const find = controls.querySelector('input[aria-label="Find one of these zips"]') as HTMLElement
    const order = [label, zip, add, move, find]
    for (const el of order) expect(el).toBeTruthy()
    for (let i = 0; i < order.length - 1; i++) expect(order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING, `step ${i}`).toBeTruthy()
    expect(zip.parentElement).toBe(add.parentElement)   // one row
    expect(zip.parentElement!.style.display).toBe('flex')
    expect(controls.textContent).not.toContain('Move a zipType')   // the old bare "Move a zip" heading is gone
  })

  it('the label is the small gold uppercase one a rebuilt Settings card opens with, and names no font of its own', async () => {
    const { T: DESIGN } = await import('@/components/design/tokens')
    CORPORATE()
    const { host } = await mountPanel(DENVER.id)
    const label = host.querySelector('[data-testid="territory-change-label"]') as HTMLElement
    expect(label.textContent).toBe('Change this territory')
    const hex = (c: string) => c.startsWith('rgb') ? '#' + c.match(/\d+/g)!.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('') : c
    expect(hex(label.style.color).toLowerCase()).toBe(DESIGN.gold.toLowerCase())
    expect([label.style.fontSize, label.style.fontWeight, label.style.textTransform, label.style.letterSpacing]).toEqual(['11px', '700', 'uppercase', '0.14em'])
    // Settings gives it its heading font through the shell's stylesheet; the
    // panel itself (shared with Admin, which is not rebuilt) names none.
    expect(label.style.fontFamily).toBe('inherit')
    expect(label.hasAttribute('data-seyebrow')).toBe(true)
    expect(readFileSync('components/admin/LocationZipsPanel.jsx', 'utf8')).not.toMatch(/Lato|Arvo/)
    expect(readFileSync('components/settings/SettingsShell.jsx', 'utf8')).toContain('[data-settings-ui] [data-seyebrow]{font-family:${FONT.ui}!important}')
  })

  it('corporate with no zips: still one card, with the controls under "No zips"', async () => {
    CORPORATE()
    h.state.rows = []
    const { host } = await mountPanel(DENVER.id)
    expect(host.querySelector('[data-testid="territory-count"]')!.textContent).toBe('0 zips')
    expect(cardsIn(host).length).toBe(1)
    const card = cardsIn(host)[0]
    expect(card.textContent).toContain('No zips.')
    const controls = card.querySelector('[data-testid="territory-controls"]') as HTMLElement
    expect(controls).not.toBeNull()
    expect(controls.querySelector('input[aria-label="Zip code"]')).not.toBeNull()
    expect(card.querySelector('[data-testid="zip-chips"]')!.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('an owner with no zips: one card, ending at the line that says so', async () => {
    DENVER_OWNER()
    h.state.rows = []
    const { host } = await mountPanel(DENVER.id)
    expect(cardsIn(host).length).toBe(1)
    expect(host.textContent).toContain('No website leads route to Denver by zip yet.')
    expect(host.querySelector('[data-testid="territory-controls"]')).toBeNull()
    expect(host.querySelectorAll('input, button').length).toBe(0)
  })

  it('an owner: one card that ENDS after the zips — no crosses, no hairline, no label, no boxes — and says changes go through corporate', async () => {
    DENVER_OWNER()
    const { host } = await mountPanel(DENVER.id)
    const cards = cardsIn(host)
    expect(cards.length).toBe(1)
    const card = cards[0]
    expect(card.querySelector('[data-testid="territory-controls"]')).toBeNull()
    expect(card.querySelector('[data-testid="territory-change-label"]')).toBeNull()
    expect(card.querySelectorAll('input, select, textarea').length).toBe(0)
    expect(Array.from(card.querySelectorAll('button')).filter(b => /Remove|×|Add/.test((b.getAttribute('aria-label') || '') + b.textContent)).length).toBe(0)
    expect(card.textContent).toContain('Territory changes go through corporate.')
    expect(card.textContent).not.toMatch(/Change this territory|Move a zip/)
    // Nothing after the zips but (when there are none) the line that says so.
    const chips = card.querySelector('[data-testid="zip-chips"]') as HTMLElement
    const after = Array.from(card.children).slice(Array.from(card.children).indexOf(chips) + 1) as HTMLElement[]
    for (const el of after) expect(el.style.borderTop, 'no hairline for an owner').toBe('')
  })
})

describe('C2. corporate sees the controls and edits from this page', () => {
  it('has the controls: add, remove per zip, move, resolve', async () => {
    CORPORATE()
    const { host } = await mountPanel(DENVER.id)
    expect(host.querySelector('[data-testid="territory-controls"]')).not.toBeNull()
    // 2026-11-13: one card. The controls open with "Change this territory"
    // (it was "Add a zip to Denver" at the top of a second card).
    expect(host.textContent).toContain('Change this territory')
    expect(host.textContent).not.toContain('Add a zip to Denver')
    expect(host.querySelector('button[aria-label="Remove 80111 from Denver"]')).not.toBeNull()
    expect(btnText(host, 'Give to Central Denver')).toBeTruthy()
    expect(btnText(host, 'Give to West Denver')).toBeTruthy()
  })

  it('adds a zip — to THIS location, no picker', async () => {
    CORPORATE()
    const { host } = await mountPanel(DENVER.id)
    const box = host.querySelector('[data-testid="territory-controls"]')!
    expect(box.querySelector('select[aria-label="Location"]')).toBeNull()
    await setValue(box.querySelector('input[aria-label="Zip code"]') as HTMLInputElement, '80016')
    await click(btnText(box, 'Add')!)
    expect(writes).toEqual([{ method: 'POST', url: '/api/admin/location-zips', body: { zip: '80016', location_uuid: DENVER.id } }])
    expect(host.querySelector('[data-testid="territory-count"]')!.textContent).toBe('5 zips')
  })

  it('removes a zip', async () => {
    CORPORATE()
    const { host } = await mountPanel(DENVER.id)
    await click(host.querySelector('button[aria-label="Remove 80111 from Denver"]')!)
    expect(writes).toEqual([{ method: 'DELETE', url: '/api/admin/location-zips?id=d1', body: null }])
    expect(chips(host)).toEqual(['80015', '80126', '80203'])
  })

  it('moves a zip to another location', async () => {
    CORPORATE()
    const { host } = await mountPanel(DENVER.id)
    await setValue(host.querySelector('input[aria-label="Find one of these zips"]') as HTMLInputElement, '8001')
    await setValue(host.querySelector('select[aria-label="Location for 80015"]') as HTMLSelectElement, OMAHA.id)
    await settle()
    expect(writes).toEqual([{ method: 'PATCH', url: '/api/admin/location-zips', body: { id: 'd4', location_uuid: OMAHA.id } }])
    expect(chips(host)).toEqual(['80111', '80126', '80203'])
  })

  it('resolves a conflict from this page', async () => {
    CORPORATE()
    const { host } = await mountPanel(DENVER.id)
    await click(btnText(host, 'Give to Denver')!) // first Give-to-Denver = 80126 (sorted)
    expect(writes[0]).toEqual({ method: 'POST', url: '/api/admin/location-zips/resolve', body: { zip: '80126', location_uuid: DENVER.id } })
    expect(h.state.rows.filter((r) => r.zip === '80126').map((r) => r.location_uuid)).toEqual([DENVER.id])
    expect(host.querySelector('[data-testid="territory-conflicts"]')!.textContent).toContain('1 zip is also claimed')
  })
})

// ═══ D. where it is mounted, and shared parts ═════════════════════
describe('D. mounted on both location pages; built from the shared parts', () => {
  const BEEHUB = readFileSync('components/BeeHub.jsx', 'utf8')
  const PANEL = readFileSync('components/admin/LocationZipsPanel.jsx', 'utf8')
  const SCREEN = readFileSync('components/admin/AdminZipCodesScreen.jsx', 'utf8')
  const PARTS = readFileSync('components/admin/zips/zipParts.jsx', 'utf8')

  it('admin location sheet: directly under Quick info (the address), above the tabs', () => {
    const quick = BEEHUB.indexOf('{/* Quick info */}')
    const panel = BEEHUB.indexOf('<LocationZipsPanel locationId={currentLoc.id} />')
    const owners = BEEHUB.indexOf('{/* Owners — up to two claimed owners', quick)
    expect(quick).toBeGreaterThan(-1)
    expect(panel).toBeGreaterThan(quick)
    expect(panel).toBeLessThan(owners)
  })

  it('Settings → Location: right after Location details (address, Location ID), before the assessment default and the Emails pointer', () => {
    // 2026-11-13 (Settings slice 3): Location is rebuilt to the new look. The
    // panel itself is untouched and sits where it sat: after the details
    // card, before everything else.
    const details = BEEHUB.indexOf('<LUI.LocationIdLine id={settings.location.locId} />')
    const panel = BEEHUB.indexOf('<LocationZipsPanel locationId={realLocId} />')
    const assessment = BEEHUB.indexOf('<SUI.Section eyebrow="Assessment default"')
    // 2026-10-30: the Online Presence rows moved to Settings → Emails; the
    // pointer to them still follows the territory panel.
    const online = BEEHUB.indexOf('<SUI.EmailsLink plural what="Booking links')
    expect(details).toBeGreaterThan(0)
    expect(panel).toBeGreaterThan(details)
    expect(panel).toBeLessThan(assessment)
    expect(assessment).toBeLessThan(online)
  })

  it('both screens use the same parts — no second implementation', () => {
    for (const src of [PANEL, SCREEN]) {
      expect(src).toContain("from './zips/zipParts'")
      for (const part of ['useZipActions', 'ZipConflictRow', 'ZipAddForm', 'ZipEditRow', 'ZipChips']) expect(src).toContain(part)
      expect(src).not.toMatch(/fetch\(/) // all I/O goes through zipSend
    }
  })

  it('tokens only — no hex/rgba literal in the panel or the shared parts', () => {
    for (const src of [PANEL, PARTS]) {
      expect(/#[0-9a-fA-F]{3,8}\b/.test(src)).toBe(false)
      expect(/rgba?\(/.test(src)).toBe(false)
    }
  })
})
