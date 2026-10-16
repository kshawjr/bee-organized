// @vitest-environment happy-dom
//
// Location tags (2026-10-16) — each location creates and applies its own,
// behind a near-match guard so the list doesn't fragment again.
//   A) the near-match key: case, spacing, punctuation, plurals — not spelling
//   B) the verdict: use (active) · restore (own removed) · retired
//      (corporate off → still creatable) · none
//   C) a location's own tags: their own section, last, named for the location
//   D) the picker's create flow: Use / Restore / retired notice / Create
//   E) Settings › Tags: counts, rename, remove (switch-off) and restore
//   F) the read routes: /api/tags/own and corporate's /api/tags/locations
//   G) a switched-off tag is hidden on people's records
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  const state: any = { respond: (_ctx: any) => ({ data: null, error: null }), calls: [] as any[], hubUser: null as any }
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select', filters: [] as any[], payload: null }
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.limit = () => b
    for (const m of ['eq', 'is', 'in', 'or', 'ilike', 'not']) b[m] = (...a: any[]) => { ctx.filters.push([m, ...a]); return b }
    const resolve = () => { state.calls.push(ctx); return Promise.resolve(state.respond(ctx)) }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, makeBuilder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: {
  from: (t: string) => h.makeBuilder(t),
  // tag_delete_blockers — nothing blocks unless a test says so
  rpc: async (fn: string, args: any) => ({ data: (h.state.blockers || {})[args?.p_id] ?? [], error: null }),
} }))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => {}),
  getHubUser: vi.fn(async () => h.state.hubUser),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))

import { tagKey, nearTagVerdict, tagSection, sectionTags } from '@/lib/tags'
import PickerModal from '@/components/hive/shared/PickerModal'
import OwnTagsSettings from '@/components/hive/OwnTagsSettings'
import TagFilterSection from '@/components/hive/shared/TagFilterSection'
import { GET as ownGET } from '@/app/api/tags/own/route'
import { GET as locationsGET } from '@/app/api/tags/locations/route'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

// ── A) the key ───────────────────────────────────────────────────────────────
describe('A) the near-match key', () => {
  it.each([
    ['Realtor', 'realtor'], ['REALTORS', 'realtor'], [' Real tor ', 'realtor'], ['Real-tor', 'realtor'], ['Realtor/', 'realtor'],
    ['Estate Sales', 'estatesale'], ['Agencies', 'agency'], ['Boxes', 'box'], ['House Keeper', 'housekeeper'],
    ['Glass', 'glass'], ['Business', 'business'], ['Trash & Junk', 'trashjunk'],
  ])('%s → %s', (label, key) => { expect(tagKey(label)).toBe(key) })

  it('no spelling-distance matching: Mover and Moved stay apart', () => {
    expect(tagKey('Mover')).not.toBe(tagKey('Moved'))
  })
  it('an empty name has no key', () => { expect(tagKey('  -/ ')).toBe('') })
})

// ── B) the verdict ───────────────────────────────────────────────────────────
describe('B) what a new name collides with', () => {
  const C = [
    { id: 'c1', label: 'Realtor', location_id: null, is_active: true },
    { id: 'c2', label: 'Housekeeper', location_id: null, is_active: false },
    { id: 'o1', label: 'Snowbird', location_id: LOC, is_active: false },
    { id: 'o2', label: 'Organizer', location_id: LOC, is_active: true },
  ]
  it('an active tag (corporate or own) → use it', () => {
    expect(nearTagVerdict('realtors', C)).toEqual({ kind: 'use', tag: C[0] })
    expect(nearTagVerdict('Organizers', C)).toEqual({ kind: 'use', tag: C[3] })
  })
  it("the location's own removed tag → restore it", () => {
    expect(nearTagVerdict('snow birds', C)).toEqual({ kind: 'restore', tag: C[2] })
  })
  it('a retired corporate tag → retired (create still allowed)', () => {
    expect(nearTagVerdict('House Keeper', C)).toEqual({ kind: 'retired', tag: C[1] })
  })
  it('an active match beats a retired one', () => {
    expect(nearTagVerdict('housekeeper', [...C, { id: 'o3', label: 'Housekeepers', location_id: LOC, is_active: true }]).kind).toBe('use')
  })
  it('a rename is not checked against the tag itself', () => {
    expect(nearTagVerdict('organizers', C, 'o2')).toEqual({ kind: 'none' })
  })
  it('nothing close → none', () => { expect(nearTagVerdict('Piano tuner', C)).toEqual({ kind: 'none' }) })
})

