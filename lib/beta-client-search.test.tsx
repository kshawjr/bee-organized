// @vitest-environment happy-dom
//
// Clients at scale, slice 1 — the Client List's search reaches every client,
// not just the 5,000 the page loaded (lib/client-search.ts,
// app/api/clients/search, components/hive/ClientGroupedList.jsx).
//
// The two that matter most: EVERY client is findable, and ONLY your own.
//   1) a client outside the newest loaded rows is found by name, email, phone
//      and tag name
//   2) a small location's server answer is exactly the browser filter's
//   3) another location's clients cannot be reached — scope rule, and a direct
//      call to the route with a forged location id
//   4) junk and archived stay out, through the shared applyLeadActiveFilter
//   5) a searched-in client lands in its real status band — the same Person
//      the page load would have built
//   6) a capped result says it is capped
//   7) an empty box asks nothing and renders as before; a search never shows
//      fewer rows than the browser filter alone
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  searchClients, resolveClientSearchScope, clientSearchOrClause, cleanClientSearchTerm, CLIENT_SEARCH_CAP,
} from '@/lib/client-search'
import { mapLeadToPerson } from '@/lib/people-mapper'
import { rollUpEngagements } from '@/lib/engagement-rollup'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { matchesTagSearch } from '@/components/hive/shared/tagFilter'
import ClientGroupedList, { CLIENT_SEARCH_DEBOUNCE_MS } from '@/components/hive/ClientGroupedList'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_A = '11111111-1111-4111-8111-111111111111'
const LOC_B = '22222222-2222-4222-8222-222222222222'
const TAG_REALTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = Date.now()
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString()

// ── a small in-memory PostgREST ──────────────────────────────────────────────
// Real filter semantics for the handful of operators the search uses, and a
// log of every filter applied per table — so a test can ask both "what came
// back" and "was the fence on that read".
type Call = { table: string; filters: string[] }
function fakeDb(tables: Record<string, any[]>) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, filters: [] }
    calls.push(call)
    let rows = [...(tables[table] || [])]
    let wantCount = false
    let limitN: number | null = null
    let rangeFT: [number, number] | null = null
    const orders: Array<{ col: string; asc: boolean }> = []
    const b: any = {
      select(_cols: string, opts?: any) { if (opts?.count) wantCount = true; return b },
      eq(col: string, v: any) { call.filters.push(`eq:${col}:${v}`); rows = rows.filter(r => String(r[col]) === String(v)); return b },
      in(col: string, vs: any[]) { call.filters.push(`in:${col}`); const s = new Set(vs.map(String)); rows = rows.filter(r => s.has(String(r[col]))); return b },
      is(col: string, v: any) { call.filters.push(`is:${col}:${v}`); rows = rows.filter(r => (r[col] ?? null) === v); return b },
      not(col: string, op: string, v: any) { call.filters.push(`not:${col}:${op}:${v}`); rows = rows.filter(r => !(r[col] === v)); return b },
      lte(col: string, v: any) { call.filters.push(`lte:${col}:${v}`); rows = rows.filter(r => new Date(r[col]).getTime() <= new Date(v).getTime()); return b },
      ilike(col: string, pattern: string) {
        call.filters.push(`ilike:${col}:${pattern}`)
        const needle = pattern.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase()
        rows = rows.filter(r => String(r[col] || '').toLowerCase().includes(needle)); return b
      },
      or(clause: string) {
        call.filters.push(`or:${clause}`)
        if (table === 'leads') {
          // name.ilike."*term*",email.ilike."*term*",phone.ilike."*term*"
          const m = clause.match(/^name\.ilike\."\*(.*)\*",email\.ilike\."\*(.*)\*",phone\.ilike\."\*(.*)\*"$/)
          if (!m) throw new Error(`unparsed or clause: ${clause}`)
          // undo the PostgREST quoting, then the LIKE escaping
          const needle = m[1].replace(/\\(.)/g, '$1').replace(/\\(.)/g, '$1').toLowerCase()
          rows = rows.filter(r => ['name', 'email', 'phone'].some(f => String(r[f] || '').toLowerCase().includes(needle)))
        } else if (table === 'lookups') {
          const loc = clause.split('location_id.eq.')[1]
          rows = rows.filter(r => r.location_id == null || r.location_id === loc)
        }
        return b
      },
      order(col: string, o?: any) { orders.push({ col, asc: o?.ascending !== false }); return b },
      limit(n: number) { limitN = n; return b },
      range(f: number, t: number) { rangeFT = [f, t]; return b },
      then(res: any, rej: any) {
        const sorted = [...rows].sort((x, y) => {
          for (const o of orders) {
            const a = x[o.col] ?? '', c = y[o.col] ?? ''
            if (a !== c) return (a < c ? -1 : 1) * (o.asc ? 1 : -1)
          }
          return 0
        })
        const count = sorted.length
        let out = sorted
        if (rangeFT) out = out.slice(rangeFT[0], rangeFT[1] + 1)
        if (limitN != null) out = out.slice(0, limitN)
        return Promise.resolve({ data: out, error: null, count: wantCount ? count : null }).then(res, rej)
      },
    }
    return b
  }
  return { db: { from }, calls }
}

