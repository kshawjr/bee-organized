// Owner-safe Network routes: every handler, every role, own location and someone else's.
//
// THE GATE IS OPENED IN THIS FILE ONLY. lib/network/access.ts still says
// super admins only, and the last block here pins that. To test what owners
// will meet the day Kevin widens it, this file swaps the gate for a widened
// one, then drives the REAL route handlers with the REAL loadCaller, against
// a stand-in database that records every read and write.
//
// Two locations: HOME (where the owner, manager and lite user work) and AWAY
// (somebody else's). PAUSED is a third location whose owner is tested for the
// read-only rule. Every id handed to a route below exists; the question is
// only whose it is.
//
// Pinned:
//   · an owner (and a manager, and a lite user) cannot read or write AWAY's
//     contact or person by ANY route, by naming its id or by naming its location;
//     a guessed id answers exactly as an id that does not exist
//   · a lite user cannot write anywhere, not even at HOME
//   · nobody below corporate can open an All locations view or the overview
//   · a paused location is read-only for its owner
//   · corporate reads every location and, until Kevin rules, writes nowhere
//   · a refused call writes nothing and reads nothing of AWAY's beyond the
//     one row it had to look at to know whose it was
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import * as list from '@/app/api/network/list/route'
import * as summary from '@/app/api/network/summary/route'
import * as nurturing from '@/app/api/network/nurturing/route'
import * as person from '@/app/api/network/nurturing/[id]/route'
import * as followUp from '@/app/api/network/nurturing/[id]/follow-up/route'
import * as nurtureBulk from '@/app/api/network/nurturing/bulk/route'
import * as overview from '@/app/api/network/overview/route'
import * as add from '@/app/api/network/contacts/route'
import * as contact from '@/app/api/network/contacts/[id]/route'
import * as contactBulk from '@/app/api/network/contacts/bulk/route'
import * as importRoute from '@/app/api/network/import/route'

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

// Every handler, aimed at one location's records. `kind` says what it is.
type Call = { name: string; kind: 'read' | 'write'; run: (w: Where) => Promise<Response> }
const CALLS: Call[] = [
  { name: 'GET list (one location)', kind: 'read', run: (w) => list.GET(req(`/api/network/list?location_id=${LOCS[w]}`)) },
  { name: 'GET summary (one location)', kind: 'read', run: (w) => summary.GET(req(`/api/network/summary?location_id=${LOCS[w]}`)) },
  { name: 'GET nurturing (one location)', kind: 'read', run: (w) => nurturing.GET(req(`/api/network/nurturing?location_id=${LOCS[w]}`)) },
  { name: 'GET nurturing/[id]', kind: 'read', run: (w) => person.GET(req(`/api/network/nurturing/${L[w]}`), params(L[w])) },
  { name: 'GET contacts/[id]', kind: 'read', run: (w) => contact.GET(req(`/api/network/contacts/${C[w]}`), params(C[w])) },
  { name: 'GET import mappings', kind: 'read', run: (w) => importRoute.GET(req(`/api/network/import?location_id=${LOCS[w]}`)) },
  { name: 'POST nurturing/[id]/follow-up', kind: 'write', run: (w) => followUp.POST(req('/x', { due_on: '2026-12-01', note: 'Call about the garage' }), params(L[w])) },
  { name: 'POST nurturing/bulk', kind: 'write', run: (w) => nurtureBulk.POST(req('/x', { location_id: LOCS[w], action: 'tag_add', tag_id: TAG[w], selection: { ids: [L[w]] }, dry_run: true })) },
  { name: 'POST contacts (add one)', kind: 'write', run: (w) => add.POST(req('/x', { location_id: LOCS[w], name: 'Brand New', types: ['partner'] })) },
  { name: 'PATCH contacts/[id]', kind: 'write', run: (w) => contact.PATCH(req('/x', { changes: { title: { from: 'Realtor', to: 'Broker' } } }), params(C[w])) },
  { name: 'POST contacts/bulk', kind: 'write', run: (w) => contactBulk.POST(req('/x', { location_id: LOCS[w], ids: [C[w]], action: 'level', value: 'power', confirmed: true })) },
  { name: 'POST import', kind: 'write', run: (w) => importRoute.POST(req('/x', { location_id: LOCS[w], csv: 'Name,Email\nNew Person,new@example.com\n', mode: 'check' })) },
]
const ALL_VIEWS: { name: string; run: () => Promise<Response> }[] = [
  { name: 'GET list (All locations)', run: () => list.GET(req('/api/network/list')) },
  { name: 'GET summary (All locations)', run: () => summary.GET(req('/api/network/summary')) },
  { name: 'GET overview', run: () => overview.GET() },
]

