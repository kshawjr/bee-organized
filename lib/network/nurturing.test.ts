// Slice 7: the Nurturing rule (lib/network/nurturing.ts), its reads
// (lib/network/nurturing-read.ts) and its two routes, against a fake
// database that records every call and refuses every write.
//
// What this file pins (the brief's list, where it can be pinned in code):
//   · the rule, clause by clause, and the SQL built from the same numbers
//   · 18,826 people at one location are read in pages and only one page
//     goes to the browser
//   · nothing here writes: only selects reach the database
//   · the 90 days is one value, and it moves the verdict and the SQL
//   · someone with no email and no phone is listed and flagged
//   · super admins only
//
// The proof that code and SQL agree on every one of the 52 locations was
// run against production (reads only) and is recorded in the slice 7
// report; it cannot run here without production.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NURTURING_QUIET_DAYS, NURTURING_MIN_AGE_DAYS, addressLine, assessmentAt, quoteAt, foldActivity, nurturingVerdict, nurturingSql,
  needsContactInfo, searchNurture, sortNurture, nurtureName, nurturingCutoffs,
} from './nurturing'

const NOW = new Date('2026-11-20T03:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString()
const lead = (over: any = {}) => ({ id: 'L1', created_at: daysAgo(400), archived_at: null, is_junk: false, email: 'a@b.com', phone: null, ...over })
const fold = (a: any[] = [], q: any[] = [], j: any[] = []) => foldActivity(a, q, j)
const v = (l: any, act = fold(), quiet?: number) => nurturingVerdict(l, act, NOW, quiet)

describe('Kevin\'s rule, clause by clause', () => {
  it('the settings are the brief\'s: 90 days quiet, 30 days old', () => {
    expect(NURTURING_QUIET_DAYS).toBe(90)
    expect(NURTURING_MIN_AGE_DAYS).toBe(30)
  })
  it('a person with nothing, added long ago, is Nurturing', () => {
    expect(v(lead())).toMatchObject({ nurturing: true, why: null, lastActivity: null })
  })
  it('1. never had a job: any job takes them out, a deleted one does not', () => {
    expect(v(lead(), fold([], [], [{ lead_id: 'L1', status: 'completed' }]))).toMatchObject({ nurturing: false, why: 'had_job' })
    expect(v(lead(), fold([], [], [{ lead_id: 'L1', status: 'action_required' }]))).toMatchObject({ nurturing: false, why: 'had_job' })
    expect(v(lead(), fold([], [], [{ lead_id: 'L1', status: 'deleted' }]))).toMatchObject({ nurturing: true })
  })
  it('2. an assessment or quote inside 90 days takes them out; older than 90 keeps them in', () => {
    expect(v(lead(), fold([{ lead_id: 'L1', created_at: daysAgo(89) }]))).toMatchObject({ nurturing: false, why: 'recent_activity' })
    expect(v(lead(), fold([{ lead_id: 'L1', created_at: daysAgo(91) }]))).toMatchObject({ nurturing: true, lastActivity: { kind: 'assessment' } })
    expect(v(lead(), fold([], [{ lead_id: 'L1', status: 'sent', created_at: daysAgo(200), sent_at: daysAgo(60) }]))).toMatchObject({ nurturing: false, why: 'recent_activity' })
    expect(v(lead(), fold([], [{ lead_id: 'L1', status: 'approved', created_at: daysAgo(200), sent_at: daysAgo(120) }]))).toMatchObject({ nurturing: true, lastActivity: { kind: 'quote', at: daysAgo(120) } })
  })
  it('2. the dates: assessment = latest of completed, scheduled, created; quote = latest of sent, created', () => {
    expect(assessmentAt({ lead_id: 'x', created_at: daysAgo(300), scheduled_at: daysAgo(10), completed_at: daysAgo(200) })).toBe(daysAgo(10))
    expect(assessmentAt({ lead_id: 'x', created_at: daysAgo(300), scheduled_at: null, completed_at: daysAgo(5) })).toBe(daysAgo(5))
    expect(quoteAt({ lead_id: 'x', status: 'sent', created_at: daysAgo(10), sent_at: daysAgo(100) })).toBe(daysAgo(10))
    // a future-scheduled assessment holds them out until 90 days after it
    expect(v(lead(), fold([{ lead_id: 'L1', created_at: daysAgo(300), scheduled_at: daysAgo(-5) }]))).toMatchObject({ nurturing: false, why: 'recent_activity' })
  })
  it('2. a draft quote does not count at all, however recent', () => {
    expect(quoteAt({ lead_id: 'x', status: 'draft', created_at: daysAgo(1) })).toBeNull()
    expect(v(lead(), fold([], [{ lead_id: 'L1', status: 'draft', created_at: daysAgo(1), sent_at: null }]))).toMatchObject({ nurturing: true, lastActivity: null })
  })
  it('2. a bare request does not count: requests are not even read by the rule', () => {
    expect(foldActivity.length).toBe(3)
    expect(nurturingSql()).not.toMatch(/service_requests/)
  })
  it('3. created in the last 30 days: not yet', () => {
    expect(v(lead({ created_at: daysAgo(29) }))).toMatchObject({ nurturing: false, why: 'too_new' })
    expect(v(lead({ created_at: daysAgo(31) }))).toMatchObject({ nurturing: true })
    expect(v(lead({ created_at: null }))).toMatchObject({ nurturing: false, why: 'too_new' })
  })
  it('4. archived or junk: out', () => {
    expect(v(lead({ archived_at: daysAgo(3) }))).toMatchObject({ nurturing: false, why: 'archived' })
    expect(v(lead({ is_junk: true }))).toMatchObject({ nurturing: false, why: 'junk' })
    expect(v(lead({ is_junk: null }))).toMatchObject({ nurturing: true })
  })
  it('no email and no phone: STILL IN, flagged', () => {
    const r = v(lead({ email: '  ', phone: null }))
    expect(r).toMatchObject({ nurturing: true, needsContactInfo: true })
    expect(needsContactInfo({ email: null, phone: '(303) 555-0100' })).toBe(false)
    expect(needsContactInfo({ email: 'x@y.z', phone: '' })).toBe(false)
  })
  it('the 90 days is one value: changing it changes the verdict and the SQL', () => {
    const act = fold([{ lead_id: 'L1', created_at: daysAgo(75) }])
    expect(v(lead(), act).nurturing).toBe(false)
    expect(v(lead(), act, 60).nurturing).toBe(true)
    expect(nurturingSql()).toContain(`interval '${NURTURING_QUIET_DAYS} days'`)
    expect(nurturingSql(60)).toContain("interval '60 days'")
    expect(nurturingSql(60)).not.toContain("interval '90 days'")
    expect(nurturingCutoffs(NOW, 60).quietBefore).toBe(daysAgo(60))
  })
  it('the SQL carries every clause the code does', () => {
    const s = nurturingSql()
    expect(s).toMatch(/status is distinct from 'deleted'/)
    expect(s).toMatch(/status is distinct from 'draft'/)
    expect(s).toMatch(/greatest\(completed_at, scheduled_at, created_at\)/)
    expect(s).toMatch(/greatest\(sent_at, created_at\)/)
    expect(s).toMatch(/archived_at is null/)
    expect(s).toMatch(/is_junk is not true/)
    expect(s).toContain(`interval '${NURTURING_MIN_AGE_DAYS} days'`)
    expect(s).toMatch(/^with /)
    expect(s).not.toMatch(/\b(insert|update|delete|upsert|alter|drop|create)\b/i)
  })
})

describe('search, sort, names', () => {
  const rows = [
    { id: 'b', name: 'Beth Ames', email: 'beth@x.com', phone: '(215) 555-0101', city: 'Media', zip: '19063', createdAt: daysAgo(100), needsContactInfo: false, lastActivity: null },
    { id: 'a', name: 'aaron Zed', email: null, phone: null, city: 'Wayne', zip: '19087', createdAt: daysAgo(50), needsContactInfo: true, lastActivity: { at: daysAgo(200), kind: 'quote' as const } },
    { id: 'c', name: 'Cal Moss', email: 'cal@y.com', phone: '610-555-0199', city: null, zip: null, createdAt: daysAgo(900), needsContactInfo: false, lastActivity: { at: daysAgo(100), kind: 'assessment' as const } },
  ]
  it('finds by name, email, town, zip and phone digits however they are typed', () => {
    expect(searchNurture(rows, 'beth').map((r) => r.id)).toEqual(['b'])
    expect(searchNurture(rows, 'WAYNE').map((r) => r.id)).toEqual(['a'])
    expect(searchNurture(rows, '19063').map((r) => r.id)).toEqual(['b'])
    expect(searchNurture(rows, '5550199').map((r) => r.id)).toEqual(['c'])
    expect(searchNurture(rows, '(215) 555').map((r) => r.id)).toEqual(['b'])
    expect(searchNurture(rows, 'nobody-here')).toEqual([])
    expect(searchNurture(rows, '   ')).toHaveLength(3)
  })
  it('sorts four ways', () => {
    expect(sortNurture(rows, 'az').map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(sortNurture(rows, 'newest').map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(sortNurture(rows, 'oldest').map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(sortNurture(rows, 'quoted').map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })
  it('stray punctuation at the ends of a name is not shown and does not sort first (found on Philadelphia\'s first page)', () => {
    expect(nurtureName({ name: ', Bernadette Gruszka' })).toBe('Bernadette Gruszka')
    expect(nurtureName({ name: '. Openaker' })).toBe('Openaker')
    expect(nurtureName({ name: "Mary-Kate O'Neil" })).toBe("Mary-Kate O'Neil")
    const r = (id: string, name: string) => ({ id, name: nurtureName({ name }), email: null, phone: null, city: null, zip: null, createdAt: daysAgo(40), needsContactInfo: false, lastActivity: null })
    expect(sortNurture([r('1', 'Bob'), r('2', ', Al')], 'az').map((x) => x.id)).toEqual(['2', '1'])
  })
  it('an address never says the town or zip twice (some imports hold the whole line in the street field)', () => {
    expect(addressLine('229 Chatham Way, West Chester, Pennsylvania, 19380', 'West Chester, Pennsylvania 19380', '19380')).toBe('229 Chatham Way, West Chester, Pennsylvania, 19380')
    expect(addressLine('98126', '98126', '98126')).toBe('98126')
    expect(addressLine('12 Elm St', 'Media, PA 19063', '19063')).toBe('12 Elm St, Media, PA 19063')
    expect(addressLine(null, 'Media, PA 19063')).toBe('Media, PA 19063')
    expect(addressLine(null, null)).toBeNull()
  })
  it('a row always has something to call them', () => {
    expect(nurtureName({ name: ' ', first_name: 'Jo', last_name: 'Ray' })).toBe('Jo Ray')
    expect(nurtureName({ name: null, email: 'z@z.z' })).toBe('z@z.z')
    expect(nurtureName({})).toBe('No name')
  })
})

// ── the reads and routes, on a fake database ─────────────────
const h = vi.hoisted(() => ({ state: { calls: [] as any[], tables: {} as Record<string, any[]>, hubUser: null as any, sessionUser: null as any } }))
function builder(table: string) {
  const c: any = { table, op: 'select', filters: [] as any[], range: null as any, head: false, limit: null as any }
  const b: any = {}
  b.select = (_cols: string, opts?: any) => { if (opts?.head) c.head = true; return b }
  for (const op of ['insert', 'update', 'upsert', 'delete']) b[op] = () => { c.op = op; throw new Error(`WRITE ${op} on ${table}`) }
  b.rpc = () => { throw new Error('rpc') }
  b.eq = (k: string, val: any) => { c.filters.push((r: any) => r[k] === val); return b }
  b.is = (k: string, val: any) => { c.filters.push((r: any) => (val === null ? r[k] == null : r[k] === val)); return b }
  b.not = (k: string, op: string, val: any) => { if (op === 'is' && val === true) c.filters.push((r: any) => r[k] !== true); return b }
  b.lt = (k: string, val: any) => { c.filters.push((r: any) => r[k] != null && r[k] < val); return b }
  b.in = (k: string, vals: any[]) => { c.filters.push((r: any) => vals.includes(r[k])); return b }
  b.order = () => b
  b.limit = (n: number) => { c.limit = n; return b }
  b.range = (a: number, z: number) => { c.range = [a, z]; return b }
  const run = () => {
    h.state.calls.push(c)
    if (table === 'hub_users') return { data: h.state.hubUser, error: null }
    let rows = (h.state.tables[table] || []).filter((r) => c.filters.every((f: any) => f(r)))
    rows.sort((x: any, y: any) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    if (c.head) return { data: null, count: rows.length, error: null }
    if (c.range) rows = rows.slice(c.range[0], c.range[1] + 1)
    if (c.limit != null) rows = rows.slice(0, c.limit)
    return { data: rows, error: null }
  }
  b.maybeSingle = async () => { const r = run(); return { data: (r.data as any[])?.[0] ?? null, error: null } }
  b.single = async () => run()
  b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
  return b
}
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => builder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.state.sessionUser } }) }, from: (t: string) => builder(t) }),
}))