const lead = (over: any) => ({
  id: over.id, name: 'Nobody', first_name: null, last_name: null, email: null, phone: null,
  location_uuid: LOC_A, location_id: 'loc_a', is_junk: null, archived_at: null,
  created_at: daysAgo(700), import_source: 'jobber', stage: 'Nurturing', addresses: [],
  paid_amount: 0, jobber_request_id: null, jobber_job_id: null,
  ...over,
})

// A location whose page load was cut short: two "loaded" (newer) clients and
// a set of older ones the browser never received.
const CUT = daysAgo(300)
function world() {
  const leads = [
    lead({ id: 'new-1', name: 'Nora Newer', email: 'nora@x.com', phone: '(215) 555-0001', created_at: daysAgo(10), import_source: 'manual' }),
    lead({ id: 'new-2', name: 'Sam Smith', email: 'sam@x.com', phone: '(215) 555-0002', created_at: daysAgo(200) }),
    // ── older than the cut: NOT in the browser ──
    lead({ id: 'old-plain', name: 'Olive Oldhand', email: 'olive.oldhand@mail.com', phone: '(610) 555-7788', created_at: daysAgo(400) }),
    lead({ id: 'old-won', name: 'Wendy Wonwork', email: 'wendy@x.com', phone: '610-555-1000', created_at: daysAgo(500) }),
    lead({ id: 'old-open', name: 'Opal Openjob', email: 'opal@x.com', phone: '610-555-2000', created_at: daysAgo(500) }),
    lead({ id: 'old-reached', name: 'Rita Reached', email: 'rita@x.com', phone: '610-555-3000', created_at: daysAgo(400), import_source: 'manual' }),
    lead({ id: 'old-nocontact', name: 'Nick Nocontact', email: null, phone: null, created_at: daysAgo(400) }),
    lead({ id: 'old-tagged', name: 'Tessa Tagged', email: 'tessa@x.com', phone: '610-555-4000', created_at: daysAgo(450) }),
    lead({ id: 'old-junk', name: 'Olive Junked', email: 'junk@x.com', created_at: daysAgo(400), is_junk: true }),
    lead({ id: 'old-archived', name: 'Olive Archived', email: 'arch@x.com', created_at: daysAgo(400), archived_at: daysAgo(30) }),
    // ── another location entirely ──
    lead({ id: 'b-1', name: 'Olive Elsewhere', email: 'olive.elsewhere@mail.com', phone: '(610) 555-7788', location_uuid: LOC_B, location_id: 'loc_b', created_at: daysAgo(400) }),
    lead({ id: 'b-tagged', name: 'Terry Elsewhere', location_uuid: LOC_B, location_id: 'loc_b', created_at: daysAgo(400) }),
  ]
  return {
    leads,
    lookups: [
      { id: TAG_REALTOR, label: 'Realtor', category: 'tags', is_active: true, location_id: null, icon: null, attrs: null },
    ],
    lead_tags: [
      { lead_id: 'old-tagged', tag_lookup_id: TAG_REALTOR },
      { lead_id: 'b-tagged', tag_lookup_id: TAG_REALTOR },
    ],
    touchpoints: [
      { id: 't1', lead_id: 'old-reached', kind: 'reach_out', method: 'call', label: 'Called', occurred_at: daysAgo(390) },
    ],
    engagements: [
      { id: 'e-won', client_id: 'old-won', stage: 'Closed Won', total_paid: 900, total_invoiced: 900, closed_at: daysAgo(450), created_at: daysAgo(480) },
      { id: 'e-open', client_id: 'old-open', stage: 'Request', total_paid: 0, total_invoiced: 0, closed_at: null, created_at: daysAgo(20) },
    ],
    lead_notes: [], lead_contacts: [], assessments: [], service_requests: [], quotes: [], jobs: [], invoices: [],
    lead_assignees: [], partners: [],
  } as Record<string, any[]>
}

