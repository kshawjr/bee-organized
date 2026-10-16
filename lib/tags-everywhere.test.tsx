// @vitest-environment happy-dom
//
// Tags everywhere people are listed — push 1 (2026-10-15).
//   A) the shared filter brains (shared/tagFilter) — one copy, Network's
//      old imports still resolve to it
//   B) client rows carry real tagIds (lead_tags link ids), not short codes
//   C) the client record's Tags row hands tagIds up through the patch seam
//   D) Everyone: the Network tag filter (sections, counts, any-of, chips)
//      and a search box that matches tag names
//   E) global search (/api/search): tag-name hits, fenced, labelled why
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  const state: any = { respond: (_ctx: any) => ({ data: null, error: null }), calls: [] as any[], user: { id: 'u1' }, hubUser: null as any }
  const makeBuilder = (table: string) => {
    const ctx: any = { table, filters: [] as any[] }
    const b: any = {}
    for (const m of ['select', 'order', 'limit']) b[m] = () => b
    for (const m of ['eq', 'is', 'in', 'or', 'ilike', 'not']) b[m] = (...args: any[]) => { ctx.filters.push([m, ...args]); return b }
    const resolve = () => { state.calls.push(ctx); return Promise.resolve(state.respond(ctx)) }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, makeBuilder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user } }) },
    from: (t: string) => {
      const b = h.makeBuilder(t)
      b.single = () => Promise.resolve({ data: h.state.hubUser, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/auth', () => ({ isAdmin: (r: string) => r === 'super_admin' || r === 'admin' }))

import { matchesTags, tagOptionsInUse, matchesTagSearch } from '@/components/hive/shared/tagFilter'
import * as networkGroups from '@/components/hive/shared/networkGroups'
import { mapLeadToPerson } from '@/lib/people-mapper'
import { leadColsToPersonFields } from '@/components/hive/shared/leadPatchMap'
import ClientGroupedList from '@/components/hive/ClientGroupedList'
import { GET as searchGET } from '@/app/api/search/route'
import { readFileSync } from 'node:fs'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const TAGS = [
  { id: 't-hot', label: 'Hot Lead', icon: '🔥', section: 'relationship', sort_order: 1010 },
  { id: 't-vip', label: 'VIP', icon: '⭐', section: 'relationship', sort_order: 1020 },
  { id: 't-realtor', label: 'Realtor', icon: '🏠', section: 'trade', sort_order: 2010 },
  { id: 't-unused', label: 'Mover', icon: '📦', section: 'trade', sort_order: 2020 },
]
const tagById = new Map(TAGS.map(t => [t.id, t]))

describe('A) shared tag filter', () => {
  it('Network’s old imports are the shared functions, not copies', () => {
    expect(networkGroups.matchesTags).toBe(matchesTags)
    expect(networkGroups.tagOptionsInUse).toBe(tagOptionsInUse)
  })
  it('matchesTagSearch finds a tag whose NAME contains the text, and says which', () => {
    expect(matchesTagSearch({ tagIds: ['t-vip', 't-realtor'] }, 'realt', tagById)).toBe(tagById.get('t-realtor'))
    expect(matchesTagSearch({ tagIds: ['t-vip'] }, 'realt', tagById)).toBeNull()
    expect(matchesTagSearch({ tagIds: ['t-realtor'] }, '', tagById)).toBeNull()
    expect(matchesTagSearch({}, 'realt', tagById)).toBeNull()
  })
})

describe('B) client rows carry real tagIds', () => {
  it('from the lead_tags links — the same ids Network rows carry', () => {
    const p: any = mapLeadToPerson({ id: 'l1', name: 'Dana' } as any, {
      lead_tags: [{ lead_id: 'l1', tag_lookup_id: 't-hot' }, { lead_id: 'l1', tag_lookup_id: 't-dnb' }],
      tag_lookups: { 't-hot': { id: 't-hot', attrs: { key: 'hot' } }, 't-dnb': { id: 't-dnb', attrs: {} } },
    } as any)
    expect(p.tagIds).toEqual(['t-hot', 't-dnb'])
    expect(p.tags).toEqual(['hot', 't-dnb'])   // the retired Classic short codes, unchanged
    expect((mapLeadToPerson({ id: 'l2', name: 'X' } as any, {}) as any).tagIds).toEqual([])
  })
})

describe('C) the record’s Tags row keeps the list fresh', () => {
  it('tag_ids from the record become person.tagIds', () => {
    expect(leadColsToPersonFields({ tag_ids: ['t-hot'] })).toEqual({ tagIds: ['t-hot'] })
  })
  it('ClientProfile hands the new ids up after every Tags change', () => {
    const src = readFileSync('components/hive/ClientProfile.jsx', 'utf8')
    expect(src).toContain("onLeadPatched(c.id, { tag_ids: next.map(t => t.id) })")
  })
})

// ── D) Everyone ──────────────────────────────────────────────────────────────
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const person = (over: any) => ({
  email: '', phone: '', locationId: 'loc-1', created: daysAgo(200), paidAmount: null, outreachTimeline: [],
  jobs: [], isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null, wonEngagements: null,
  engagementCount: 0, tagIds: [], ...over,
})
const PEOPLE = [
  person({ id: 'c1', name: 'Dana Whitfield', email: 'dana@x.com', tagIds: ['t-hot'] }),
  person({ id: 'c2', name: 'Karen Pell', tagIds: ['t-realtor', 't-vip'] }),
  person({ id: 'c3', name: 'Realtor Rita', tagIds: [] }),      // the NAME contains realtor
  person({ id: 'c4', name: 'Sam Untagged' }),
]

let host: HTMLDivElement
let root: Root
const mount = async (props: any = {}) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => {
    root.render(<ClientGroupedList people={PEOPLE} engagements={[]} locFilter="all" tags={TAGS} {...props} />)
  })
}
const names = () => [...host.querySelectorAll('.bee-grp-row')].map(r => r.querySelector('p')!.textContent).sort()
const button = (text: string) => [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text) as HTMLElement
const type = async (el: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const searchBox = () => host.querySelector('input[placeholder^="Search name"]') as HTMLInputElement

describe('D) Everyone — the Network tag filter and tag-matching search', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', lsMock); lsStore.clear() })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

  it('typing "realtor" finds the person TAGGED Realtor as well as the name match', async () => {
    await mount()
    await type(searchBox(), 'realtor')
    expect(names()).toEqual(['Karen Pell', 'Realtor Rita'])
    expect(searchBox().placeholder).toContain('tag')
  })

  it('the filter lists only tags someone here has, in sections, with counts', async () => {
    await mount()
    await act(async () => { button('Filters').click() })
    const opts = (k: string) => [...host.querySelectorAll(`[data-testid="clients-tag-options"] [data-section="${k}"] button`)].map(b => b.textContent)
    expect(opts('relationship')).toEqual(['🔥 Hot Lead (1)', '⭐ VIP (1)'])
    expect(opts('trade')).toEqual(['🏠 Realtor (1)'])   // Mover: nobody carries it
  })

  it('picking tags is any-of, shows chips, and opens the bands', async () => {
    await mount()
    await act(async () => { button('Filters').click() })
    const opt = (t: string) => [...host.querySelectorAll('[data-testid="clients-tag-options"] button')].find(b => b.textContent!.includes(t)) as HTMLElement
    await act(async () => { opt('Hot Lead').click() })
    expect(names()).toEqual(['Dana Whitfield'])
    await act(async () => { opt('Realtor').click() })
    expect(names()).toEqual(['Dana Whitfield', 'Karen Pell'])
    expect(host.querySelector('[data-active-tag="t-hot"]')!.textContent).toContain('🔥 Hot Lead')
    expect(button('Filters · 2')).toBeTruthy()
  })

  it("a row shows the client's tags, so a tag match is visible", async () => {
    await mount()
    await type(searchBox(), 'karen')
    const row = host.querySelector('.bee-grp-row')!
    expect(row.textContent).toContain('🏠 Realtor, ⭐ VIP')
  })

  it('nobody tagged → the filter says so', async () => {
    await mount({ people: PEOPLE.map(p => ({ ...p, tagIds: [] })) })
    await act(async () => { button('Filters').click() })
    expect(host.textContent).toContain('No one here is tagged yet')
  })
})

// ── E) global search ─────────────────────────────────────────────────────────
describe('E) global search matches tag names and says why', () => {
  const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const req = (q: string) => new Request(`http://t.local/api/search?q=${encodeURIComponent(q)}`)
  const has = (ctx: any, m: string, col?: string) => ctx.filters.some((f: any[]) => f[0] === m && (!col || f[1] === col))
  beforeEach(() => {
    h.state.calls = []
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = (ctx: any) => {
      if (ctx.table === 'leads' && has(ctx, 'or')) return { data: [{ id: 'l-name', name: 'Realtor Rita', location_uuid: LOC }], error: null }
      if (ctx.table === 'lookups' && has(ctx, 'ilike', 'label')) return { data: [{ id: 't-realtor', label: 'Realtor', icon: '🏠' }], error: null }
      if (ctx.table === 'lead_tags') return { data: [{ lead_id: 'l-tag', tag_lookup_id: 't-realtor' }, { lead_id: 'l-name', tag_lookup_id: 't-realtor' }], error: null }
      if (ctx.table === 'leads' && has(ctx, 'in', 'id')) return { data: [{ id: 'l-tag', name: 'Karen Pell', location_uuid: LOC }], error: null }
      if (ctx.table === 'partners' && has(ctx, 'or')) return { data: [], error: null }
      if (ctx.table === 'partner_tags') return { data: [{ partner_id: 'p-tag', tag_lookup_id: 't-realtor' }], error: null }
      if (ctx.table === 'partners' && has(ctx, 'in', 'id')) return { data: [{ id: 'p-tag', name: 'Jo Agent', location_id: LOC, partner_tags: [{ tag_lookup_id: 't-realtor' }] }], error: null }
      if (ctx.table === 'locations') return { data: [{ id: LOC, name: 'Denver' }], error: null }
      return { data: [], error: null }
    }
  })

  it('name matches first, then people found by tag — each tag hit says which tag', async () => {
    const json = await (await searchGET(req('realtor'))).json()
    expect(json.results.map((r: any) => [r.name, r.matchedTag?.label ?? null])).toEqual([
      ['Realtor Rita', null],            // matched by name — no tag label, not duplicated
      ['Karen Pell', 'Realtor'],
    ])
    expect(json.results[1].matchedTag).toEqual({ id: 't-realtor', label: 'Realtor', icon: '🏠' })
    expect(json.partners.map((p: any) => [p.name, p.matchedTag?.label])).toEqual([['Jo Agent', 'Realtor']])
  })

  it('tag hits go through the same location fence as name hits', async () => {
    await searchGET(req('realtor'))
    const tagLookup = h.state.calls.find((c: any) => c.table === 'lookups')
    expect(tagLookup.filters).toContainEqual(['or', `location_id.is.null,location_id.eq.${LOC}`])
    expect(tagLookup.filters).toContainEqual(['eq', 'is_active', true])
    const taggedLeads = h.state.calls.find((c: any) => c.table === 'leads' && has(c, 'in', 'id'))
    expect(taggedLeads.filters).toContainEqual(['eq', 'location_uuid', LOC])
    const taggedPartners = h.state.calls.find((c: any) => c.table === 'partners' && has(c, 'in', 'id'))
    expect(taggedPartners.filters).toContainEqual(['eq', 'location_id', LOC])
  })

  it('no matching tag → no tag queries, name results unchanged', async () => {
    const base = h.state.respond
    h.state.respond = (ctx: any) => (ctx.table === 'lookups' ? { data: [], error: null } : base(ctx))
    const json = await (await searchGET(req('dana'))).json()
    expect(h.state.calls.some((c: any) => c.table === 'lead_tags' || c.table === 'partner_tags')).toBe(false)
    expect(json.results.every((r: any) => !r.matchedTag)).toBe(true)
  })
})
