// The four screens Network calls OUTSIDE its own routes, driven as every role.
//
//   tags on a contact   /api/partner-tags        GET · POST · DELETE
//   touchpoints         /api/touchpoints         POST (a contact or a client)
//   reminders           /api/reminders           POST · GET, /api/reminders/[id] PATCH · DELETE
//   tag-making          /api/lookups             GET · POST, /api/lookups/[id] PATCH · DELETE,
//                       /api/lookups/reorder     POST
//
// TESTED, NOT REWRITTEN (Kevin, 2026-11-20). None of these routes is changed by
// this file or by the commit that added it; the last block pins their bytes.
// Each is driven with the REAL handler and the REAL sign-in lookup against the
// stand-in database owner-safe-routes.test.ts uses, as super admin, corporate,
// owner, manager and lite user, aimed at HOME (the user's own location), AWAY
// (somebody else's) and PAUSED (a paused location's own owner).
//
// What is pinned as SAFE: nobody below corporate reads or changes anything of
// AWAY's through any of them; a lite user changes nothing but their own
// reminders; a paused location's owner changes nothing but their own reminders.
//
// What is pinned as FOUND (named for Kevin before the gate widens, not fixed):
//   1. /api/touchpoints takes engagement_id from the browser without checking
//      the card belongs to the person or the location. An owner can log a
//      touchpoint on their own contact that names another location's card, and
//      that card's timeline (/api/engagements/[id], read by engagement_id) then
//      shows it. Production: 0 of 2,657 card touchpoints are at the wrong
//      location (read 2026-11-20), so it has never happened.
//   2. partner-tags, touchpoints and reminders answer another location's
//      record with 403 (forbidden), not 404 like a missing id. Nothing is read
//      or changed, but a guessed id learns that it exists. The Network routes
//      answer 404 for both.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { withoutNotFoundFix } from '@/lib/not-found-footprint'

const h = vi.hoisted(() => {
  const state: any = { sessionUser: null, hubUser: null, tables: {} as Record<string, any[]>, calls: [] as any[], gateRoles: ['super_admin', 'admin', 'owner', 'manager', 'lite_user'] }
  let n = 0
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', filters: [] as any[], payload: null as any, returning: false }
    const apply = () => {
      let rows = state.tables[table] || []
      for (const [k, col, val] of ctx.filters) {
        if (k === 'eq') rows = rows.filter((r: any) => r[col] === val)
        if (k === 'neq') rows = rows.filter((r: any) => r[col] !== val)
        if (k === 'in') rows = rows.filter((r: any) => val.includes(r[col]))
        if (k === 'is' && val === null) rows = rows.filter((r: any) => r[col] == null)
        if (k === 'is' && val === true) rows = rows.filter((r: any) => r[col] === true)
        if (k === 'notis' && val === null) rows = rows.filter((r: any) => r[col] != null)
        if (k === 'notis' && val === true) rows = rows.filter((r: any) => r[col] !== true)
        if (k === 'or') rows = rows.filter((r: any) => String(val).split(',').some((part) => {
          const [c, op, ...rest] = part.split('.'); const v = rest.join('.')
          return op === 'is' && v === 'null' ? r[c] == null : op === 'eq' ? String(r[c]) === v : false
        }))
      }
      return rows
    }
    const resolve = (single: boolean) => {
      state.calls.push({ ...ctx, filters: ctx.filters.slice() })
      if (client === 'session' && table === 'hub_users') return Promise.resolve({ data: state.hubUser, error: null })
      if (ctx.op === 'insert' || ctx.op === 'upsert') {
        const list = (Array.isArray(ctx.payload) ? ctx.payload : [ctx.payload]).map((r: any) => ({ id: `new-${++n}`, ...r }))
        ;(state.tables[table] ||= []).push(...list)
        return Promise.resolve({ data: single ? list[0] : list, error: null })
      }
      const rows = apply()
      if (ctx.op === 'update') { for (const r of rows) Object.assign(r, ctx.payload); return Promise.resolve({ data: single ? (rows[0] ? { ...rows[0] } : null) : rows.map((r: any) => ({ ...r })), error: null }) }
      if (ctx.op === 'delete') { state.tables[table] = (state.tables[table] || []).filter((r: any) => !rows.includes(r)); return Promise.resolve({ data: null, error: null }) }
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows.map((r: any) => ({ ...r })), error: null })
    }
    const b: any = new Proxy({}, {
      get(_t, k: string) {
        if (k === 'then') return (res: any, rej: any) => resolve(false).then(res, rej)
        if (k === 'single' || k === 'maybeSingle') return () => resolve(true)
        if (['insert', 'update', 'upsert', 'delete'].includes(k)) return (p?: any) => { ctx.op = k; ctx.payload = p ?? null; return b }
        if (k === 'eq' || k === 'neq' || k === 'in' || k === 'is') return (c: string, v: any) => { ctx.filters.push([k, c, v]); return b }
        if (k === 'or') return (v: string) => { ctx.filters.push(['or', '', v]); return b }
        if (k === 'not') return (c: string, op: string, v: any) => { if (op === 'is') ctx.filters.push(['notis', c, v]); return b }
        return () => b
      },
    })
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t, 'service') } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.sessionUser } }) },
    from: (t: string) => h.makeBuilder(t, 'session'),
  }),
}))
// THE UN-GREY, SIMULATED: this file only. See the last describe for the real gate.
vi.mock('@/lib/network/access', () => ({
  NEW_NETWORK_ROLES: h.state.gateRoles,
  maySeeNewNetwork: (role: unknown) => typeof role === 'string' && h.state.gateRoles.includes(role),
}))