const ids = (r: { people: any[] }) => r.people.map(p => p.id).sort()

// ── 1 · every client findable ────────────────────────────────────────────────
describe('a client the page never loaded is found', () => {
  it('by name, by email and by phone', async () => {
    const { db } = fakeDb(world())
    for (const term of ['oldhand', 'olive.oldhand@mail.com', '(610) 555-7788']) {
      const r = await searchClients(db, { locationUuid: LOC_A, term, olderThan: CUT })
      expect(ids(r), term).toEqual(['old-plain'])
    }
  })

  it('by tag name — a client tagged Realtor, whose name, email and phone do not contain it', async () => {
    const { db } = fakeDb(world())
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'realtor', olderThan: CUT })
    expect(ids(r)).toEqual(['old-tagged'])
    expect(r.total).toBe(1)
    // and the Person carries the tag id the screen's tag filter + sub-line read
    expect(r.people[0].tagIds).toEqual([TAG_REALTOR])
  })

  it('a client matching by BOTH name and tag is counted once', async () => {
    const w = world()
    w.leads.find(l => l.id === 'old-tagged').name = 'Tessa Realtor'
    const { db } = fakeDb(w)
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'realtor', olderThan: CUT })
    expect(ids(r)).toEqual(['old-tagged'])
    expect(r.total).toBe(1)
  })

  it('typed punctuation means itself — dots, commas, brackets, quotes, % and _ are not wildcards or structure', () => {
    expect(clientSearchOrClause('a.b')).toBe('name.ilike."*a.b*",email.ilike."*a.b*",phone.ilike."*a.b*"')
    expect(clientSearchOrClause('50%_x')).toContain('"*50\\\\%\\\\_x*"')
    expect(clientSearchOrClause('say "hi"')).toContain('"*say \\"hi\\"*"')
    expect(cleanClientSearchTerm('  jo*hn  ')).toBe('jo hn')
  })
})

// ── 2 · small location parity ────────────────────────────────────────────────
describe('a location that fits in the page load', () => {
  it('the server returns exactly what the browser filter returns, term by term', async () => {
    const w = world()
    const { db } = fakeDb(w)
    // what the page would hold for LOC_A: every active lead, mapped
    const loaded = w.leads
      .filter(l => l.location_uuid === LOC_A && l.is_junk !== true && l.archived_at == null)
      .map(l => mapLeadToPerson(l, {
        lead_tags: w.lead_tags.filter(t => t.lead_id === l.id),
        tag_lookups: { [TAG_REALTOR]: w.lookups[0] },
      } as any))
    const tagById = new Map(w.lookups.map(t => [t.id, t]))
    // ClientGroupedList's filter, verbatim
    const browser = (search: string) => {
      const q = search.trim().toLowerCase()
      return loaded.filter((p: any) =>
        (p.name || '').toLowerCase().includes(q)
        || (p.email || '').toLowerCase().includes(q)
        || (p.phone || '').toLowerCase().includes(q)
        || !!matchesTagSearch(p, q, tagById)).map((p: any) => p.id).sort()
    }
    for (const term of ['olive', 'smith', 'x.com', '610-555', '(215)', 'realtor', 'o', 'zzz', 'WENDY']) {
      const r = await searchClients(db, { locationUuid: LOC_A, term })
      expect(ids(r), term).toEqual(browser(term))
    }
  })
})

