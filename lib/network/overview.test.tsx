// @vitest-environment happy-dom
//
// Slice 9: the corporate overview (lib/network/overview.ts, its route, and
// the "All locations" tab). Pinned: what a row counts; who may read it (the
// Network gate: an owner never sees other locations' numbers); it shows only
// on All locations; it writes nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { buildOverview } from './overview'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LOCS = [{ id: A, name: 'Akron', slug: 'loc_akron' }, { id: B, name: 'Boise', slug: 'loc_boise' }, { id: C, name: 'Camden', slug: 'loc_camden' }, { id: TEST, name: 'Test Location', slug: 'loc_test' }]
const CONTACTS = [
  { location_id: A, network_types: ['partner'], partner_stage: 'Gone quiet' },
  { location_id: A, network_types: ['partner', 'vendor'], partner_stage: 'New Contact' },
  { location_id: A, network_types: null, partner_stage: null },
  { location_id: B, network_types: ['unsure'], partner_stage: null },
  { location_id: B, network_types: [], partner_stage: null },
  { location_id: B, network_types: ['vendor'], partner_stage: null },
  { location_id: TEST, network_types: ['unsure'], partner_stage: null },
]
const REFERRED = [{ id: 'l1', name: 'x', created_at: null, location_uuid: A }, { id: 'l2', name: 'y', created_at: null, location_uuid: A }, { id: 'l3', name: 'z', created_at: null, location_uuid: TEST }]
const ENGS = [{ client_id: 'l1', stage: 'Closed Won', total_paid: 1200 }, { client_id: 'l2', stage: 'Closed Lost', total_paid: 0 }, { client_id: 'l3', stage: 'Closed Won', total_paid: 999 }]

describe('what a row counts', () => {
  it('contacts, Referral partners, not typed, gone quiet, referred, won, revenue; Test Location left out; not-started named', () => {
    const o = buildOverview({ locations: LOCS, contacts: CONTACTS, referred: REFERRED, engagements: ENGS })
    const row = (id: string) => o.rows.find((r) => r.id === id)!
    expect(row(A)).toMatchObject({ contacts: 3, partners: 2, notSure: 1, goneQuiet: 1, referred: 2, won: 1, revenue: 1200, started: true })
    expect(row(B)).toMatchObject({ contacts: 3, partners: 0, notSure: 2, goneQuiet: 0, referred: 0, started: true })
    expect(row(C)).toMatchObject({ contacts: 0, started: false })
    expect(o.rows.find((r) => r.id === TEST)).toBeUndefined()
    expect(o.notStarted).toEqual(['Camden'])
    expect(o.totals).toEqual({ locations: 3, started: 2, contacts: 6, partners: 2, notSure: 3, goneQuiet: 1, referred: 2, won: 1, revenue: 1200 })
  })
  it('the biggest untyped backlog comes first', () => {
    const o = buildOverview({ locations: LOCS, contacts: CONTACTS, referred: [], engagements: [] })
    expect(o.rows.map((r) => r.name)).toEqual(['Boise', 'Akron', 'Camden'])
  })
})

// ── the route ──
const h = vi.hoisted(() => ({ state: { role: null as string | null, calls: [] as any[], tables: {} as Record<string, any[]> } }))
function builder(table: string) {
  const c: any = { table, op: 'select', filters: [] as any[], range: null as any }
  const b: any = {}
  b.select = () => b
  for (const op of ['insert', 'update', 'upsert', 'delete']) b[op] = () => { c.op = op; throw new Error(`WRITE ${op} ${table}`) }
  b.eq = (k: string, v: any) => { c.filters.push((r: any) => r[k] === v); return b }
  b.is = (k: string, v: any) => { c.filters.push((r: any) => (v === null ? r[k] == null : r[k] === v)); return b }
  b.not = (k: string, op: string, v: any) => { if (op === 'is') c.filters.push((r: any) => (v === null ? r[k] != null : r[k] !== v)); return b }
  b.in = (k: string, vs: any[]) => { c.filters.push((r: any) => vs.includes(r[k])); return b }
  b.order = () => b
  b.range = (a: number, z: number) => { c.range = [a, z]; return b }
  const run = () => {
    h.state.calls.push(c)
    if (table === 'hub_users') return { data: h.state.role ? { id: 'me', role: h.state.role, location_id: A } : null, error: null }
    let rows = (h.state.tables[table] || []).filter((r) => c.filters.every((f: any) => f(r)))
    if (c.range) rows = rows.slice(c.range[0], c.range[1] + 1)
    return { data: rows, error: null }
  }
  b.single = async () => run()
  b.maybeSingle = async () => run()
  b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
  return b
}
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => builder(t) } }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.state.role ? { id: 'me' } : null } }) }, from: (t: string) => builder(t) }) }))
import * as route from '@/app/api/network/overview/route'

