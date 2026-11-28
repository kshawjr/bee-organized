// @vitest-environment node
//
// "NOT FOUND, NEVER FORBIDDEN", and a touchpoint's card (Kevin, 2026-11-21).
//
// Two holes that were live on main, found while proving the Network gate:
//   1. POST /api/touchpoints took engagement_id from the browser unchecked, so
//      an owner could log a touchpoint on their own client or contact that
//      named another location's card. Now the card must be THIS client's card
//      at THIS client's location, for every role, or it is "not found" and
//      nothing is written. No other route takes a card id from the browser
//      when it writes a touchpoint (pinned below by reading the source).
//   2. The shared screens answered another location's record "forbidden"
//      (403) and a missing one "not found" (404), so a guessed id learned it
//      was real. Now anything the person may not see answers EXACTLY like a
//      missing record: same status, same body. The family: tags on contacts,
//      touchpoints, reminders, tag-making, companies (list, one, referrals,
//      history), a contact's referrals, and the Network routes that read by
//      location (list, Nurturing, import mappings, the old summary).
// Something the person CAN see but may not change still answers 403.
//
// Real handlers, real sign-in lookup, stand-in database (the outside-screens
// harness). The gate is opened in this file only, so the Network routes can
// be reached at all; the real gate is pinned shut in owner-safe-gate.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
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
import * as lookups from '@/app/api/lookups/route'
import * as lookupOne from '@/app/api/lookups/[id]/route'
import * as companies from '@/app/api/companies/route'
import * as companyOne from '@/app/api/companies/[id]/route'
import * as companyReferrals from '@/app/api/companies/[id]/referrals/route'
import * as companyTouches from '@/app/api/companies/[id]/touchpoints/route'
import * as partnerReferrals from '@/app/api/partners/[id]/referrals/route'
import * as netList from '@/app/api/network/list/route'
import * as netNurturing from '@/app/api/network/nurturing/route'
import * as netImport from '@/app/api/network/import/route'
import * as netSummary from '@/app/api/network/summary/route'

const HOME = 'a0000000-0000-4000-8000-000000000001'
const AWAY = 'b0000000-0000-4000-8000-000000000002'
const MISSING = 'deadbeef-0000-4000-8000-000000000000'
const ID = {
  partner: { HOME: 'a1000000-0000-4000-8000-0000000000c1', AWAY: 'b1000000-0000-4000-8000-0000000000c2' },
  lead: { HOME: 'a2000000-0000-4000-8000-0000000000e1', AWAY: 'b2000000-0000-4000-8000-0000000000e2', OTHER: 'a2000000-0000-4000-8000-0000000000e9' },
  tag: { HOME: 'a3000000-0000-4000-8000-0000000000f1', AWAY: 'b3000000-0000-4000-8000-0000000000f2', CORP: 'c3000000-0000-4000-8000-0000000000f9' },
  card: { HOME: 'a4000000-0000-4000-8000-0000000000d1', AWAY: 'b4000000-0000-4000-8000-0000000000d2', OTHER: 'a4000000-0000-4000-8000-0000000000d9' },
  company: { HOME: 'a6000000-0000-4000-8000-0000000000b1', AWAY: 'b6000000-0000-4000-8000-0000000000b2' },
}
const OLD = '2025-01-01T00:00:00Z'
const ME = 'user-me'
function seed() {
  const W = ['HOME', 'AWAY'] as const
  const L = { HOME, AWAY }
  h.state.tables = {
    locations: W.map((w) => ({ id: L[w], name: `${w} Bees`, location_id: `loc_${w.toLowerCase()}`, lifecycle_status: 'active', subscription_status: 'active' })),
    partners: W.map((w) => ({ id: ID.partner[w], location_id: L[w], deleted_at: null, name: `${w} Contact`, company_id: null, created_at: OLD, updated_at: OLD })),
    leads: [
      ...W.map((w) => ({ id: ID.lead[w], location_id: `loc_${w.toLowerCase()}`, location_uuid: L[w], name: `${w} Person`, created_at: OLD, archived_at: null, is_junk: false })),
      { id: ID.lead.OTHER, location_id: 'loc_home', location_uuid: HOME, name: 'Other Person at HOME', created_at: OLD, archived_at: null, is_junk: false },
    ],
    engagements: [
      { id: ID.card.HOME, client_id: ID.lead.HOME, location_uuid: HOME, stage: 'Estimate' },
      { id: ID.card.AWAY, client_id: ID.lead.AWAY, location_uuid: AWAY, stage: 'Estimate' },
      { id: ID.card.OTHER, client_id: ID.lead.OTHER, location_uuid: HOME, stage: 'Estimate' },
    ],
    lookups: [
      ...W.map((w) => ({ id: ID.tag[w], label: `${w} tag`, location_id: L[w], is_active: true, category: 'tags', attrs: {}, icon: null })),
      { id: ID.tag.CORP, label: 'Corporate tag', location_id: null, is_active: true, category: 'tags', attrs: {}, icon: null },
    ],
    companies: W.map((w) => ({ id: ID.company[w], location_id: L[w], name: `${w} Co`, deleted_at: null, created_at: OLD, updated_at: OLD })),
    partner_tags: [], touchpoints: [], reminders: [], hub_users: [], import_mappings: [],
  }
}
const as = (role: string, locationId: string | null) => {
  h.state.sessionUser = { id: ME }
  h.state.hubUser = { id: ME, role, location_id: locationId }
}
const req = (url: string, body?: any) => {
  const u = new URL(url, 'http://x')
  return { nextUrl: u, url: u.toString(), json: async () => body, text: async () => JSON.stringify(body) } as any
}
const p = (id: string) => ({ params: Promise.resolve({ id }) }) as any
const pSync = (id: string) => ({ params: { id } }) as any
const writes = () => h.state.calls.filter((c: any) => c.client === 'service' && c.op !== 'select')
const tpInserts = () => h.state.calls.filter((c: any) => c.table === 'touchpoints' && c.op === 'insert')

