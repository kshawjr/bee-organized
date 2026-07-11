// @vitest-environment node
//
// PATCH /api/engagements/:id — stage writes are TERMINAL-ONLY
// (decision 2026-07-10, Kevin): all business flows through Jobber, so
// a manual non-terminal stage assertion is always fiction. The panel
// Advance button and the board's local-card pipeline drag were removed
// the same day (see beta-stage-control.test.tsx for the UI side); this
// file pins the API floor under them:
//
//   1) Non-terminal stage values are REJECTED (409
//      manual_stage_move_rejected) for every engagement — including
//      the forward-rank moves the route used to accept, and regardless
//      of Jobber children (the old linked gate was client-side only;
//      now nothing gets a manual pipeline move).
//   2) The rejection fires BEFORE any DB write.
//   3) Terminal closes (Closed Won / Closed Lost from an open stage)
//      still commit — closing is a human act with no Jobber auto-Lost.
//   4) Terminal→terminal stays rejected (settled closes don't flip
//      through this route; stale_on_import recovery is the GET's job).
//   5) Non-stage fields (title/description/project_type) are untouched
//      by the hardening.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (stage-drift-test pattern):
//    chainable builder, per-table FIFO response queues. ──────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null, count: number | null = null) =>
    state.queue.push({ table, resp: { data, error, count } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null, count: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))

import { PATCH } from '@/app/api/engagements/[id]/route'

const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', location_uuid: 'loc-uuid-1',
  stage: 'Request', title: 'Garage organization', description: null,
  project_type: null, closed_reason: null,
  ...over,
})

// Queue the auth + load pair every PATCH consumes first: the hub_users
// profile (server client) and the engagement row (service client).
const arm = (engagement: any) => {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('engagements', engagement)
}

const patch = (id: string, body: any) =>
  PATCH(
    new Request(`http://test/api/engagements/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  )

const engagementWrites = () =>
  h.state.calls.filter(c => c.table === 'engagements' && c.ops.some(([m]) => m === 'update' || m === 'insert'))

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('non-terminal stage values are rejected — no manual pipeline moves', () => {
  it('Request → Estimate (the old Advance) → 409 manual_stage_move_rejected, zero writes', async () => {
    arm(ENG({ stage: 'Request' }))
    const res = await patch('e1', { stage: 'Estimate' })
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.error).toBe('manual_stage_move_rejected')
    expect(j.current).toBe('Request')
    expect(j.requested).toBe('Estimate')
    expect(engagementWrites()).toEqual([])
  })

  it('forward-rank moves the route USED to accept are rejected too (Estimate → Job in Progress)', async () => {
    arm(ENG({ stage: 'Estimate' }))
    const res = await patch('e1', { stage: 'Job in Progress' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('manual_stage_move_rejected')
    expect(engagementWrites()).toEqual([])
  })

  it('unknown stage values still fail vocabulary validation (400 invalid_stage)', async () => {
    arm(ENG({ stage: 'Request' }))
    const res = await patch('e1', { stage: 'Sideways' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_stage')
    expect(engagementWrites()).toEqual([])
  })
})

describe('terminal closes remain the one human stage write', () => {
  it('open → Closed Lost commits: stage + closed_at + closed_reason, stage_change touchpoint', async () => {
    arm(ENG({ stage: 'Estimate' }))
    h.enqueue('engagements', null)                       // the update
    h.enqueue('touchpoints', null)                       // stage_change trail
    h.enqueue('leads', { location_id: 'loc1', name: 'Pat' }) // close trail lookup
    h.enqueue('engagements', null, null, 0)              // other-open count
    const res = await patch('e1', { stage: 'Closed Lost', closed_reason: 'lost_no_response' })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.stage).toBe('Closed Lost')
    const update = engagementWrites().find(c => c.ops.some(([m]) => m === 'update'))!
    expect(update).toBeTruthy()
    const payload = update.ops.find(([m]) => m === 'update')![1][0]
    expect(payload.stage).toBe('Closed Lost')
    expect(payload.closed_reason).toBe('lost_no_response')
    expect(payload.closed_at).toBeTruthy()
    const tp = h.state.calls.find(c => c.table === 'touchpoints')!
    expect(tp.ops.find(([m]) => m === 'insert')![1][0].kind).toBe('stage_change')
  })

  it('terminal → terminal stays rejected (Closed Lost → Closed Won is not a manual flip)', async () => {
    arm(ENG({ stage: 'Closed Lost', closed_reason: 'lost_other' }))
    const res = await patch('e1', { stage: 'Closed Won' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('backward_move_rejected')
    expect(engagementWrites()).toEqual([])
  })
})

describe('non-stage fields are untouched by the hardening', () => {
  it('description-only PATCH still commits without a stage', async () => {
    arm(ENG({ stage: 'Request' }))
    h.enqueue('engagements', null) // the update
    const res = await patch('e1', { description: 'Full kitchen reorganization' })
    expect(res.status).toBe(200)
    const update = engagementWrites().find(c => c.ops.some(([m]) => m === 'update'))!
    const payload = update.ops.find(([m]) => m === 'update')![1][0]
    expect(payload.description).toBe('Full kitchen reorganization')
    expect(payload.stage).toBeUndefined()
  })
})
