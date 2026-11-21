// Kevin's two rulings of 2026-11-20, pinned by driving the real routes.
//
//   1. Corporate (the admin role: one account, tied to no location) can
//      CHANGE Network records at any location, not only read them. The All
//      locations overview stays a report: nobody can change anything through it.
//   2. A read-only user (lite_user) may set a follow-up, because a follow-up
//      is a reminder to yourself, not a change to the person. Network matches
//      the shared Reminders page (/api/reminders), which already allowed it;
//      the two must agree, role by role and location by location.
//      Read-only still means read-only for everything else.
//
// The gate is opened IN THIS FILE ONLY, as in owner-safe-routes.test.ts.
// lib/network/owner-safe-gate.test.ts keeps the real gate and pins that it
// has not widened.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
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
      if (ctx.op === 'update') { for (const r of rows) Object.assign(r, ctx.payload); return Promise.resolve({ data: null, error: null }) }
      if (ctx.op === 'delete') { state.tables[table] = (state.tables[table] || []).filter((r: any) => !rows.includes(r)); return Promise.resolve({ data: null, error: null }) }
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows.map((r: any) => ({ ...r })), error: null })
    }
    const b: any = new Proxy({}, {
      get(_t, k: string) {
        if (k === 'then') return (res: any, rej: any) => resolve(false).then(res, rej)
        if (k === 'single' || k === 'maybeSingle') return () => resolve(true)
        if (['insert', 'update', 'upsert', 'delete'].includes(k)) return (p?: any) => { ctx.op = k; ctx.payload = p ?? null; return b }
        if (k === 'eq' || k === 'neq' || k === 'in' || k === 'is') return (c: string, v: any) => { ctx.filters.push([k, c, v]); return b }
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

import * as followUp from '@/app/api/network/nurturing/[id]/follow-up/route'
import * as nurtureBulk from '@/app/api/network/nurturing/bulk/route'
import * as overview from '@/app/api/network/overview/route'
import * as add from '@/app/api/network/contacts/route'
import * as contact from '@/app/api/network/contacts/[id]/route'
import * as contactBulk from '@/app/api/network/contacts/bulk/route'
import * as importRoute from '@/app/api/network/import/route'
import * as reminders from '@/app/api/reminders/route'

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
const WHERE: Where[] = ['HOME', 'AWAY', 'PAUSED']

beforeEach(() => {
  h.state.tables = seed()
  h.state.calls = []
})

// ── Ruling 1: corporate can change Network records, at any location ──────────
// Every Network write there is, as corporate, at every location (paused too).
const CORPORATE_WRITES: { name: string; run: (w: Where) => Promise<Response>; landed: (w: Where) => void }[] = [
  {
    name: 'add a contact', run: (w) => add.POST(req('/x', { location_id: LOCS[w], name: 'Brand New', types: ['partner'] })),
    landed: (w) => expect(h.state.tables.partners.filter((p: any) => p.name === 'Brand New').map((p: any) => p.location_id)).toEqual([LOCS[w]]),
  },
  {
    name: 'edit a contact', run: (w) => contact.PATCH(req('/x', { changes: { title: { from: 'Realtor', to: 'Broker' } } }), params(C[w])),
    landed: (w) => expect(h.state.tables.partners.filter((p: any) => p.title === 'Broker').map((p: any) => p.id)).toEqual([C[w]]),
  },
  {
    name: 'change contacts in bulk (level)', run: (w) => contactBulk.POST(req('/x', { location_id: LOCS[w], ids: [C[w]], action: 'level', value: 'power', confirmed: true })),
    landed: (w) => expect(h.state.tables.partners.filter((p: any) => p.partner_level === 'power').map((p: any) => p.id)).toEqual([C[w]]),
  },
  {
    name: 'import contacts', run: (w) => importRoute.POST(req('/x', { location_id: LOCS[w], csv: 'Name,Email\nNew Person,new@example.com\n', mode: 'import' })),
    landed: (w) => expect(h.state.tables.partners.filter((p: any) => p.email === 'new@example.com').map((p: any) => p.location_id)).toEqual([LOCS[w]]),
  },
  {
    name: 'tag Nurturing people in bulk', run: async (w) => nurtureBulk.POST(req('/x', { location_id: LOCS[w], action: 'tag_add', tag_id: TAG[w], selection: { ids: [L[w]] }, confirmed: true, expected: 1 })),
    landed: (w) => expect(h.state.tables.lead_tags.map((t: any) => [t.lead_id, t.tag_lookup_id])).toEqual([[L[w], TAG[w]]]),
  },
  {
    name: 'set a follow-up', run: (w) => followUp.POST(req('/x', { due_on: '2026-12-01', note: 'Call about the garage' }), params(L[w])),
    landed: (w) => expect(h.state.tables.reminders.map((r: any) => [r.lead_id, r.location_uuid])).toEqual([[L[w], LOCS[w]]]),
  },
]

describe('ruling 1: corporate can change Network records at any location', () => {
  for (const wr of CORPORATE_WRITES) {
    for (const w of WHERE) {
      it(`corporate · ${wr.name} · ${w} → done, and it landed at ${w} only`, async () => {
        as('admin', null)
        const res = await wr.run(w)
        const body = await res.json().catch(() => ({}))
        expect([200, 201], `${res.status} ${JSON.stringify(body)}`).toContain(res.status)
        wr.landed(w)
      })
    }
  }
  it('corporate must still name a location: a write with none is refused and writes nothing', async () => {
    as('admin', null)
    expect((await add.POST(req('/x', { name: 'Nowhere', types: ['partner'] }))).status).toBeGreaterThanOrEqual(400)
    expect((await contactBulk.POST(req('/x', { ids: [C.HOME], action: 'level', value: 'power', confirmed: true }))).status).toBeGreaterThanOrEqual(400)
    expect((await nurtureBulk.POST(req('/x', { action: 'tag_add', tag_id: TAG.HOME, selection: { ids: [L.HOME] }, confirmed: true, expected: 1 }))).status).toBeGreaterThanOrEqual(400)
    expect(writes()).toEqual([])
  })
  it('corporate still cannot smuggle one location’s contact into another’s bulk change', async () => {
    as('admin', null)
    const res = await contactBulk.POST(req('/x', { location_id: HOME, ids: [C.HOME, C.AWAY], action: 'level', value: 'power', confirmed: true }))
    expect(res.status).toBe(422)
    expect(writes()).toEqual([])
  })
  it('people who said no to marketing stay out of every action, for corporate too', async () => {
    as('admin', null)
    h.state.tables.leads.find((l: any) => l.id === L.AWAY).marketing_opt_out = true
    expect((await followUp.POST(req('/x', { due_on: '2026-12-01', note: 'x' }), params(L.AWAY))).status).toBe(403)
    expect(writes()).toEqual([])
  })
})

describe('the All locations overview stays read-only for everyone', () => {
  it('the overview route has a GET and nothing else', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/network/overview/route.ts'), 'utf8')
    expect(src.match(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)).toEqual(['export async function GET'])
  })
  for (const role of Object.keys(ROLES) as Role[]) {
    it(`${role} · opening the overview writes nothing`, async () => {
      as(role, ROLES[role])
      await overview.GET()
      expect(writes()).toEqual([])
    })
  }
})

// ── Ruling 2: a read-only user may set a follow-up, and nothing else ─────────
describe('ruling 2: a read-only user can set a follow-up and nothing else', () => {
  it('lite user · follow-up on their own location’s person → set (one reminders row, theirs)', async () => {
    as('lite_user', HOME)
    const res = await followUp.POST(req('/x', { due_on: '2026-12-01', note: 'Call about the garage' }), params(L.HOME))
    expect(res.status).toBe(201)
    expect(writes().map((c: any) => c.table)).toEqual(['reminders'])
    expect(h.state.tables.reminders.map((r: any) => [r.user_id, r.lead_id])).toEqual([[ME, L.HOME]])
  })
  it('lite user · follow-up on another location’s person → not found, nothing written', async () => {
    as('lite_user', HOME)
    expect((await followUp.POST(req('/x', { due_on: '2026-12-01', note: 'x' }), params(L.AWAY))).status).toBe(404)
    expect(writes()).toEqual([])
  })
  const OTHER_WRITES: [string, () => Promise<Response>][] = [
    ['add a contact', () => add.POST(req('/x', { location_id: HOME, name: 'Brand New', types: ['partner'] }))],
    ['edit a contact', () => contact.PATCH(req('/x', { changes: { title: { from: 'Realtor', to: 'Broker' } } }), params(C.HOME))],
    ['bulk level', () => contactBulk.POST(req('/x', { location_id: HOME, ids: [C.HOME], action: 'level', value: 'power', confirmed: true }))],
    ['bulk tag', () => contactBulk.POST(req('/x', { location_id: HOME, ids: [C.HOME], action: 'tag_add', value: TAG.HOME, confirmed: true }))],
    ['import (check)', () => importRoute.POST(req('/x', { location_id: HOME, csv: 'Name,Email\nNew Person,new@example.com\n', mode: 'check' }))],
    ['import', () => importRoute.POST(req('/x', { location_id: HOME, csv: 'Name,Email\nNew Person,new@example.com\n', mode: 'import' }))],
    ['Nurturing bulk tag', () => nurtureBulk.POST(req('/x', { location_id: HOME, action: 'tag_add', tag_id: TAG.HOME, selection: { ids: [L.HOME] }, confirmed: true, expected: 1 }))],
  ]
  for (const [name, run] of OTHER_WRITES) {
    it(`lite user · ${name} → refused, nothing written`, async () => {
      as('lite_user', HOME)
      expect((await run()).status).toBe(403)
      expect(writes()).toEqual([])
    })
  }
})

describe('Network and the Reminders page agree, role by role and location by location', () => {
  // Same person, same note, through both doors. Allowed on one ⇔ allowed on the other.
  const CASES: [string, string | null][] = [
    ['super_admin', null], ['admin', null],
    ['owner', HOME], ['manager', HOME], ['lite_user', HOME],
    ['owner', PAUSED], ['manager', PAUSED], ['lite_user', PAUSED],
  ]
  for (const [role, home] of CASES) {
    for (const w of WHERE) {
      it(`${role} at ${home === null ? 'no location' : home === HOME ? 'HOME' : 'PAUSED'} · follow-up on ${w}'s person`, async () => {
        as(role, home)
        const viaNetwork = (await followUp.POST(req('/x', { due_on: '2026-12-01', note: 'x' }), params(L[w]))).status
        h.state.tables.reminders = []
        const viaReminders = (await reminders.POST(req('/x', { lead_id: L[w], due_on: '2026-12-01', note: 'x' }))).status
        expect(viaNetwork === 201, `Network ${viaNetwork}, Reminders ${viaReminders}`).toBe(viaReminders === 201)
      })
    }
  }
})

describe('nothing outside Network changes', () => {
  // sha256 (first 16) at 2a599f9, before these rulings.
  const PINNED: Record<string, string> = {
    'app/api/reminders/route.ts': 'ac50556b4dbb5fe9',
    'app/api/reminders/[id]/route.ts': '92ef8d8175d0c9cb',
    'lib/reminders.ts': '764c53026dba4381',
    'lib/reminders-server.ts': '5d2df2fa1586c6fe',
  }
  for (const [f, sha] of Object.entries(PINNED)) {
    it(`${f} is byte for byte unchanged`, () => {
      expect(createHash('sha256').update(withoutNotFoundFix(f, readFileSync(join(process.cwd(), f), 'utf8'))).digest('hex').slice(0, 16)).toBe(sha)
    })
  }
})
