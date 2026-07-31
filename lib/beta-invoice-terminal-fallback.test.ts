// @vitest-environment node
//
// #98 — invoices orphan when ALL of a client's engagements are terminal.
//
// Production bug (KC invoice 165190116, $556.20): an invoice billed straight
// to a client with no job and no request. resolveEngagementForChild walked
// rule 1 (SR) → rule 3 (job) → rule 5 (findOpenEngagementForClient), all
// missed, and rule 5 deliberately excludes terminal stages (Closed Won/Lost).
// The client's only engagement was Closed Won, so the resolver returned null,
// upsertInvoice left engagement_id null, and the money sat off the card.
//
// Rule 6 (invoice-only): when no OPEN engagement resolves, fall back to the
// client's MOST-RECENT engagement of ANY stage — the money belongs on the
// latest deal even after it closed. Safe because maybeAdvanceEngagementStage
// never moves a terminal stage, so attaching cannot reopen a closed deal.
//
// These drive the REAL resolveEngagementForChild against a query-level
// supabaseService mock (not the handler, which mocks the resolver away).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock: per-table FIFO queue + call recording,
//    same shape as beta-requestless-invoice-attach.test.ts, plus `count`
//    support for head:true count() reads. ──────────────────────────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, opts: { error?: any; count?: number | null } = {}) =>
    state.queue.push({ table, resp: { data, error: opts.error ?? null, count: opts.count ?? null } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null, count: null }
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
  const callsFor = (table: string) => state.calls.filter(c => c.table === table)
  // the args of the Nth op of a given name against a table, across all calls
  const opArgs = (table: string, op: string) =>
    state.calls.filter(c => c.table === table).flatMap(c => c.ops.filter(o => o[0] === op).map(o => o[1]))
  return { state, reset, enqueue, makeBuilder, callsFor, opArgs }
})

const sync = vi.hoisted(() => ({ writeSyncLog: vi.fn(async () => {}) }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: sync.writeSyncLog }))

import { resolveEngagementForChild } from '@/lib/engagements'

// The invoice's own row (readEngagementIdOf('invoices', ...)) — fresh, so
// engagement_id is null (not yet attached).
const freshInvoiceRow = () => h.enqueue('invoices', { engagement_id: null })

const invoiceParams = (leadId = 'client-1') => ({
  childTable: 'invoices' as const,
  childId: 'inv-db-1',
  leadId,
  serviceRequestId: null,   // no request
  jobDbId: null,            // no job (jobs:{nodes:[]} in Jobber)
  locationSlug: 'loc_kc',
})

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('#98 rule 6 — invoice attaches to the most-recent engagement of any stage', () => {
  it('client has ONLY a Closed Won engagement → attaches to it', async () => {
    freshInvoiceRow()
    h.enqueue('engagements', [])                 // rule 5 findOpen → excluded (terminal) → none
    h.enqueue('engagements', [], { count: 1 })   // priorCount
    h.enqueue('engagements', [{ id: 'eng-won', stage: 'Closed Won' }]) // rule 6 most-recent

    const id = await resolveEngagementForChild(invoiceParams())

    expect(id).toBe('eng-won')
    // it was a rule-6 attach, logged as such — never a founding/insert
    expect(h.opArgs('engagements', 'insert')).toHaveLength(0)
    expect(sync.writeSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/rule 6/) }),
    )
  })

  it('client has ONLY a Closed Lost engagement → still attaches to it (no preference ordering)', async () => {
    freshInvoiceRow()
    h.enqueue('engagements', [])
    h.enqueue('engagements', [], { count: 1 })
    h.enqueue('engagements', [{ id: 'eng-lost', stage: 'Closed Lost' }])

    const id = await resolveEngagementForChild(invoiceParams())

    expect(id).toBe('eng-lost')
    expect(h.opArgs('engagements', 'insert')).toHaveLength(0)
  })

  it('client has an OPEN engagement → rule 5 wins, the rule-6 fallback is never reached', async () => {
    freshInvoiceRow()
    // rule 5 returns an open engagement — the fallback query must never run
    h.enqueue('engagements', [{ id: 'eng-open', stage: 'Job in Progress', created_at: '2026-01-01', founded_by: 'request' }])
    h.enqueue('engagements', [], { count: 2 })   // priorCount (runs before the openEng branch returns)

    const id = await resolveEngagementForChild(invoiceParams())

    expect(id).toBe('eng-open')
    // exactly two engagements reads: findOpen + priorCount. A THIRD would mean
    // rule 6 fired — it must not.
    expect(h.callsFor('engagements')).toHaveLength(2)
  })

  it('client has NO engagements at all → still null, invoices never found', async () => {
    freshInvoiceRow()
    h.enqueue('engagements', [])                 // findOpen → none
    h.enqueue('engagements', [], { count: 0 })   // priorCount → 0
    h.enqueue('engagements', [])                 // rule 6 most-recent → none

    const id = await resolveEngagementForChild(invoiceParams())

    expect(id).toBeNull()
    expect(h.opArgs('engagements', 'insert')).toHaveLength(0)  // no implicit founding for invoices
  })
})

