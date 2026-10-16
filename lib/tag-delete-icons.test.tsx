// @vitest-environment happy-dom
//
// Custom tags, round two (2026-10-16):
//   A) near-match on the stored CODE too — Kevin's "real estate" vs Realtor
//      (code real-estate) got through on name-only matching; pinned here
//   B) the curated icon grid, enforced by the server
//   C) permanent delete: who may, what blocks it, and the reason in words
//   D) the picker's create confirm card — Enter never creates
//   E) Settings › Tags: Icon and Delete; Configure › Retired tags
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  const state: any = { respond: (_: any) => ({ data: null, error: null }), calls: [] as any[], rpc: [] as any[], rpcResult: (_fn: string, _a: any) => ({ data: [], error: null }), hubUser: null as any }
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select', filters: [] as any[], payload: null }
    const b: any = {}
    b.select = () => b; b.order = () => b; b.limit = () => b
    b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
    b.update = (p: any) => { ctx.op = 'update'; ctx.payload = p; return b }
    for (const m of ['eq', 'is', 'in', 'or', 'ilike', 'not']) b[m] = (...a: any[]) => { ctx.filters.push([m, ...a]); return b }
    const resolve = () => { state.calls.push(ctx); return Promise.resolve(state.respond(ctx)) }
    b.single = resolve; b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, makeBuilder }
})
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (t: string) => h.makeBuilder(t),
    rpc: async (fn: string, args: any) => { h.state.rpc.push({ fn, args }); return h.state.rpcResult(fn, args) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => {}),
  getHubUser: vi.fn(async () => h.state.hubUser),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(async () => null) }))