import * as listRoute from '@/app/api/network/nurturing/route'
import * as personRoute from '@/app/api/network/nurturing/[id]/route'
import { clearNurtureCache, loadNurturingList } from './nurturing-read'

const PHILLY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const as = (role: string | null) => { h.state.sessionUser = role ? { id: 'me' } : null; h.state.hubUser = role ? { id: 'me', role, location_id: null } : null }
const getList = (qs: string) => listRoute.GET({ nextUrl: new URL(`http://x/api/network/nurturing?${qs}`) } as any)
const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

function seedPhilly(count: number) {
  const leads: any[] = []
  for (let i = 0; i < count; i++) leads.push({ id: pid(i), location_uuid: PHILLY, location_id: 'loc_phillysuburbs', name: `Person ${String(i).padStart(5, '0')}`, email: `p${i}@x.com`, phone: null, created_at: '2025-01-01T00:00:00Z', archived_at: null, is_junk: false })
  return leads
}

beforeEach(() => {
  clearNurtureCache()
  h.state.calls = []
  as('super_admin')
  const leads = [
    ...seedPhilly(30),
    { id: pid(900), location_uuid: PHILLY, location_id: 'loc_phillysuburbs', name: 'No Contact', email: '', phone: null, created_at: '2025-01-01T00:00:00Z', archived_at: null, is_junk: false },
    { id: pid(901), location_uuid: PHILLY, location_id: 'loc_phillysuburbs', name: 'Had Job', email: 'j@x.com', created_at: '2025-01-01T00:00:00Z', archived_at: null, is_junk: false },
    { id: pid(902), location_uuid: PHILLY, location_id: 'loc_phillysuburbs', name: 'Junk', email: 'k@x.com', created_at: '2025-01-01T00:00:00Z', archived_at: null, is_junk: true },
    { id: pid(903), location_uuid: PHILLY, location_id: 'loc_phillysuburbs', name: 'Fresh Quote', email: 'f@x.com', created_at: '2025-01-01T00:00:00Z', archived_at: null, is_junk: null },
    { id: pid(904), location_uuid: OTHER, location_id: 'loc_other', name: 'Elsewhere', email: 'e@x.com', created_at: '2025-01-01T00:00:00Z', archived_at: null, is_junk: false },
  ]
  h.state.tables = {
    locations: [{ id: PHILLY, slug: 'loc_phillysuburbs', name: 'Philadelphia Suburbs' }, { id: OTHER, slug: 'loc_other', name: 'Other' }],
    leads,
    jobs: [{ id: 'j1', lead_id: pid(901), location_id: 'loc_phillysuburbs', status: 'completed' }],
    quotes: [{ id: 'q1', lead_id: pid(903), location_id: 'loc_phillysuburbs', status: 'sent', created_at: new Date().toISOString(), sent_at: null }],
    assessments: [],
  }
})