// ── 3 · only your own ────────────────────────────────────────────────────────
describe('another location cannot be searched', () => {
  it('the search never returns a client from outside the location it was given', async () => {
    const { db, calls } = fakeDb(world())
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'olive' })
    expect(ids(r)).toEqual(['old-plain'])
    const tagged = await searchClients(db, { locationUuid: LOC_A, term: 'realtor' })
    expect(ids(tagged)).toEqual(['old-tagged'])
    // every read of the leads table carried the location fence
    const leadReads = calls.filter(c => c.table === 'leads')
    expect(leadReads.length).toBeGreaterThan(3)
    for (const c of leadReads) expect(c.filters).toContain(`eq:location_uuid:${LOC_A}`)
  })

  it('scope rule: a franchise user is pinned to their own location and a forged id is refused', () => {
    const owner = { elevated: false, location_id: LOC_A }
    expect(resolveClientSearchScope(owner, null)).toEqual({ ok: true, locationUuid: LOC_A })
    expect(resolveClientSearchScope(owner, LOC_A)).toEqual({ ok: true, locationUuid: LOC_A })
    expect(resolveClientSearchScope(owner, LOC_B)).toEqual({ ok: false, status: 403, error: 'forbidden_wrong_location' })
    expect(resolveClientSearchScope({ elevated: false, location_id: null }, LOC_B)).toMatchObject({ ok: false, status: 403 })
    expect(resolveClientSearchScope(owner, "x' or 1=1")).toMatchObject({ ok: false, status: 400 })
    // elevated: the location they name, and one must be named
    expect(resolveClientSearchScope({ elevated: true, location_id: null }, LOC_B)).toEqual({ ok: true, locationUuid: LOC_B })
    expect(resolveClientSearchScope({ elevated: true, location_id: null }, null)).toMatchObject({ ok: false, status: 400 })
  })
})

// The route itself, called directly, with the session of a LOC_A user.
const session = vi.hoisted(() => ({ role: 'owner', location_id: '', user: true as boolean, db: null as any }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user ? { id: 'u1' } : null } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'u1', role: session.role, location_id: session.location_id }, error: null }) }) }) }),
  }),
}))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => session.db.from(t) } }))

describe('GET /api/clients/search, called directly', () => {
  const call = async (qs: string) => {
    const { GET } = await import('@/app/api/clients/search/route')
    const res = await GET(new Request(`http://x/api/clients/search?${qs}`))
    return { status: res.status, body: await res.json() }
  }
  let calls: Call[]
  beforeEach(() => {
    const f = fakeDb(world()); session.db = f.db; calls = f.calls
    session.role = 'owner'; session.location_id = LOC_A; session.user = true
  })

  it('a forged location id is a 403 and the clients table is never read', async () => {
    const r = await call(`q=olive&location=${LOC_B}`)
    expect(r.status).toBe(403)
    expect(r.body.people).toBeUndefined()
    expect(calls.length).toBe(0)
  })

  it('with no location given, the owner gets their own location only', async () => {
    const r = await call('q=olive')
    expect(r.status).toBe(200)
    expect(r.body.people.map((p: any) => p.id)).toEqual(['old-plain'])
    expect(r.body.location).toBe(LOC_A)
  })

  it('lite_user (read-only) can search — their own location, nothing wider', async () => {
    session.role = 'lite_user'
    expect((await call('q=olive')).body.people.map((p: any) => p.id)).toEqual(['old-plain'])
    expect((await call(`q=olive&location=${LOC_B}`)).status).toBe(403)
  })

  it('signed out is a 401; an elevated user must name a location', async () => {
    session.user = false
    expect((await call('q=olive')).status).toBe(401)
    session.user = true; session.role = 'super_admin'; session.location_id = ''
    expect((await call('q=olive')).status).toBe(400)
    const r = await call(`q=olive&location=${LOC_B}`)
    expect(r.body.people.map((p: any) => p.id)).toEqual(['b-1'])
  })
})

