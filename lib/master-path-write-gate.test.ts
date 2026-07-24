// @vitest-environment node
//
// PATCH / DELETE /api/drip-paths/:id — corp masters are not owner-writable.
//
// The route used to authorize non-admins on location match alone:
//     hubUser.location_id !== path.location_uuid  → 403
// A master's location_uuid is NULL, so an owner with a real location_id
// mismatched and 403'd — but only by accident of the comparison. A caller
// whose own location_id was ALSO null compared equal and fell straight
// through to the write, able to rename a master path, flip is_active /
// is_default, change path_key, or DELETE it (cascading its 3 steps).
//
// The fix reads is_master and refuses it explicitly, mirroring
// forbidden_master_step in /api/drip-path-steps. These suites pin:
//   1) NULL-location non-admin cannot PATCH or DELETE a master (the hole)
//   2) ordinary owners still can't either, and now get the honest error code
//   3) super_admin CAN still edit a master deliberately
//   4) an owner's own location-owned path is untouched by the new gate
//   5) the lite_user/manager read-only block still fires first
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabaseService mock (engagement-reopen pattern): chainable
// builder, per-table FIFO response queues.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error, count: null } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null, count: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'not', 'is', 'limit', 'order', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { PATCH, DELETE } from '@/app/api/drip-paths/[id]/route'

const LOC = 'loc-uuid-1'
const MASTER_ID = 'aaaaaaaa-1111-4222-8333-444455556666'

const MASTER = {
  id: MASTER_ID, location_uuid: null, path_key: 'moving-d',
  name: 'Moving — Path D', is_active: true, is_default: false, is_master: true,
}
const OWN_PATH = {
  id: 'p2', location_uuid: LOC, path_key: 'moving-d',
  name: 'Moving — Path D', is_active: true, is_default: false, is_master: false,
}

// hub_users profile (server client) then the drip_paths row (service client).
function setup(hubUser: any, path: any) {
  h.reset()
  h.enqueue('hub_users', hubUser)
  h.enqueue('drip_paths', path)
}

const req = (body: any) => ({ json: async () => body }) as any
const params = (id: string) => ({ params: { id } })

// Did the route reach a real write on drip_paths?
const wrote = (op: 'update' | 'delete') =>
  h.state.calls.some(c => c.table === 'drip_paths' && c.ops.some(([m]) => m === op))

beforeEach(() => h.reset())

describe('PATCH /api/drip-paths/:id — master gate', () => {
  it('blocks a NULL-location non-admin from patching a master (the hole)', async () => {
    // location_id null vs master location_uuid null used to compare EQUAL and
    // sail past the old guard.
    setup({ id: 'u1', role: 'owner', location_id: null }, MASTER)
    const res = await PATCH(req({ name: 'renamed by an owner' }), params(MASTER_ID))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_master_path')
    expect(wrote('update')).toBe(false)
  })

  it('blocks an ordinary owner with the honest error code', async () => {
    setup({ id: 'u1', role: 'owner', location_id: LOC }, MASTER)
    const res = await PATCH(req({ is_active: false }), params(MASTER_ID))
    expect(res.status).toBe(403)
    // Previously 403'd as forbidden_wrong_location — a side effect, not a rule.
    expect((await res.json()).error).toBe('forbidden_master_path')
    expect(wrote('update')).toBe(false)
  })

  it('still lets super_admin edit a master deliberately', async () => {
    setup({ id: 'u1', role: 'super_admin', location_id: null }, MASTER)
    h.enqueue('drip_paths', { ...MASTER, name: 'Moving — Path D (rev)' })
    const res = await PATCH(req({ name: 'Moving — Path D (rev)' }), params(MASTER_ID))
    expect(res.status).toBe(200)
    expect((await res.json()).path.name).toBe('Moving — Path D (rev)')
    expect(wrote('update')).toBe(true)
  })

  it('leaves an owner editing their OWN location path working', async () => {
    setup({ id: 'u1', role: 'owner', location_id: LOC }, OWN_PATH)
    h.enqueue('drip_paths', { ...OWN_PATH, name: 'My Move Path' })
    const res = await PATCH(req({ name: 'My Move Path' }), params('p2'))
    expect(res.status).toBe(200)
    expect(wrote('update')).toBe(true)
  })

  it('keeps the read-only block ahead of the master check', async () => {
    setup({ id: 'u1', role: 'lite_user', location_id: LOC }, MASTER)
    const res = await PATCH(req({ name: 'nope' }), params(MASTER_ID))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only')
    expect(wrote('update')).toBe(false)
  })
})

describe('DELETE /api/drip-paths/:id — master gate', () => {
  it('blocks a NULL-location non-admin from deleting a master', async () => {
    setup({ id: 'u1', role: 'owner', location_id: null }, MASTER)
    const res = await DELETE({} as any, params(MASTER_ID))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_master_path')
    expect(wrote('delete')).toBe(false)
  })

  it('still lets an owner delete their own location path', async () => {
    setup({ id: 'u1', role: 'owner', location_id: LOC }, OWN_PATH)
    h.enqueue('drip_paths', null)
    const res = await DELETE({} as any, params('p2'))
    expect(res.status).toBe(200)
    expect(wrote('delete')).toBe(true)
  })
})
