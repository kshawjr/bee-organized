// @vitest-environment node
//
// INVOICE_UPDATE webhook wiring (production bug: Jobber emits INVOICE_UPDATE
// — not a distinct INVOICE_PAID — when an invoice is marked paid, and the
// topic was absent from TOPIC_HANDLERS, so payments fell through to
// "[skipped] unknown topic" and never synced. That stalled every live deal
// at Final Processing's predecessor, so the Mark-won button never surfaced.)
//
// Pins:
//   — INVOICE_UPDATE is registered → routes to the invoice handler, NOT the
//     unknown-topic skip; a genuinely-unknown topic stays out of the map so
//     the route's skip fallback still fires for it.
//   — A PAID INVOICE_UPDATE upserts the invoice, attaches it, and triggers
//     the LIVE engagement re-derivation (maybeAdvanceEngagementStage), plus
//     zeroes the balance + stamps invoice_paid_at + promotes → 'Closed Won'.
//     Paid-ness is DERIVED from the fetched invoiceStatus, not the topic
//     (mirrors JOB_UPDATE deriving its promotion from the refreshed status).
//   — A non-paid INVOICE_UPDATE still re-derives the engagement (a balance
//     change can matter) but does NOT promote to Closed Won and does NOT
//     re-stamp invoice_created_at.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock (per-table FIFO queue + call recording),
//    same shape as beta-webhook-landed.test.ts. ────────────────────
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
  // last leads.update(...) payload, for asserting the denormalization
  const leadsUpdatePayload = () => {
    const call = [...state.calls].reverse().find(c =>
      c.table === 'leads' && c.ops.some(o => o[0] === 'update'))
    return call?.ops.find(o => o[0] === 'update')?.[1][0] as Record<string, any> | undefined
  }
  return { state, reset, enqueue, makeBuilder, leadsUpdatePayload }
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
const drip = vi.hoisted(() => ({ applyDripSideEffects: vi.fn(async () => {}) }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: jobber.jobberGraphQL }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: drip.applyDripSideEffects }))
vi.mock('@/lib/jobber-disconnect', () => ({
  disconnectJobberFromLocation: vi.fn(async () => ({ error: null })),
}))
vi.mock('@/lib/engagements', () => eng)
// Full stub of jobber-import: real ID helpers aren't needed (jobberGraphQL is
// mocked), so lightweight stand-ins keep the numeric extraction deterministic.
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

import {
  TOPIC_HANDLERS,
  SUPPORTED_TOPICS,
  handleInvoiceUpdate,
} from '@/lib/jobber-webhook-handlers'

const ctx = (over: any = {}) => ({
  topic: 'INVOICE_UPDATE',
  itemId: '999',
  occurredAt: '2026-07-11T14:00:00Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test' } as any,
  ...over,
})

// A requestless (client-attached) invoice — no jobs — so the pipeline takes
// the findLeadByJobberClientId branch and skips SR/job lookups.
const invoiceRecord = (invoiceStatus: string) => ({
  data: {
    invoice: {
      id: '999',
      invoiceStatus,
      jobberWebUri: 'https://jobber/x',
      amounts: { total: '500.00', subtotal: '500.00' },
      client: { id: '888' },
      jobs: { nodes: [] },
    },
  },
})

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  eng.resolveEngagementForChild.mockResolvedValue('eng-1')
  imp.upsertInvoice.mockResolvedValue({ id: 'inv-db-1', created: false, status: 'paid' })
  imp.promoteLeadStage.mockResolvedValue({ prevStage: 'Job in Progress', promoted: true })
})

describe('INVOICE_UPDATE is wired (not skipped)', () => {
  it('routes INVOICE_UPDATE → handleInvoiceUpdate', () => {
    expect(SUPPORTED_TOPICS).toContain('INVOICE_UPDATE')
    expect(TOPIC_HANDLERS.INVOICE_UPDATE).toBe(handleInvoiceUpdate)
  })

  it('genuinely-unknown topics stay OUT of the map (route skip fallback still fires)', () => {
    // The route skips any topic not in SUPPORTED_TOPICS; these must never
    // sneak in just because we widened invoice coverage.
    expect(SUPPORTED_TOPICS).not.toContain('VISIT_COMPLETE')
    expect(SUPPORTED_TOPICS).not.toContain('INVOICE_FROBNICATE')
    expect(TOPIC_HANDLERS['VISIT_COMPLETE']).toBeUndefined()
  })
})

describe('paid INVOICE_UPDATE (the payment event) → syncs + live re-derivation', () => {
  it('upserts the invoice, attaches it, and triggers maybeAdvanceEngagementStage', async () => {
    jobber.jobberGraphQL.mockResolvedValue(invoiceRecord('PAID'))
    h.enqueue('leads', { id: 'lead-1', stage: 'Job in Progress' })

    const res = await handleInvoiceUpdate(ctx())

    // invoice row upserted from the fetched (PAID) record
    expect(imp.upsertInvoice).toHaveBeenCalledTimes(1)
    expect(imp.upsertInvoice.mock.calls[0][0]).toMatchObject({ invoiceStatus: 'PAID' })
    // attached + LIVE engagement re-derivation fired
    expect(eng.attachToEngagement).toHaveBeenCalledWith('invoices', 'inv-db-1', 'eng-1')
    expect(eng.maybeAdvanceEngagementStage).toHaveBeenCalledWith('eng-1')

    expect(res).toMatchObject({
      processed: true,
      lead_id: 'lead-1',
      lead_stage: 'Closed Won',
      prev_stage: 'Job in Progress',
    })
  })

  it('zeroes balance, stamps invoice_paid_at, and forward-promotes → Closed Won', async () => {
    jobber.jobberGraphQL.mockResolvedValue(invoiceRecord('PAID'))
    h.enqueue('leads', { id: 'lead-1', stage: 'Job in Progress' })

    await handleInvoiceUpdate(ctx())

    const patch = h.leadsUpdatePayload()!
    expect(patch.balance_owing).toBe(0)
    expect(patch.paid_amount).toBe(500)
    expect(patch.invoice_paid_at).toBe('2026-07-11T14:00:00Z')
    expect(patch.invoice_created_at).toBeUndefined()

    expect(imp.promoteLeadStage).toHaveBeenCalledWith('lead-1', 'Closed Won')
    expect(drip.applyDripSideEffects).toHaveBeenCalledTimes(1)
  })
})

describe('non-paid INVOICE_UPDATE (a plain edit) → refresh only', () => {
  it('re-derives the engagement but does NOT promote to Closed Won', async () => {
    jobber.jobberGraphQL.mockResolvedValue(invoiceRecord('SENT'))
    h.enqueue('leads', { id: 'lead-1', stage: 'Job in Progress' })

    const res = await handleInvoiceUpdate(ctx())

    expect(imp.upsertInvoice).toHaveBeenCalledTimes(1)
    // engagement is still re-derived — a balance change can move stage
    expect(eng.maybeAdvanceEngagementStage).toHaveBeenCalledWith('eng-1')
    // ...but no Closed Won promotion + no drip stop for an unpaid edit
    expect(imp.promoteLeadStage).not.toHaveBeenCalled()
    expect(drip.applyDripSideEffects).not.toHaveBeenCalled()

    const patch = h.leadsUpdatePayload()!
    expect(patch.balance_owing).toBe(500)
    expect(patch.invoice_paid_at).toBeUndefined()
    // invoice_created_at is a create-time stamp — an UPDATE must not set it
    expect(patch.invoice_created_at).toBeUndefined()

    expect(res.processed).toBe(true)
  })
})