import * as partnerTags from '@/app/api/partner-tags/route'
import * as touchpoints from '@/app/api/touchpoints/route'
import * as reminders from '@/app/api/reminders/route'
import * as reminderOne from '@/app/api/reminders/[id]/route'
import * as lookups from '@/app/api/lookups/route'
import * as lookupOne from '@/app/api/lookups/[id]/route'
import * as reorder from '@/app/api/lookups/reorder/route'

const HOME = 'a0000000-0000-4000-8000-000000000001'
const AWAY = 'b0000000-0000-4000-8000-000000000002'
const PAUSED = 'c0000000-0000-4000-8000-000000000003'
const C = { HOME: 'a1000000-0000-4000-8000-0000000000c1', AWAY: 'b1000000-0000-4000-8000-0000000000c2', PAUSED: 'c1000000-0000-4000-8000-0000000000c3' }
const L = { HOME: 'a2000000-0000-4000-8000-0000000000e1', AWAY: 'b2000000-0000-4000-8000-0000000000e2', PAUSED: 'c2000000-0000-4000-8000-0000000000e3' }
const TAG = { HOME: 'a3000000-0000-4000-8000-0000000000f1', AWAY: 'b3000000-0000-4000-8000-0000000000f2', PAUSED: 'c3000000-0000-4000-8000-0000000000f3' }
const LOCS = { HOME, AWAY, PAUSED } as const
type Where = keyof typeof LOCS

const OLD = '2025-01-01T00:00:00Z'
function seed() {
  const locations = (['HOME', 'AWAY', 'PAUSED'] as Where[]).map((w) => ({
    id: LOCS[w], name: `${w} Bees`, slug: `loc_${w.toLowerCase()}`, location_id: `loc_${w.toLowerCase()}`,
    lifecycle_status: w === 'PAUSED' ? 'paused' : 'active', subscription_status: 'active',
  }))
  const partners = (['HOME', 'AWAY', 'PAUSED'] as Where[]).map((w) => ({
    id: C[w], location_id: LOCS[w], deleted_at: null, name: `${w} Contact`, first_name: w, last_name: 'Contact', title: 'Realtor', company: null, company_id: null,
    phone: null, email: `${w.toLowerCase()}@example.com`, website: null, addresses: [], how_we_met: null, specialties: [], relationship: null, notes: [], next_steps: [], activity: [],
    is_customer: false, customer_lead_id: null, network_types: ['partner'], partner_level: 'referral', partner_stage: 'Reaching Out', birthday: null, birthday_reminder: false,
    last_contacted_at: null, created_at: OLD, updated_at: OLD, partner_tags: [],
  }))
  const leads = (['HOME', 'AWAY', 'PAUSED'] as Where[]).map((w) => ({
    id: L[w], location_id: `loc_${w.toLowerCase()}`, location_uuid: LOCS[w], name: `${w} Person`, first_name: w, last_name: 'Person', email: `${w.toLowerCase()}p@example.com`, phone: '(303) 555-0100',
    city: null, zip: null, created_at: OLD, archived_at: null, is_junk: false, marketing_opt_out: false, marketing_unsubscribed_at: null, paid_amount: 0, invoice_paid_at: null,
    company: null, address: null, street2: null, state: null, source: null, project_type: null, request_details: null, notes: null, preferred_contact: null, referred_by_kind: null,
  }))
  const quotes = (['HOME', 'AWAY', 'PAUSED'] as Where[]).map((w) => ({ id: `q-${w}`, lead_id: L[w], location_id: `loc_${w.toLowerCase()}`, status: 'sent', sent_at: OLD, created_at: OLD }))
  const lookups = (['HOME', 'AWAY', 'PAUSED'] as Where[]).map((w) => ({ id: TAG[w], label: `${w} tag`, location_id: LOCS[w], is_active: true, category: 'tags', list: 'tags', type: 'tag', attrs: { shows_on: ['clients', 'network'] }, icon: null }))
  return { locations, partners, leads, quotes, lookups, assessments: [], jobs: [], engagements: [], service_requests: [], lead_tags: [], partner_tags: [], touchpoints: [], reminders: [], hub_users: [], companies: [], import_mappings: [] }
}

