// @vitest-environment node
//
// POST /api/engagements/:id/reopen — RESURRECT a Closed Lost engagement
// (Part 4, option B: re-derive). The route:
//   1) Closed LOST only — Closed Won is out of scope (409
//      reopen_won_out_of_scope), open stages rejected (409
//      reopen_requires_closed_lost); both BEFORE any write.
//   2) Re-derives the correct OPEN stage from the actual child records
//      via live-mode deriveEngagementStage — a live quote and no job ⇒
//      Estimate (the pinned case), NOT a stored pre-close stage nor a
//      default. Terminal fields (closed_at/closed_reason/closed_note) and
//      nurture_started_at are cleared in the same write.
//   3) Writes a Reopened stage_change touchpoint trail.
//   4) lite_user is blocked; wrong-location non-admins are blocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabaseService mock (stage-terminal-only pattern): chainable
// builder, per-table FIFO response queues.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null, count: number | null = null) =>
    state.queue.push({ table, resp: { data, error, count } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null, count: null }
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

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { POST } from '@/app/api/engagements/[id]/reopen/route'

const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', location_uuid: 'loc-uuid-1',
  stage: 'Closed Lost', closed_reason: 'lost_no_response',
  ...over,
})

// hub_users profile (server client) then engagement row (service client).
const arm = (engagement: any, role = 'super_admin', location_id: any = null) => {
  h.enqueue('hub_users', { id: 'u1', role, location_id })
  h.enqueue('engagements', engagement)
}
// The four child reads deriveEngagementStage consumes (order matches the
// route's Promise.all: service_requests, quotes, jobs, invoices).
const armChildren = (children: { sr?: any; quotes?: any[]; jobs?: any[]; invoices?: any[] } = {}) => {
  h.enqueue('service_requests', children.sr ? [children.sr] : [])
  h.enqueue('quotes', children.quotes ?? [])
  h.enqueue('jobs', children.jobs ?? [])
  h.enqueue('invoices', children.invoices ?? [])
}

const post = (id: string) =>
  POST(new Request(`http://test/api/engagements/${id}/reopen`, { method: 'POST' }), { params: Promise.resolve({ id }) })

const engagementUpdate = () =>
  h.state.calls.find(c => c.table === 'engagements' && c.ops.some(([m]) => m === 'update'))
const updatePayload = () => engagementUpdate()?.ops.find(([m]) => m === 'update')?.[1][0]

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('scope: Closed Lost only', () => {
  it('Closed Won is out of scope (409, no write)', async () => {
    arm(ENG({ stage: 'Closed Won', closed_reason: 'won' }))
    const res = await post('e1')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('reopen_won_out_of_scope')
    expect(engagementUpdate()).toBeUndefined()
  })

  it('an OPEN engagement cannot be reopened (409, no write)', async () => {
    arm(ENG({ stage: 'Estimate', closed_reason: null }))
    const res = await post('e1')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('reopen_requires_closed_lost')
    expect(engagementUpdate()).toBeUndefined()
  })
})

describe('re-derive from records (option B)', () => {
  it('PIN: a live quote and no job ⇒ Estimate; terminal + nurture fields cleared', async () => {
    arm(ENG({ stage: 'Closed Lost' }))
    armChildren({ quotes: [{ status: 'sent', sent_at: new Date().toISOString() }] })
    h.enqueue('engagements', null)                 // the update
    h.enqueue('touchpoints', null)                 // stage_change trail
    h.enqueue('leads', { location_id: 'loc1', name: 'Pat' })
    const res = await post('e1')
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.reopened).toBe(true)
    expect(j.stage).toBe('Estimate')
    const p = updatePayload()
    expect(p.stage).toBe('Estimate')
    expect(p.closed_at).toBeNull()
    expect(p.closed_reason).toBeNull()
    expect(p.closed_note).toBeNull()
    expect(p.nurture_started_at).toBeNull()
    // Reopened stage_change touchpoint written.
    const tp = h.state.calls.find(c => c.table === 'touchpoints')!
    const ins = tp.ops.find(([m]) => m === 'insert')![1][0]
    expect(ins.kind).toBe('stage_change')
    expect(ins.label).toContain('Reopened')
  })

  it('no children ⇒ Request (still an open stage, never a stored default)', async () => {
    arm(ENG({ stage: 'Closed Lost' }))
    armChildren({})
    h.enqueue('engagements', null)
    h.enqueue('touchpoints', null)
    h.enqueue('leads', { location_id: 'loc1', name: 'Pat' })
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect((await res.json()).stage).toBe('Request')
    expect(updatePayload().stage).toBe('Request')
  })

  it('a booked job in flight ⇒ Job in Progress', async () => {
    arm(ENG({ stage: 'Closed Lost' }))
    armChildren({ jobs: [{ status: 'active', scheduled_start: new Date().toISOString() }] })
    h.enqueue('engagements', null)
    h.enqueue('touchpoints', null)
    h.enqueue('leads', { location_id: 'loc1', name: 'Pat' })
    const res = await post('e1')
    expect((await res.json()).stage).toBe('Job in Progress')
  })
})

describe('auth', () => {
  it('lite_user is blocked (403) before any load', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'lite_user', location_id: 'loc-uuid-1' })
    const res = await post('e1')
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only_role')
  })

  it('non-admin from another location is blocked (403)', async () => {
    arm(ENG({ stage: 'Closed Lost' }), 'owner', 'other-loc')
    const res = await post('e1')
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_wrong_location')
    expect(engagementUpdate()).toBeUndefined()
  })
})
