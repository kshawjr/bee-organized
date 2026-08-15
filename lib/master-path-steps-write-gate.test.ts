// @vitest-environment node
//
// PATCH /api/drip-paths/:id/steps — corp masters are not writable here at all.
//
// Companion to master-path-write-gate.test.ts. That fix taught
// /api/drip-paths/:id to read is_master and refuse it; this route was missed
// and still authorized on location match alone:
//     hubUser.location_id !== path.location_uuid  → 403
// A master's location_uuid is NULL, so a caller whose own location_id is ALSO
// null compared equal and sailed through — and what it sailed into is worse
// than a field update. The write is a whole-set DELETE-then-INSERT, so a
// single call rewrites the steps every un-cloned location renders from, and
// reissues their ids.
//
// This route is deliberately STRICTER than its sibling: masters are refused
// for admins too. Nothing needs the exception — commitSteps clones before it
// PATCHes, and the admin master editor goes through
// PATCH /api/drip-path-steps/:stepId one step at a time.
//
// These suites pin:
//   1) NULL-location non-admin cannot PATCH a master's steps (the hole)
//   2) an ordinary owner can't either, and gets the honest error code
//   3) super_admin is refused too — the deliberate divergence from the sibling
//   4) an owner's own location-owned path still saves normally
//   5) the lite_user/manager read-only block still fires first
//   6) nothing is deleted on any refusal — the blast radius stays closed
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

import { PATCH } from '@/app/api/drip-paths/[id]/steps/route'

const LOC = 'loc-uuid-1'
const MASTER_ID = 'aaaaaaaa-1111-4222-8333-444455556666'

const MASTER = { id: MASTER_ID, location_uuid: null, is_master: true }
const OWN_PATH = { id: 'p2', location_uuid: LOC, is_master: false }

// A payload that would replace the whole set — the shape commitSteps sends.
const STEPS = [
  { step_order: 1, delay_days: 0, channel: 'email', subject: 'Rewritten', body: 'Rewritten body' },
]

// hub_users profile (server client) then the drip_paths row (service client).
function setup(hubUser: any, path: any) {
  h.reset()
  h.enqueue('hub_users', hubUser)
  h.enqueue('drip_paths', path)
}

const req = (body: any) => ({ json: async () => body }) as any
const params = (id: string) => ({ params: { id } })

// Did the route reach the destructive half?
const deletedSteps = () =>
  h.state.calls.some(c => c.table === 'drip_path_steps' && c.ops.some(([m]) => m === 'delete'))
const insertedSteps = () =>
  h.state.calls.some(c => c.table === 'drip_path_steps' && c.ops.some(([m]) => m === 'insert'))

beforeEach(() => h.reset())

describe('PATCH /api/drip-paths/:id/steps — master gate', () => {
  it('blocks a NULL-location non-admin from replacing a master\'s steps (the hole)', async () => {
    // location_id null vs master location_uuid null used to compare EQUAL.
    setup({ id: 'u1', role: 'owner', location_id: null }, MASTER)
    const res = await PATCH(req({ steps: STEPS }), params(MASTER_ID))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_master_path')
    expect(deletedSteps()).toBe(false)
    expect(insertedSteps()).toBe(false)
  })

  it('blocks an ordinary owner with the honest error code', async () => {
    setup({ id: 'u1', role: 'owner', location_id: LOC }, MASTER)
    const res = await PATCH(req({ steps: STEPS }), params(MASTER_ID))
    expect(res.status).toBe(403)
    // Previously 403'd as forbidden_wrong_location — a side effect, not a rule.
    expect((await res.json()).error).toBe('forbidden_master_path')
    expect(deletedSteps()).toBe(false)
  })

  it('refuses super_admin too — this route is stricter than /api/drip-paths/:id', async () => {
    // The sibling route lets super_admin rename a master deliberately. Here the
    // write is a whole-set delete-then-insert shared by every un-cloned
    // location, and the admin master editor uses the per-step route instead.
    setup({ id: 'u1', role: 'super_admin', location_id: null }, MASTER)
    const res = await PATCH(req({ steps: STEPS }), params(MASTER_ID))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_master_path')
    expect(deletedSteps()).toBe(false)
    expect(insertedSteps()).toBe(false)
  })

  it('leaves an owner saving their OWN location path working', async () => {
    setup({ id: 'u1', role: 'owner', location_id: LOC }, OWN_PATH)
    h.enqueue('drip_path_steps', null)                       // delete
    h.enqueue('drip_path_steps', [{ id: 's1', step_order: 1 }]) // insert .select()
    const res = await PATCH(req({ steps: STEPS }), params('p2'))
    expect(res.status).toBe(200)
    expect(deletedSteps()).toBe(true)
    expect(insertedSteps()).toBe(true)
  })

  it('keeps the read-only block ahead of the master check', async () => {
    setup({ id: 'u1', role: 'lite_user', location_id: LOC }, MASTER)
    const res = await PATCH(req({ steps: STEPS }), params(MASTER_ID))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only')
    expect(deletedSteps()).toBe(false)
  })

  it('refuses a master before parsing the body — an empty steps array cannot clear one', async () => {
    // steps:[] is the one payload that deletes everything and inserts nothing.
    setup({ id: 'u1', role: 'owner', location_id: null }, MASTER)
    const res = await PATCH(req({ steps: [] }), params(MASTER_ID))
    expect(res.status).toBe(403)
    expect(deletedSteps()).toBe(false)
  })
})
