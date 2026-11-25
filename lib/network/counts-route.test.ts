// GET /api/network/counts — the two numbers on the Network & Nurture tabs
// (Kevin, 2026-11-25: "Network & Partners (100)", "Nurturing Clients (5,037)").
//
// What this pins:
//   · the Network number is a head-only exact count on the server, never the
//     length of fetched rows: a Supabase read stops at 1,000 rows. The fake
//     below answers a head count with a number far past 1,000 and hands back
//     NO rows, so a route that counted rows would say 0.
//   · live contacts only (deleted_at is null), one location when asked.
//   · the Nurturing number is the rule's own count (loadNurturingList), for
//     one location; on All locations it is null.
//   · super admins only; it only reads.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const state: any = { sessionUser: null, hubUser: null, calls: [] as any[], headCount: 0, fail: false, nurturing: 0, nurtureCalls: [] as any[] }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', cols: '', opts: null, filters: [] as any[] }
    const b: any = {}
    b.select = (cols?: any, opts?: any) => { ctx.cols = cols || ''; ctx.opts = opts || null; return b }
    for (const op of ['insert', 'update', 'upsert', 'delete']) b[op] = () => { ctx.op = op; return b }
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.is = (col: string, val: any) => { ctx.filters.push(['is', col, val]); return b }
    b.order = () => b
    b.range = () => b
    const resolve = () => {
      state.calls.push(ctx)
      if (client === 'session' && table === 'hub_users') return Promise.resolve({ data: state.hubUser, error: null })
      if (state.fail) return Promise.resolve({ data: null, count: null, error: { message: `${table} is down` } })
      if (ctx.opts?.head) return Promise.resolve({ data: null, count: state.headCount, error: null })
      return Promise.resolve({ data: [], count: null, error: null })
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
vi.mock('@/lib/network/nurturing-read', () => ({
  nurtureLocation: async (_db: any, id: string) => ({ id, slug: 'loc_a', name: 'Philadelphia Suburbs' }),
  loadNurturingList: async (_db: any, loc: any) => { h.state.nurtureCalls.push(loc.id); return { rows: [], counts: { nurturing: h.state.nurturing, needsContactInfo: 0, hadQuoteOrAssessment: 0 }, readMs: 0, peopleRead: 0 } },
}))

import * as route from '@/app/api/network/counts/route'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const as = (role: string | null) => {
  h.state.sessionUser = role ? { id: 'me' } : null
  h.state.hubUser = role ? { id: 'me', role, location_id: null } : null
}
const get = (qs = '') => route.GET({ nextUrl: new URL(`http://x/api/network/counts${qs}`) } as any)
const partnerReads = () => h.state.calls.filter((c: any) => c.client === 'service' && c.table === 'partners')

beforeEach(() => {
  h.state.calls = []; h.state.nurtureCalls = []; h.state.fail = false
  h.state.headCount = 4321; h.state.nurturing = 5037
})

describe('GET /api/network/counts', () => {
  it('one location: the Network count is a head-only exact count of live contacts there, and Nurturing is the rule’s count', async () => {
    as('super_admin')
    const res = await get(`?location_id=${LOC}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ network: 4321, nurturing: 5037 })
    const reads = partnerReads()
    expect(reads).toHaveLength(1)
    expect(reads[0].opts).toEqual({ count: 'exact', head: true })
    expect(reads[0].filters).toEqual(expect.arrayContaining([['is', 'deleted_at', null], ['eq', 'location_id', LOC]]))
    expect(h.state.nurtureCalls).toEqual([LOC])
  })

  it('All locations: every live contact, and no Nurturing number (that tab is one location only)', async () => {
    as('super_admin')
    const res = await get()
    expect(await res.json()).toEqual({ network: 4321, nurturing: null })
    expect(partnerReads()[0].filters).toEqual([['is', 'deleted_at', null]])
    expect(h.state.nurtureCalls).toEqual([])
  })

  it('a failed read answers 500, so the tabs show no number rather than a wrong one', async () => {
    as('super_admin'); h.state.fail = true
    expect((await get(`?location_id=${LOC}`)).status).toBe(500)
  })

  for (const role of ['admin', 'owner', 'manager', 'lite_user']) {
    it(`${role} → 403, and nothing is counted for them`, async () => {
      as(role)
      expect((await get(`?location_id=${LOC}`)).status).toBe(403)
      expect(h.state.calls.filter((c: any) => c.client === 'service')).toEqual([])
      expect(h.state.nurtureCalls).toEqual([])
    })
  }

  it('signed out → 401; a bad location id → 400', async () => {
    as(null)
    expect((await get()).status).toBe(401)
    as('super_admin')
    expect((await get('?location_id=nope')).status).toBe(400)
  })

  it('only reads: one GET handler, no write anywhere', async () => {
    const src = readFileSync(join(process.cwd(), 'app/api/network/counts/route.ts'), 'utf8')
    expect(src.match(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)).toEqual(['export async function GET'])
    as('super_admin')
    await get(`?location_id=${LOC}`)
    expect(h.state.calls.filter((c: any) => c.op !== 'select')).toEqual([])
  })
})