const ME = 'user-me'
const ROLES = {
  super_admin: null,
  admin: null,
  owner: HOME,
  manager: HOME,
  lite_user: HOME,
} as const
type Role = keyof typeof ROLES
const as = (role: string, locationId: string | null) => {
  h.state.sessionUser = { id: ME }
  h.state.hubUser = { id: ME, role, location_id: locationId }
}

const req = (url: string, body?: any) => {
  const u = new URL(url, 'http://x')
  return { nextUrl: u, url: u.toString(), json: async () => body, text: async () => JSON.stringify(body) } as any
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const writes = () => h.state.calls.filter((c: any) => c.client === 'service' && c.op !== 'select')
const CARD = { HOME: 'a4000000-0000-4000-8000-0000000000d1', AWAY: 'b4000000-0000-4000-8000-0000000000d2', PAUSED: 'c4000000-0000-4000-8000-0000000000d3' }
const REM = { mine: 'a5000000-0000-4000-8000-000000000001', theirs: 'b5000000-0000-4000-8000-000000000002' }
const MISSING = 'deadbeef-0000-4000-8000-000000000000'
const WHERE: Where[] = ['HOME', 'AWAY', 'PAUSED']

function seedMore(t: any) {
  t.engagements = WHERE.map((w) => ({ id: CARD[w], location_uuid: LOCS[w], client_id: L[w], stage: 'Estimate' }))
  t.partner_tags = WHERE.map((w) => ({ partner_id: C[w], tag_lookup_id: TAG[w], added_at: OLD }))
  t.reminders = [
    { id: REM.mine, user_id: ME, lead_id: L.HOME, location_uuid: HOME, due_on: '2026-12-01', note: 'mine', done_at: null },
    { id: REM.theirs, user_id: 'someone-else', lead_id: L.AWAY, location_uuid: AWAY, due_on: '2026-12-01', note: 'theirs', done_at: null },
  ]
}

type Kind = 'read' | 'write' | 'remind'
type Call = { screen: string; name: string; kind: Kind; byId: boolean; run: (w: Where) => Promise<Response> }
const CALLS: Call[] = [
  { screen: 'tags on a contact', name: 'GET a contact’s tags', kind: 'read', byId: true, run: (w) => partnerTags.GET(req(`/api/partner-tags?partner_id=${C[w]}`)) },
  { screen: 'tags on a contact', name: 'POST add a tag', kind: 'write', byId: true, run: (w) => partnerTags.POST(req('/x', { partner_id: C[w], tag_lookup_id: TAG[w] })) },
  { screen: 'tags on a contact', name: 'DELETE take a tag off', kind: 'write', byId: true, run: (w) => partnerTags.DELETE(req(`/api/partner-tags?partner_id=${C[w]}&tag_lookup_id=${TAG[w]}`)) },
  { screen: 'touchpoints', name: 'POST on a contact', kind: 'write', byId: true, run: (w) => touchpoints.POST(req('/x', { partner_id: C[w], kind: 'reach_out', method: 'coffee', label: 'Coffee' })) },
  { screen: 'touchpoints', name: 'POST on a client', kind: 'write', byId: true, run: (w) => touchpoints.POST(req('/x', { lead_id: L[w], kind: 'reach_out', method: 'call', label: 'Called' })) },
  { screen: 'reminders', name: 'POST on a contact', kind: 'remind', byId: true, run: (w) => reminders.POST(req('/x', { partner_id: C[w], due_on: '2026-12-01', note: 'x' })) },
  { screen: 'reminders', name: 'POST on a client', kind: 'remind', byId: true, run: (w) => reminders.POST(req('/x', { lead_id: L[w], due_on: '2026-12-01', note: 'x' })) },
  { screen: 'tag-making', name: 'POST make a location tag', kind: 'write', byId: false, run: (w) => lookups.POST(req('/x', { category: 'tags', label: 'Zebra Quilting', location_id: LOCS[w], made_on: 'network', group: 'relationship', icon: null })) },
  { screen: 'tag-making', name: 'PATCH rename a location tag', kind: 'write', byId: true, run: (w) => lookupOne.PATCH(req('/x', { label: 'Renamed' }), { params: { id: TAG[w] } }) },
  { screen: 'tag-making', name: 'DELETE switch off a location tag', kind: 'write', byId: true, run: (w) => lookupOne.DELETE(req('/x'), { params: { id: TAG[w] } }) },
]

const ROLE_HOME: Record<Role, string | null> = { super_admin: null, admin: null, owner: HOME, manager: HOME, lite_user: HOME }
const LOCATION_TAG_WRITERS = new Set(['owner', 'manager'])
// What the screen SHOULD allow: elevated anywhere; otherwise own location only,
// lite users change nothing but reminders, a paused location's owner the same.
function shouldAllow(role: Role, call: Call, w: Where, paused = false) {
  if (role === 'super_admin' || role === 'admin') return true
  if (w === 'AWAY') return false
  if (call.kind === 'read' || call.kind === 'remind') return true
  if (role === 'lite_user' || paused) return false
  if (call.screen === 'tag-making') return LOCATION_TAG_WRITERS.has(role)
  return true
}

const MATRIX: any[] = []
afterAll(() => {
  const out = process.env.OUTSIDE_SCREENS_REPORT
  if (out) writeFileSync(out, JSON.stringify(MATRIX, null, 2))
})

beforeEach(() => {
  h.state.tables = seed()
  seedMore(h.state.tables)
  h.state.calls = []
})

describe('the four outside screens × every role × own location, someone else’s, and paused', () => {
  const cases: [Role, string | null, Where, boolean][] = []
  for (const role of Object.keys(ROLE_HOME) as Role[]) for (const w of ['HOME', 'AWAY'] as Where[]) cases.push([role, ROLE_HOME[role], w, false])
  for (const role of ['owner', 'manager', 'lite_user'] as Role[]) cases.push([role, PAUSED, 'PAUSED', true])
  for (const [role, home, w, paused] of cases) {
    for (const call of CALLS) {
      const ok = shouldAllow(role, call, w, paused)
      it(`${call.screen} · ${call.name} · ${role}${paused ? ' (paused location)' : ''} · ${w} → ${ok ? 'allowed' : 'refused'}`, async () => {
        as(role, home)
        const res = await call.run(w)
        const body = await res.json().catch(() => ({}))
        const wrote = writes().map((c: any) => `${c.op} ${c.table}`)
        MATRIX.push({ screen: call.screen, call: call.name, role, paused, at: w, status: res.status, error: body?.error ?? null, wrote })
        if (ok) {
          expect([200, 201], `${res.status} ${JSON.stringify(body)}`).toContain(res.status)
          return
        }
        expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400)
        expect(wrote, 'a refused call wrote').toEqual([])
      })
    }
  }
})

