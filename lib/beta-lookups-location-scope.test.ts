// Tag system 2A — location-aware lookups.
//
// /api/lookups GET returns corporate (location_id null) + AT MOST the
// caller's own location's rows — never another location's: owners are
// pinned to their hub_users location (the location_id param is ignored
// for them); admins scope via the param (no param → corporate only).
//
// /api/lookups POST grows a location-owned create path (PickerModal
// allowCreate): owner for own location only, location-scoped categories
// only, duplicate labels rejected against corporate + that location.
//
// /api/lead-tags POST rejects a lookup owned by a DIFFERENT location
// than the lead's — corporate or the lead's own, nothing else.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { hubUser: null, sessionUser: null, respond: (_ctx: any) => ({ data: null, error: null }), calls: [] as any[] }
  const reset = () => { state.calls = [] }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', filters: [] as any[], payload: null }
    const b: any = {}
    b.select = (_cols?: any, _opts?: any) => b
    b.insert = (payload: any) => { ctx.op = 'insert'; ctx.payload = payload; return b }
    b.upsert = (payload: any, _opts?: any) => { ctx.op = 'upsert'; ctx.payload = payload; return b }
    b.update = (payload: any) => { ctx.op = 'update'; ctx.payload = payload; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.is = (col: string, val: any) => { ctx.filters.push(['is', col, val]); return b }
    b.in = (col: string, vals: any[]) => { ctx.filters.push(['in', col, vals]); return b }
    b.or = (raw: string) => { ctx.filters.push(['or', raw]); return b }
    b.ilike = (col: string, val: any) => { ctx.filters.push(['ilike', col, val]); return b }
    b.order = () => b
    b.limit = () => b
    const resolve = () => {
      state.calls.push(ctx)
      return Promise.resolve(state.respond(ctx))
    }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t, 'service') },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.sessionUser } }) },
    from: (t: string) => h.makeBuilder(t, 'session'),
  }),
}))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => {}),
  getHubUser: vi.fn(async () => h.state.hubUser),
  isAdmin: (role: string) => role === 'super_admin' || role === 'admin',
}))
vi.mock('@/lib/read-only-access', () => ({
  readOnlyWriteBlock: vi.fn(async () => null),
}))

import { GET as lookupsGET, POST as lookupsPOST } from '@/app/api/lookups/route'
import { POST as leadTagsPOST } from '@/app/api/lead-tags/route'

const LOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const f = (ctx: any, kind: string) => ctx.filters.find((x: any[]) => x[0] === kind)
const lookupsCtx = () => h.state.calls.find((c: any) => c.table === 'lookups')

