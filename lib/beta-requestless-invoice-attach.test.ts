// @vitest-environment node
//
// Requestless-job invoices orphaned (production bug: Stephanie Sahagian's
// invoice 164346516 landed with job_id null, engagement_id null, and both its
// sync_log rows recorded not_landed).
//
// Jobber allows a job with no parent request (booked straight off a quote, or
// created by hand). handleInvoiceCore resolved the invoice's job_id INSIDE the
// `if (firstJob?.request?.id)` branch, so a requestless job never got looked
// up — job_id stayed null, resolveEngagementForChild had no rule-3 key, and
// the invoice attached to nothing. It then contributed to no engagement
// rollup and appeared on no board, while the money sat real in Jobber.
//
// Pins:
//   — A requestless job's invoice STILL resolves job_id (rule-3 key present).
//   — The request-having path is unchanged: SR resolved AND job_id resolved.
//   — An unattachable invoice surfaces a note (checkLanded independently
//     records not_landed) instead of passing silently as processed:true.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock (per-table FIFO queue + call recording),
//    same shape as beta-invoice-update-webhook.test.ts. ────────────────
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  // every .eq() arg pair seen against a table — used to assert WHICH job row
  // was looked up, not merely that some jobs query happened.
  const eqArgsFor = (table: string) =>
    state.calls.filter(c => c.table === table)
      .flatMap(c => c.ops.filter(o => o[0] === 'eq').map(o => o[1]))
  return { state, reset, enqueue, makeBuilder, eqArgsFor }
})

const eng = vi.hoisted(() => ({
  ensureEngagementForServiceRequest: vi.fn(async () => ({ id: 'eng-1' })),
  resolveEngagementForChild: vi.fn(async () => 'eng-1'),
  attachToEngagement: vi.fn(async () => {}),
  maybeAdvanceEngagementStage: vi.fn(async () => {}),
}))
const imp = vi.hoisted(() => ({
  upsertInvoice: vi.fn(async () => ({ id: 'inv-db-1', created: false, status: 'paid' })),
  promoteLeadStage: vi.fn(async () => ({ prevStage: 'Job in Progress', promoted: true })),
}))
const jobber = vi.hoisted(() => ({ jobberGraphQL: vi.fn() }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: jobber.jobberGraphQL }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-disconnect', () => ({
  disconnectJobberFromLocation: vi.fn(async () => ({ error: null })),
}))
vi.mock('@/lib/engagements', () => eng)
vi.mock('@/lib/jobber-import', () => ({
  SINGLE_CLIENT_QUERY: '', SINGLE_REQUEST_QUERY: '', SINGLE_QUOTE_QUERY: '',
  SINGLE_JOB_QUERY: '', SINGLE_INVOICE_QUERY: '', SINGLE_PROPERTY_QUERY: '',
  upsertLead: vi.fn(), upsertServiceRequest: vi.fn(), upsertAssessment: vi.fn(),
  upsertQuote: vi.fn(), upsertJob: vi.fn(),
  upsertInvoice: imp.upsertInvoice,
  promoteLeadStage: imp.promoteLeadStage,
  extractJobberId: (id: any) => (id == null ? null : String(id).replace(/\D/g, '') || String(id)),
  encodeJobberId: (type: string, id: any) => `gid://Jobber/${type}/${id}`,
  isUnbookedJobStatus: () => false,
  BOOKED_JOB_STATUSES: new Set<string>(),
}))

import { handleInvoiceUpdate } from '@/lib/jobber-webhook-handlers'

const ctx = (over: any = {}) => ({
  topic: 'INVOICE_UPDATE',
  itemId: '164346516',
  occurredAt: '2026-07-16T04:05:45Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_portland', name: 'Portland' } as any,
  ...over,
})

// Stephanie's real shape: one job, request=NONE (Jobber returned exactly this).
const requestlessInvoice = (invoiceStatus = 'PAST_DUE') => ({
  data: {
    invoice: {
      id: '164346516',
      invoiceStatus,
      jobberWebUri: 'https://jobber/x',
      amounts: { total: '1115.49', subtotal: '1115.49' },
      client: { id: '888' },
      jobs: { nodes: [{ id: 'gid://Jobber/Job/148323766', request: null }] },
    },
  },
})