const writes = () => h.state.calls.filter((c: any) => c.client === 'service' && c.op !== 'select')
// Every value any read filtered on, so "nothing of AWAY's was read" can be checked.
const touchedAway = () => h.state.calls.filter((c: any) => c.client === 'service' && c.op === 'select'
  && c.filters.some(([, , v]: any) => [AWAY, 'loc_away'].includes(v) || (Array.isArray(v) && (v.includes(AWAY) || v.includes(C.AWAY) || v.includes(L.AWAY)))))

// What each role may do at each location.
const allowed = (role: Role, kind: 'read' | 'write', w: Where) => {
  if (role === 'super_admin') return true
  if (role === 'admin') return kind === 'read'
  if (w !== 'HOME') return false
  return kind === 'read' || role !== 'lite_user'
}
const refusedStatus = (role: Role, kind: 'read' | 'write', w: Where) => {
  // Someone else's record or location: not found (by id) / refused (by location).
  if (w === 'AWAY' && !['super_admin', 'admin'].includes(role)) return 'away'
  return 'read_only'
}

beforeEach(() => {
  h.state.tables = seed()
  h.state.calls = []
})

describe('every handler × every role × own location and someone else’s', () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    for (const call of CALLS) {
      for (const w of ['HOME', 'AWAY'] as Where[]) {
        const ok = allowed(role, call.kind, w)
        it(`${role} · ${call.name} · ${w} → ${ok ? 'allowed' : 'refused'}`, async () => {
          as(role, ROLES[role])
          const res = await call.run(w)
          const body = await res.json().catch(() => ({}))
          if (ok) {
            // Allowed means it actually worked, not merely "was not refused".
            expect([200, 201], `${res.status} ${JSON.stringify(body)}`).toContain(res.status)
            return
          }
          expect(writes(), 'a refused call wrote').toEqual([])
          if (refusedStatus(role, call.kind, w) === 'away') {
            expect([403, 404]).toContain(res.status)
            // By id: exactly the answer an id that does not exist gets.
            if (call.name.includes('[id]')) expect(res.status).toBe(404)
            // Nothing of AWAY's was read beyond the one row that said whose it was.
            const away = touchedAway()
            expect(away.length, JSON.stringify(away.map((c: any) => c.table))).toBeLessThanOrEqual(1)
            for (const c of away) expect(c.filters.some(([k, col, v]: any) => k === 'eq' && col === 'id' && [C.AWAY, L.AWAY].includes(v))).toBe(true)
          } else {
            expect(res.status).toBe(403)
          }
        })
      }
    }
  }
})

describe('a guessed id answers exactly like a missing one', () => {
  const MISSING = { contact: 'deadbeef-0000-4000-8000-000000000000' }
  for (const role of ['owner', 'manager', 'lite_user'] as Role[]) {
    it(`${role}: AWAY's contact and a contact that does not exist get the same answer, read and write`, async () => {
      as(role, HOME)
      const a = await contact.GET(req('/x'), params(C.AWAY)); const m = await contact.GET(req('/x'), params(MISSING.contact))
      expect([a.status, await a.json()]).toEqual([m.status, await m.json()])
      const pa = await contact.PATCH(req('/x', { changes: { title: { from: 'Realtor', to: 'Broker' } } }), params(C.AWAY))
      const pm = await contact.PATCH(req('/x', { changes: { title: { from: 'Realtor', to: 'Broker' } } }), params(MISSING.contact))
      expect([pa.status, await pa.json()]).toEqual([pm.status, await pm.json()])
      const fa = await followUp.POST(req('/x', { due_on: '2026-12-01', note: 'x' }), params(L.AWAY))
      const fm = await followUp.POST(req('/x', { due_on: '2026-12-01', note: 'x' }), params(MISSING.contact))
      expect([fa.status, await fa.json()]).toEqual([fm.status, await fm.json()])
      const na = await person.GET(req('/x'), params(L.AWAY)); const nm = await person.GET(req('/x'), params(MISSING.contact))
      expect([na.status, await na.json()]).toEqual([nm.status, await nm.json()])
      expect(writes()).toEqual([])
    })
  }
})

