// Tag system 2A — location-aware lookups.
//
// /api/lookups GET returns corporate (location_id null) + AT MOST the
// caller's own location's rows — never another location's: owners are
// pinned to their hub_users location (the location_id param is ignored
// for them); admins scope via the param (no param → corporate only).
//
// /api/lookups POST: a new tag goes to the one list ('tags'). Since
// 2026-10-16 a location may create its own again, behind the near-match
// guard (lib/tags.ts tagKey); /api/lookups/[id] lets it rename / switch off
// its own.
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
import { PATCH as lookupPATCH } from '@/app/api/lookups/[id]/route'
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

// ─── POST — a location's own tags, behind the near-match guard ───
// Corporate-only for one day after the merge; since 2026-10-16 an owner or
// manager may create their location's own tag. The guard (lib/tags.ts tagKey:
// case, spacing, punctuation, plurals) checks every corporate tag (on or off)
// and the location's own: an ACTIVE match → "use that" (409); their own
// switched-off one → "restore it" (409); a switched-off CORPORATE one → the
// tag is created AND corporate gets a request to bring theirs back.
describe('/api/lookups POST — location tags and the near-match guard', () => {
  // The candidate read (category IN tags…, location scope, no is_active
  // filter) answers `existing`; the sort read answers a max; inserts echo.
  const scenario = (existing: any[] = []) => (ctx: any) => {
    if (ctx.table === 'lookups' && ctx.op === 'select' && f(ctx, 'in') && !f(ctx, 'eq')) return { data: existing, error: null }
    if (ctx.table === 'lookups' && ctx.op === 'select') return { data: { sort_order: 4000 }, error: null }
    if (ctx.table === 'lookups' && ctx.op === 'insert') return { data: { id: 'new-1', ...ctx.payload }, error: null }
    if (ctx.table === 'locations') return { data: { name: 'Southeast Nashville' }, error: null }
    if (ctx.table === 'feedback_items') return { data: null, error: null }
    return { data: null, error: null }
  }
  const CORP_REALTOR = { id: 'c-realtor', label: 'Realtor', icon: '🏠', location_id: null, is_active: true }
  const CORP_HOUSEKEEPER_OFF = { id: 'c-hk', label: 'Housekeeper', icon: '🧽', location_id: null, is_active: false }
  const OWN_SNOWBIRD_OFF = { id: 'o-sb', label: 'Snowbird', icon: null, location_id: LOC_A, is_active: false }
  const insertCall = () => h.state.calls.find((c: any) => c.table === 'lookups' && c.op === 'insert')
  const feedbackCall = () => h.state.calls.find((c: any) => c.table === 'feedback_items')
  const create = (label: string, extra: any = {}) => lookupsPOST(postReq('/api/lookups', { category: 'tags', label, location_id: LOC_A, ...extra }))

  it('owner creates a tag for their own location — it belongs to that location alone', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario([CORP_REALTOR])
    const res = await create('Organizer')
    expect(res.status).toBe(200)
    expect(insertCall().payload).toMatchObject({ category: 'tags', label: 'Organizer', location_id: LOC_A })
    expect(insertCall().payload.attrs.created_by_user).toBe('u1')
    expect(feedbackCall()).toBeUndefined()
  })

  it('a manager may too', async () => {
    h.state.hubUser = { id: 'u2', role: 'manager', location_id: LOC_A }
    h.state.respond = scenario([])
    expect((await create('Organizer')).status).toBe(200)
  })

  it.each(['realtors', 'REALTOR', ' Real-tor ', 'Real tor', 'Realtor/'])(
    'a near-match of an active tag ("%s") is blocked and offers the existing one',
    async (label) => {
      h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
      h.state.respond = scenario([CORP_REALTOR])
      const res = await create(label)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'near_match', verdict: 'use', tag: { id: 'c-realtor', label: 'Realtor', icon: '🏠', location_id: null, is_active: true } })
      expect(insertCall()).toBeUndefined()
    }
  )

  it("a near-match of the location's OWN removed tag is blocked: restore it instead", async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario([OWN_SNOWBIRD_OFF])
    const res = await create('Snowbirds')
    expect(res.status).toBe(409)
    expect((await res.json()).verdict).toBe('restore')
    expect(insertCall()).toBeUndefined()
  })

  it('a near-match of a RETIRED corporate tag is NOT blocked: created, and corporate is asked to bring theirs back', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario([CORP_HOUSEKEEPER_OFF])
    const res = await create('House Keeper')
    expect(res.status).toBe(200)
    expect((await res.json()).retired).toEqual({ id: 'c-hk', label: 'Housekeeper' })
    expect(insertCall().payload.label).toBe('House Keeper')
    expect(feedbackCall().payload).toMatchObject({ type: 'feature', status: 'submitted', location_id: LOC_A, user_id: 'u1', title: 'Tag request: bring back "Housekeeper"' })
    expect(feedbackCall().payload.description).toContain('Southeast Nashville')
  })

  it('read-only staff cannot create', async () => {
    h.state.hubUser = { id: 'u3', role: 'lite_user', location_id: LOC_A }
    h.state.respond = scenario([])
    expect((await create('Organizer')).status).toBe(403)
    expect(insertCall()).toBeUndefined()
  })

  it("owner creating for ANOTHER location is 403", async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'tags', label: 'Organizer', location_id: LOC_B }))
    expect(res.status).toBe(403)
  })

  it('owner corporate tag create (no location_id) is 403 — admins only', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'tags', label: 'Snowbird' }))
    expect(res.status).toBe(403)
  })

  it('a non-location-scoped category (project_types) cannot be location-created', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'project_types', label: 'Sheds', location_id: LOC_A }))
    expect(res.status).toBe(400)
  })

  it.each(['client_tags', 'partner_tags', 'partner_specialties'])(
    'the pre-merge category %s is no longer creatable, even by an admin',
    async (category) => {
      h.state.hubUser = { id: 'u1', role: 'super_admin', location_id: null }
      h.state.respond = scenario([])
      const res = await lookupsPOST(postReq('/api/lookups', { category, label: 'Snowbird' }))
      expect(res.status).toBe(400)
      expect(insertCall()).toBeUndefined()
    }
  )

  it("admin corporate create lands in 'tags', after every existing tag, in Trade", async () => {
    h.state.hubUser = { id: 'u1', role: 'super_admin', location_id: null }
    h.state.respond = scenario([CORP_REALTOR])
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'tags', label: 'Mentor' }))
    expect(res.status).toBe(200)
    expect(insertCall().payload).toMatchObject({ category: 'tags', sort_order: 4010 })
    expect(insertCall().payload.location_id).toBeUndefined()
    expect(insertCall().payload.attrs.section).toBe('trade')
  })

  it('a corporate near-match of a retired corporate tag is blocked: switch it back on instead', async () => {
    h.state.hubUser = { id: 'u1', role: 'super_admin', location_id: null }
    h.state.respond = scenario([CORP_HOUSEKEEPER_OFF])
    const res = await lookupsPOST(postReq('/api/lookups', { category: 'tags', label: 'housekeepers' }))
    expect(res.status).toBe(409)
    expect((await res.json()).verdict).toBe('restore')
    expect(insertCall()).toBeUndefined()
  })
})