describe('the list route', () => {
  it('lists the Nurturing people at ONE location, flags no-contact, leaves out job, junk, recent and other locations', async () => {
    const res = await getList(`location_id=${PHILLY}&size=100`)
    expect(res.status).toBe(200)
    const j = await res.json()
    const names = j.rows.map((r: any) => r.name)
    expect(j.total).toBe(31)
    expect(names).toContain('No Contact')
    expect(j.rows.find((r: any) => r.name === 'No Contact').needsContactInfo).toBe(true)
    for (const out of ['Had Job', 'Junk', 'Fresh Quote', 'Elsewhere']) expect(names).not.toContain(out)
    expect(j.counts).toEqual({ nurturing: 31, needsContactInfo: 1, hadQuoteOrAssessment: 0 })
    expect(j.quietDays).toBe(NURTURING_QUIET_DAYS)
    expect(j.location).toEqual({ id: PHILLY, name: 'Philadelphia Suburbs' })
  })
  it('the "Needs contact info" filter finds them', async () => {
    const j = await (await getList(`location_id=${PHILLY}&needs_contact=1`)).json()
    expect(j.rows.map((r: any) => r.name)).toEqual(['No Contact'])
    expect(j.total).toBe(1)
  })
  it('reads leads by location_uuid and activity by the location\'s slug, never the other way round', async () => {
    await getList(`location_id=${PHILLY}`)
    const tables = h.state.calls.map((c) => c.table)
    expect(tables).toEqual(expect.arrayContaining(['locations', 'leads', 'assessments', 'quotes', 'jobs']))
    // the location in the other table is never touched
    const j = await (await getList(`location_id=${OTHER}`)).json()
    expect(j.rows.map((r: any) => r.name)).toEqual(['Elsewhere'])
  })
  it('a slug, a missing or a junk location id is refused', async () => {
    expect((await getList('location_id=loc_phillysuburbs')).status).toBe(400)
    expect((await getList('')).status).toBe(400)
    expect((await getList('location_id=cccccccc-cccc-4ccc-8ccc-cccccccccccc')).status).toBe(404)
  })
  it('super admins only: owner, manager, read-only and corporate get 403; nobody signed in gets 401', async () => {
    for (const role of ['owner', 'manager', 'lite_user', 'admin']) {
      as(role)
      expect((await getList(`location_id=${PHILLY}`)).status, role).toBe(403)
      expect((await personRoute.GET({} as any, { params: Promise.resolve({ id: pid(1) }) })).status, role).toBe(403)
    }
    as(null)
    expect((await getList(`location_id=${PHILLY}`)).status).toBe(401)
  })
  it('pages: the page asked for, clamped to the last page, never more rows than the size', async () => {
    const j = await (await getList(`location_id=${PHILLY}&size=10&page=2`)).json()
    expect(j.rows).toHaveLength(10)
    expect(j.page).toBe(2)
    const last = await (await getList(`location_id=${PHILLY}&size=10&page=999`)).json()
    expect(last.page).toBe(3)
    expect(last.rows).toHaveLength(1)
    const odd = await (await getList(`location_id=${PHILLY}&size=7`)).json()
    expect(odd.size).toBe(25)
  })
  it('search with no results answers an empty page, not an error', async () => {
    const j = await (await getList(`location_id=${PHILLY}&q=zzzz`)).json()
    expect(j).toMatchObject({ total: 0, page: 0, rows: [] })
  })
})

