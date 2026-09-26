// @vitest-environment node
//
// Kitchen this month, bedroom next month (Kevin, 2026-09-26). A client with
// an OPEN kitchen engagement phones about the bedroom; the owner presses
// "New job in Jobber" on their card, the request lands on the SAME Jobber
// client, and the REQUEST_CREATE webhook runs ensureEngagementForServiceRequest.
// Kevin wants two cards, not one: the bedroom must found its OWN engagement
// beside the kitchen, never be folded into it.
//
// Same recording supabaseService mock as beta-returning-engagement.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in', 'delete']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { ensureEngagementForServiceRequest } from '@/lib/engagements'

const LEAD = { id: 'martha', location_uuid: 'loc-uuid-1', location_id: 'loc_chattanooga', name: 'Martha Wassel', request_details: null, project_type: null }
const inserts = () => h.state.calls
  .filter(c => c.table === 'engagements')
  .flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))

beforeEach(() => h.reset())

describe('kitchen then bedroom — two separate engagements', () => {
  it('the bedroom request founds a NEW engagement beside the open kitchen one', async () => {
    // The kitchen: open, founded by its own request (the normal path).
    h.enqueue('service_requests', { engagement_id: null })              // bedroom SR not yet on an engagement
    h.enqueue('engagements', [{ id: 'eng-kitchen', stage: 'Job in Progress', founded_by: 'request', created_at: '2026-09-02T00:00:00Z' }])
    // foundEngagement: SR read → lead read → insert → SR link → assignee seed
    h.enqueue('service_requests', { engagement_id: null, id: 'sr-bedroom', notes: '', requested_at: '2026-09-26T15:00:00Z', created_at: null })
    h.enqueue('leads', LEAD)
    h.enqueue('engagements', { id: 'eng-bedroom' })
    h.enqueue('service_requests', [{ id: 'sr-bedroom' }])
    h.enqueue('lead_assignees', [])

    const res = await ensureEngagementForServiceRequest('sr-bedroom', 'martha')

    expect(res).toEqual({ id: 'eng-bedroom', created: true })
    expect(res!.id).not.toBe('eng-kitchen')
    const rows = inserts()
    expect(rows, 'exactly one new engagement — the bedroom').toHaveLength(1)
    expect(rows[0]).toMatchObject({ client_id: 'martha', founded_by: 'request' })
    // The kitchen was never written to: nothing attached the bedroom SR to it.
    const kitchenWrites = h.state.calls.filter(c =>
      c.ops.some(o => o[0] === 'eq' && o[1][0] === 'id' && o[1][1] === 'eng-kitchen'))
    expect(kitchenWrites).toHaveLength(0)
  })

  it('a kitchen that was itself hand-started AND already has its request still stays separate', async () => {
    h.enqueue('service_requests', { engagement_id: null })
    h.enqueue('engagements', [{ id: 'eng-kitchen', stage: 'Estimate', founded_by: 'manual', created_at: '2026-09-02T00:00:00Z' }])
    h.enqueue('service_requests', [{ id: 'sr-kitchen' }])              // the kitchen owns its request → not adoptable
    h.enqueue('service_requests', { engagement_id: null, id: 'sr-bedroom', notes: '', requested_at: null, created_at: null })
    h.enqueue('leads', LEAD)
    h.enqueue('engagements', { id: 'eng-bedroom' })
    h.enqueue('service_requests', [{ id: 'sr-bedroom' }])
    h.enqueue('lead_assignees', [])

    const res = await ensureEngagementForServiceRequest('sr-bedroom', 'martha')
    expect(res).toEqual({ id: 'eng-bedroom', created: true })
    expect(inserts()).toHaveLength(1)
  })
})