describe('who may read it', () => {
  beforeEach(() => {
    h.state.calls = []
    h.state.tables = {
      locations: LOCS,
      partners: CONTACTS.map((c, i) => ({ id: `p${i}`, deleted_at: null, ...c })).concat([{ id: 'gone', deleted_at: '2026-01-01', location_id: C, network_types: ['partner'], partner_stage: null } as any]),
      leads: REFERRED.map((l) => ({ ...l, referred_by_kind: 'partner', referred_by_id: 'p0', is_junk: null })),
      engagements: ENGS,
    }
  })
  it('super admin: every location, and only reads', async () => {
    h.state.role = 'super_admin'
    const res = await route.GET()
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.rows.map((r: any) => r.name).sort()).toEqual(['Akron', 'Boise', 'Camden'])
    expect(j.notStarted).toEqual(['Camden']) // a deleted contact does not count as a start
    expect(h.state.calls.every((c) => c.op === 'select')).toBe(true)
  })
  it('owner, manager, read-only and corporate (until the un-grey): 403, and nothing of any location is read', async () => {
    for (const role of ['owner', 'manager', 'lite_user', 'admin']) {
      h.state.role = role; h.state.calls = []
      expect((await route.GET()).status, role).toBe(403)
      expect(h.state.calls.map((c) => c.table), role).toEqual(['hub_users'])
    }
    h.state.role = null
    expect((await route.GET()).status).toBe(401)
  })
  it('the route exports GET and nothing that writes', () => {
    expect(Object.keys(route).filter((k) => /^(GET|POST|PATCH|PUT|DELETE)$/.test(k))).toEqual(['GET'])
    const src = readFileSync(join(process.cwd(), 'app/api/network/overview/route.ts'), 'utf8')
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/)
  })
})

// ── on screen ──
import NetworkTabs from '@/components/network/NetworkTabs'
describe('the All locations tab', () => {
  let host: HTMLDivElement, root: any
  const fetcher: any = vi.fn(async (url: string) => {
    if (url === '/api/network/overview') return { ok: true, status: 200, json: async () => buildOverview({ locations: LOCS, contacts: CONTACTS, referred: REFERRED, engagements: ENGS }) }
    if (url.startsWith('/api/network/list')) return { ok: true, status: 200, json: async () => ({ contacts: [], tags: [], followUps: {}, total: 0, truncated: false }) }
    if (url.startsWith('/api/network/summary')) return { ok: true, status: 200, json: async () => ({ referrers: [], totals: {} }) }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  beforeEach(() => { fetcher.mockClear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
  it('no location picked: an All locations tab beside the list; it names who has not started', async () => {
    await act(async () => { root.render(React.createElement(NetworkTabs as any, { locationId: null, locationName: '', fetchImpl: fetcher })) }); await settle()
    expect(host.querySelector('[data-tab="network"]')!.getAttribute('aria-selected')).toBe('true') // Network still opens on the list
    expect(fetcher.mock.calls.map((c: any) => c[0])).not.toContain('/api/network/overview') // nothing read until asked
    await act(async () => { (host.querySelector('[data-tab="overview"]') as HTMLElement).click() }); await settle()
    expect(host.querySelector('[data-tab="overview"]')!.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('[data-not-started]')!.textContent).toBe('Not started (1): Camden.')
    expect(host.querySelector('[data-tile="started"]')!.textContent).toBe('2 of 3locations have started')
    expect(Array.from(host.querySelectorAll('[data-overview-table] tbody tr')).map((r) => r.querySelector('td')!.textContent)).toEqual(['Boise', 'Akron'])
  })
  it('one location picked: no overview tab at all', async () => {
    await act(async () => { root.render(React.createElement(NetworkTabs as any, { locationId: A, locationName: 'Akron', fetchImpl: fetcher })) }); await settle()
    expect(host.querySelector('[data-tab="overview"]')).toBeNull()
    expect(host.querySelector('[data-network-overview]')).toBeNull()
    expect(fetcher.mock.calls.map((c: any) => c[0])).not.toContain('/api/network/overview')
  })
})

describe('three tabs on a phone', () => {
  it('shrink and wrap their words, so they never push the page sideways (found in the 390px picture)', () => {
    const src = readFileSync(join(process.cwd(), 'components/network/NetworkTabs.jsx'), 'utf8')
    const phone = src.slice(src.indexOf('@media (max-width:767px)'), src.indexOf('}\n', src.indexOf('@media (max-width:767px)')) + 1)
    expect(phone).toContain('[data-network-tabs] .nt-tab{flex:1 1 0;min-width:0;')
    expect(phone).toContain('white-space:normal')
    expect(phone).toContain('[data-network-tabs] .nt-tabs{display:flex;flex:1 1 auto;max-width:100%}')
  })
})