beforeEach(() => { seed(); h.state.calls = [] })

// ── 1. a touchpoint's card ────────────────────────────────────────────────
describe("a touchpoint cannot be attached to another location's card, by any role", () => {
  const log = (lead: string, card: string | null, extra: any = {}) =>
    touchpoints.POST(req('/x', { lead_id: lead, ...(card ? { engagement_id: card } : {}), kind: 'reach_out', method: 'call', label: 'Called', ...extra }))

  for (const [role, loc] of [['owner', HOME], ['manager', HOME], ['admin', null], ['super_admin', null]] as const) {
    it(`${role}: own client + own card → written, on that card`, async () => {
      as(role, loc)
      const res = await log(ID.lead.HOME, ID.card.HOME)
      expect(res.status).toBe(201)
      expect(h.state.tables.touchpoints.at(-1)).toMatchObject({ lead_id: ID.lead.HOME, location_uuid: HOME, engagement_id: ID.card.HOME })
    })
    it(`${role}: own client + ANOTHER location's card → not found, nothing written (corporate too)`, async () => {
      as(role, loc)
      const res = await log(ID.lead.HOME, ID.card.AWAY)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'engagement_not_found' })
      expect(tpInserts()).toEqual([])
      expect(writes()).toEqual([])
    })
    it(`${role}: own client + another CLIENT's card at the same location → not found, nothing written`, async () => {
      as(role, loc)
      expect((await log(ID.lead.HOME, ID.card.OTHER)).status).toBe(404)
      expect(writes()).toEqual([])
    })
    it(`${role}: a contact (partner) + any card → not found (contacts have no cards)`, async () => {
      as(role, loc)
      const res = await touchpoints.POST(req('/x', { partner_id: ID.partner.HOME, engagement_id: ID.card.HOME, kind: 'reach_out', method: 'coffee', label: 'Coffee' }))
      expect(res.status).toBe(404)
      expect(writes()).toEqual([])
    })
    it(`${role}: another location's card answers exactly like a card that does not exist`, async () => {
      as(role, loc)
      const a = await log(ID.lead.HOME, ID.card.AWAY), m = await log(ID.lead.HOME, MISSING)
      expect([a.status, await a.json()]).toEqual([m.status, await m.json()])
    })
  }
  it('no card named → written with no card, exactly as before', async () => {
    as('owner', HOME)
    expect((await log(ID.lead.HOME, null)).status).toBe(201)
    expect(h.state.tables.touchpoints.at(-1).engagement_id).toBeUndefined()
  })

  it('BY ANY ROUTE: the only route that writes a touchpoint with a card id taken from the request is /api/touchpoints, and it checks the card', () => {
    const root = join(process.cwd(), 'app/api')
    const files: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const x = join(d, f); statSync(x).isDirectory() ? walk(x) : f === 'route.ts' && files.push(x) } }
    walk(root)
    const writers = files.filter((f) => { const s = readFileSync(f, 'utf8'); return /from\('touchpoints'\)[\s\S]{0,200}\.insert\(|insertTouchpoint\(|logCallTouchpoint\(/.test(s) })
    // Any mention of a card id near the request body (body.engagement_id,
    // (body as any)?.engagementId, body['engagement_id'] …) or in the query.
    const takesCardFromRequest = writers.filter((f) => /\bbody\b[^\n;]{0,40}\bengagement_?[iI]d\b|searchParams\.get\(['"]engagement/.test(readFileSync(f, 'utf8')))
    expect(takesCardFromRequest.map((f) => f.slice(root.length + 1))).toEqual(['touchpoints/route.ts'])
    const src = readFileSync(join(root, 'touchpoints/route.ts'), 'utf8')
    expect(src).toMatch(/card\.client_id !== lead_id \|\| card\.location_uuid !== subjectLocation/)
    expect(src).toMatch(/engagement_id: engagementId,/)
    // The shared writer has no other door that takes a card from a person.
    const slack = readFileSync(join(root, 'slack/interactivity/route.ts'), 'utf8')
    expect(slack).not.toMatch(/engagementId:/)
  })
})

// ── 2. not found, never forbidden ─────────────────────────────────────────
type Probe = [string, (id: 'AWAY' | 'MISSING') => Promise<Response>]
const pick = (o: { AWAY: string }, k: 'AWAY' | 'MISSING') => (k === 'AWAY' ? o.AWAY : MISSING)
const LOC = { AWAY }
const PROBES: Probe[] = [
  ['tags on a contact · GET', (k) => partnerTags.GET(req(`/x?partner_id=${pick(ID.partner, k)}`))],
  ['tags on a contact · POST, the contact', (k) => partnerTags.POST(req('/x', { partner_id: pick(ID.partner, k), tag_lookup_id: ID.tag.HOME }))],
  ['tags on a contact · POST, the tag', (k) => partnerTags.POST(req('/x', { partner_id: ID.partner.HOME, tag_lookup_id: pick(ID.tag, k) }))],
  ['tags on a contact · DELETE', (k) => partnerTags.DELETE(req(`/x?partner_id=${pick(ID.partner, k)}&tag_lookup_id=${ID.tag.HOME}`))],
  ['touchpoints · a client', (k) => touchpoints.POST(req('/x', { lead_id: pick(ID.lead, k), kind: 'reach_out', label: 'x' }))],
  ['touchpoints · a contact', (k) => touchpoints.POST(req('/x', { partner_id: pick(ID.partner, k), kind: 'reach_out', label: 'x' }))],
  ['touchpoints · the card', (k) => touchpoints.POST(req('/x', { lead_id: ID.lead.HOME, engagement_id: pick(ID.card, k), kind: 'reach_out', label: 'x' }))],
  ['reminders · a client', (k) => reminders.POST(req('/x', { lead_id: pick(ID.lead, k), due_on: '2026-12-01', note: 'x' }))],
  ['reminders · a contact', (k) => reminders.POST(req('/x', { partner_id: pick(ID.partner, k), due_on: '2026-12-01', note: 'x' }))],
  ['tag-making · POST at a location', (k) => lookups.POST(req('/x', { category: 'tags', label: 'Zebra Quilting', location_id: pick(LOC, k), made_on: 'network', group: 'relationship', icon: null }))],
  ['tag-making · PATCH a tag', (k) => lookupOne.PATCH(req('/x', { label: 'Renamed' }), pSync(pick(ID.tag, k)))],
  ['tag-making · DELETE a tag', (k) => lookupOne.DELETE(req('/x'), pSync(pick(ID.tag, k)))],
  ['companies · list', (k) => companies.GET(req(`/x?location_id=${pick(LOC, k)}`))],
  ['companies · POST', (k) => companies.POST(req('/x', { location_id: pick(LOC, k), name: 'New Co' }))],
  ['companies · GET one', (k) => companyOne.GET(req('/x'), p(pick(ID.company, k)))],
  ['companies · PATCH', (k) => companyOne.PATCH(req('/x', { name: 'x' }), p(pick(ID.company, k)))],
  ['companies · DELETE', (k) => companyOne.DELETE(req('/x'), p(pick(ID.company, k)))],
  ['companies · referrals', (k) => companyReferrals.GET(req('/x'), p(pick(ID.company, k)))],
  ['companies · history', (k) => companyTouches.GET(req('/x'), p(pick(ID.company, k)))],
  ['a contact’s referrals', (k) => partnerReferrals.GET(req('/x'), p(pick(ID.partner, k)))],
  ['Network · list', (k) => netList.GET(req(`/x?location_id=${pick(LOC, k)}`))],
  ['Network · Nurturing', (k) => netNurturing.GET(req(`/x?location_id=${pick(LOC, k)}`))],
  ['Network · import mappings', (k) => netImport.GET(req(`/x?location_id=${pick(LOC, k)}`))],
  ['Network · old summary', (k) => netSummary.GET(req(`/x?location_id=${pick(LOC, k)}`))],
]

describe('a record the person may not see answers "not found", never "forbidden" — the whole family', () => {
  for (const role of ['owner', 'manager', 'lite_user']) {
    for (const [name, run] of PROBES) {
      it(`${role} · ${name}: another location's id and a missing id get the same answer${role === 'lite_user' ? '' : ', and it is 404'}`, async () => {
        as(role, HOME)
        const a = await run('AWAY'); const ab = await a.json()
        const m = await run('MISSING'); const mb = await m.json()
        expect([a.status, ab]).toEqual([m.status, mb])
        expect(a.status).not.toBe(200)
        if (role !== 'lite_user') expect(a.status).toBe(404)
        // A read-only seat may be stopped by its ROLE first (the same answer
        // either way, which says nothing about the record); never by a
        // location "forbidden".
        expect(JSON.stringify(ab)).not.toMatch(/wrong_location|"forbidden"/)
        expect(writes()).toEqual([])
      })
    }
  }
  it('no route in the family still answers a location mismatch with 403 (source)', () => {
    for (const f of ['app/api/touchpoints/route.ts', 'app/api/partner-tags/route.ts', 'app/api/reminders/route.ts', 'app/api/lookups/route.ts', 'app/api/lookups/[id]/route.ts',
      'app/api/companies/route.ts', 'app/api/companies/[id]/route.ts', 'app/api/companies/[id]/referrals/route.ts', 'app/api/companies/[id]/touchpoints/route.ts', 'app/api/partners/[id]/referrals/route.ts',
      'app/api/network/list/route.ts', 'app/api/network/nurturing/route.ts', 'app/api/network/import/route.ts', 'app/api/network/summary/route.ts',
      'app/api/network/counts/route.ts']) {
      const s = readFileSync(join(process.cwd(), f), 'utf8')
      expect(s, f).not.toMatch(/forbidden_wrong_location/)
      expect(s, f).not.toMatch(/(canReadLocation|mayReadNetworkLocation)\([^)]*\)\)?\s*\{?\s*\n?\s*return NextResponse\.json\(\{ error: 'forbidden' \}, \{ status: 403 \}\)/)
    }
  })
})

describe('something the person CAN see but may not change still says so (403)', () => {
  it('an owner renaming a corporate tag', async () => {
    as('owner', HOME)
    expect((await lookupOne.PATCH(req('/x', { label: 'x' }), pSync(ID.tag.CORP))).status).toBe(403)
  })
  it('a read-only seat changing its own location’s company', async () => {
    as('lite_user', HOME)
    expect((await companyOne.PATCH(req('/x', { name: 'x' }), p(ID.company.HOME))).status).toBe(403)
  })
  it('a read-only seat making a tag at its own location', async () => {
    as('lite_user', HOME)
    expect((await lookups.POST(req('/x', { category: 'tags', label: 'Zebra Quilting', location_id: HOME, made_on: 'network', group: 'relationship', icon: null }))).status).toBe(403)
  })
  it('corporate putting another location’s tag on a contact: they can see the tag, so 403 tag_lookup_wrong_location (the only place it is still said)', async () => {
    as('admin', null)
    const res = await partnerTags.POST(req('/x', { partner_id: ID.partner.HOME, tag_lookup_id: ID.tag.AWAY }))
    expect([res.status, (await res.json()).error]).toEqual([403, 'tag_lookup_wrong_location'])
    expect(writes()).toEqual([])
  })
  it('corporate is never answered "not found" for a record that is there', async () => {
    as('admin', null)
    expect((await companyOne.GET(req('/x'), p(ID.company.AWAY))).status).toBe(200)
    expect((await partnerTags.GET(req(`/x?partner_id=${ID.partner.AWAY}`))).status).toBe(200)
  })
})

describe('nothing else changes, by fingerprint', () => {
  // sha256 (first 16) at 54b6b58, with today's lines taken back out first
  // (lib/not-found-footprint.ts) — so only the named lines moved.
  const AT_MAIN: Record<string, string> = {
    'app/api/touchpoints/route.ts': '33d10fb808c54228',
    'app/api/partner-tags/route.ts': 'c5c2a0d881a2fa57',
    'app/api/reminders/route.ts': 'ac50556b4dbb5fe9',
    'app/api/lookups/route.ts': 'fd4e56c6ec43d06e',
    'app/api/lookups/[id]/route.ts': '47cc5216d92c7eac',
    'app/api/companies/route.ts': 'd2f9ad16d2b0596f',
    'app/api/companies/[id]/route.ts': '00178989efcff2b3',
    'app/api/companies/[id]/referrals/route.ts': '9fcebf59eae7a5bf',
    'app/api/companies/[id]/touchpoints/route.ts': 'e8730a7232464b52',
    'app/api/partners/[id]/referrals/route.ts': '8e591713660cc957',
    'app/api/network/list/route.ts': '0d855b5f6e791ba0',
    'app/api/network/nurturing/route.ts': '8486a2e62115b0cc', // was 1991346d299e0a2f until FL-135 fix 3 (2026-11-28): fresh=1 reads the list afresh after an Add; nothing about who may read it
    'app/api/network/import/route.ts': 'de9a47efb7497db9',
    'app/api/network/summary/route.ts': '075d9fd79131455d',
    // untouched outright
    'lib/crm.ts': '0f15c0b894575bbc',
    'lib/touchpoints.ts': '49b88f073e234c2e',
    'lib/read-only-access.ts': '5401c65cf277c0bf',
    'lib/tag-guard.ts': '45799f8364ec40a6',
    'lib/auth.ts': '58e71d92c9808be3',
    'app/api/lookups/reorder/route.ts': 'd43783aa33265f84',
    'app/api/reminders/[id]/route.ts': '92ef8d8175d0c9cb',
    'lib/network/route-access.ts': '43d00dcbcb3640f5',
    'lib/network/access.ts': '2c76af86bf29a472',
  }
  for (const [f, sha] of Object.entries(AT_MAIN)) {
    it(`${f}`, () => {
      expect(createHash('sha256').update(withoutNotFoundFix(f, readFileSync(join(process.cwd(), f), 'utf8'))).digest('hex').slice(0, 16)).toBe(sha)
    })
  }
})
