// @vitest-environment node
//
// GET /api/locations/transfer-targets — the TransferLeadModal's picker feed.
// Pins: admin-gated; each row carries lifecycle_status (drives the modal's
// active-vs-not note) and a batched owner_name; loc_other is excluded via the
// query. Also asserts mapLeadToPerson exposes atLocOther + origin fields.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[], neqs: [] as any[][] }
  const reset = () => { state.queue = []; state.neqs = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'or', 'not', 'is', 'in', 'order', 'limit']) b[m] = () => b
    b.neq = (...args: any[]) => { state.neqs.push(args); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'u1' } as any }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { GET } from '@/app/api/locations/transfer-targets/route'
import { mapLeadToPerson } from '@/lib/people-mapper'

beforeEach(() => { h.reset(); authUser.current = { id: 'u1' } })

describe('transfer-targets endpoint', () => {
  it('non-admin (manager) → 403', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'manager' })
    const res = await GET()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_admin_only')
  })

  it('admin → targets with lifecycle_status, slug, and batched owner_name; excludes loc_other', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'admin' })
    h.enqueue('locations', [
      { id: 'l-boulder', name: 'Boulder', location_id: 'boulder-01', lifecycle_status: 'active' },
      { id: 'l-denver', name: 'Denver', location_id: 'denver-01', lifecycle_status: 'onboarding' },
    ])
    h.enqueue('hub_users', [
      { location_id: 'l-boulder', full_name: 'Dana Lee', email: 'dana@x.com', role: 'owner', created_at: '2026-01-01' },
    ])
    const res = await GET()
    expect(res.status).toBe(200)
    const { targets } = await res.json()
    expect(targets).toHaveLength(2)
    expect(targets[0]).toMatchObject({ id: 'l-boulder', name: 'Boulder', slug: 'boulder-01', lifecycle_status: 'active', owner_name: 'Dana Lee' })
    // no owner row for Denver → null (rendered as "the owner" in the modal)
    expect(targets[1]).toMatchObject({ slug: 'denver-01', lifecycle_status: 'onboarding', owner_name: null })
    // loc_other is filtered out at the query
    expect(h.state.neqs).toContainEqual(['location_id', 'loc_other'])
  })
})

describe('people-mapper — transfer fields', () => {
  it('flags a loc_other lead and exposes discrete origin fields', () => {
    const p = mapLeadToPerson({
      id: 'lead-1', name: 'Global Lead', location_id: 'loc_other', location_uuid: 'loc-other-uuid',
      city: 'Austin', state: 'TX', zip: '78701', project_type: 'Garage', stage: 'New', created_at: '2026-07-01',
    } as any)
    expect(p.atLocOther).toBe(true)
    expect(p.originCity).toBe('Austin')
    expect(p.originState).toBe('TX')
    expect(p.originZip).toBe('78701')
  })

  it('a normal lead is not flagged for transfer', () => {
    const p = mapLeadToPerson({
      id: 'lead-2', name: 'Local Lead', location_id: 'boulder-01', location_uuid: 'l-boulder',
      stage: 'New', created_at: '2026-07-01',
    } as any)
    expect(p.atLocOther).toBe(false)
  })
})