describe('18,826 people at one location', () => {
  it('are read in pages of at most 1,000, and only one page is sent', async () => {
    h.state.tables.leads = seedPhilly(18826)
    h.state.tables.jobs = []; h.state.tables.quotes = []
    const t0 = Date.now()
    const res = await getList(`location_id=${PHILLY}&size=25&page=0`)
    const j = await res.json()
    const ms = Date.now() - t0
    expect(j.total).toBe(18826)
    expect(j.rows).toHaveLength(25)
    expect(j.rows[0].name).toBe('Person 00000')
    const leadReads = h.state.calls.filter((c) => c.table === 'leads' && !c.head)
    expect(leadReads.length).toBe(20) // 19 full pages + the read that finds the end
    for (const c of leadReads) expect(c.range[1] - c.range[0] + 1).toBeLessThanOrEqual(1000)
    expect(JSON.stringify(j).length).toBeLessThan(20_000)
    expect(ms).toBeLessThan(5000)
    // The last page: page 754 of 754 holds the last one person.
    const last = await (await getList(`location_id=${PHILLY}&size=25&page=753`)).json()
    expect(last.rows).toHaveLength(1)
    expect(last.rows[0].name).toBe('Person 18825')
    // …and turning the page did not read 18,826 people again.
    expect(h.state.calls.filter((c) => c.table === 'leads' && !c.head).length).toBe(20)
  })
  it('a person added between the count and the pages is still read', async () => {
    h.state.tables.leads = seedPhilly(1000)
    h.state.tables.jobs = []; h.state.tables.quotes = []
    const real = h.state.tables.leads
    let counted = false
    const orig = builder
    // the count says 1,000; the pages then find 1,001
    const list = await loadNurturingList({
      from: (t: string) => {
        const b = orig(t)
        if (t === 'leads' && !counted) { counted = true; real.push({ ...real[0], id: pid(99999), name: 'Late Arrival' }) }
        return b
      },
    }, { id: PHILLY, slug: 'loc_phillysuburbs', name: 'P' }, { useCache: false })
    expect(list.rows.map((r) => r.name)).toContain('Late Arrival')
    expect(list.rows).toHaveLength(1001)
  })
})

