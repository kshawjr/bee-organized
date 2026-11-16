// GET /api/network/list — the read behind the new Network list (slice 3).
//
// What this pins:
//   · super admins only. Every other role gets 403 and NOT ONE read of the
//     contacts is made on their behalf.
//   · it only reads: the file has one handler, GET, and no builder call that
//     writes is ever made.
//   · live contacts only, one location when asked, the caller's OWN
//     reminders, and the three new columns sent as they are stored.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const state: any = { sessionUser: null, hubUser: null, tables: {} as Record<string, any[]>, calls: [] as any[], fail: null as string | null }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', cols: '', filters: [] as any[], range: null as any }
    const b: any = {}
    b.select = (cols?: any) => { ctx.cols = cols || ''; return b }
    for (const op of ['insert', 'update', 'upsert', 'delete']) b[op] = () => { ctx.op = op; return b }
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.is = (col: string, val: any) => { ctx.filters.push(['is', col, val]); return b }
    b.in = (col: string, vals: any[]) => { ctx.filters.push(['in', col, vals]); return b }
    b.not = (col: string, op: string, val: any) => { ctx.filters.push(['not', col, op, val]); return b }
    b.order = () => b
    b.range = (from: number, to: number) => { ctx.range = [from, to]; return b }
    const resolve = () => {
      state.calls.push(ctx)
      if (client === 'session' && table === 'hub_users') return Promise.resolve({ data: state.hubUser, error: null })
      if (state.fail === table) return Promise.resolve({ data: null, error: { message: `${table} is down` } })
      let rows = (state.tables[table] || []).slice()
      for (const fl of ctx.filters) {
        if (fl[0] === 'eq') rows = rows.filter((r: any) => r[fl[1]] === fl[2])
        if (fl[0] === 'is' && fl[2] === null) rows = rows.filter((r: any) => r[fl[1]] == null)
        if (fl[0] === 'in') rows = rows.filter((r: any) => fl[2].includes(r[fl[1]]))
        if (fl[0] === 'not' && fl[2] === 'is' && fl[3] === null) rows = rows.filter((r: any) => r[fl[1]] != null)
      }
      if (ctx.range) rows = rows.slice(ctx.range[0], ctx.range[1] + 1)
      return Promise.resolve({ data: rows, error: null })
    }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
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

import * as route from '@/app/api/network/list/route'

const LOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ME = 'user-me'
const partner = (over: any = {}) => ({
  id: 'p1', location_id: LOC_A, name: 'Ann', company: 'Acme', title: null, phone: '(303) 555-0142', email: 'ann@acme.com',
  how_we_met: null, network_types: ['partner'], partner_level: 'referral', partner_stage: 'New Contact', is_customer: false,
  last_contacted_at: null, deleted_at: null, partner_tags: [{ tag_lookup_id: 't1' }], ...over,
})
const as = (role: string | null, locationId: string | null = null) => {
  h.state.sessionUser = role ? { id: ME } : null
  h.state.hubUser = role ? { id: ME, role, location_id: locationId } : null
}
const get = (qs = '') => route.GET({ nextUrl: new URL(`http://x/api/network/list${qs}`) } as any)
const serviceReads = () => h.state.calls.filter((c: any) => c.client === 'service')

beforeEach(() => {
  h.state.calls = []
  h.state.fail = null
  h.state.tables = {
    partners: [
      partner(),
      partner({ id: 'p2', name: 'Bo', location_id: LOC_B, network_types: ['vendor'], partner_level: null, partner_stage: null, partner_tags: [] }),
      partner({ id: 'p3', name: 'Gone', deleted_at: '2026-10-01T00:00:00Z' }),
      partner({ id: 'p4', name: 'Unmapped', network_types: null, partner_level: null, partner_stage: null, partner_tags: [] }),
    ],
    lookups: [{ id: 't1', label: 'Realtor' }, { id: 't9', label: 'Unused' }],
    locations: [{ id: LOC_A, name: 'Greensboro' }, { id: LOC_B, name: 'Seattle' }],
    reminders: [
      { partner_id: 'p1', due_on: '2026-11-20', user_id: ME, done_at: null },
      { partner_id: 'p1', due_on: '2026-11-12', user_id: ME, done_at: null },
      { partner_id: 'p2', due_on: '2026-11-01', user_id: 'someone-else', done_at: null },
      { partner_id: 'p2', due_on: '2026-11-02', user_id: ME, done_at: '2026-11-03T00:00:00Z' },
      { partner_id: null, lead_id: 'l1', due_on: '2026-11-01', user_id: ME, done_at: null },
      { partner_id: 'p3', due_on: '2026-11-01', user_id: ME, done_at: null },
    ],
  }
})