// ── 4 · junk and archived stay out ───────────────────────────────────────────
describe('the Client List rule: not junk, not archived', () => {
  it('neither is returned, and every leads read went through applyLeadActiveFilter', async () => {
    const { db, calls } = fakeDb(world())
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'olive' })
    expect(ids(r)).toEqual(['old-plain'])   // not old-junk, not old-archived
    await searchClients(db, { locationUuid: LOC_A, term: 'realtor' })
    for (const c of calls.filter(c => c.table === 'leads')) {
      expect(c.filters).toContain('not:is_junk:is:true')
      expect(c.filters).toContain('is:archived_at:null')
    }
  })

  it('the predicate is the shared helper, not a second copy — and ⌘K keeps its own rule', () => {
    const src = readFileSync('lib/client-search.ts', 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).toContain("import { applyLeadActiveFilter } from './lead-suppression'")
    expect(code).not.toMatch(/is_junk|archived_at/)
    // ⌘K deliberately includes archived clients; this work must not change that.
    const cmdk = readFileSync('app/api/search/route.ts', 'utf8')
    expect(cmdk).not.toContain('archived_at')
    expect(cmdk).not.toContain('applyLeadActiveFilter')
  })
})

// ── 5 · the right band ───────────────────────────────────────────────────────
describe('a searched-in client lands in its real status band', () => {
  it('is the same Person the page load builds from the same rows', async () => {
    const w = world()
    const { db } = fakeDb(w)
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'o', olderThan: CUT })
    for (const p of r.people) {
      const row = w.leads.find(l => l.id === p.id)
      // the page load's inputs (app/_hub-page.tsx), for this one lead
      const pageLoad = mapLeadToPerson(row, {
        lead_notes: [], lead_contacts: [], assessments: [], service_requests: [], quotes: [], jobs: [], invoices: [], lead_assignees: [],
        touchpoints: w.touchpoints.filter(t => t.lead_id === p.id),
        lead_tags: w.lead_tags.filter(t => t.lead_id === p.id),
        tag_lookups: Object.fromEntries(w.lead_tags.filter(t => t.lead_id === p.id).map(() => [TAG_REALTOR, w.lookups[0]])),
        ...rollUpEngagements(w.engagements.filter(e => e.client_id === p.id)),
        network_moved: false,
      } as any)
      expect(p, p.id).toEqual(pageLoad)
    }
  })

  it('won work → Client, a logged reach-out → Attempting, no email or phone → No contact, open work → Active', async () => {
    const w = world()
    // a still-open enquiry needs a recent, manual lead
    Object.assign(w.leads.find(l => l.id === 'old-reached'), { created_at: daysAgo(5) })
    w.touchpoints[0].occurred_at = daysAgo(2)
    const { db } = fakeDb(w)
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'o' })
    const by = Object.fromEntries(r.people.map(p => [p.id, p]))
    // the page's open-engagement set: complete for the location, not cut at 5,000
    const open = new Set(['old-open'])
    const band = (id: string) => deriveClientStatus(by[id], open, Date.now(), null)
    expect(band('old-won')).toBe('Client')
    expect(band('old-reached')).toBe('Attempting')
    expect(band('old-nocontact')).toBe('no_contact')
    expect(band('old-open')).toBe('Active')
    expect(band('old-plain')).toBe('Nurturing')
  })

  it('a failed child read fails the search rather than filing people in the wrong band', async () => {
    const { db } = fakeDb(world())
    const real = db.from
    ;(db as any).from = (t: string) => t === 'touchpoints'
      ? { select: () => ({ in: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }) }
      : real(t)
    await expect(searchClients(db, { locationUuid: LOC_A, term: 'olive' })).rejects.toThrow(/touchpoints/)
  })

  it('the page loads EVERY open engagement for the location — the Active band does not depend on the 5,000', () => {
    const src = readFileSync('app/_hub-page.tsx', 'utf8')
    const at = src.indexOf('const engOpen: any[] = []')
    const block = src.slice(at, at + 900)
    expect(block).toContain('for (let from = 0; ; from += PAGE)')   // no ceiling
    expect(block).not.toContain('MAX_LEADS')
  })
})