// ── C) the own section ───────────────────────────────────────────────────────
describe("C) a location's own tags: their own section, last", () => {
  it('owned by a location → own, whatever its stored section (DO NOT BOOK keeps "relationship" in data)', () => {
    expect(tagSection({ location_id: LOC, attrs: { section: 'relationship' } })).toBe('own')
    expect(tagSection({ location_id: null, attrs: { section: 'relationship' } })).toBe('relationship')
  })
  it('sections come Relationship, Trade, then "<Location>\'s own" (A–Z)', () => {
    const out = sectionTags([
      { label: 'Lead', location_id: LOC, attrs: { section: 'relationship' } },
      { label: 'DO NOT BOOK', location_id: LOC, attrs: { section: 'relationship' } },
      { label: 'Realtor', attrs: { section: 'trade' } },
      { label: 'VIP', sort_order: 1020, attrs: { section: 'relationship' } },
    ] as any, "Southeast Nashville's own")
    expect(out.map(s => [s.key, s.label, s.rows.map((r: any) => r.label)])).toEqual([
      ['relationship', 'Relationship', ['VIP']],
      ['trade', 'Trade', ['Realtor']],
      ['own', "Southeast Nashville's own", ['DO NOT BOOK', 'Lead']],
    ])
  })
  it('every Tags filter shows the own section under the location’s name', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const r = createRoot(host)
    await act(async () => {
      r.render(<TagFilterSection tags={[
        { id: 'c1', label: 'Realtor', section: 'trade' },
        { id: 'o1', label: 'DO NOT BOOK', section: 'relationship', location_id: LOC, ownerName: 'Southeast Nashville' },
      ] as any} rows={[{ tagIds: ['c1', 'o1'] }]} picked={[]} />)
    })
    const own = host.querySelector('[data-section="own"]')!
    expect(own.textContent).toContain("Southeast Nashville's own")
    expect(own.textContent).toContain('DO NOT BOOK (1)')
    expect(host.querySelector('[data-section="relationship"]')).toBeNull()
    await act(async () => r.unmount()); host.remove()
  })
})