// ─── PATCH / DELETE — a location's own tags ──────────────────────
describe('/api/lookups/[id] — an owner renames or switches off their own tag', () => {
  const OWN = { id: 'o-org', category: 'tags', label: 'Organizer', location_id: LOC_A }
  const scenario = (row: any, existing: any[] = []) => (ctx: any) => {
    if (ctx.table === 'lookups' && ctx.op === 'select' && f(ctx, 'eq')?.[1] === 'id') return { data: row, error: null }
    if (ctx.table === 'lookups' && ctx.op === 'select') return { data: existing, error: null }
    if (ctx.table === 'lookups' && ctx.op === 'update') return { data: { ...row, ...ctx.payload }, error: null }
    return { data: null, error: null }
  }
  const patchReq = (body: any) => new Request('http://test.local/api/lookups/o-org', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as any
  const updateCall = () => h.state.calls.find((c: any) => c.table === 'lookups' && c.op === 'update')

  it('owner renames their own tag', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario(OWN, [OWN])
    const res = await lookupPATCH(patchReq({ label: 'Organiser' }), { params: { id: 'o-org' } } as any)
    expect(res.status).toBe(200)
    expect(updateCall().payload.label).toBe('Organiser')
  })

  it('a rename that near-matches an existing tag is blocked (not against itself)', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario(OWN, [OWN, { id: 'c-realtor', label: 'Realtor', location_id: null, is_active: true }])
    const res = await lookupPATCH(patchReq({ label: 'Realtors' }), { params: { id: 'o-org' } } as any)
    expect(res.status).toBe(409)
    expect((await res.json()).tag.label).toBe('Realtor')
    expect(updateCall()).toBeUndefined()
    // …but re-saving its own name in a new spelling is fine
    h.state.calls = []
    expect((await lookupPATCH(patchReq({ label: 'organizers' }), { params: { id: 'o-org' } } as any)).status).toBe(200)
  })

  it('owner switches it off and back on', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario(OWN)
    expect((await lookupPATCH(patchReq({ is_active: false }), { params: { id: 'o-org' } } as any)).status).toBe(200)
    expect(updateCall().payload.is_active).toBe(false)
  })

  it('an owner may change nothing but the name and on/off', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario(OWN)
    const res = await lookupPATCH(patchReq({ icon: '🌟' }), { params: { id: 'o-org' } } as any)
    expect(res.status).toBe(403)
    expect(updateCall()).toBeUndefined()
  })

  it("an owner can't touch a corporate tag or another location's", async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    h.state.respond = scenario({ id: 'c-realtor', category: 'tags', label: 'Realtor', location_id: null })
    expect((await lookupPATCH(patchReq({ label: 'Agent' }), { params: { id: 'c-realtor' } } as any)).status).toBe(403)
    h.state.respond = scenario({ ...OWN, location_id: LOC_B })
    expect((await lookupPATCH(patchReq({ is_active: false }), { params: { id: 'o-org' } } as any)).status).toBe(403)
    expect(updateCall()).toBeUndefined()
  })

  it('read-only staff cannot rename or remove', async () => {
    h.state.hubUser = { id: 'u3', role: 'lite_user', location_id: LOC_A }
    h.state.respond = scenario(OWN)
    expect((await lookupPATCH(patchReq({ is_active: false }), { params: { id: 'o-org' } } as any)).status).toBe(403)
  })
})