// ── 6 · the cap ──────────────────────────────────────────────────────────────
describe('a capped result says so', () => {
  it('returns the newest `cap`, the exact total, and capped: true', async () => {
    const w = world()
    for (let i = 0; i < 30; i++) w.leads.push(lead({ id: `many-${String(i).padStart(2, '0')}`, name: `Many Person ${i}`, created_at: daysAgo(600 + i) }))
    const { db } = fakeDb(w)
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'many', cap: 10 })
    expect(r.people.length).toBe(10)
    expect(r.total).toBe(30)
    expect(r.capped).toBe(true)
    expect(r.people[0].id).toBe('many-00')   // newest first
    const all = await searchClients(db, { locationUuid: LOC_A, term: 'many', cap: 30 })
    expect(all.capped).toBe(false)
    expect(CLIENT_SEARCH_CAP).toBe(200)
  })

  it('olderThan spends the cap on clients the page does not hold', async () => {
    const { db, calls } = fakeDb(world())
    const r = await searchClients(db, { locationUuid: LOC_A, term: 'x.com', olderThan: CUT })
    expect(ids(r)).not.toContain('new-1')
    expect(ids(r)).not.toContain('new-2')
    expect(ids(r)).toContain('old-won')
    for (const c of calls.filter(c => c.table === 'leads')) expect(c.filters.some(f => f.startsWith('lte:created_at:'))).toBe(true)
  })
})

