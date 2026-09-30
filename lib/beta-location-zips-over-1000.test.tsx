// @vitest-environment happy-dom
//
// location_zips past Supabase's 1,000-row response cap.
//
// Production has 1,546 rows. Supabase returns at most 1,000 per response
// whatever .range() asks for. The first admin read asked for .range(0, 9999),
// got 1,000, and the screen said "1,000 zips · 34 locations · 0 in conflict",
// with Seattle, Portland, San Diego… at "0 zips" and the conflict card empty.
//
// The fake table below is the REAL list (every pair the migration loads) and
// enforces the cap the way PostgREST does: any response is cut to CAP rows.
//   A. ROUTING — every zip in the table routes to its location, including all
//      of those that sort past row 1,000. Pinned hardest: this is a lead sent
//      to Leslie that its own location holds.
//   B. THE ADMIN READ — true totals, 52 locations, 11 conflicts, the real
//      per-location counts Kevin verified in the database.
//   C. THE SCREEN — shows those totals, a late location's real count, and the
//      11 conflicts, and resolves one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SHEET_TO_BEE_HUB } from '@/lib/zip-territory-sheet'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── The real list, from the migration ───────────────────────────
const SQL = readFileSync('migrations/location_zips.sql', 'utf8')
const entriesBlock = (() => {
  const marker = 'entries(sheet, zip) AS (VALUES'
  const rest = SQL.slice(SQL.indexOf(marker) + marker.length)
  return rest.slice(0, rest.indexOf('\n  )'))
})()
const ENTRIES = Array.from(entriesBlock.matchAll(/\('((?:[^']|'')+)',\s*'(\d{5})'\)/g))
  .map(m => [m[1].replace(/''/g, "'"), m[2]] as [string, string])

const slugOf = (name: string) => 'loc_' + name.toLowerCase().replace(/[^a-z0-9]/g, '')
const LOCATIONS = Array.from(new Set(Object.values(SHEET_TO_BEE_HUB).filter(Boolean) as string[]))
  .sort()
  .map(name => ({ id: `L-${slugOf(name)}`, name, location_id: slugOf(name), lifecycle_status: 'active' }))
const LOC_BY_NAME = new Map(LOCATIONS.map(l => [l.name, l]))
const LOC_BY_ID = new Map(LOCATIONS.map(l => [l.id, l]))

// DISTINCT (zip, location) — exactly what the migration inserts.
const PAIRS = Array.from(new Set(
  ENTRIES.filter(([s]) => SHEET_TO_BEE_HUB[s]).map(([s, z]) => `${z}|${LOC_BY_NAME.get(SHEET_TO_BEE_HUB[s]!)!.id}`),
)).map((k, i) => {
  const [zip, location_uuid] = k.split('|')
  return { id: `r${String(i).padStart(5, '0')}`, zip, location_uuid, updated_at: 't' }
})

// ── A fake PostgREST that enforces the response cap ─────────────
const h = vi.hoisted(() => ({ state: { cap: 1000, rows: [] as any[], locations: [] as any[], locById: new Map(), calls: [] as any[] } }))

const makeBuilder = (table: string) => {
  const ctx: any = { table, cols: '', opts: undefined, filters: [], orders: [], range: null, op: 'select' }
  h.state.calls.push(ctx)
  const b: any = {}
  b.select = (cols: string, opts?: any) => { ctx.cols = cols; ctx.opts = opts; return b }
  b.eq = (c: string, v: any) => { ctx.filters.push(['eq', c, v]); return b }
  b.in = (c: string, v: any[]) => { ctx.filters.push(['in', c, v]); return b }
  b.order = (c: string, o: any = {}) => { ctx.orders.push([c, o.ascending !== false]); return b }
  b.range = (a: number, z: number) => { ctx.range = [a, z]; return b }
  b.limit = (n: number) => { ctx.range = [0, n - 1]; return b }
  b.delete = () => { ctx.op = 'delete'; return b }
  const run = () => {
    if (table === 'hub_users') return { data: { id: 'corp', role: 'admin' }, error: null }
    const src = table === 'locations' ? h.state.locations : h.state.rows
    const match = (r: any) => ctx.filters.every(([k, c, v]: any) => (k === 'eq' ? r[c] === v : v.includes(r[c])))
    if (ctx.op === 'delete') {
      const gone = h.state.rows.filter(match)
      h.state.rows = h.state.rows.filter((r: any) => !match(r))
      return { data: gone, error: null }
    }
    let out = src.filter(match)
    const count = out.length
    for (const [c, asc] of [...ctx.orders].reverse()) {
      out = [...out].sort((x: any, y: any) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1))
    }
    if (ctx.range) out = out.slice(ctx.range[0], ctx.range[1] + 1)
    out = out.slice(0, h.state.cap) // ← the server's max-rows: applies to EVERY response
    if (table === 'location_zips' && ctx.cols.includes('location:')) {
      out = out.map((r: any) => ({ zip: r.zip, location: h.state.locById.get(r.location_uuid) }))
    }
    return { data: out, error: null, count: ctx.opts?.count === 'exact' ? count : null }
  }
  b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
  b.maybeSingle = () => Promise.resolve(run()).then((r: any) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }))
  b.single = b.maybeSingle
  return b
}

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'corp' } } }) },
    from: (t: string) => makeBuilder(t),
  }),
}))