// ── D) the picker's create flow ──────────────────────────────────────────────
let host: HTMLDivElement
let root: Root
let fetchCalls: { url: string; init: any }[] = []
const LOOKUPS = [
  { id: 'c-realtor', label: 'Realtor', icon: '🏠', category: 'tags', location_id: null, is_active: true, attrs: { section: 'trade' } },
  { id: 'c-vip', label: 'VIP', icon: '⭐', category: 'tags', location_id: null, is_active: true, sort_order: 1020, attrs: { section: 'relationship' } },
  { id: 'o-org', label: 'Organizer', icon: null, category: 'tags', location_id: LOC, is_active: true, attrs: {} },
  { id: 'c-hk', label: 'Housekeeper', icon: '🧽', category: 'tags', location_id: null, is_active: false, attrs: { section: 'trade' } },
  { id: 'o-sb', label: 'Snowbird', icon: null, category: 'tags', location_id: LOC, is_active: false, attrs: {} },
]
const installFetch = (handlers: Record<string, (url: string, init: any) => any>) => {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const u = String(url); fetchCalls.push({ url: u, init })
    for (const [frag, fn] of Object.entries(handlers)) if (u.includes(frag)) {
      const r = fn(u, init); return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}
const type = async (el: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const click = async (el: Element) => act(async () => { (el as HTMLElement).click() })

describe("D) the picker: search, then Use / Restore / Create", () => {
  let saved: any = null
  const mountPicker = async (props: any = {}) => {
    saved = null
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => {
      root.render(<PickerModal category="tags" locationId={LOC} sections showIcons allowCreate mode="multi" selected={[]}
        onSave={(p: any) => { saved = p }} onClose={() => {}} {...props} />)
    })
    await act(async () => {})
  }
  const search = () => host.querySelector('[aria-label="Search options"]') as HTMLInputElement
  const checked = () => [...host.querySelectorAll('[aria-checked="true"]')].map(b => b.textContent!.trim())
  beforeEach(() => {
    installFetch({
      '/api/lookups?': () => ({ body: { lookups: LOOKUPS, location: { id: LOC, name: 'Denver' } } }),
      '/api/lookups/o-sb': (_u, init) => ({ body: { ok: true, lookup: { id: 'o-sb', label: 'Snowbird', is_active: JSON.parse(init.body).is_active } } }),
    })
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

  it('asks for switched-off tags too, and never offers them as options', async () => {
    await mountPicker()
    expect(fetchCalls[0].url).toBe(`/api/lookups?category=tags&location_id=${LOC}&include_inactive=1`)
    expect(host.textContent).not.toContain('Housekeeper')
    expect(host.textContent).not.toContain('Snowbird')
  })

  it("the location's own tags sit last, under \"Denver's own\"", async () => {
    await mountPicker()
    expect([...host.querySelectorAll('[data-section]')].map(s => s.getAttribute('data-section'))).toEqual(['relationship', 'trade', 'own'])
    expect(host.querySelector('[data-section="own"]')!.textContent).toContain("Denver's own")
    expect(host.querySelector('[data-section="own"]')!.textContent).toContain('Organizer')
  })

  it('a near-match of an active tag offers "Use" and no Create', async () => {
    await mountPicker()
    await type(search(), 'realtors')
    expect(host.querySelector('[data-near="use"]')!.textContent).toContain('Use 🏠 Realtor')
    expect(host.querySelector('[data-create]')).toBeNull()
    await click(host.querySelector('[data-near="use"]')!)
    expect(checked()).toEqual(['🏠 Realtor'])
  })

  it('typing an existing name exactly just shows it — no extra Use row', async () => {
    await mountPicker()
    await type(search(), 'realtor')
    expect(host.querySelector('[data-near="use"]')).toBeNull()
    expect(host.querySelector('[data-create]')).toBeNull()
  })

  it("their own removed tag offers Restore — it comes back on and is picked", async () => {
    await mountPicker()
    await type(search(), 'snow birds')
    expect(host.querySelector('[data-create]')).toBeNull()
    await click(host.querySelector('[data-near="restore"]')!)
    const p = fetchCalls.find(c => c.url === '/api/lookups/o-sb')!
    expect(p.init.method).toBe('PATCH')
    expect(JSON.parse(p.init.body)).toEqual({ is_active: true })
    expect(checked()).toEqual(['Snowbird'])
  })

  it('a retired corporate tag: says so, and STILL offers Create', async () => {
    let posted: any = null
    installFetch({
      '/api/lookups?': () => ({ body: { lookups: LOOKUPS, location: { id: LOC, name: 'Denver' } } }),
      '/api/lookups': (_u, init) => { posted = JSON.parse(init.body); return { body: { ok: true, lookup: { id: 'new-hk', label: 'House Keeper', category: 'tags', location_id: LOC, is_active: true, attrs: {} }, retired: { id: 'c-hk', label: 'Housekeeper' } } } },
    })
    await mountPicker()
    await type(search(), 'House Keeper')
    expect(host.querySelector('[data-near="retired"]')!.textContent).toContain('Corporate retired “Housekeeper”')
    await click(host.querySelector('[data-create]')!)
    await click(host.querySelector('[data-create-go]')!)
    expect(posted).toEqual({ category: 'tags', label: 'House Keeper', location_id: LOC })
    expect(host.textContent).toContain('Corporate has been told you needed “Housekeeper”')
    expect(checked()).toEqual(['House Keeper'])
  })

  it('nothing close → Create; the new tag is this location’s, picked, and announced to the app', async () => {
    const announced: any[] = []
    const onAdded = (e: any) => announced.push(e.detail)
    window.addEventListener('bee:tag-added', onAdded)
    installFetch({
      '/api/lookups?': () => ({ body: { lookups: LOOKUPS, location: { id: LOC, name: 'Denver' } } }),
      '/api/lookups': () => ({ body: { ok: true, lookup: { id: 'new-pt', label: 'Piano tuner', category: 'tags', location_id: LOC, is_active: true, attrs: {} } } }),
    })
    await mountPicker()
    await type(search(), 'Piano tuner')
    expect(host.querySelector('[data-create]')!.textContent).toContain('Only Denver will see it')
    await click(host.querySelector('[data-create]')!)
    await click(host.querySelector('[data-create-go]')!)
    expect(host.querySelector('[data-section="own"]')!.textContent).toContain('Piano tuner')
    expect(checked()).toEqual(['Piano tuner'])
    expect(announced).toEqual([expect.objectContaining({ id: 'new-pt', ownerName: 'Denver' })])
    window.removeEventListener('bee:tag-added', onAdded)
  })

  it('the server’s own near-match (a race) turns Create into Use', async () => {
    installFetch({
      '/api/lookups?': () => ({ body: { lookups: LOOKUPS, location: { id: LOC, name: 'Denver' } } }),
      '/api/lookups': () => ({ status: 409, body: { error: 'near_match', verdict: 'use', tag: { id: 'c-vip', label: 'VIP', icon: '⭐', location_id: null, is_active: true } } }),
    })
    await mountPicker()
    await type(search(), 'Very Important')
    await click(host.querySelector('[data-create]')!)
    await click(host.querySelector('[data-create-go]')!)
    expect(host.querySelector('[data-near="use"]')!.textContent).toContain('Use ⭐ VIP')
    expect(host.querySelector('[data-create]')).toBeNull()
  })

  it('without allowCreate (read-only staff): no create, and the box just says Search', async () => {
    await mountPicker({ allowCreate: false })
    expect(search().placeholder).toBe('Search')
    await type(search(), 'Piano tuner')
    expect(host.querySelector('[data-create]')).toBeNull()
    expect(host.querySelector('[data-near]')).toBeNull()
  })
})

// ── E) Settings › Tags ───────────────────────────────────────────────────────
describe('E) Settings › Tags', () => {
  const OWN = [
    { id: 'o-org', label: 'Organizer', icon: null, is_active: true, people: 12 },
    { id: 'o-sb', label: 'Snowbird', icon: null, is_active: false, people: 3 },
  ]
  const mountSettings = async () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root.render(<OwnTagsSettings locationId={LOC} locationName="Denver" />) })
    await act(async () => {})
  }
  const btn = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent!.trim() === t) as HTMLElement
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

  it('lists the location’s own tags with people counts; removed ones apart', async () => {
    installFetch({ '/api/tags/own': () => ({ body: { tags: OWN } }) })
    await mountSettings()
    expect(host.textContent).toContain("Denver's own tags")
    expect(host.querySelector('[data-own-tag="o-org"]')!.textContent).toContain('12 people')
    expect(host.querySelector('[data-own-tag="o-sb"]')!.textContent).toContain('removed — hidden everywhere')
  })

  it('Remove asks first, saying how many carry it, then switches it off', async () => {
    installFetch({
      '/api/tags/own': () => ({ body: { tags: OWN } }),
      '/api/lookups/o-org': (_u, init) => ({ body: { ok: true, lookup: { id: 'o-org', label: 'Organizer', is_active: JSON.parse(init.body).is_active } } }),
    })
    await mountSettings()
    await click(btn('Remove'))
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('12 people carry “Organizer”')
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('restore it here any time')
    await click(host.querySelector('[role="dialog"]')!.querySelector('button')!)
    expect(JSON.parse(fetchCalls.find(c => c.url === '/api/lookups/o-org')!.init.body)).toEqual({ is_active: false })
    expect(host.querySelector('[data-own-tag="o-org"]')!.textContent).toContain('removed')
  })

  it('a rename that near-matches is refused with the existing tag named', async () => {
    installFetch({
      '/api/tags/own': () => ({ body: { tags: OWN } }),
      '/api/lookups/o-org': () => ({ status: 409, body: { error: 'near_match', verdict: 'use', tag: { id: 'c-realtor', label: 'Realtor' } } }),
    })
    await mountSettings()
    await click(btn('Rename'))
    await type(host.querySelector('[aria-label="New name for Organizer"]') as HTMLInputElement, 'Realtors')
    await click(btn('Save'))
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('“Realtor” is already a tag')
  })

  it('a copy made corporate says so and has no Restore', async () => {
    installFetch({ '/api/tags/own': () => ({ body: { tags: [{ id: 'o-dnb', label: 'DO NOT BOOK', icon: null, is_active: false, people: 1, promoted: true, deleteBlockers: ['clients:1', 'promotion'], deleteReason: '1 person carries it — take it off them first, or Remove it to hide it.' }] } }) })
    await mountSettings()
    const row = host.querySelector('[data-own-tag="o-dnb"]')!
    expect(row.textContent).toContain('made corporate — it’s in the shared list now')
    // No Restore, no Icon — only Delete, greyed, saying why (never hidden).
    expect([...row.querySelectorAll('button')].map(b => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([['Delete', true]])
  })

  it('Restore switches a removed tag back on', async () => {
    installFetch({
      '/api/tags/own': () => ({ body: { tags: OWN } }),
      '/api/lookups/o-sb': (_u, init) => ({ body: { ok: true, lookup: { id: 'o-sb', label: 'Snowbird', is_active: JSON.parse(init.body).is_active } } }),
    })
    await mountSettings()
    await click(btn('Restore'))
    expect(JSON.parse(fetchCalls.find(c => c.url === '/api/lookups/o-sb')!.init.body)).toEqual({ is_active: true })
  })

  it('Settings shows it to owners and managers', () => {
    const src = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(src).toContain("const canManageOwnTags = franchiseRole === 'owner' || franchiseRole === 'manager'")
    expect(src).toContain("<OwnTagsSettings locationId={realLocId}")
  })
})

// ── F) the read routes ───────────────────────────────────────────────────────
describe('F) /api/tags/own and /api/tags/locations', () => {
  const req = (u: string) => new Request(`http://t.local${u}`) as any
  beforeEach(() => { h.state.calls = [] })

  it('own: an owner reads their own location, with people counts', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = (ctx: any) => {
      if (ctx.table === 'lookups') return { data: [{ id: 'o-org', label: 'Organizer', is_active: true }], error: null }
      if (ctx.table === 'lead_tags') return { data: [{ tag_lookup_id: 'o-org' }, { tag_lookup_id: 'o-org' }], error: null }
      if (ctx.table === 'partner_tags') return { data: [{ tag_lookup_id: 'o-org' }], error: null }
      return { data: null, error: null }
    }
    const json = await (await ownGET(req(`/api/tags/own?location_id=${LOC}`))).json()
    expect(json.tags).toEqual([{ id: 'o-org', label: 'Organizer', is_active: true, people: 3, deleteBlockers: [], deleteReason: null }])
    expect(h.state.calls.find((c: any) => c.table === 'lookups').filters).toContainEqual(['eq', 'location_id', LOC])
  })

  it('own: a copy collapsed into a corporate tag is marked promoted', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = (ctx: any) => {
      if (ctx.table === 'lookups') return { data: [{ id: 'o-dnb', label: 'DO NOT BOOK', is_active: false }], error: null }
      if (ctx.table === 'tag_promotion_copies') return { data: [{ tag_id: 'o-dnb' }], error: null }
      return { data: [], error: null }
    }
    const json = await (await ownGET(req(`/api/tags/own?location_id=${LOC}`))).json()
    expect(json.tags[0]).toMatchObject({ id: 'o-dnb', promoted: true })
    const promoRead = h.state.calls.find((c: any) => c.table === 'tag_promotion_copies')
    expect(promoRead.filters).toContainEqual(['is', 'tag_promotions.undone_at', null])
  })

  it("own: another location's, or read-only staff → 403", async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    expect((await ownGET(req(`/api/tags/own?location_id=${LOC}`))).status).toBe(403)
    h.state.hubUser = { id: 'u3', role: 'lite_user', location_id: LOC }
    expect((await ownGET(req(`/api/tags/own?location_id=${LOC}`))).status).toBe(403)
  })

  it('locations: corporate only; the same name at several locations is ONE row, most widespread first', async () => {
    h.state.hubUser = { id: 'u9', role: 'owner', location_id: LOC }
    expect((await locationsGET()).status).toBe(403)

    h.state.hubUser = { id: 'a1', role: 'super_admin', location_id: null }
    h.state.respond = (ctx: any) => {
      if (ctx.table === 'lookups') return { data: [
        { id: 't1', label: 'Organizer', location_id: 'L1', is_active: true, created_at: '2026-10-16', attrs: { created_by_user: 'u1' }, location: { name: 'Denver' } },
        { id: 't2', label: 'organizers', location_id: 'L2', is_active: true, created_at: '2026-10-16', attrs: {}, location: { name: 'Boston' } },
        { id: 't3', label: 'Snowbird', location_id: 'L1', is_active: false, created_at: '2026-10-16', attrs: {}, location: { name: 'Denver' } },
      ], error: null }
      if (ctx.table === 'lead_tags') return { data: [{ tag_lookup_id: 't1' }, { tag_lookup_id: 't2' }, { tag_lookup_id: 't2' }], error: null }
      if (ctx.table === 'partner_tags') return { data: [], error: null }
      if (ctx.table === 'hub_users') return { data: [{ id: 'u1', full_name: 'Dana Owner' }], error: null }
      return { data: [], error: null }
    }
    const json = await (await locationsGET()).json()
    expect(json.groups.map((g: any) => [g.key, g.locations, g.people])).toEqual([['organizer', 2, 3], ['snowbird', 1, 0]])
    expect(json.groups[0].tags.map((t: any) => [t.location_name, t.created_by, t.people])).toEqual([['Denver', 'Dana Owner', 1], ['Boston', null, 2]])
    expect(h.state.calls.find((c: any) => c.table === 'lookups').filters).toContainEqual(['not', 'location_id', 'is', null])
  })
})

// ── G) records hide a switched-off tag ───────────────────────────────────────
describe('G) a switched-off tag is hidden on people’s records', () => {
  it('the Network record’s tag read asks for switched-on tags only', () => {
    const src = readFileSync('app/api/partner-tags/route.ts', 'utf8')
    expect(src).toMatch(/\.in\('id', ids\)[\s\S]{0,250}\.eq\('is_active', true\)/)
  })
  it('so does the client record’s', () => {
    const src = readFileSync('app/api/clients/[id]/profile/route.ts', 'utf8')
    expect(src).toMatch(/\.in\('id', tagLookupIds\)[\s\S]{0,200}\.eq\('is_active', true\)/)
  })
})