describe('one person', () => {
  it('opens a lead with its own fields and the rule\'s verdict, and reads no partner table', async () => {
    h.state.tables.assessments = [{ id: 'a1', lead_id: pid(1), status: 'completed', created_at: '2025-03-01T00:00:00Z', scheduled_at: '2025-03-02T00:00:00Z', completed_at: '2025-03-02T00:00:00Z' }]
    h.state.tables.quotes.push({ id: 'q2', lead_id: pid(1), status: 'draft', created_at: new Date().toISOString(), total: 900 })
    const res = await personRoute.GET({} as any, { params: Promise.resolve({ id: pid(1) }) })
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.person.name).toBe('Person 00001')
    expect(j.verdict).toMatchObject({ nurturing: true, lastActivity: { kind: 'assessment' } })
    expect(j.quotes[0]).toMatchObject({ status: 'draft', counts: false })
    expect(j.quietDays).toBe(NURTURING_QUIET_DAYS)
    expect(h.state.calls.map((c) => c.table)).not.toContain('partners')
    expect(h.state.calls.map((c) => c.table)).not.toContain('partner_tags')
  })
  it('not a uuid: 400; nobody by that id: 404', async () => {
    expect((await personRoute.GET({} as any, { params: Promise.resolve({ id: 'x' }) })).status).toBe(400)
    expect((await personRoute.GET({} as any, { params: Promise.resolve({ id: pid(55555) }) })).status).toBe(404)
  })
})