describe('an owner naming THEIR OWN location cannot slip someone else’s id into a bulk action', () => {
  it('Network bulk: AWAY’s contact under HOME is refused whole, nothing written', async () => {
    as('owner', HOME)
    const res = await contactBulk.POST(req('/x', { location_id: HOME, ids: [C.HOME, C.AWAY], action: 'level', value: 'power', confirmed: true }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('not_all_at_this_location')
    expect(writes()).toEqual([])
    expect(h.state.tables.partners.find((p: any) => p.id === C.AWAY).partner_level).toBe('referral')
  })
  it('Nurturing bulk: AWAY’s person under HOME is not tagged; only HOME’s is', async () => {
    as('owner', HOME)
    const dry = await (await nurtureBulk.POST(req('/x', { location_id: HOME, action: 'tag_add', tag_id: TAG.HOME, selection: { ids: [L.HOME, L.AWAY] }, dry_run: true }))).json()
    expect(dry.change).toBe(1)
    expect(dry.notNurturing).toBe(1)
    const res = await nurtureBulk.POST(req('/x', { location_id: HOME, action: 'tag_add', tag_id: TAG.HOME, selection: { ids: [L.HOME, L.AWAY] }, confirmed: true, expected: 1 }))
    expect(res.status).toBe(200)
    expect(h.state.tables.lead_tags.map((t: any) => t.lead_id)).toEqual([L.HOME])
  })
  it('Nurturing bulk: AWAY’s tag under HOME is refused', async () => {
    as('owner', HOME)
    const res = await nurtureBulk.POST(req('/x', { location_id: HOME, action: 'tag_add', tag_id: TAG.AWAY, selection: { ids: [L.HOME] }, dry_run: true }))
    expect(res.status).toBe(400)
    expect(writes()).toEqual([])
  })
  it('an owner’s allowed write lands on their own record and nowhere else', async () => {
    as('owner', HOME)
    const res = await contact.PATCH(req('/x', { changes: { title: { from: 'Realtor', to: 'Broker' } } }), params(C.HOME))
    expect(res.status).toBe(200)
    const w = writes()
    expect(w.length).toBe(1)
    expect(w[0].table).toBe('partners')
    expect(w[0].filters).toEqual([['eq', 'id', C.HOME]])
    expect(h.state.tables.partners.find((p: any) => p.id === C.AWAY).title).toBe('Realtor')
  })
})

describe('All locations views', () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    for (const v of ALL_VIEWS) {
      const ok = role === 'super_admin' || role === 'admin'
      it(`${role} · ${v.name} → ${ok ? 'allowed' : 'refused'}`, async () => {
        as(role, ROLES[role])
        const res = await v.run()
        if (ok) expect(res.status).toBe(200)
        else {
          expect([400, 403]).toContain(res.status)
          // Refused before any partner, lead or location row was read.
          expect(h.state.calls.filter((c: any) => c.client === 'service' && ['partners', 'leads', 'locations', 'engagements'].includes(c.table))).toEqual([])
        }
      })
    }
  }
})

describe('a paused location is read-only for its owner', () => {
  it('reads still work', async () => {
    as('owner', PAUSED)
    expect((await contact.GET(req('/x'), params(C.PAUSED))).status).toBe(200)
    expect((await list.GET(req(`/x?location_id=${PAUSED}`))).status).toBe(200)
  })
  for (const call of CALLS.filter((c) => c.kind === 'write' && c.name !== 'POST import')) {
    it(`${call.name} → 403 read-only location, nothing written`, async () => {
      as('owner', PAUSED)
      const res = await call.run('PAUSED')
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('forbidden_read_only_location')
      expect(writes()).toEqual([])
    })
  }
  it('POST import: a check writes nothing; an import is refused', async () => {
    as('owner', PAUSED)
    const res = await importRoute.POST(req('/x', { location_id: PAUSED, csv: 'Name,Email\nNew Person,new@example.com\n', mode: 'import' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only_location')
    expect(writes()).toEqual([])
  })
})