describe('reminders: each person only ever sees and changes their own', () => {
  for (const role of Object.keys(ROLE_HOME) as Role[]) {
    it(`${role} · GET lists only their own; PATCH/DELETE of someone else’s → 404 like a missing one`, async () => {
      as(role, ROLE_HOME[role])
      const list = await (await reminders.GET(req('/api/reminders'))).json()
      expect(list.reminders.map((r: any) => r.id)).toEqual([REM.mine])
      const theirs = await reminderOne.PATCH(req('/x', { done: true }), { params: Promise.resolve({ id: REM.theirs }) })
      const missing = await reminderOne.PATCH(req('/x', { done: true }), { params: Promise.resolve({ id: MISSING }) })
      expect([theirs.status, await theirs.json()]).toEqual([missing.status, await missing.json()])
      const del = await reminderOne.DELETE(req('/x'), { params: Promise.resolve({ id: REM.theirs }) })
      expect(del.status).toBe(404)
      expect(writes()).toEqual([])
    })
  }
})

describe('tag-making: the tag list never shows another location’s tags', () => {
  for (const role of ['owner', 'manager', 'lite_user'] as Role[]) {
    it(`${role} · GET /api/lookups naming AWAY → corporate + HOME’s own tags only`, async () => {
      as(role, HOME)
      const body = await (await lookups.GET(req(`/api/lookups?category=tags&location_id=${AWAY}`))).json()
      expect(body.lookups.map((t: any) => t.id).sort()).toEqual([TAG.HOME])
    })
  }
  it('corporate · GET /api/lookups naming AWAY → AWAY’s tags (corporate may look at any location)', async () => {
    as('admin', null)
    const body = await (await lookups.GET(req(`/api/lookups?category=tags&location_id=${AWAY}`))).json()
    expect(body.lookups.map((t: any) => t.id)).toEqual([TAG.AWAY])
  })
  for (const role of ['owner', 'manager', 'lite_user'] as Role[]) {
    it(`${role} · reordering the tag list → refused (corporate only)`, async () => {
      as(role, HOME)
      expect((await reorder.POST(req('/x', { items: [{ id: TAG.HOME, sort_order: 1 }] }))).status).toBe(403)
      expect(writes()).toEqual([])
    })
  }
  it('an owner cannot put AWAY’s tag on their own contact (it answers like a tag that does not exist)', async () => {
    as('owner', HOME)
    const away = await partnerTags.POST(req('/x', { partner_id: C.HOME, tag_lookup_id: TAG.AWAY }))
    const missing = await partnerTags.POST(req('/x', { partner_id: C.HOME, tag_lookup_id: MISSING }))
    expect([away.status, missing.status]).toEqual([404, 404])
    expect(await away.json()).toEqual(await missing.json())
    expect(writes()).toEqual([])
  })
})