// ─── GET ?category=tags — the one list ───────────────────────────
describe('/api/lookups GET ?category=tags', () => {
  it('include_inactive=1 (tags only) returns switched-off rows too — the picker warns from them', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    await lookupsGET(getReq('?category=tags&include_inactive=1'))
    expect(lookupsCtx().filters).not.toContainEqual(['eq', 'is_active', true])
    h.state.calls = []
    await lookupsGET(getReq('?category=project_types&include_inactive=1'))
    expect(lookupsCtx().filters).toContainEqual(['eq', 'is_active', true])   // not for other lists
  })

  it('matches the merged rows AND the three pre-merge categories', async () => {
    h.state.hubUser = { id: 'u1', role: 'owner', location_id: LOC_A }
    await lookupsGET(getReq('?category=tags'))
    expect(f(lookupsCtx(), 'in')).toEqual(['in', 'category', ['tags', 'client_tags', 'partner_tags', 'partner_specialties']])
    expect(f(lookupsCtx(), 'eq')?.[1]).not.toBe('category')
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

  it('a tag merged into the one list (category tags) applies to a client', async () => {
    h.state.respond = (ctx: any) => {
      if (ctx.table === 'hub_users') return { data: { id: 'u1', role: 'owner', location_id: LOC_A }, error: null }
      if (ctx.table === 'leads') return { data: { id: 'lead-1', location_uuid: LOC_A }, error: null }
      if (ctx.table === 'lookups') return { data: { id: 'tag-1', category: 'tags', location_id: null }, error: null }
      if (ctx.table === 'lead_tags') return { data: { lead_id: 'lead-1', tag_lookup_id: 'tag-1' }, error: null }
      return { data: null, error: null }
    }
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