const getReq = (qs = '') => new Request(`http://test.local/api/lookups${qs}`) as any
const postReq = (url: string, body: any) =>
  new Request(`http://test.local${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as any

beforeEach(() => {
  h.reset()
  h.state.hubUser = null
  h.state.sessionUser = { id: 'user-1' }
  h.state.respond = () => ({ data: [], error: null })
})

// ─── GET scoping ─────────────────────────────────────────────────
describe('/api/lookups GET — corporate + the caller\'s own location only', () => {
  it('owner: corporate + own location, and a foreign location_id param is IGNORED', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    const res = await lookupsGET(getReq(`?location_id=${LOC_B}`))
    expect(res.status).toBe(200)
    const or = f(lookupsCtx(), 'or')
    expect(or[1]).toBe(`location_id.is.null,location_id.eq.${LOC_A}`)
    expect(or[1]).not.toContain(LOC_B)
  })

  it('super_admin with a location_id param scopes to that location', async () => {
    h.state.hubUser = { id: 'u1', role: 'super_admin', location_id: null }
    await lookupsGET(getReq(`?location_id=${LOC_B}`))
    expect(f(lookupsCtx(), 'or')[1]).toBe(`location_id.is.null,location_id.eq.${LOC_B}`)
  })

  it('super_admin with NO param gets corporate only (the Configure tab read)', async () => {
    h.state.hubUser = { id: 'u1', role: 'super_admin', location_id: null }
    await lookupsGET(getReq())
    expect(f(lookupsCtx(), 'or')).toBeUndefined()
    expect(f(lookupsCtx(), 'is')).toEqual(['is', 'location_id', null])
  })

  it('a non-uuid location value falls back to corporate only (no filter injection)', async () => {
    h.state.hubUser = { id: 'u1', role: 'super_admin', location_id: null }
    await lookupsGET(getReq('?location_id=evil,or(id.gt.0)'))
    expect(f(lookupsCtx(), 'or')).toBeUndefined()
    expect(f(lookupsCtx(), 'is')).toEqual(['is', 'location_id', null])
  })
})

// ─── POST location-owned create ──────────────────────────────────
describe('/api/lookups POST — location-owned create (PickerModal allowCreate)', () => {
  const respondNoDup = (ctx: any) => {
    if (ctx.table === 'lookups' && ctx.op === 'select') return { data: null, error: null } // dup guard + sort_order max
    if (ctx.table === 'lookups' && ctx.op === 'insert') {
      return { data: { id: 'new-1', ...ctx.payload }, error: null }
    }
    return { data: null, error: null }
  }

  it('owner creates for their OWN location — row inserts with that location_id', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = respondNoDup
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'client_tags', label: 'Snowbird', location_id: LOC_A }))
    expect(res.status).toBe(200)
    const insert = h.state.calls.find((c: any) => c.table === 'lookups' && c.op === 'insert')
    expect(insert.payload.location_id).toBe(LOC_A)
    expect(insert.payload.label).toBe('Snowbird')
  })

  it("owner creating for ANOTHER location is 403", async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'client_tags', label: 'Snowbird', location_id: LOC_B }))
    expect(res.status).toBe(403)
  })

  it('owner corporate create (no location_id) stays 403 — admins only', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'client_tags', label: 'Snowbird' }))
    expect(res.status).toBe(403)
  })

  it('a non-location-scoped category (project_types) cannot be location-created', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'project_types', label: 'Sheds', location_id: LOC_A }))
    expect(res.status).toBe(400)
  })

  it('duplicate label against corporate + that location is 409', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = (ctx: any) => {
      if (ctx.table === 'lookups' && ctx.op === 'select' && f(ctx, 'ilike')) {
        return { data: { id: 'corp-vip' }, error: null }
      }
      return { data: null, error: null }
    }
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'client_tags', label: 'VIP', location_id: LOC_A }))
    expect(res.status).toBe(409)
    expect(h.state.calls.find((c: any) => c.op === 'insert')).toBeUndefined()
  })

  it('admin may create for any location (the super_admin-viewing-a-location path)', async () => {
    h.state.hubUser = { id: 'u1', role: 'super_admin', location_id: null }
    h.state.respond = respondNoDup
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'partner_tags', label: 'Snowbird', location_id: LOC_B }))
    expect(res.status).toBe(200)
    const insert = h.state.calls.find((c: any) => c.table === 'lookups' && c.op === 'insert')
    expect(insert.payload.location_id).toBe(LOC_B)
  })
})

// ─── /api/lead-tags location validation ──────────────────────────
describe('/api/lead-tags POST — corporate or the lead\'s own location, nothing else', () => {
  const scenario = (tagLocationId: string | null) => (ctx: any) => {
    if (ctx.table === 'hub_users') {
      return { data: { id: 'user-1', role: 'owner', location_id: LOC_A }, error: null }
    }
    if (ctx.table === 'leads') {
      return { data: { id: 'lead-1', location_uuid: LOC_A }, error: null }
    }
    if (ctx.table === 'lookups') {
      return { data: { id: 'tag-1', category: 'client_tags', location_id: tagLocationId }, error: null }
    }
    if (ctx.table === 'lead_tags' && ctx.op === 'upsert') {
      return { data: { lead_id: 'lead-1', tag_lookup_id: 'tag-1' }, error: null }
    }
    return { data: null, error: null }
  }

  it('a corporate tag (location_id null) applies', async () => {
    h.state.respond = scenario(null)
    const res = await leadTagsPOST(postReq('/api/lead-tags', { lead_id: 'lead-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(201)
  })

  it("the lead's own location's tag applies", async () => {
    h.state.respond = scenario(LOC_A)
    const res = await leadTagsPOST(postReq('/api/lead-tags', { lead_id: 'lead-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(201)
  })

  it("another location's tag is rejected — no junction row written", async () => {
    h.state.respond = scenario(LOC_B)
    const res = await leadTagsPOST(postReq('/api/lead-tags', { lead_id: 'lead-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('tag_lookup_wrong_location')
    expect(h.state.calls.find((c: any) => c.table === 'lead_tags')).toBeUndefined()
  })
})
