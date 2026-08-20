// Tag system 2B — /api/partner-tags, the partner mirror of /api/lead-tags.
//
// POST upserts the partner_tags junction, DELETE removes; both validate
// category='partner_tags' AND that the lookup is corporate or the
// PARTNER's own location — anything else is rejected with the same 403
// shape lead-tags uses (tag_lookup_wrong_location). GET serves the
// record's read (labels resolved) and is open to lite_user; writes are
// not. The dead partners.tags text[] column is never touched.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { sessionUser: null, respond: (_ctx: any) => ({ data: null, error: null }), calls: [] as any[] }
  const reset = () => { state.calls = [] }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', filters: [] as any[], payload: null }
    const b: any = {}
    b.select = (_cols?: any, _opts?: any) => b
    b.insert = (payload: any) => { ctx.op = 'insert'; ctx.payload = payload; return b }
    b.upsert = (payload: any, _opts?: any) => { ctx.op = 'upsert'; ctx.payload = payload; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.is = (col: string, val: any) => { ctx.filters.push(['is', col, val]); return b }
    b.in = (col: string, vals: any[]) => { ctx.filters.push(['in', col, vals]); return b }
    b.or = (raw: string) => { ctx.filters.push(['or', raw]); return b }
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
  isAdmin: (role: string) => role === 'super_admin' || role === 'admin',
}))
vi.mock('@/lib/read-only-access', () => ({
  readOnlyWriteBlock: vi.fn(async () => null),
}))

import { GET, POST, DELETE } from '@/app/api/partner-tags/route'

const LOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const postReq = (body: any) =>
  new Request('http://test.local/api/partner-tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as any
const qsReq = (qs: string) => new Request(`http://test.local/api/partner-tags${qs}`) as any

// role: caller's hub_users role; tagLocationId: the lookup's owner
const scenario = (cfg: { role?: string, callerLoc?: string, tagLocationId?: string | null, category?: string } = {}) => (ctx: any) => {
  if (ctx.table === 'hub_users') {
    return { data: { id: 'user-1', role: cfg.role ?? 'owner', location_id: cfg.callerLoc ?? LOC_A }, error: null }
  }
  if (ctx.table === 'partners') {
    return { data: { id: 'p-1', location_id: LOC_A }, error: null }
  }
  if (ctx.table === 'lookups') {
    if (ctx.filters.some((f: any[]) => f[0] === 'in')) {
      return { data: [{ id: 'tag-1', label: 'Snowbird' }], error: null }
    }
    return { data: { id: 'tag-1', category: cfg.category ?? 'partner_tags', location_id: cfg.tagLocationId ?? null }, error: null }
  }
  if (ctx.table === 'partner_tags' && ctx.op === 'upsert') {
    return { data: { partner_id: 'p-1', tag_lookup_id: 'tag-1' }, error: null }
  }
  if (ctx.table === 'partner_tags' && ctx.op === 'select') {
    return { data: [{ tag_lookup_id: 'tag-1', added_at: '2026-08-20T00:00:00Z' }], error: null }
  }
  return { data: null, error: null }
}

beforeEach(() => {
  h.reset()
  h.state.sessionUser = { id: 'user-1' }
  h.state.respond = scenario()
})

describe('POST /api/partner-tags — corporate or the partner\'s own location, nothing else', () => {
  it('a corporate tag (location_id null) upserts the junction row', async () => {
    const res = await POST(postReq({ partner_id: 'p-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(201)
    const upsert = h.state.calls.find((c: any) => c.table === 'partner_tags' && c.op === 'upsert')
    expect(upsert.payload).toEqual({ partner_id: 'p-1', tag_lookup_id: 'tag-1', added_by: 'user-1' })
  })

  it("the partner's own location's tag applies", async () => {
    h.state.respond = scenario({ tagLocationId: LOC_A })
    const res = await POST(postReq({ partner_id: 'p-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(201)
  })

  it("another location's tag is 403 tag_lookup_wrong_location — no junction write", async () => {
    h.state.respond = scenario({ tagLocationId: LOC_B })
    const res = await POST(postReq({ partner_id: 'p-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('tag_lookup_wrong_location')
    expect(h.state.calls.find((c: any) => c.table === 'partner_tags')).toBeUndefined()
  })

  it('a non-partner_tags lookup (client_tags) is 400 wrong category', async () => {
    h.state.respond = scenario({ category: 'client_tags' })
    const res = await POST(postReq({ partner_id: 'p-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('tag_lookup_wrong_category')
  })

  it("an owner from another location can't write this partner", async () => {
    h.state.respond = scenario({ callerLoc: LOC_B })
    const res = await POST(postReq({ partner_id: 'p-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_wrong_location')
  })

  it('lite_user cannot write', async () => {
    h.state.respond = scenario({ role: 'lite_user' })
    const res = await POST(postReq({ partner_id: 'p-1', tag_lookup_id: 'tag-1' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only_role')
  })
})

describe('GET /api/partner-tags — the record read', () => {
  it('returns junction tags with labels resolved', async () => {
    const res = await GET(qsReq('?partner_id=p-1'))
    expect(res.status).toBe(200)
    expect((await res.json()).tags).toEqual([{ id: 'tag-1', label: 'Snowbird' }])
  })

  it('lite_user may read (the read-only role still sees the record)', async () => {
    h.state.respond = scenario({ role: 'lite_user' })
    const res = await GET(qsReq('?partner_id=p-1'))
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/partner-tags', () => {
  it('removes by query params (the route contract)', async () => {
    const res = await DELETE(qsReq('?partner_id=p-1&tag_lookup_id=tag-1'))
    expect(res.status).toBe(200)
    const del = h.state.calls.find((c: any) => c.table === 'partner_tags' && c.op === 'delete')
    expect(del.filters).toEqual([['eq', 'partner_id', 'p-1'], ['eq', 'tag_lookup_id', 'tag-1']])
  })
})