import { routeByZip } from '@/lib/zip-routing'
import { GET } from '@/app/api/admin/location-zips/route'
import { POST as RESOLVE } from '@/app/api/admin/location-zips/resolve/route'
import AdminZipCodesScreen from '@/components/admin/AdminZipCodesScreen'

beforeEach(() => {
  h.state.cap = 1000
  h.state.rows = PAIRS.map(r => ({ ...r }))
  h.state.locations = LOCATIONS
  h.state.locById = LOC_BY_ID
  h.state.calls = []
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

// Rows beyond the first 1,000 in the order a capped whole-table read returns.
const pastRow1000 = () =>
  [...PAIRS].sort((a, b) => (a.zip < b.zip ? -1 : a.zip > b.zip ? 1 : a.id < b.id ? -1 : 1)).slice(1000)

const claimants = (zip: string) => PAIRS.filter(p => p.zip === zip)

describe('the fixture is the real list', () => {
  it('1,546 pairs · 1,535 zips · 52 locations · 11 conflicts — the numbers verified in the database', () => {
    expect(PAIRS).toHaveLength(1546)
    expect(new Set(PAIRS.map(p => p.zip)).size).toBe(1535)
    expect(new Set(PAIRS.map(p => p.location_uuid)).size).toBe(52)
    const conflicted = Array.from(new Set(PAIRS.map(p => p.zip))).filter(z => claimants(z).length > 1)
    expect(conflicted).toHaveLength(11)
  })
})

// ═══ A. ROUTING — pinned hardest ═════════════════════════════════
describe('A. routing finds zips past the 1,000th row', () => {
  it('Seattle 98026 (sorts far past row 1,000) routes to Seattle, not Leslie', async () => {
    const late = pastRow1000().map(r => r.zip)
    expect(late).toContain('98026')
    const d = await routeByZip('98026')
    expect(d).toMatchObject({ reason: 'matched', slug: 'loc_seattle' })
  })

  it('EVERY zip past row 1,000 routes to its own location (or loc_other when conflicted)', async () => {
    const late = Array.from(new Set(pastRow1000().map(r => r.zip)))
    expect(late.length).toBeGreaterThan(500)
    for (const zip of late) {
      const owners = claimants(zip)
      const d = await routeByZip(zip)
      if (owners.length === 1) {
        expect(d, zip).toMatchObject({ reason: 'matched', slug: LOC_BY_ID.get(owners[0].location_uuid)!.location_id })
      } else {
        expect(d, zip).toMatchObject({ reason: 'conflict', slug: 'loc_other' })
      }
    }
  })

  it('EVERY zip in the table routes correctly — all 1,535', async () => {
    let matched = 0, conflicts = 0
    for (const zip of Array.from(new Set(PAIRS.map(p => p.zip)))) {
      const d = await routeByZip(zip)
      if (d.reason === 'matched') matched++
      else if (d.reason === 'conflict') conflicts++
      else throw new Error(`${zip} → ${d.reason}`)
    }
    expect({ matched, conflicts }).toEqual({ matched: 1524, conflicts: 11 })
  })

  it('the lookup asks the DATABASE for the one zip — it never pulls the table to filter', async () => {
    await routeByZip('98026')
    const q = h.state.calls.find(c => c.table === 'location_zips')
    expect(q.filters).toContainEqual(['eq', 'zip', '98026'])
  })

  it('still correct if the server cap were far lower (50)', async () => {
    h.state.cap = 50
    expect(await routeByZip('98026')).toMatchObject({ reason: 'matched', slug: 'loc_seattle' })
    expect(await routeByZip('80203')).toMatchObject({ reason: 'conflict' })
  })
})

// ═══ B. THE ADMIN READ ════════════════════════════════════════════
const zipsPer = (rows: any[], name: string) =>
  rows.filter(r => r.location_uuid === LOC_BY_NAME.get(name)!.id).length

describe('B. GET /api/admin/location-zips returns the whole list', () => {
  it('all 1,546 rows and the exact total, across pages', async () => {
    const j = await (await GET()).json()
    expect(j.total).toBe(1546)
    expect(j.zips).toHaveLength(1546)
    expect(new Set(j.zips.map((z: any) => z.id)).size).toBe(1546) // no page overlap
    expect(new Set(j.zips.map((z: any) => z.location_uuid)).size).toBe(52)
  })

  it('late locations carry their real counts (the ten that read "0 zips")', async () => {
    const j = await (await GET()).json()
    expect({
      Seattle: zipsPer(j.zips, 'Seattle'),
      Portland: zipsPer(j.zips, 'Portland'),
      'San Diego': zipsPer(j.zips, 'San Diego'),
      Scottsdale: zipsPer(j.zips, 'Scottsdale'),
      Temecula: zipsPer(j.zips, 'Temecula'),
      'Southwest Austin': zipsPer(j.zips, 'Southwest Austin'),
      'Central Austin': zipsPer(j.zips, 'Central Austin'),
      'Central Denver': zipsPer(j.zips, 'Central Denver'),
      'Northwest Austin': zipsPer(j.zips, 'Northwest Austin'),
      Peoria: zipsPer(j.zips, 'Peoria'),
    }).toEqual({
      Seattle: 87, Portland: 43, 'San Diego': 78, Scottsdale: 25, Temecula: 17,
      'Southwest Austin': 10, 'Central Austin': 9, 'Central Denver': 17, 'Northwest Austin': 8, Peoria: 40,
    })
  })

  it('the 11 conflicts are all in the response', async () => {
    const j = await (await GET()).json()
    const by = new Map<string, number>()
    for (const z of j.zips) by.set(z.zip, (by.get(z.zip) || 0) + 1)
    expect(Array.from(by.entries()).filter(([, n]) => n > 1).map(([z]) => z).sort()).toEqual([
      '80010', '80126', '80203', '80206', '80209', '80210', '80218', '80220', '80224', '80230', '80246',
    ])
  })

  it('completes even if the server cap is below the page size (cap 300)', async () => {
    h.state.cap = 300
    const j = await (await GET()).json()
    expect(j.zips).toHaveLength(1546)
    expect(j.total).toBe(1546)
  })
})

// ═══ C. THE SCREEN ════════════════════════════════════════════════
const mountWithRealApi = async () => {
  vi.stubGlobal('confirm', () => true)
  const writes: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET'
    if (method === 'GET') {
      const r = await GET()
      return { ok: r.status < 400, json: () => r.json() }
    }
    const body = init.body ? JSON.parse(init.body) : null
    writes.push({ method, url, body })
    if (url.endsWith('/resolve')) {
      const r = await RESOLVE({ json: async () => body, nextUrl: new URL('http://x' + url) } as any)
      return { ok: r.status < 400, json: () => r.json() }
    }
    return { ok: true, json: async () => ({}) }
  }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<AdminZipCodesScreen />) })
  for (let i = 0; i < 5; i++) await act(async () => {})
  return { host, writes }
}

