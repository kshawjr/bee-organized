// @vitest-environment node
//
// #122 — Archiving a request in Jobber arrives as REQUEST_UPDATE, not a
// DESTROY. The archive state rides requestStatus (enum value 'archived');
// there is NO Request.isArchived. SINGLE_REQUEST_QUERY now selects
// requestStatus, and handleRequestUpdate runs the SAME #66 stale-mirror +
// engagement tidy as a destroy — with ONE critical divergence:
//
//   the request STILL EXISTS in Jobber, so jobber_request_id is NEVER nulled.
//   (A destroy nulls it; nulling it on archive would let a re-fetch / re-import
//    re-link the row and fight the archive.)
//
// Pins:
//   — archived + childless SR → SR deleted, request-founded empty engagement
//     SOFT-closed (Closed Lost / request_destroyed), jobber_request_id NOT nulled
//   — archived + SR has downstream work → SR kept, engagement intact, link intact
//   — a non-archived UPDATE ingests exactly as before (no cleanup)
//   — a cleanup failure NEVER fails the webhook (still processed=true)
//   — engagement_assignees is NEVER read or written (the #66 cascade trap)
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabaseService mock — same shared beta pattern as
// beta-request-destroy-cleanup.test.ts (per-table FIFO queues + call log).
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

// Keep the real query constant + id helpers; stub only the DB-writing upserts
// so a NON-archived request can flow through fetchAndUpsertRequest without a
// live Supabase.
vi.mock('@/lib/jobber-import', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/jobber-import')>()
  return {
    ...mod,
    upsertLead: vi.fn(async () => ({ id: 'lead-1', stage: 'Nurturing' })),
    upsertServiceRequest: vi.fn(async () => ({ id: 'sr-1', prev_lead_stage: 'Nurturing' })),
    upsertAssessment: vi.fn(async () => null),
  }
})
vi.mock('@/lib/engagements', () => ({
  ensureEngagementForServiceRequest: vi.fn(async () => ({ id: 'eng-1' })),
  resolveEngagementForChild: vi.fn(async () => null),
  attachToEngagement: vi.fn(async () => {}),
  maybeAdvanceEngagementStage: vi.fn(async () => {}),
}))

import { handleRequestUpdate } from '@/lib/jobber-webhook-handlers'
import { jobberGraphQL } from '@/lib/jobber'

const ctx = (over: any = {}) => ({
  topic: 'REQUEST_UPDATE',
  itemId: '28564073',
  accountId: 'acct-1',
  occurredAt: '2026-07-31T05:47:50Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test Location' },
  ...over,
}) as any

// Jobber returns a request with the given requestStatus. Client is always
// present (fetchAndUpsertRequest requires it).
const jobberReturns = (requestStatus: string, extra: any = {}) =>
  vi.mocked(jobberGraphQL).mockResolvedValue({
    data: {
      request: {
        id: 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMjg1NjQwNzM=',
        createdAt: '2026-04-12T03:42:41Z',
        jobberWebUri: 'https://secure.getjobber.com/requests/28564073',
        requestStatus,
        client: { id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzYyOTU2NzM=', firstName: 'John', lastName: 'Smith' },
        assessment: null,
        quotes: { nodes: [] },
        jobs: { nodes: [] },
        ...extra,
      },
    },
    errors: undefined,
  } as any)

const callsTo = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOn = (table: string) => callsTo(table).flatMap(c => c.ops.map(([m]) => m))

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('#122 REQUEST_UPDATE archived — childless request', () => {
  it('archived + empty → SR deleted, engagement soft-closed, jobber_request_id NOT nulled', async () => {
    jobberReturns('archived')
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' }) // find
    h.enqueue('assessments', null)          // assessment delete
    h.enqueue('service_requests', null)     // SR delete
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request', founded_by: 'request' }) // read
    h.enqueue('engagements', null)          // soft-close update

    const res = await handleRequestUpdate(ctx())

    expect(res.processed).toBe(true)
    // SR deleted, keyed off the SR table.
    const srDeletes = callsTo('service_requests').filter(c => c.ops.some(([m]) => m === 'delete'))
    expect(srDeletes.length).toBe(1)
    // Engagement SOFT-closed, never deleted.
    const engUpdate = callsTo('engagements').find(c => c.ops.some(([m]) => m === 'update'))
    const patch = engUpdate!.ops.find(([m]) => m === 'update')![1][0]
    expect(patch.stage).toBe('Closed Lost')
    expect(patch.closed_reason).toBe('request_destroyed')
    expect(opsOn('engagements')).not.toContain('delete')
    // CRITICAL divergence from destroy: the lead's jobber_request_id is NEVER
    // touched — the archived path reaches cleanup WITHOUT nullifyLeadJobberColumns,
    // so the leads table is never read or written at all.
    expect(callsTo('leads').length).toBe(0)
    expect(res.note).toContain('→archived')
    expect(res.note).toContain('closed empty engagement eng-1')
  })

  it('engagement_assignees is NEVER touched on the archived path', async () => {
    jobberReturns('archived')
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' })
    h.enqueue('assessments', null)
    h.enqueue('service_requests', null)
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request', founded_by: 'request' })
    h.enqueue('engagements', null)

    await handleRequestUpdate(ctx())

    expect(callsTo('engagement_assignees').length).toBe(0)
  })
})

describe('#122 REQUEST_UPDATE archived — request with downstream work', () => {
  it('archived + SR has a quote → SR kept, engagement untouched, link intact', async () => {
    jobberReturns('archived')
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' }) // find
    h.enqueue('quotes', [{ id: 'q1' }]) // SR has a child quote → real history

    const res = await handleRequestUpdate(ctx())

    expect(res.processed).toBe(true)
    expect(opsOn('service_requests')).not.toContain('delete')
    expect(callsTo('engagements').length).toBe(0) // engagement never read/closed
    expect(callsTo('leads').length).toBe(0)       // jobber_request_id untouched
    expect(res.note).toContain('kept')
  })
})

describe('#122 REQUEST_UPDATE non-archived — unchanged behavior', () => {
  it('requestStatus new → ingests via upsert, no cleanup, reports stage', async () => {
    jobberReturns('new')
    h.enqueue('leads', { stage: 'Nurturing' }) // readLeadStage after ingest

    const res = await handleRequestUpdate(ctx())

    expect(res.processed).toBe(true)
    expect(res.lead_id).toBe('lead-1')
    expect(res.lead_stage).toBe('Nurturing')
    // No teardown: the cleanup path (service_requests via supabaseService) never runs.
    expect(callsTo('service_requests').length).toBe(0)
    expect(res.note ?? '').not.toContain('archived')
  })
})

describe('#122 REQUEST_UPDATE archived — fail-soft', () => {
  it('cleanup throws (SR delete errors) → webhook still processed=true', async () => {
    jobberReturns('archived')
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1', engagement_id: 'eng-1' })
    h.enqueue('assessments', null)
    h.enqueue('service_requests', null, { message: 'boom' }) // delete FAILS

    const res = await handleRequestUpdate(ctx())

    expect(res.processed).toBe(true) // fail-soft bookkeeping never fails the webhook
    expect(callsTo('leads').length).toBe(0) // still never nulls the link
  })
})
