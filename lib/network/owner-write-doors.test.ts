// WHO CAN WRITE A NETWORK CONTACT, AND WHAT A NEW ONE IS. Pinned by WRITES,
// not by what screen shows.
//
// Why this file exists: lib/network/doors.test.tsx proved the nine ways onto
// the Network TAB are shut for owners, and that was read as "owners cannot
// touch Network". They could, and did: 26 contacts in three days came in
// through doors in Clients and the server routes behind them, none of
// which asks the Network gate (2026-11-19 investigation). So this file
// drives every route that creates or edits a Network contact, as each of
// the five roles, against a stand-in database, and asserts who gets
// through. It describes what is TRUE, including that the Clients doors
// stay open to owners and managers on purpose (Kevin, 2026-11-19).
//
//   1  WHO GETS THROUGH, route by route, for super admin, corporate (admin),
//      owner at the contact's location, owner elsewhere, manager, read-only
//   2  EVERY CONTACT MADE HAS A TYPE, on every create path, for every role
//      that gets through. A Referred-by contact is a Referral partner with a
//      level and stage; one made from a client record is Not sure yet.
//   3  THERE IS NO OTHER WAY TO INSERT A CONTACT: a scan of the source finds
//      exactly the three places that insert into partners, and each is
//      driven above. A new one fails here until it is added.
//   4  The Network TAB itself stays super admins only (the gate is unchanged).
//
// What this cannot pin: the table has no NOT NULL on network_types (that is
// a migration, not made in this pass), so a hand-written SQL insert could
// still leave it empty. Every insert in the app's code is covered.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