describe('nothing in this slice writes', () => {
  it('every database call the routes made was a read', async () => {
    await getList(`location_id=${PHILLY}`)
    await personRoute.GET({} as any, { params: Promise.resolve({ id: pid(1) }) })
    expect(h.state.calls.length).toBeGreaterThan(5)
    expect(h.state.calls.every((c) => c.op === 'select')).toBe(true)
  })
  const FILES = [
    'lib/network/nurturing.ts', 'lib/network/nurturing-read.ts',
    'app/api/network/nurturing/route.ts', 'app/api/network/nurturing/[id]/route.ts',
    'components/network/NurturingScreen.jsx', 'components/network/NurtureSheet.jsx', 'components/network/NetworkTabs.jsx',
  ]
  const code = (f: string) => readFileSync(join(process.cwd(), f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  it('by fingerprint: no write verb, no database function, no POST/PATCH/DELETE in any slice 7 file', () => {
    for (const f of FILES) {
      const s = code(f)
      expect(s, f).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/)
      expect(s, f).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i)
    }
  })
  it('the routes export GET and nothing that writes', () => {
    expect(Object.keys(listRoute).filter((k) => /^(GET|POST|PATCH|PUT|DELETE)$/.test(k))).toEqual(['GET'])
    expect(Object.keys(personRoute).filter((k) => /^(GET|POST|PATCH|PUT|DELETE)$/.test(k))).toEqual(['GET'])
  })
  it('the 90 is typed in exactly one place: the rule file', () => {
    for (const f of FILES.filter((x) => x !== 'lib/network/nurturing.ts')) expect(code(f), f).not.toMatch(/\b90\b/)
    expect(code('lib/network/nurturing.ts').match(/\b90\b/g)).toHaveLength(1)
  })
})

describe('the Clients Nurturing band is untouched', () => {
  // Byte for byte what they were at 8fd6ba7, the tip this slice started on.
  // Slice 9 removes the band; until then both places show these people.
  const sha = (f: string) => require('node:crypto').createHash('sha256').update(readFileSync(join(process.cwd(), f))).digest('hex')
  it.each([
    ['components/hive/ClientGroupedList.jsx', '1fc2b08317a73fbd5ed9c7e27c8905597e3d863de8b972694963d5db20904aae'],
    ['components/hive/shared/clientStatus.js', '07b76c1cbba5abed47b4fe22b738d8f14c355ad3b5ae2e625184ba53a14eb0d2'],
    ['app/api/clients/browse/route.ts', '83c87bc084c60b112796f26b0f9fabe71a172106924a00f970c3d3a03ae164ba'],
    ['lib/hub-working-clients.ts', '1f0256023aa65f756c11e86602f46242b848a65e53361abf99cae043cb05a5b1'],
  ])('%s', (f, want) => { expect(sha(f)).toBe(want) })
})