describe('who may read it', () => {
  it('nobody signed in: 401', async () => {
    as(null)
    expect((await get()).status).toBe(401)
    expect(serviceReads()).toEqual([])
  })
  it.each([['owner', LOC_A], ['manager', LOC_A], ['lite_user', LOC_A], ['admin', null]])('%s: 403, and no contact is read for them', async (role, loc) => {
    as(role, loc)
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(serviceReads()).toEqual([])
  })
  it("an owner asking for their OWN location is still 403: the list is not theirs yet", async () => {
    as('owner', LOC_A)
    expect((await get(`?location_id=${LOC_A}`)).status).toBe(403)
    expect(serviceReads()).toEqual([])
  })
  it('super admin: 200', async () => {
    as('super_admin')
    expect((await get()).status).toBe(200)
  })
})

describe('it only reads', () => {
  it('the route file has one handler, GET, and no other export', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'runtime'])
  })
  it('makes no call that writes, in either scope', async () => {
    as('super_admin')
    await get()
    await get(`?location_id=${LOC_A}`)
    expect(h.state.calls.length).toBeGreaterThan(0)
    expect(h.state.calls.map((c: any) => c.op).filter((op: string) => op !== 'select')).toEqual([])
  })
  it('names no write in its source', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/network/list/route.ts'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/)
    expect(src).not.toMatch(/export async function (POST|PATCH|PUT|DELETE)/)
  })
  it('reads only partners, lookups, locations and reminders', async () => {
    as('super_admin')
    await get()
    expect(Array.from(new Set(serviceReads().map((c: any) => c.table))).sort()).toEqual(['locations', 'lookups', 'partners', 'reminders'])
  })
})

describe('what it sends', () => {
  it('every location: the live contacts, never a deleted one', async () => {
    as('super_admin')
    const json = await (await get()).json()
    expect(json.contacts.map((c: any) => c.id)).toEqual(['p1', 'p2', 'p4'])
    expect(json.total).toBe(3)
    expect(json.truncated).toBe(false)
    expect(serviceReads().find((c: any) => c.table === 'partners').filters).toContainEqual(['is', 'deleted_at', null])
  })
  it('one location when asked', async () => {
    as('super_admin')
    const json = await (await get(`?location_id=${LOC_B}`)).json()
    expect(json.contacts.map((c: any) => c.id)).toEqual(['p2'])
  })
  it('a location id that is not an id: 400, nothing read', async () => {
    as('super_admin')
    expect((await get('?location_id=all')).status).toBe(400)
    expect(serviceReads()).toEqual([])
  })
  it('the three new columns exactly as stored, empty included', async () => {
    as('super_admin')
    const { contacts } = await (await get()).json()
    expect(contacts[0]).toMatchObject({ networkTypes: ['partner'], partnerLevel: 'referral', partnerStage: 'New Contact', locationName: 'Greensboro', tagIds: ['t1'] })
    expect(contacts[1]).toMatchObject({ networkTypes: ['vendor'], partnerLevel: null, partnerStage: null, locationName: 'Seattle' })
    expect(contacts[2]).toMatchObject({ id: 'p4', networkTypes: null, partnerLevel: null, partnerStage: null })
  })
  it('asks the database for the new columns by name', async () => {
    as('super_admin')
    await get()
    const cols = serviceReads().find((c: any) => c.table === 'partners').cols
    for (const col of ['network_types', 'partner_level', 'partner_stage']) expect(cols).toContain(col)
    expect(cols).not.toContain('*')
  })
  it('names only the tags these contacts carry', async () => {
    as('super_admin')
    expect((await (await get()).json()).tags).toEqual([{ id: 't1', label: 'Realtor' }])
  })
  it("follow-ups are the caller's own open reminders on these contacts, the soonest per contact", async () => {
    as('super_admin')
    const json = await (await get()).json()
    // p1: the caller's two, soonest wins. p2: someone else's, and a done one. p3: deleted contact.
    expect(json.followUps).toEqual({ p1: '2026-11-12' })
    const rem = serviceReads().find((c: any) => c.table === 'reminders')
    expect(rem.filters).toContainEqual(['eq', 'user_id', ME])
    expect(rem.filters).toContainEqual(['is', 'done_at', null])
  })
  it('a database error is said, not hidden behind an empty list', async () => {
    as('super_admin')
    h.state.fail = 'partners'
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'partners is down' })
  })
})