// Same, but the job carries a parent request — the path that already worked.
const requestHavingInvoice = (invoiceStatus = 'PAID') => ({
  data: {
    invoice: {
      id: '999',
      invoiceStatus,
      jobberWebUri: 'https://jobber/x',
      amounts: { total: '500.00', subtotal: '500.00' },
      client: { id: '888' },
      jobs: { nodes: [{ id: 'gid://Jobber/Job/777', request: { id: 'gid://Jobber/Request/555' } }] },
    },
  },
})

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  eng.resolveEngagementForChild.mockResolvedValue('eng-1')
  imp.upsertInvoice.mockResolvedValue({ id: 'inv-db-1', created: false, status: 'sent' })
  imp.promoteLeadStage.mockResolvedValue({ prevStage: 'Job in Progress', promoted: true })
})

describe('requestless job → invoice still resolves its job (rule-3 key)', () => {
  it('looks up the job by its jobber id even though request is null', async () => {
    jobber.jobberGraphQL.mockResolvedValue(requestlessInvoice())
    h.enqueue('jobs', { id: 'job-db-1' })            // the hoisted job lookup
    h.enqueue('leads', { id: 'lead-1', stage: 'Job in Progress' }) // client branch

    await handleInvoiceUpdate(ctx())

    // the job WAS queried, by the right jobber_job_id
    expect(h.eqArgsFor('jobs')).toContainEqual(['jobber_job_id', '148323766'])
    // ...and that db id reached upsertInvoice's job_id arg (2nd positional)
    expect(imp.upsertInvoice).toHaveBeenCalledTimes(1)
    expect(imp.upsertInvoice.mock.calls[0][1]).toBe('job-db-1')
    // ...and reached rule 3
    expect(eng.resolveEngagementForChild).toHaveBeenCalledWith(
      expect.objectContaining({ childTable: 'invoices', jobDbId: 'job-db-1', serviceRequestId: null }),
    )
    expect(eng.attachToEngagement).toHaveBeenCalledWith('invoices', 'inv-db-1', 'eng-1')
  })

  it('REGRESSION: job_id is not null for a requestless job', async () => {
    jobber.jobberGraphQL.mockResolvedValue(requestlessInvoice())
    h.enqueue('jobs', { id: 'job-db-1' })
    h.enqueue('leads', { id: 'lead-1', stage: 'Job in Progress' })

    await handleInvoiceUpdate(ctx())

    // the exact bug: this arg used to be null, orphaning the invoice
    expect(imp.upsertInvoice.mock.calls[0][1]).not.toBeNull()
  })
})

describe('request-having path is unchanged', () => {
  it('still resolves BOTH the service request and the job', async () => {
    jobber.jobberGraphQL.mockResolvedValue(requestHavingInvoice())
    h.enqueue('jobs', { id: 'job-db-7' })
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-9' })
    h.enqueue('leads', { id: 'lead-9', stage: 'Job in Progress' })

    await handleInvoiceUpdate(ctx({ itemId: '999' }))

    expect(imp.upsertInvoice.mock.calls[0][1]).toBe('job-db-7')   // job_id
    expect(imp.upsertInvoice.mock.calls[0][2]).toBe('sr-1')       // service_request_id
    expect(imp.upsertInvoice.mock.calls[0][3]).toBe('lead-9')     // lead_id — from the SR, not the client
    expect(eng.resolveEngagementForChild).toHaveBeenCalledWith(
      expect.objectContaining({ jobDbId: 'job-db-7', serviceRequestId: 'sr-1' }),
    )
  })
})

describe('unattachable invoice is surfaced, not silent', () => {
  it('returns a note naming why when no engagement resolves', async () => {
    jobber.jobberGraphQL.mockResolvedValue(requestlessInvoice())
    eng.resolveEngagementForChild.mockResolvedValue(null as any)
    h.enqueue('jobs', { data: null })  // job row genuinely absent → jobDbId null
    h.enqueue('leads', { id: 'lead-1', stage: 'Job in Progress' })

    const res = await handleInvoiceUpdate(ctx())

    expect(res.processed).toBe(true)          // the invoice row DID write
    expect(res.note).toMatch(/engagement unresolved/)
    expect(eng.attachToEngagement).not.toHaveBeenCalled()
  })

  it('an attachable invoice carries no note', async () => {
    jobber.jobberGraphQL.mockResolvedValue(requestlessInvoice())
    h.enqueue('jobs', { id: 'job-db-1' })
    h.enqueue('leads', { id: 'lead-1', stage: 'Job in Progress' })

    const res = await handleInvoiceUpdate(ctx())

    expect(res.note).toBeUndefined()
  })
})
