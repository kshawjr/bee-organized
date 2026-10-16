// @vitest-environment happy-dom
//
// "Make corporate" (Configure › Location tags, 2026-10-16). The database
// half (make_tag_corporate / undo_tag_promotion) is proven on a real
// Postgres by the migration run; this pins the app half:
//   A) the route previews (dry run, nothing written) before it runs
//   B) a corporate tag with the same name is the target, not a duplicate
//   C) only corporate may use it; only location tags may be promoted
//   D) the panel: Preview → Make corporate → Undo
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  const state: any = { respond: (_: any) => ({ data: null, error: null }), calls: [] as any[], rpc: [] as any[], rpcResult: { data: 'promo-1', error: null }, hubUser: null as any }
  const makeBuilder = (table: string) => {
    const ctx: any = { table, filters: [] as any[] }
    const b: any = {}
    for (const m of ['select', 'order', 'limit']) b[m] = () => b
    for (const m of ['eq', 'is', 'in', 'not', 'or']) b[m] = (...a: any[]) => { ctx.filters.push([m, ...a]); return b }
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
    rpc: async (fn: string, args: any) => { h.state.rpc.push({ fn, args }); return h.state.rpcResult },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => {}),
  getHubUser: vi.fn(async () => h.state.hubUser),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))

import { POST as makePOST } from '@/app/api/tags/make-corporate/route'
import { POST as undoPOST } from '@/app/api/tags/make-corporate/undo/route'
import LocationTagsPanel from '@/components/hive/LocationTagsPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const req = (body: any) => new Request('http://t.local/api/tags/make-corporate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as any
const has = (ctx: any, m: string, col?: string) => ctx.filters.some((f: any[]) => f[0] === m && (!col || f[1] === col))

const DNB_COPY = { id: 'dnb', label: 'DO NOT BOOK', icon: null, is_active: true, location_id: 'L-nash', sort_order: 1080, location: { name: 'Southeast Nashville' } }
const scenario = (corp: any[] = [], leadLinks: any[] = [{ lead_id: 'jess', tag_lookup_id: 'dnb' }], partnerLinks: any[] = []) => (ctx: any) => {
  if (ctx.table === 'lookups' && has(ctx, 'not')) return { data: [DNB_COPY], error: null }       // the copies
  if (ctx.table === 'lookups' && has(ctx, 'is', 'location_id')) return { data: corp, error: null } // corporate tags
  if (ctx.table === 'lead_tags') return { data: leadLinks, error: null }
  if (ctx.table === 'partner_tags') return { data: partnerLinks, error: null }
  return { data: [], error: null }
}
beforeEach(() => { h.state.calls = []; h.state.rpc = []; h.state.rpcResult = { data: 'promo-1', error: null }; h.state.hubUser = { id: 'admin-1', role: 'super_admin' } })

