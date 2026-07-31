// @vitest-environment node
//
// #66 — REQUEST_DESTROY leaves a stale service_requests row.
//
// handleRequestDestroy nulls the lead's linkage columns (only ever set by
// Send-to-Jobber) but historically never touched the service_requests mirror
// — leaving a phantom "Request" on the engagement card. cleanupDestroyedRequest
// now deletes the stale SR and soft-closes the engagement it founded when
// nothing else is left. Pins per rule:
//   — the SR is deleted keyed off service_requests.jobber_request_id (the
//     reliable key), NOT the lead column
//   — a request-founded, now-empty engagement is SOFT-closed (Closed Lost /
//     closed_reason='request_destroyed'), NEVER deleted (engagement_assignees
//     is ON DELETE CASCADE — the #66 trap)
//   — an engagement that advanced past Request (SR has a downstream
//     quote/job/invoice) is left fully intact, stage untouched, SR kept
//   — an engagement still holding another child (another SR) is left intact
//   — a manual container (founded_by='manual') is never closed
//   — a cleanup failure NEVER fails the webhook (still processed=true)
//   — engagement_assignees is NEVER read or written
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (shared beta pattern): per-table FIFO
//    response queues + a call log to assert what touched which table. ──
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
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
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn() }))

import { handleRequestDestroy } from '@/lib/jobber-webhook-handlers'

const ctx = (over: any = {}) => ({
  topic: 'REQUEST_DESTROY',
  itemId: '555',
  accountId: 'acct-1',
  occurredAt: '2026-07-24T23:40:00Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test Location' },
  ...over,
}) as any

// Enqueue the lead read+update that nullifyLeadJobberColumns performs before
// the SR cleanup runs. `lead` null = imported request (no lead carries the id).
const enqueueLead = (lead: any) => {
  h.enqueue('leads', lead)   // the match read
  if (lead) h.enqueue('leads', null) // the nullify update
}

// All the tables the cleanup touches, keyed by table name, for a compact
// "was this table hit / with what op" assertion.
const callsTo = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOn = (table: string) =>
  callsTo(table).flatMap(c => c.ops.map(([m]) => m))

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('#66 REQUEST_DESTROY — deletes the stale SR mirror', () => {
  it('imported request (no lead match): still finds + deletes the SR by jobber_request_id', async () => {
    enqueueLead(null) // imported → nullify no-ops (no lead has jobber_request_id)
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' }) // find
    // no quote/job/invoice children of the SR → childless
    h.enqueue('assessments', null)          // assessment delete
    h.enqueue('service_requests', null)     // SR delete
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request', founded_by: 'request' }) // read
    // no remaining children on the engagement
    h.enqueue('engagements', null)          // soft-close update

    const res = await handleRequestDestroy(ctx())

    expect(res.processed).toBe(true)
    // the SR was deleted, keyed off the SR table (not the lead column)
    const srDeletes = callsTo('service_requests').filter(c => c.ops.some(([m]) => m === 'delete'))
    expect(srDeletes.length).toBe(1)
    expect(res.note).toContain('deleted stale SR sr-1')
  })
})

describe('#66 engagement handling', () => {
  it('request-founded + nothing left → SOFT-close (Closed Lost / request_destroyed), never delete', async () => {
    enqueueLead(null)
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' })
    h.enqueue('assessments', null)
    h.enqueue('service_requests', null) // delete
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request', founded_by: 'request' })
    h.enqueue('engagements', null)      // update

    const res = await handleRequestDestroy(ctx())

    const engUpdate = callsTo('engagements').find(c => c.ops.some(([m]) => m === 'update'))
    expect(engUpdate).toBeTruthy()
    const patch = engUpdate!.ops.find(([m]) => m === 'update')![1][0]
    expect(patch.stage).toBe('Closed Lost')
    expect(patch.closed_reason).toBe('request_destroyed')
    // NEVER a hard delete of the engagement (would cascade assignees)
    expect(opsOn('engagements')).not.toContain('delete')
    expect(res.note).toContain('closed empty engagement eng-1')
  })

  it('advanced past Request (SR has a downstream quote) → SR kept, engagement untouched', async () => {
    enqueueLead(null)
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' })
    h.enqueue('quotes', [{ id: 'q1' }]) // SR has a child quote → real history

    const res = await handleRequestDestroy(ctx())

    expect(res.processed).toBe(true)
    // SR NOT deleted, engagement NOT read/updated
    expect(opsOn('service_requests')).not.toContain('delete')
    expect(callsTo('engagements').length).toBe(0)
    expect(res.note).toContain('kept')
  })

  it('engagement holds another SR → destroyed SR removed, engagement left open', async () => {
    enqueueLead(null)
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' }) // find
    // sr-1 itself is childless
    h.enqueue('quotes', [])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('assessments', null)
    h.enqueue('service_requests', null) // delete sr-1
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request', founded_by: 'request' })
    h.enqueue('service_requests', [{ id: 'sr-2' }]) // remaining-children probe → another SR

    const res = await handleRequestDestroy(ctx())

    // sr-1 deleted, but engagement NOT closed (other work remains)
    const srDeletes = callsTo('service_requests').filter(c => c.ops.some(([m]) => m === 'delete'))
    expect(srDeletes.length).toBe(1)
    expect(opsOn('engagements')).not.toContain('update')
    expect(res.note).toContain('other children remain')
  })

  it('manual container (founded_by=manual) → SR removed, engagement never closed', async () => {
    enqueueLead(null)
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-9' })
    h.enqueue('quotes', [])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('assessments', null)
    h.enqueue('service_requests', null) // delete
    h.enqueue('engagements', { id: 'eng-9', stage: 'Request', founded_by: 'manual' })

    const res = await handleRequestDestroy(ctx())

    expect(opsOn('engagements')).not.toContain('update')
    expect(res.note).toContain('founded_by=manual')
  })
})

describe('#66 fail-soft + assignee safety', () => {
  it('cleanup throws (SR delete errors) → webhook still returns processed=true', async () => {
    enqueueLead(null)
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' })
    h.enqueue('quotes', [])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('assessments', null)
    h.enqueue('service_requests', null, { message: 'boom' }) // delete FAILS

    const res = await handleRequestDestroy(ctx())

    expect(res.processed).toBe(true) // fail-soft: bookkeeping error never fails the webhook
  })

  it('SR was never imported (no SR found) → clean no-op, webhook processed', async () => {
    enqueueLead(null)
    // nothing enqueued for service_requests → find returns null
    const res = await handleRequestDestroy(ctx())
    expect(res.processed).toBe(true)
    expect(opsOn('service_requests')).not.toContain('delete')
    expect(callsTo('engagements').length).toBe(0)
  })

  it('engagement_assignees is NEVER read or written across any path', async () => {
    // run the full soft-close path
    enqueueLead(null)
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' })
    h.enqueue('assessments', null)
    h.enqueue('service_requests', null)
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request', founded_by: 'request' })
    h.enqueue('engagements', null)

    await handleRequestDestroy(ctx())

    expect(callsTo('engagement_assignees').length).toBe(0)
  })
})