// ── 7 · the screen ───────────────────────────────────────────────────────────
describe('the Client List search box', () => {
  let host: HTMLDivElement, root: any, fetchMock: any
  const loadedPeople = () => [
    { id: 'new-1', name: 'Nora Newer', email: 'nora@x.com', phone: '(215) 555-0001', locationId: LOC_A, created: daysAgo(10), tagIds: [], outreachTimeline: [], importSource: 'jobber' },
    { id: 'new-2', name: 'Sam Smith', email: 'sam@x.com', phone: '(215) 555-0002', locationId: LOC_A, created: daysAgo(200), tagIds: [TAG_REALTOR], outreachTimeline: [], importSource: 'jobber' },
  ]
  const serverPerson = (over: any = {}) => ({
    id: 'old-won', name: 'Wendy Smith', email: 'wendy@x.com', phone: '610-555-1000', locationId: LOC_A, created: daysAgo(500),
    tagIds: [], outreachTimeline: [], importSource: 'jobber', wonEngagements: { count: 1, value: 900, lastClosedAt: daysAgo(450) }, ...over,
  })
  const TAGS = [{ id: TAG_REALTOR, label: 'Realtor' }]
  const mount = async (props: any = {}) => {
    await act(async () => {
      root.render(<ClientGroupedList people={loadedPeople()} engagements={[]} locFilter={LOC_A} locations={[]} tags={TAGS} searchLocationId={LOC_A} {...props} />)
    })
  }
  const type = async (value: string) => {
    const input = host.querySelector('input[aria-label="Search clients"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(CLIENT_SEARCH_DEBOUNCE_MS + 5) }) }
  const names = () => Array.from(host.querySelectorAll('.bee-grp-row p[title]')).map(p => p.getAttribute('title')).filter(t => !t!.includes('·') && !t!.includes('Realtor'))
  const band = (label: string) => host.querySelector(`[aria-label="${label} group"]`)?.parentElement as HTMLElement | undefined
  const reply = (body: any, ok = true) => fetchMock.mockImplementation(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }))

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    fetchMock = vi.fn(); (globalThis as any).fetch = fetchMock
    try { window.localStorage.clear() } catch {}
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })

  it('an empty box asks the server nothing and shows no search notices', async () => {
    reply({ people: [], total: 0, capped: false })
    await mount({ leadsTruncated: true })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid^="clients-search"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-tagfilter-partial"]')).toBeNull()
    // typed then cleared: back to nothing asked, nothing said
    await type('smith'); await type('')
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid^="clients-search"]')).toBeNull()
  })

  it('a client the page never loaded appears, in its real band, beside the loaded match', async () => {
    reply({ people: [serverPerson()], total: 1, capped: false })
    await mount({ leadsTruncated: true })
    await type('smith')
    // before the server answers: the browser filter's rows are already there
    expect(names()).toEqual(['Sam Smith'])
    await settle()
    expect(names().sort()).toEqual(['Sam Smith', 'Wendy Smith'])
    expect(band('Client')!.textContent).toContain('Wendy Smith')
    expect(band('Client')!.textContent).not.toContain('Sam Smith')
    // asked for its own location, and only for clients older than the oldest loaded
    const url = new URL(fetchMock.mock.calls[0][0], 'http://x')
    expect(url.pathname).toBe('/api/clients/search')
    expect(url.searchParams.get('q')).toBe('smith')
    expect(url.searchParams.get('location')).toBe(LOC_A)
    expect(url.searchParams.get('olderThan')).toBe(loadedPeople()[1].created)
  })

  it('a location that loaded in full sends no olderThan', async () => {
    reply({ people: [], total: 0, capped: false })
    await mount({ leadsTruncated: false })
    await type('smith'); await settle()
    expect(new URL(fetchMock.mock.calls[0][0], 'http://x').searchParams.has('olderThan')).toBe(false)
    expect(names()).toEqual(['Sam Smith'])
  })

  it('never fewer than the browser filter: an empty, failed or duplicate reply leaves its rows standing', async () => {
    await mount()
    // the server finds nothing (e.g. it disagrees) — the loaded match stays
    reply({ people: [], total: 0, capped: false })
    await type('smith'); await settle()
    expect(names()).toEqual(['Sam Smith'])
    // the server returns the loaded row again — shown once
    reply({ people: [{ ...loadedPeople()[1] }], total: 1, capped: false })
    await type('smit'); await settle()
    expect(names()).toEqual(['Sam Smith'])
    // the server fails — rows stay, and the screen says the rest was not searched
    reply({}, false)
    await type('smi'); await settle()
    expect(names()).toEqual(['Sam Smith'])
    expect(host.querySelector('[data-testid="clients-search-failed"]')!.textContent).toContain('only matches from the clients already on this screen')
  })

  it('a reply for an earlier term is not shown under a later one', async () => {
    reply({ people: [serverPerson()], total: 1, capped: false })
    await mount()
    await type('smith'); await settle()
    expect(names()).toContain('Wendy Smith')
    reply({ people: [], total: 0, capped: false })
    await type('nora')
    expect(names()).toEqual(['Nora Newer'])   // Wendy gone at once, not after the reply
  })

  it('a capped reply says how many of how many', async () => {
    reply({ people: [serverPerson()], total: 412, capped: true })
    await mount({ leadsTruncated: true })
    await type('s'); await settle()
    const note = host.querySelector('[data-testid="clients-search-capped"]')!.textContent!
    expect(note).toContain('1 of 412 older clients that match')
    expect(note).toContain('Type more')
  })

  it('a tag filter with a search narrows the server rows too, and says so when capped', async () => {
    reply({ people: [serverPerson(), serverPerson({ id: 'old-tagged', name: 'Tessa Smith', wonEngagements: null, tagIds: [TAG_REALTOR] })], total: 300, capped: true })
    await mount({ leadsTruncated: true, initialTagId: TAG_REALTOR })
    await type('smith'); await settle()
    expect(names().sort()).toEqual(['Sam Smith', 'Tessa Smith'])   // Wendy is not tagged Realtor
    expect(host.querySelector('[data-testid="clients-search-capped"]')!.textContent).toContain('Your tag filter only narrows the ones shown')
  })

  it('a tag filter alone, on a cut-off load, says it only covers the loaded clients', async () => {
    await mount({ leadsTruncated: true, initialTagId: TAG_REALTOR })
    expect(host.querySelector('[data-testid="clients-tagfilter-partial"]')!.textContent).toContain('Tag filters only look through your newest 2 clients')
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => root.unmount()); root = createRoot(host)
    await mount({ leadsTruncated: false, initialTagId: TAG_REALTOR })
    expect(host.querySelector('[data-testid="clients-tagfilter-partial"]')).toBeNull()
  })

  it('the cut-off flag is threaded from the page to the list', () => {
    const hub = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(hub).toContain('transferPeople={transferPeople} leadsTruncated={!!initialLeadsTruncated} locationRequired={!!initialAllOverview}')
    expect(hub).toContain('transferPeople={transferPeople} leadsTruncated={leadsTruncated} locationRequired={!!allOverview}')
    const shell = readFileSync('components/hive/HiveShell.jsx', 'utf8')
    expect(shell).toContain('leadsTruncated={leadsTruncated}')
    expect(shell).toContain("searchLocationId={locFilter !== 'all' ? locFilter : (currentLocationUuid || null)}")
  })
})