describe('A) preview first, then run', () => {
  it('a dry run returns the plan and writes nothing', async () => {
    h.state.respond = scenario()
    const json = await (await makePOST(req({ tagIds: ['dnb'], label: 'DO NOT BOOK', icon: '🛑', section: 'relationship', dryRun: true }))).json()
    expect(json.plan).toEqual({
      target: { kind: 'new', label: 'DO NOT BOOK', icon: '🛑', section: 'relationship', sortOrder: 1080 },
      clients: { carriers: 1, alreadyOnTarget: 0, linksAdded: 1 },
      network: { carriers: 0, alreadyOnTarget: 0, linksAdded: 0 },
      copies: [{ id: 'dnb', label: 'DO NOT BOOK', location: 'Southeast Nashville', isActive: true }],
    })
    expect(h.state.rpc).toEqual([])
  })

  it('no dryRun flag at all is treated as a dry run', async () => {
    h.state.respond = scenario()
    await makePOST(req({ tagIds: ['dnb'], label: 'DO NOT BOOK', section: 'relationship' }))
    expect(h.state.rpc).toEqual([])
  })

  it('dryRun:false runs make_tag_corporate once, logged with who and from where', async () => {
    h.state.respond = scenario()
    const json = await (await makePOST(req({ tagIds: ['dnb'], label: 'DO NOT BOOK', icon: '🛑', section: 'relationship', dryRun: false }))).json()
    expect(json.promotionId).toBe('promo-1')
    expect(h.state.rpc).toEqual([{ fn: 'make_tag_corporate', args: {
      p_copy_ids: ['dnb'], p_label: 'DO NOT BOOK', p_icon: '🛑', p_section: 'relationship', p_target_id: null, p_sort_order: 1080,
      p_by: 'admin-1', p_note: 'Configure › Location tags: "DO NOT BOOK" from Southeast Nashville',
    } }])
  })

  it('a database failure is reported, not swallowed', async () => {
    h.state.respond = scenario()
    h.state.rpcResult = { data: null, error: { message: 'function make_tag_corporate does not exist' } }
    const res = await makePOST(req({ tagIds: ['dnb'], label: 'DO NOT BOOK', section: 'relationship', dryRun: false }))
    expect(res.status).toBe(500)
    expect((await res.json()).detail).toContain('does not exist')
  })
})

describe('B) an existing corporate tag with the same name is the target', () => {
  it('uses it (switching it back on if retired) instead of creating a duplicate', async () => {
    h.state.respond = scenario([{ id: 'c-hk', label: 'Housekeeper', icon: '🧽', is_active: false }], [
      { lead_id: 'a', tag_lookup_id: 'dnb' }, { lead_id: 'b', tag_lookup_id: 'dnb' }, { lead_id: 'b', tag_lookup_id: 'c-hk' },
    ])
    const json = await (await makePOST(req({ tagIds: ['dnb'], label: 'House Keepers', dryRun: true }))).json()
    expect(json.plan.target).toEqual({ kind: 'existing', id: 'c-hk', label: 'Housekeeper', icon: '🧽', wasActive: false })
    expect(json.plan.clients).toEqual({ carriers: 2, alreadyOnTarget: 1, linksAdded: 1 })
    await makePOST(req({ tagIds: ['dnb'], label: 'House Keepers', dryRun: false }))
    expect(h.state.rpc[0].args).toMatchObject({ p_target_id: 'c-hk', p_label: null, p_section: null })
  })
})

