// @vitest-environment node
//
// POST /api/engagements/:id/reopen — RESURRECT a Closed Lost engagement
// (Part 4, option B: re-derive). The route:
//   1) Closed Lost or Closed Won only — open stages rejected (409
//      reopen_requires_closed_lost) BEFORE any write. A Won undo needs a
//      reason (400 close_reason_required, no write); a Lost undo does not.
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
import { writeSyncLog } from '@/lib/sync-log'

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

const post = (id: string, body?: any) =>
  POST(
    new Request(`http://test/api/engagements/${id}/reopen`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    { params: Promise.resolve({ id }) },
  )

const engagementUpdate = () =>
  h.state.calls.find(c => c.table === 'engagements' && c.ops.some(([m]) => m === 'update'))
const updatePayload = () => engagementUpdate()?.ops.find(([m]) => m === 'update')?.[1][0]

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('scope: terminal stages only', () => {
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

// A genuinely won deal: a finished job and every invoice paid. Live
// derivation with its default closeWonOnDone would hand back Closed Won —
// the undo must not be a silent no-op.
const WON_CHILDREN = {
  jobs: [{ status: 'completed', completed_at: '2026-09-01T12:00:00Z' }],
  invoices: [{ status: 'paid', total: 500, paid_amount: 500, paid_at: '2026-09-05T12:00:00Z', issued_at: '2026-09-02T12:00:00Z' }],
}
const armWrites = () => {
  h.enqueue('engagements', null)                 // the update
  h.enqueue('touchpoints', null)                 // stage_change trail
  h.enqueue('leads', { location_id: 'loc1', name: 'Pat' })
}
const touchpointInsert = () =>
  h.state.calls.find(c => c.table === 'touchpoints')?.ops.find(([m]) => m === 'insert')?.[1][0]
const lastSyncLog = () => {
  const logged = (writeSyncLog as any).mock.calls.map((c: any) => c[0])
  return logged[logged.length - 1]
}

describe('undo Closed Won', () => {
  it('REGRESSION: a won deal with a reason lands on Final Processing, not back on Closed Won', async () => {
    arm(ENG({ stage: 'Closed Won', closed_reason: 'won' }), 'owner', 'loc-uuid-1')
    armChildren(WON_CHILDREN)
    armWrites()
    const res = await post('e1', { reason: 'Marked won on the wrong client' })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.reopened).toBe(true)
    expect(j.stage).toBe('Final Processing')
    expect(j.prev_stage).toBe('Closed Won')
    const p = updatePayload()
    expect(p.stage).toBe('Final Processing')
    expect(p.closed_at).toBeNull()
    expect(p.closed_reason).toBeNull()
    expect(p.closed_note).toBeNull()        // the reason is NOT stored here
    // Money columns untouched.
    expect(p).not.toHaveProperty('total_invoiced')
    expect(p).not.toHaveProperty('total_paid')
    expect(p).not.toHaveProperty('balance_owing')
  })

  it('no reason ⇒ 400 close_reason_required and nothing is written', async () => {
    arm(ENG({ stage: 'Closed Won', closed_reason: 'won' }))
    const res = await post('e1')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('close_reason_required')
    expect(engagementUpdate()).toBeUndefined()
    expect(h.state.calls.find(c => c.table === 'touchpoints')).toBeUndefined()
    expect(writeSyncLog).not.toHaveBeenCalled()
  })

  it('a whitespace-only reason is no reason (400, nothing written)', async () => {
    arm(ENG({ stage: 'Closed Won', closed_reason: 'won' }))
    const res = await post('e1', { reason: '   ' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('close_reason_required')
    expect(engagementUpdate()).toBeUndefined()
  })

  it('an accidentally-won deal with no jobs and no invoices lands on Request', async () => {
    arm(ENG({ stage: 'Closed Won', closed_reason: 'won' }))
    armChildren({})
    armWrites()
    const res = await post('e1', { reason: 'Dragged by mistake' })
    expect(res.status).toBe(200)
    expect((await res.json()).stage).toBe('Request')
    expect(updatePayload().stage).toBe('Request')
  })

  it('the touchpoint and sync_log lines carry the reason', async () => {
    arm(ENG({ stage: 'Closed Won', closed_reason: 'won' }))
    armChildren(WON_CHILDREN)
    armWrites()
    await post('e1', { reason: '  Client disputed the last visit  ' })
    const tp = touchpointInsert()
    expect(tp.kind).toBe('stage_change')
    expect(tp.label).toContain('Closed Won → Final Processing')
    expect(tp.label).toContain('Client disputed the last visit')
    expect(lastSyncLog().message).toContain('Client disputed the last visit')
    expect(lastSyncLog().message).toContain('Closed Won → Final Processing')
  })

  it('lite_user is refused on a Won undo', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'lite_user', location_id: 'loc-uuid-1' })
    const res = await post('e1', { reason: 'x' })
    expect(res.status).toBe(403)
    expect(engagementUpdate()).toBeUndefined()
  })

  it('an owner at another location is refused on a Won undo', async () => {
    arm(ENG({ stage: 'Closed Won', closed_reason: 'won' }), 'owner', 'other-loc')
    const res = await post('e1', { reason: 'x' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_wrong_location')
    expect(engagementUpdate()).toBeUndefined()
  })
})

describe('undo Closed Lost — unchanged', () => {
  it('needs no reason and re-derives as before', async () => {
    arm(ENG({ stage: 'Closed Lost' }), 'owner', 'loc-uuid-1')
    armChildren({ quotes: [{ status: 'sent', sent_at: new Date().toISOString() }] })
    armWrites()
    const res = await post('e1')
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.stage).toBe('Estimate')
    expect(j.prev_stage).toBe('Closed Lost')
    expect(touchpointInsert().label).toBe('Reopened: Closed Lost → Estimate')
  })

  it('Lost path keeps live derivation exactly as before (paid-in-full records ⇒ Closed Won)', async () => {
    arm(ENG({ stage: 'Closed Lost' }))
    armChildren(WON_CHILDREN)
    armWrites()
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect((await res.json()).stage).toBe('Closed Won')
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

describe('sync_log breadcrumb — no PII (#110a)', () => {
  it('reopen row carries the client lead UUID, never the client name', async () => {
    arm(ENG({ stage: 'Closed Lost' }))
    armChildren({ quotes: [{ status: 'sent', sent_at: new Date().toISOString() }] })
    h.enqueue('engagements', null)                              // the update
    h.enqueue('touchpoints', null)                             // stage_change trail
    h.enqueue('leads', { location_id: 'loc1', name: 'Jane Q Customer' })
    const res = await post('e1')
    expect(res.status).toBe(200)
    const logged = (writeSyncLog as any).mock.calls.map((c: any) => c[0])
    const row = logged[logged.length - 1]
    expect(row.entity_id).toBe('e1')            // engagement UUID
    expect(row.message).toContain('c1')          // client lead UUID — joinable
    expect(row.message).not.toContain('Jane Q Customer')
  })
})