vi.hoisted(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'k'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k' })
const h = vi.hoisted(() => {
  const state: any = { role: 'owner', loc: null as string | null, tables: {} as Record<string, any[]>, serviceCalls: [] as string[] }
  let n = 0
  const svc = (table: string) => {
    const ctx: any = { op: 'select', filters: [] as any[], payload: null, returning: false, range: null as any }
    const b: any = {}
    b.select = (c?: string) => { if (ctx.op !== 'select') ctx.returning = true; else ctx.cols = c; return b }
    b.insert = (rows: any) => { ctx.op = 'insert'; ctx.payload = Array.isArray(rows) ? rows : [rows]; return b }
    b.upsert = (rows: any) => { ctx.op = 'insert'; ctx.payload = Array.isArray(rows) ? rows : [rows]; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.update = (v: any) => { ctx.op = 'update'; ctx.payload = v; return b }
    b.eq = (c: string, v: any) => { ctx.filters.push(['eq', c, v]); return b }
    b.is = (c: string, v: any) => { ctx.filters.push(['is', c, v]); return b }
    b.in = (c: string, v: any[]) => { ctx.filters.push(['in', c, v]); return b }
    b.or = (expr: string) => { ctx.filters.push(['or', expr]); return b }
    for (const k of ['order', 'limit', 'ilike', 'not', 'neq', 'gte', 'lte', 'lt', 'gt']) b[k] = () => b
    b.range = (a: number, z: number) => { ctx.range = [a, z]; return b }
    const match = (r: any) => ctx.filters.every((f: any) => {
      if (f[0] === 'eq') return r[f[1]] === f[2]
      if (f[0] === 'is') return r[f[1]] == null
      if (f[0] === 'in') return f[2].includes(r[f[1]])
      if (f[0] === 'or') { const loc = String(f[1]).split('location_id.eq.')[1]; return loc ? (r.location_id == null || r.location_id === loc) : true }
      return true
    })
    const run = async (single: boolean) => {
      state.serviceCalls.push(`${ctx.op} ${table}`)
      const rows = (state.tables[table] ||= [])
      if (ctx.op === 'insert') {
        const made = ctx.payload.map((r: any) => ({ deleted_at: null, ...r, id: r.id ?? `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }))
        rows.push(...made)
        return { data: ctx.returning ? (single ? made[0] : made) : null, error: null }
      }
      if (ctx.op === 'delete') { state.tables[table] = rows.filter((r: any) => !match(r)); return { data: null, error: null } }
      if (ctx.op === 'update') {
        const hit = rows.filter(match)
        for (const r of hit) Object.assign(r, ctx.payload)
        return { data: ctx.returning ? (single ? hit[0] ?? null : hit) : null, error: null }
      }
      let out = rows.filter(match)
      if (ctx.range) out = out.slice(ctx.range[0], ctx.range[1] + 1)
      return { data: single ? out[0] ?? null : out, error: null }
    }
    b.single = () => run(true)
    b.maybeSingle = () => run(true)
    b.then = (res: any, rej: any) => run(false).then(res, rej)
    return b
  }
  return { state, svc }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.svc(t), rpc: async () => ({ data: null, error: null }) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => {
    const me = () => ({ data: { id: 'user-1', role: h.state.role, location_id: h.state.loc }, error: null })
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
      from: (t: string) => t === 'hub_users'
        ? { select: () => ({ eq: () => ({ single: async () => me(), maybeSingle: async () => me() }) }) }
        : h.svc(t),
    }
  },
}))

import { POST as CREATE } from '@/app/api/partners/route'
import { PATCH as EDIT, DELETE as REMOVE } from '@/app/api/partners/[id]/route'
import { POST as TO_NETWORK } from '@/app/api/leads/[id]/network/route'
import { POST as TAG } from '@/app/api/partner-tags/route'
import { POST as TOUCH } from '@/app/api/touchpoints/route'
import { POST as NET_ADD } from '@/app/api/network/contacts/route'
import { POST as NET_IMPORT } from '@/app/api/network/import/route'
import { PATCH as NET_EDIT } from '@/app/api/network/contacts/[id]/route'
import { POST as NET_BULK } from '@/app/api/network/contacts/bulk/route'
import { maySeeNewNetwork } from '@/lib/network/access'
import { NET_TYPES } from '@/lib/network/types'

const RI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LEAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PART = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const VENDOR_TAG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OTHER_LOC_PARTNER_TAG = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

// The five roles (hub_users_role_check), with the location each sits at.
const ROLES = {
  'super admin': { role: 'super_admin', loc: null },
  corporate: { role: 'admin', loc: null },
  'owner here': { role: 'owner', loc: RI },
  'owner elsewhere': { role: 'owner', loc: OTHER },
  manager: { role: 'manager', loc: RI },
  'read-only': { role: 'lite_user', loc: RI },
} as const
type Who = keyof typeof ROLES
const ALL = Object.keys(ROLES) as Who[]
/** Who gets through a Clients door: anyone who may write at the location. */
const CLIENTS_DOOR: Who[] = ['super admin', 'corporate', 'owner here', 'manager']
/** Who gets through a Network screen route: the gate, super admins only. */
const NETWORK_ONLY: Who[] = ['super admin']

const req = (body: any) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }) as any
const jsonReq = (body: any) => ({ json: async () => body, nextUrl: new URL('http://x/api') }) as any
const params = (id: string) => ({ params: Promise.resolve({ id }) }) as any
const ok = (s: number) => s >= 200 && s < 300
const partnersMade = () => h.state.tables.partners.filter((p: any) => p.id !== PART)

beforeEach(() => {
  h.state.serviceCalls = []
  h.state.tables = {
    locations: [
      { id: RI, name: 'Rhode Island', location_id: 'loc_ri', lifecycle_status: 'active', subscription_status: 'active' },
      { id: OTHER, name: 'Elsewhere', location_id: 'loc_x', lifecycle_status: 'active', subscription_status: 'active' },
    ],
    lookups: [
      { id: VENDOR_TAG, category: 'tags', location_id: null, label: 'Vendor', is_active: true },
      { id: OTHER_LOC_PARTNER_TAG, category: 'tags', location_id: OTHER, label: 'Partner', is_active: true },
    ],
    partner_tags: [], touchpoints: [], lead_notes: [], sync_log: [], reminders: [], hub_users: [],
    partners: [{ id: PART, location_id: RI, type: 'partner', name: 'Jim Culhane', email: null, phone: null, company: 'Penguin Mile', tier: 'networking-contact', stage: 'New Contact', network_types: ['unsure'], partner_level: null, partner_stage: null, deleted_at: null, activity: [], notes: [], addresses: [], referrals: [], next_steps: [] }],
    leads: [{ id: LEAD, location_uuid: RI, location_id: 'loc_ri', name: 'Zahnia Harut', first_name: 'Zahnia', last_name: 'Harut', email: 'z@x.co', phone: null, company: null, stage: 'New', source: 'Website', addresses: [], deleted_at: null }],
  }
})
const as = (who: Who) => { h.state.role = ROLES[who].role; h.state.loc = ROLES[who].loc }

// ── Every create path ───────────────────────────────────────────────────────
type Create = { name: string; who: Who[]; run: () => Promise<Response>; expectModel: any }
const CREATES: Create[] = [
  {
    name: 'Clients › Referred by › Create partner (POST /api/partners)',
    who: CLIENTS_DOOR,
    run: () => CREATE(req({ name: 'Britt Bragg', type: 'partner', location_id: RI, stage: 'New Contact', as_referrer: true })),
    expectModel: { network_types: ['partner'], partner_level: 'referral', partner_stage: 'New Contact' },
  },
  {
    name: 'Clients › Referred by › Create contact (POST /api/partners)',
    who: CLIENTS_DOOR,
    run: () => CREATE(req({ name: 'Bee Van', type: 'contact', location_id: RI, stage: 'New Contact', as_referrer: true })),
    expectModel: { network_types: ['partner'], partner_level: 'referral', partner_stage: 'New Contact' },
  },
  {
    name: 'the old Network screen’s Add, from a tab opened before 13 Nov (POST /api/partners, tier Networking Contact)',
    who: CLIENTS_DOOR,
    run: () => CREATE(req({ location_id: RI, type: 'partner', name: 'Coco Petrucci', tier: 'networking-contact', stage: 'New Contact', howWeMet: 'OSBE 2026', activity: [{ type: 'event', label: 'Added to Network - OSBE 2026', ts: 'Just now' }] })),
    expectModel: { network_types: ['unsure'], partner_level: null, partner_stage: null },
  },
  {
    name: 'POST /api/partners called bare, with nothing but a name',
    who: CLIENTS_DOOR,
    run: () => CREATE(req({ location_id: RI, name: 'Just A Name' })),
    expectModel: { network_types: ['unsure'], partner_level: null, partner_stage: null },
  },
  {
    name: 'POST /api/partners with a Vendor tag picked',
    who: CLIENTS_DOOR,
    run: () => CREATE(req({ location_id: RI, name: 'Sparky Electric', tagIds: [VENDOR_TAG] })),
    expectModel: { network_types: ['vendor'], partner_level: null, partner_stage: null },
  },
  {
    name: 'client card › Add to Network (POST /api/leads/:id/network, add)',
    who: CLIENTS_DOOR,
    run: () => TO_NETWORK(req({ mode: 'add' }), params(LEAD)),
    expectModel: { network_types: ['unsure'], partner_level: null, partner_stage: null },
  },
  {
    name: 'Inbox › Move to Network (POST /api/leads/:id/network, move)',
    who: CLIENTS_DOOR,
    run: () => TO_NETWORK(req({ mode: 'move' }), params(LEAD)),
    expectModel: { network_types: ['unsure'], partner_level: null, partner_stage: null },
  },
  {
    name: 'Add to Network with a Vendor tag picked',
    who: CLIENTS_DOOR,
    run: () => TO_NETWORK(req({ mode: 'add', tagIds: [VENDOR_TAG] }), params(LEAD)),
    expectModel: { network_types: ['vendor'], partner_level: null, partner_stage: null },
  },
  {
    name: 'Add to Network with another location’s Partner tag picked (it cannot attach, so it does not decide)',
    who: CLIENTS_DOOR,
    run: () => TO_NETWORK(req({ mode: 'add', tagIds: [OTHER_LOC_PARTNER_TAG] }), params(LEAD)),
    expectModel: { network_types: ['unsure'], partner_level: null, partner_stage: null },
  },
  {
    name: 'Network › Add contacts (POST /api/network/contacts)',
    who: NETWORK_ONLY,
    run: () => NET_ADD(req({ location_id: RI, name: 'Ann One', types: ['unsure'] })),
    expectModel: { network_types: ['unsure'], partner_level: null, partner_stage: null },
  },
  {
    name: 'Network › Add contacts with no type picked is refused outright (422), for the one role that gets in',
    who: [],
    run: () => NET_ADD(req({ location_id: RI, name: 'Ann One', types: [] })),
    expectModel: null,
  },
  {
    name: 'Network › import a file (POST /api/network/import)',
    who: NETWORK_ONLY,
    run: () => NET_IMPORT(req({ location_id: RI, csv: 'Name,Email\nAnn One,ann@x.co', mode: 'import' })),
    expectModel: { network_types: ['unsure'], partner_level: null, partner_stage: null },
  },
]

describe('1 + 2 · every create path, as every role: who gets through, and what the contact is', () => {
  for (const c of CREATES) {
    describe(c.name, () => {
      for (const who of ALL) {
        const through = c.who.includes(who)
        it(`${who}: ${through ? 'makes a contact with a type' : 'is refused, nothing made'}`, async () => {
          as(who)
          const res = await c.run()
          const made = partnersMade()
          if (!through) {
            expect(res.status).toBeGreaterThanOrEqual(400)
            expect(made).toHaveLength(0)
            return
          }
          expect(res.status, JSON.stringify(await res.clone().json().catch(() => null))).toBeLessThan(300)
          expect(made).toHaveLength(1)
          const row = made[0]
          // Never empty, only the five, and level/stage only on a Referral partner.
          expect(Array.isArray(row.network_types) && row.network_types.length > 0).toBe(true)
          for (const t of row.network_types) expect(NET_TYPES).toContain(t)
          if (!row.network_types.includes('partner')) {
            expect(row.partner_level ?? null).toBeNull()
            expect(row.partner_stage ?? null).toBeNull()
          }
          expect({ network_types: row.network_types, partner_level: row.partner_level ?? null, partner_stage: row.partner_stage ?? null }).toEqual(c.expectModel)
          expect(row.location_id).toBe(RI)
        })
      }
    })
  }
})

// ── Every edit path ─────────────────────────────────────────────────────────
type Edit = { name: string; who: Who[]; run: () => Promise<Response> }
const EDITS: Edit[] = [
  { name: 'the old Network record’s save (PATCH /api/partners/:id)', who: CLIENTS_DOOR, run: () => EDIT(jsonReq({ company: 'Penguin Mile RI' }), params(PART)) },
  { name: 'the old Network record’s delete (DELETE /api/partners/:id)', who: CLIENTS_DOOR, run: () => REMOVE(jsonReq({}), params(PART)) },
  { name: 'a tag on a contact (POST /api/partner-tags)', who: CLIENTS_DOOR, run: () => TAG(req({ partner_id: PART, tag_lookup_id: VENDOR_TAG })) },
  { name: 'a touchpoint on a contact (POST /api/touchpoints)', who: CLIENTS_DOOR, run: () => TOUCH(req({ partner_id: PART, kind: 'reach_out', method: 'call', label: 'Called' })) },
  { name: 'Network › contact sheet save (PATCH /api/network/contacts/:id)', who: NETWORK_ONLY, run: () => NET_EDIT(jsonReq({ changes: { title: { to: 'Broker' } } }), params(PART)) },
  { name: 'Network › bulk tag (POST /api/network/contacts/bulk)', who: NETWORK_ONLY, run: () => NET_BULK(req({ location_id: RI, ids: [PART], action: 'tag_add', value: VENDOR_TAG, confirmed: true })) },
]

describe('1 · every edit path, as every role: who gets through', () => {
  for (const e of EDITS) {
    describe(e.name, () => {
      for (const who of ALL) {
        const through = e.who.includes(who)
        it(`${who}: ${through ? 'gets through' : 'is refused'}`, async () => {
          as(who)
          const before = JSON.stringify(h.state.tables.partners) + JSON.stringify(h.state.tables.partner_tags) + JSON.stringify(h.state.tables.touchpoints)
          const res = await e.run()
          const after = JSON.stringify(h.state.tables.partners) + JSON.stringify(h.state.tables.partner_tags) + JSON.stringify(h.state.tables.touchpoints)
          if (through) {
            expect(ok(res.status), `${res.status} ${JSON.stringify(await res.clone().json().catch(() => null))}`).toBe(true)
            expect(after).not.toBe(before)
          } else {
            expect(res.status).toBeGreaterThanOrEqual(400)
            expect(after).toBe(before)
          }
        })
      }
    })
  }
})

// ── 3 · no other way in ─────────────────────────────────────────────────────
const SOURCE_DIRS = ['app', 'lib', 'components']
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const p = join(dir, name)
    if (statSync(join(process.cwd(), p)).isDirectory()) { if (name !== 'node_modules' && name !== '__fixtures__') out.push(...sourceFiles(p)); continue }
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}
const INSERTS_PARTNERS = /from\(\s*['"`]partners['"`]\s*\)\s*\.\s*(insert|upsert)\s*\(/

describe('3 · the only code that inserts a contact is the three places driven above', () => {
  it('a scan of app/, lib/ and components/ finds exactly three', () => {
    const found = SOURCE_DIRS.flatMap(sourceFiles).filter((f) => INSERTS_PARTNERS.test(readFileSync(join(process.cwd(), f), 'utf8').replace(/\s+/g, ' '))).sort()
    expect(found).toEqual([
      'app/api/leads/[id]/network/route.ts', // Add / Move to Network
      'app/api/partners/route.ts', // Referred by › Create; old screen Add
      'lib/network/contact-writes.ts', // Network › Add contacts, import (rows typed by contact-create)
    ])
  })
  it('the two Clients routes set the model on the row they insert', () => {
    for (const f of ['app/api/partners/route.ts', 'app/api/leads/[id]/network/route.ts']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8')).toMatch(/modelForNewContact\(/)
    }
  })
})

// ── 4 · the tab ─────────────────────────────────────────────────────────────
describe('4 · the Network tab stays super admins only (gate unchanged)', () => {
  it.each(ALL)('%s', (who) => expect(maySeeNewNetwork(ROLES[who].role)).toBe(who === 'super admin'))
})