describe('C) who and what', () => {
  it('only corporate', async () => {
    h.state.hubUser = { id: 'o1', role: 'owner' }
    expect((await makePOST(req({ tagIds: ['dnb'], label: 'X', section: 'trade' }))).status).toBe(403)
    expect((await undoPOST(req({ promotionId: 'promo-1' }))).status).toBe(403)
  })
  it('only location tags can be promoted', async () => {
    h.state.respond = (ctx: any) => (ctx.table === 'lookups' && has(ctx, 'not') ? { data: [], error: null } : { data: [], error: null })
    const res = await makePOST(req({ tagIds: ['c-realtor'], label: 'Realtor', section: 'trade', dryRun: false }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('not_all_location_tags')
    expect(h.state.rpc).toEqual([])
  })
  it('a new corporate tag needs a section', async () => {
    h.state.respond = scenario()
    expect((await makePOST(req({ tagIds: ['dnb'], label: 'DO NOT BOOK', dryRun: true }))).status).toBe(400)
  })
  it('undo calls undo_tag_promotion and returns its receipt', async () => {
    h.state.rpcResult = { data: 'undone: 1 client links and 0 Network links removed, 1 copies restored, corporate tag removed', error: null }
    const json = await (await undoPOST(req({ promotionId: 'promo-1' }))).json()
    expect(h.state.rpc).toEqual([{ fn: 'undo_tag_promotion', args: { p_promotion_id: 'promo-1' } }])
    expect(json.receipt).toContain('corporate tag removed')
  })
})

// ── D) the panel ─────────────────────────────────────────────────────────────
describe('D) the panel: Preview → Make corporate → Undo', () => {
  let host: HTMLDivElement, root: Root
  let calls: { url: string; init: any }[] = []
  const GROUPS = [{ key: 'donotbook', label: 'DO NOT BOOK', locations: 1, people: 1, tags: [
    { id: 'dnb', label: 'DO NOT BOOK', icon: null, is_active: true, location_name: 'Southeast Nashville', people: 1, created_at: '2026-08-25' },
    { id: 'old', label: 'Do not book', icon: null, is_active: false, location_name: 'Boston', people: 0, created_at: '2026-08-01' },
  ] }]
  let promotions: any[] = []
  beforeEach(() => {
    calls = []; promotions = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
      const u = String(url); calls.push({ url: u, init })
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body })
      if (u === '/api/tags/locations') return ok({ groups: GROUPS })
      if (u === '/api/tags/make-corporate' && !init.method) return ok({ promotions })
      if (u === '/api/tags/make-corporate') {
        const b = JSON.parse(init.body)
        if (b.dryRun) return ok({ plan: { target: { kind: 'new', label: b.label, icon: b.icon, section: b.section }, clients: { linksAdded: 1, alreadyOnTarget: 0 }, network: { linksAdded: 0, alreadyOnTarget: 0 }, copies: [{ label: 'DO NOT BOOK', location: 'Southeast Nashville' }] } })
        promotions = [{ id: 'promo-1', created_at: '2026-10-16', undone_at: null, tag: { label: 'DO NOT BOOK', icon: '🛑' } }]
        return ok({ ok: true, promotionId: 'promo-1' })
      }
      if (u === '/api/tags/make-corporate/undo') { promotions = [{ ...promotions[0], undone_at: '2026-10-16' }]; return ok({ ok: true, receipt: 'undone: 1 client links …' }) }
      return ok({})
    }))
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
  const btn = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent!.trim() === t) as HTMLElement
  const click = async (el: Element) => act(async () => { (el as HTMLElement).click() })
  const set = async (el: any, v: string) => act(async () => {
    const proto = el.tagName === 'SELECT' ? (globalThis as any).window.HTMLSelectElement.prototype : (globalThis as any).window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })

  it('previews first, runs only on the second press, then offers Undo', async () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root.render(<LocationTagsPanel />) })
    await act(async () => {})
    await click(host.querySelector('[data-tag-group="donotbook"] button')!)
    await click(btn('Make corporate…'))
    await set(host.querySelector('[aria-label="Icon"]'), '🛑')
    await set(host.querySelector('[aria-label="Section"]'), 'relationship')
    await click(btn('Preview'))
    const preview = calls.find(c => c.url === '/api/tags/make-corporate' && c.init.method === 'POST')!
    // Only the copy still in use — Boston's removed one stays removed.
    expect(JSON.parse(preview.init.body)).toEqual({ tagIds: ['dnb'], label: 'DO NOT BOOK', icon: '🛑', section: 'relationship', dryRun: true })
    expect(host.querySelector('[data-plan]')!.textContent).toContain('Creates corporate “DO NOT BOOK” 🛑 in Relationship')
    expect(host.querySelector('[data-plan]')!.textContent).toContain('Adds it to 1 client and 0 Network people')
    expect(calls.filter(c => c.init.method === 'POST' && JSON.parse(c.init.body).dryRun === false)).toHaveLength(0)
    await click(btn('Make corporate'))
    expect(JSON.parse(calls.filter(c => c.url === '/api/tags/make-corporate' && c.init.method === 'POST')[1].init.body).dryRun).toBe(false)
    await act(async () => {})
    expect(host.querySelector('[data-recent-promotions]')!.textContent).toContain('🛑 DO NOT BOOK')
    await click(btn('Undo'))
    expect(JSON.parse(calls.find(c => c.url === '/api/tags/make-corporate/undo')!.init.body)).toEqual({ promotionId: 'promo-1' })
  })
})