// FOUND 1 and FOUND 2 (2026-11-20) were fixed on 2026-11-21. The full pins
// live in lib/not-found-family.test.ts; these keep the original shapes.
describe('FOUND 1 and 2, fixed 2026-11-21', () => {
  it('FOUND 1: a touchpoint naming ANOTHER location’s card is refused as not found, and nothing is written', async () => {
    as('owner', HOME)
    const res = await touchpoints.POST(req('/x', { partner_id: C.HOME, engagement_id: CARD.AWAY, kind: 'reach_out', method: 'call', label: 'Called' }))
    expect(res.status).toBe(404)
    expect(writes()).toEqual([])
  })
  for (const [name, away, missing] of [
    ['tags on a contact', () => partnerTags.GET(req(`/x?partner_id=${C.AWAY}`)), () => partnerTags.GET(req(`/x?partner_id=${MISSING}`))],
    ['touchpoints', () => touchpoints.POST(req('/x', { partner_id: C.AWAY, kind: 'reach_out', label: 'x' })), () => touchpoints.POST(req('/x', { partner_id: MISSING, kind: 'reach_out', label: 'x' }))],
    ['reminders', () => reminders.POST(req('/x', { partner_id: C.AWAY, due_on: '2026-12-01', note: 'x' })), () => reminders.POST(req('/x', { partner_id: MISSING, due_on: '2026-12-01', note: 'x' }))],
  ] as [string, () => Promise<Response>, () => Promise<Response>][]) {
    it(`FOUND 2: ${name} answers another location’s id exactly like a missing one`, async () => {
      as('owner', HOME)
      const a = await away(), m = await missing()
      expect([a.status, m.status]).toEqual([404, 404])
      expect(await a.json()).toEqual(await m.json())
      expect(writes()).toEqual([])
    })
  }
})

describe('tested, not rewritten: the outside screens are byte for byte unchanged', () => {
  // sha256 (first 16) at 2a599f9.
  const PINNED: Record<string, string> = {
    'app/api/partner-tags/route.ts': 'c5c2a0d881a2fa57',
    'app/api/touchpoints/route.ts': '33d10fb808c54228',
    'app/api/lookups/route.ts': 'fd4e56c6ec43d06e',
    'app/api/lookups/[id]/route.ts': '47cc5216d92c7eac',
    'app/api/lookups/reorder/route.ts': 'd43783aa33265f84',
    'lib/touchpoints.ts': '49b88f073e234c2e',
    'lib/tag-guard.ts': '45799f8364ec40a6',
    'lib/auth.ts': '58e71d92c9808be3',
  }
  for (const [f, sha] of Object.entries(PINNED)) {
    it(`${f} is byte for byte unchanged`, () => {
      expect(createHash('sha256').update(withoutNotFoundFix(f, readFileSync(join(process.cwd(), f), 'utf8'))).digest('hex').slice(0, 16)).toBe(sha)
    })
  }
})