describe('C. the Zip codes screen with more than 1,000 rows', () => {
  it('reports the true totals — 1,535 zips · 52 locations · 11 in conflict', async () => {
    const { host } = await mountWithRealApi()
    expect(host.textContent).toContain('1,535 zips · 52 locations · 11 in conflict')
    expect(host.textContent).not.toContain('zip rows loaded') // no incomplete-list warning
  })

  it('a location past the 1,000th row shows its real count (Seattle 87, Peoria 40)', async () => {
    const { host } = await mountWithRealApi()
    const rowFor = (name: string) =>
      Array.from(host.querySelectorAll('button[aria-expanded]')).find(b => b.textContent?.startsWith(name))!
    expect(rowFor('Seattle').textContent).toContain('87 zips')
    expect(rowFor('Peoria').textContent).toContain('40 zips')
    expect(rowFor('Central Denver').textContent).toContain('17 zips')
  })

  it('lists all 11 conflicts, and resolving one removes the loser and leaves 10', async () => {
    const { host, writes } = await mountWithRealApi()
    const card = host.querySelector('[data-testid="zip-conflicts"]')!
    for (const z of ['80010', '80126', '80203', '80206', '80209', '80210', '80218', '80220', '80224', '80230', '80246']) {
      expect(card.textContent).toContain(z)
    }
    const give = Array.from(card.querySelectorAll('button')).find(b => b.textContent === 'Give to West Denver')!
    await act(async () => { (give as HTMLElement).click() })
    for (let i = 0; i < 5; i++) await act(async () => {})
    expect(writes).toContainEqual({
      method: 'POST', url: '/api/admin/location-zips/resolve',
      body: { zip: '80126', location_uuid: LOC_BY_NAME.get('West Denver')!.id },
    })
    expect(claimants('80126')).toHaveLength(2) // fixture unchanged…
    expect(h.state.rows.filter((r: any) => r.zip === '80126').map((r: any) => r.location_uuid))
      .toEqual([LOC_BY_NAME.get('West Denver')!.id]) // …table resolved
    expect(host.textContent).toContain('1,535 zips · 52 locations · 10 in conflict')
    expect(await routeByZip('80126')).toMatchObject({ reason: 'matched', slug: 'loc_westdenver' })
  })

  it('says so on screen if it ever holds fewer rows than the true total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ zips: PAIRS.slice(0, 1000), total: 1546, locations: LOCATIONS }),
    })))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<AdminZipCodesScreen />) })
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Only 1,000 of 1,546 zip rows loaded')
  })
})