describe('#98 — attaching to a terminal engagement does not change its stage', () => {
  it('maybeAdvanceEngagementStage on a Closed Won engagement with a new unpaid invoice writes no stage move', async () => {
    const { maybeAdvanceEngagementStage } = await import('@/lib/engagements')
    h.enqueue('engagements', { id: 'eng-won', stage: 'Closed Won', closed_reason: 'won' }) // eng read
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [])
    // the freshly-attached invoice: sent/unpaid — real money, not yet paid
    h.enqueue('invoices', [{ status: 'sent', total: 556.2, paid_amount: null, balance_owing: 556.2 }])
    h.enqueue('engagements', null)  // the update

    const res = await maybeAdvanceEngagementStage('eng-won')

    expect(res.advanced).toBe(false)
    // the rollup update carried NO stage / stage_entered_at / closed_reason
    const updateArgs = h.opArgs('engagements', 'update')
    expect(updateArgs).toHaveLength(1)
    const patch = updateArgs[0][0]
    expect(patch).not.toHaveProperty('stage')
    expect(patch).not.toHaveProperty('stage_entered_at')
    // ...but it DID refresh the money so the $556.20 shows on the card
    expect(patch.total_invoiced).toBe(556.2)
    expect(patch.balance_owing).toBe(556.2)
  })
})

describe('#98 — quotes and jobs are unaffected (rule 6 is invoice-only)', () => {
  it('a quote with an open engagement still resolves via rule 5', async () => {
    h.enqueue('quotes', { engagement_id: null })  // readEngagementIdOf('quotes')
    h.enqueue('engagements', [{ id: 'eng-open', stage: 'Estimate Sent', created_at: '2026-01-01', founded_by: 'request' }])
    h.enqueue('engagements', [], { count: 1 })    // priorCount

    const id = await resolveEngagementForChild({
      childTable: 'quotes', childId: 'q-db-1', leadId: 'client-1', locationSlug: 'loc_kc',
    })

    expect(id).toBe('eng-open')
  })

  it('a job with NO open engagement founds implicitly (insert), never a terminal-fallback attach', async () => {
    h.enqueue('jobs', { engagement_id: null })    // readEngagementIdOf('jobs')
    h.enqueue('engagements', [])                  // findOpen → none
    h.enqueue('engagements', [], { count: 0 })    // priorCount
    // foundEngagement path (childTable !== 'invoices'):
    h.enqueue('jobs', { id: 'job-db-1', engagement_id: null, created_at: '2026-01-01' }) // founding child read
    h.enqueue('leads', { id: 'client-1', location_uuid: 'loc-uuid-1', location_id: 'loc_kc', name: 'X' })
    h.enqueue('engagements', { id: 'new-eng' })   // the INSERT ... .single()
    h.enqueue('jobs', [{ id: 'job-db-1' }])       // link update ... .select('id')

    const id = await resolveEngagementForChild({
      childTable: 'jobs', childId: 'job-db-1', leadId: 'client-1', locationSlug: 'loc_kc',
    })

    expect(id).toBe('new-eng')
    // it founded (inserted), which the invoice path never does
    expect(h.opArgs('engagements', 'insert')).toHaveLength(1)
  })
})