import { nearTagVerdict, isAllowedTagIcon, TAG_ICON_CHOICES, describeTagBlockers } from '@/lib/tags'
import { POST as lookupsPOST } from '@/app/api/lookups/route'
import { POST as deletePOST } from '@/app/api/tags/delete/route'
import { GET as retiredGET } from '@/app/api/tags/retired/route'
import PickerModal from '@/components/hive/shared/PickerModal'
import OwnTagsSettings from '@/components/hive/OwnTagsSettings'
import RetiredTagsPanel from '@/components/hive/RetiredTagsPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REALTOR = { id: 'c-realtor', label: 'Realtor', icon: '🏠', location_id: null, is_active: true, attrs: { key: 'real-estate', section: 'trade' } }
const postReq = (url: string, body: any) => new Request(`http://t.local${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as any
const f = (ctx: any, k: string) => ctx.filters.find((x: any[]) => x[0] === k)

beforeEach(() => { h.state.calls = []; h.state.rpc = []; h.state.rpcResult = () => ({ data: [], error: null }) })

// ── A) the code ──────────────────────────────────────────────────────────────
describe('A) near-match on the stored code as well as the name', () => {
  it('"real estate" matches Realtor through its code real-estate (Kevin’s test tag, 2026-10-16)', () => {
    expect(nearTagVerdict('real estate', [REALTOR])).toEqual({ kind: 'use', tag: REALTOR })
    expect(nearTagVerdict('Real-Estate', [REALTOR]).kind).toBe('use')
  })
  it('senior living → Senior Living, networking → Networking Group (its code)', () => {
    expect(nearTagVerdict('senior living', [{ id: 's', label: 'Senior Living', attrs: { key: 'senior-living' }, is_active: true }]).kind).toBe('use')
    expect(nearTagVerdict('Networking', [{ id: 'n', label: 'Networking Group', attrs: { key: 'networking' }, is_active: true }]).kind).toBe('use')
  })
  it('a true synonym with no code still gets through — the limit, stated', () => {
    expect(nearTagVerdict('Agent', [REALTOR]).kind).toBe('none')
  })
  it('the server blocks "real estate" for an owner, offering Realtor', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = (ctx: any) => (ctx.table === 'lookups' && ctx.op === 'select' && f(ctx, 'in') && !f(ctx, 'eq') ? { data: [REALTOR], error: null } : { data: null, error: null })
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'tags', label: 'real estate', location_id: LOC }))
    expect(res.status).toBe(409)
    expect((await res.json()).tag.label).toBe('Realtor')
    expect(h.state.calls.find((c: any) => c.op === 'insert')).toBeUndefined()
  })
})

// ── B) icons ─────────────────────────────────────────────────────────────────
describe('B) the curated icon grid', () => {
  it('24 icons, none of them used by a live corporate tag in production', () => {
    expect(TAG_ICON_CHOICES).toHaveLength(24)
    const CORPORATE_LIVE = ['🔥', '⭐', '🤝', '🚫', '🛑', '🧰', '👋', '🏠', '🏗️', '🔨', '⚡', '🔧', '🏢', '🐛', '🎨', '🚪', '🛋️', '🧹', '📦', '🗑️', '🤲', '🏥', '🫶', '🏷️', '🏪', '📸']
    expect(TAG_ICON_CHOICES.filter(e => CORPORATE_LIVE.includes(e))).toEqual([])
  })
  it('none, or one from the grid — nothing else', () => {
    expect(isAllowedTagIcon('')).toBe(true)
    expect(isAllowedTagIcon(null)).toBe(true)
    expect(isAllowedTagIcon('🐾')).toBe(true)
    expect(isAllowedTagIcon('🍆')).toBe(false)
    expect(isAllowedTagIcon('Realtor')).toBe(false)
  })
  it('the server refuses an owner’s off-grid icon on create', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = () => ({ data: null, error: null })
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'tags', label: 'Snowbird', location_id: LOC, icon: '🍆' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('icon_not_allowed')
  })
})

// ── C) delete ────────────────────────────────────────────────────────────────
describe('C) permanent delete', () => {
  const OWN = { id: 'o-sb', category: 'tags', label: 'Snowbird', location_id: LOC }
  const CORP_NEW = { id: 'c-mentor', category: 'tags', label: 'Mentor', location_id: null }
  const rowIs = (row: any) => (ctx: any) => (ctx.table === 'lookups' ? { data: row, error: null } : { data: null, error: null })

  it('an owner deletes their own unused tag — the database decides, in one step', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = rowIs(OWN)
    const json = await (await deletePOST(postReq('/api/tags/delete', { id: 'o-sb' }))).json()
    expect(json).toEqual({ deleted: true, label: 'Snowbird' })
    expect(h.state.rpc).toEqual([{ fn: 'delete_tag_if_unused', args: { p_id: 'o-sb', p_by: 'u1' } }])
  })
  it('blocked → 409, nothing deleted, and the reason in words', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = rowIs(OWN)
    h.state.rpcResult = () => ({ data: ['clients:2', 'network:1'], error: null })
    const res = await deletePOST(postReq('/api/tags/delete', { id: 'o-sb' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ deleted: false, blockers: ['clients:2', 'network:1'], reason: '3 people carry it — take it off them first, or Remove it to hide it.' })
  })
  it("an owner can't delete another location's tag or a corporate one; read-only staff can't delete", async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    h.state.respond = rowIs({ ...OWN, location_id: OTHER })
    expect((await deletePOST(postReq('/api/tags/delete', { id: 'o-sb' }))).status).toBe(403)
    h.state.respond = rowIs(CORP_NEW)
    expect((await deletePOST(postReq('/api/tags/delete', { id: 'c-mentor' }))).status).toBe(403)
    h.state.hubUser = { id: 'u3', role: 'lite_user', location_id: LOC }
    h.state.respond = rowIs(OWN)
    expect((await deletePOST(postReq('/api/tags/delete', { id: 'o-sb' }))).status).toBe(403)
    expect(h.state.rpc).toEqual([])
  })
  it('corporate may delete a corporate tag — the database still refuses merged / live ones', async () => {
    h.state.hubUser = { id: 'a1', role: 'super_admin' }
    h.state.respond = rowIs({ id: 'c-hk', category: 'tags', label: 'Housekeeper', location_id: null })
    h.state.rpcResult = () => ({ data: ['corporate_merged'], error: null })
    const json = await (await deletePOST(postReq('/api/tags/delete', { id: 'c-hk' }))).json()
    expect(json.reason).toBe('Kept on purpose: it’s how owners are told corporate retired it, and how their requests reach you.')
  })
  it.each([
    [['corporate_active'], 'Switch it off first.'],
    [['tag_merge_log'], 'A past change to the tag list can still be undone, and that undo needs this tag.'],
    [['relationship_tag_log'], 'A past change to the tag list can still be undone, and that undo needs this tag.'],
    [['promotion'], 'A past change to the tag list can still be undone, and that undo needs this tag.'],
    [['clients:1'], '1 person carries it — take it off them first, or Remove it to hide it.'],
    [[], null],
  ])('blockers %j read as %j', (b, text) => { expect(describeTagBlockers(b as string[])).toBe(text) })

  it('Retired list: corporate only, every retired tag with its reason', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC }
    expect((await retiredGET()).status).toBe(403)
    h.state.hubUser = { id: 'a1', role: 'super_admin' }
    h.state.respond = () => ({ data: [{ id: 'c-hk', label: 'Housekeeper', icon: '🧽' }, { id: 'c-mentor', label: 'Mentor', icon: null }], error: null })
    h.state.rpcResult = (_fn: string, a: any) => ({ data: a.p_id === 'c-hk' ? ['corporate_merged'] : [], error: null })
    const json = await (await retiredGET()).json()
    expect(json.tags.map((t: any) => [t.label, t.reason])).toEqual([
      ['Housekeeper', 'Kept on purpose: it’s how owners are told corporate retired it, and how their requests reach you.'],
      ['Mentor', null],
    ])
  })
})

// ── D) the picker's create confirm card ─────────────────────────────────────
let host: HTMLDivElement
let root: Root
let calls: { url: string; init: any }[] = []
const installFetch = (handlers: Record<string, (u: string, init: any) => any>) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const u = String(url); calls.push({ url: u, init })
    for (const [k, fn] of Object.entries(handlers)) if (u.includes(k)) { const r = fn(u, init); return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}
const click = async (el: Element) => act(async () => { (el as HTMLElement).click() })
const type = async (el: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const mount = async (node: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(node) }); await act(async () => {})
}
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); vi.unstubAllGlobals() })

describe('D) create needs a confirm — Enter never creates', () => {
  beforeEach(() => installFetch({
    '/api/lookups?': () => ({ body: { lookups: [REALTOR], location: { id: LOC, name: 'Denver' } } }),
    '/api/lookups': () => ({ body: { ok: true, lookup: { id: 'new', label: 'Piano tuner', icon: '🐾', category: 'tags', location_id: LOC, is_active: true, attrs: {} } } }),
  }))
  const open = () => mount(<PickerModal category="tags" locationId={LOC} sections showIcons allowCreate mode="multi" selected={[]} onSave={() => {}} onClose={() => {}} />)
  const search = () => host.querySelector('[aria-label="Search options"]') as HTMLInputElement
  const posts = () => calls.filter(c => c.url === '/api/lookups' && c.init.method === 'POST')

  it('Enter opens the card, which names the tag and the location — and creates nothing', async () => {
    await open()
    await type(search(), 'Piano tuner')
    await act(async () => { search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const card = host.querySelector('[data-create-confirm]')!
    expect(card.textContent).toContain('“Piano tuner”')
    expect(card.textContent).toContain('Only Denver will see it')
    expect(posts()).toHaveLength(0)
    // a second Enter still doesn't create
    await act(async () => { search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(posts()).toHaveLength(0)
  })

  it('one tap on Create creates it, with the icon picked from the grid', async () => {
    await open()
    await type(search(), 'Piano tuner')
    await click(host.querySelector('[data-create]')!)
    await click(host.querySelector('[aria-label="Icon 🐾"]')!)
    expect(host.querySelector('[data-create-confirm]')!.textContent).toContain('Create 🐾 “Piano tuner”?')
    await click(host.querySelector('[data-create-go]')!)
    expect(JSON.parse(posts()[0].init.body)).toEqual({ category: 'tags', label: 'Piano tuner', location_id: LOC, icon: '🐾' })
  })

  it('None is the default — no icon is sent', async () => {
    await open()
    await type(search(), 'Piano tuner')
    await click(host.querySelector('[data-create]')!)
    expect(host.querySelector('[aria-label="No icon"]')!.getAttribute('aria-checked')).toBe('true')
    await click(host.querySelector('[data-create-go]')!)
    expect(JSON.parse(posts()[0].init.body)).toEqual({ category: 'tags', label: 'Piano tuner', location_id: LOC })
  })

  it('Cancel, or typing something else, closes the card', async () => {
    await open()
    await type(search(), 'Piano tuner')
    await click(host.querySelector('[data-create]')!)
    await click([...host.querySelectorAll('[data-create-confirm] button')].find(b => b.textContent === 'Cancel')!)
    expect(host.querySelector('[data-create-confirm]')).toBeNull()
    await click(host.querySelector('[data-create]')!)
    await type(search(), 'Piano tuners')
    expect(host.querySelector('[data-create-confirm]')).toBeNull()
  })

  it('"real estate" never reaches Create — Use Realtor instead', async () => {
    await open()
    await type(search(), 'real estate')
    expect(host.querySelector('[data-create]')).toBeNull()
    expect(host.querySelector('[data-near="use"]')!.textContent).toContain('Use 🏠 Realtor')
  })
})

// ── E) Settings › Tags and Configure › Retired ──────────────────────────────
describe('E) Settings › Tags: Icon and Delete', () => {
  const OWN = [
    { id: 'o-free', label: 'Snowbird', icon: null, is_active: false, people: 0, deleteBlockers: [], deleteReason: null },
    { id: 'o-used', label: 'Organizer', icon: null, is_active: true, people: 2, deleteBlockers: ['clients:2'], deleteReason: '2 people carry it — take it off them first, or Remove it to hide it.' },
  ]
  const btnIn = (row: Element, t: string) => [...row.querySelectorAll('button')].find(b => b.textContent!.trim() === t) as HTMLButtonElement

  it('Delete is greyed with the reason when blocked — never hidden', async () => {
    installFetch({ '/api/tags/own': () => ({ body: { tags: OWN } }) })
    await mount(<OwnTagsSettings locationId={LOC} locationName="Denver" />)
    const used = host.querySelector('[data-own-tag="o-used"]')!
    expect(btnIn(used, 'Delete').disabled).toBe(true)
    expect(used.querySelector('[data-delete-blocked]')!.textContent).toBe('Can’t delete: 2 people carry it — take it off them first, or Remove it to hide it.')
  })

  it('an unused tag: Delete → "can’t be undone" → gone', async () => {
    installFetch({ '/api/tags/own': () => ({ body: { tags: OWN } }), '/api/tags/delete': () => ({ body: { deleted: true } }) })
    await mount(<OwnTagsSettings locationId={LOC} locationName="Denver" />)
    await click(btnIn(host.querySelector('[data-own-tag="o-free"]')!, 'Delete'))
    const dlg = host.querySelector('[role="dialog"]')!
    expect(dlg.textContent).toContain('Delete “Snowbird” permanently?')
    expect(dlg.textContent).toContain('can’t be undone')
    await click(btnIn(dlg, 'Delete permanently'))
    expect(JSON.parse(calls.find(c => c.url === '/api/tags/delete')!.init.body)).toEqual({ id: 'o-free' })
    expect(host.querySelector('[data-own-tag="o-free"]')).toBeNull()
  })

  it('if something changed meanwhile, the refusal is shown and the row updated', async () => {
    installFetch({ '/api/tags/own': () => ({ body: { tags: OWN } }), '/api/tags/delete': () => ({ status: 409, body: { deleted: false, blockers: ['network:1'], reason: '1 person carries it — take it off them first, or Remove it to hide it.' } }) })
    await mount(<OwnTagsSettings locationId={LOC} locationName="Denver" />)
    await click(btnIn(host.querySelector('[data-own-tag="o-free"]')!, 'Delete'))
    await click(btnIn(host.querySelector('[role="dialog"]')!, 'Delete permanently'))
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Couldn\'t delete “Snowbird”: 1 person carries it')
    expect(btnIn(host.querySelector('[data-own-tag="o-free"]')!, 'Delete').disabled).toBe(true)
  })

  it('Icon opens the curated grid and saves the pick', async () => {
    installFetch({ '/api/tags/own': () => ({ body: { tags: OWN } }), '/api/lookups/o-used': (_u, init) => ({ body: { ok: true, lookup: { id: 'o-used', label: 'Organizer', icon: JSON.parse(init.body).icon, is_active: true } } }) })
    await mount(<OwnTagsSettings locationId={LOC} locationName="Denver" />)
    await click(btnIn(host.querySelector('[data-own-tag="o-used"]')!, 'Icon'))
    expect(host.querySelectorAll('[data-icon-grid] [role="radio"]')).toHaveLength(25)   // None + 24
    await click(host.querySelector('[aria-label="Icon 🗄️"]')!)
    expect(JSON.parse(calls.find(c => c.url === '/api/lookups/o-used')!.init.body)).toEqual({ icon: '🗄️' })
    expect(host.querySelector('[data-own-tag="o-used"]')!.textContent).toContain('🗄️ Organizer')
  })
})

describe('E) Configure › Retired tags', () => {
  it('merged ones say why they’re kept; a never-merged one can be deleted', async () => {
    installFetch({
      '/api/tags/retired': () => ({ body: { tags: [
        { id: 'c-hk', label: 'Housekeeper', icon: '🧽', reason: 'Kept on purpose: it’s how owners are told corporate retired it, and how their requests reach you.' },
        { id: 'c-mentor', label: 'Mentor', icon: null, reason: null },
      ] } }),
      '/api/tags/delete': () => ({ body: { deleted: true } }),
    })
    await mount(<RetiredTagsPanel />)
    const hk = host.querySelector('[data-retired-tag="c-hk"]')!
    expect(hk.textContent).toContain('Can’t delete: Kept on purpose')
    expect(([...hk.querySelectorAll('button')].find(b => b.textContent === 'Delete') as HTMLButtonElement).disabled).toBe(true)
    const mentor = host.querySelector('[data-retired-tag="c-mentor"]')!
    await click([...mentor.querySelectorAll('button')].find(b => b.textContent === 'Delete')!)
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('can’t be undone')
    await click([...host.querySelector('[role="dialog"]')!.querySelectorAll('button')].find(b => b.textContent === 'Delete permanently')!)
    expect(JSON.parse(calls.find(c => c.url === '/api/tags/delete')!.init.body)).toEqual({ id: 'c-mentor' })
  })
})
