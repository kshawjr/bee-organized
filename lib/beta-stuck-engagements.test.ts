// @vitest-environment node
//
// STUCK AT FINAL PROCESSING — the fix, pinned.
//
// Four owner reports, three locations, 160 stranded engagements: a job
// finished at no charge, archived without an invoice, or deleted in Jobber
// produced a done engagement with ZERO invoices, and the Mark-won gate
// (Final Processing + ≥1 invoice all paid) made it permanently uncloseable.
// Deleted jobs additionally froze their row at the last live status, holding
// engagements at 'Job in Progress' forever.
//
// The rules, per the brief:
//   · an archived job's engagement is CLOSEABLE (gate opens; the wizard —
//     which was always zero-invoice-ready — drives the close). It does NOT
//     auto-close: archived-with-no-invoice cannot be told from abandoned,
//     so the owner says which — the deliberate overrule of auto-close.
//   · a DELETED job's engagement closes on its own (Closed Lost
//     'job_deleted', Reopen-able) when every job was deleted and nothing
//     invoiced — through the same gated advance path as archived quotes.
//   · a zero-charge completion closes without claiming a cent.
//   · a genuinely open engagement is untouched.
//   · an unpaid finished job is never silently closed and never closeable
//     while money is owed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in', 'filter']) {
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
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn(), jobberMutation: vi.fn() }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  stopActiveDripsForLead: vi.fn(async () => {}),
}))

import { deriveEngagementStage, maybeAdvanceEngagementStage } from '@/lib/engagements'
import { invoicesSettled } from '@/components/hive/shared/closeEngagement'

const ARCHIVED_JOB = { status: 'archived', completed_at: '2026-08-01T00:00:00Z' }
const DELETED_JOB = { status: 'deleted', completed_at: null }
const ACTIVE_JOB = { status: 'upcoming', completed_at: null, scheduled_start: '2026-09-15T00:00:00Z' }
const PAID_INV = { status: 'paid', total: 500, paid_amount: 500, balance_owing: 0, paid_at: '2026-08-02T00:00:00Z' }
const UNPAID_INV = { status: 'sent', total: 500, paid_amount: 0, balance_owing: 500 }

const kids = (over: any = {}) => ({ sr: null, quotes: [], jobs: [], invoices: [], ...over })
const ADVANCE = { closeOnArchivedQuote: true, closeOnDeletedJobs: true } // what maybeAdvance passes

beforeEach(() => { h.reset(); vi.clearAllMocks() })

// ─── the derivation rules ─────────────────────────────────────────────

describe('archived jobs: closeable, never auto-closed', () => {
  it('archived + zero invoices rests at Final Processing in live mode — and the gate is OPEN', () => {
    const d = deriveEngagementStage(kids({ jobs: [ARCHIVED_JOB] }), { mode: 'live', closeWonOnDone: false, ...ADVANCE })
    expect(d.stage).toBe('Final Processing')
    // The fixed gate: settled includes zero invoices — the owner can close it.
    expect(invoicesSettled([])).toBe(true)
  })

  it('a zero-charge completion claims no revenue: totals stay 0 through the advance roll-up', async () => {
    h.enqueue('engagements', { id: 'e1', stage: 'Final Processing', closed_reason: null })
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [ARCHIVED_JOB])
    h.enqueue('invoices', [])
    await maybeAdvanceEngagementStage('e1')
    const upd = h.state.calls.filter(c => c.table === 'engagements').find(c => c.ops.some(([m]) => m === 'update'))
    const patch = upd!.ops.find(([m]) => m === 'update')![1][0]
    expect(patch.total_invoiced).toBe(0)
    expect(patch.total_paid).toBe(0)
    expect(patch.balance_owing).toBe(0)
    expect(patch.stage).toBeUndefined() // FP → FP: no auto-close, no revenue claim
  })
})

describe('deleted jobs close on their own', () => {
  it('every job deleted + nothing invoiced → Closed Lost job_deleted (gated path only)', () => {
    const d = deriveEngagementStage(kids({ jobs: [DELETED_JOB] }), { mode: 'live', ...ADVANCE })
    expect(d).toMatchObject({ stage: 'Closed Lost', closed_reason: 'job_deleted' })
    // The ungated paths (reopen, drift recovery) must NOT close — a human
    // reopen would otherwise be re-closed by the next panel open.
    const ungated = deriveEngagementStage(kids({ jobs: [DELETED_JOB] }), { mode: 'live' })
    expect(ungated.stage).not.toBe('Closed Lost')
  })

  it('a deleted job among live ones is simply invisible — the live job governs', () => {
    const d = deriveEngagementStage(kids({ jobs: [DELETED_JOB, ARCHIVED_JOB] }), { mode: 'live', closeWonOnDone: false, ...ADVANCE })
    expect(d.stage).toBe('Final Processing')
    const d2 = deriveEngagementStage(kids({ jobs: [DELETED_JOB, ACTIVE_JOB] }), { mode: 'live', ...ADVANCE })
    expect(d2.stage).toBe('Job in Progress')
  })

  it('an invoice blocks the deleted-close — money evidence keeps the deal open', () => {
    const d = deriveEngagementStage(kids({ jobs: [DELETED_JOB], invoices: [UNPAID_INV] }), { mode: 'live', ...ADVANCE })
    expect(d.stage).not.toBe('Closed Lost')
  })

  it('JOB_DESTROY marks the row deleted and the advance closes the engagement', async () => {
    const { handleJobDestroy } = await import('@/lib/jobber-webhook-handlers')
    // nullify: lead lookup + update
    h.enqueue('leads', { id: 'lead-1' })
    // job-row lookup, then the row UPDATE (its own builder consumes a slot)
    h.enqueue('jobs', [{ id: 'job-1', engagement_id: 'e1', status: 'upcoming' }])
    h.enqueue('jobs', null)
    // maybeAdvance reads: engagement + four child tables (jobs now deleted)
    h.enqueue('engagements', { id: 'e1', stage: 'Job in Progress', closed_reason: null })
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [{ status: 'deleted', completed_at: null }])
    h.enqueue('invoices', [])
    const res = await handleJobDestroy({
      topic: 'JOB_DESTROY', itemId: '777', accountId: 'a', occurredAt: 'x',
      location: { id: 'loc-uuid', location_id: 'loc_test', name: 'Test' },
    } as any)
    expect(res.processed).toBe(true)
    const jobsUpd = h.state.calls.filter(c => c.table === 'jobs').find(c => c.ops.some(([m]) => m === 'update'))
    expect(jobsUpd!.ops.find(([m]) => m === 'update')![1][0].status).toBe('deleted')
    const engUpd = h.state.calls.filter(c => c.table === 'engagements').find(c => c.ops.some(([m]) => m === 'update'))
    const patch = engUpd!.ops.find(([m]) => m === 'update')![1][0]
    expect(patch.stage).toBe('Closed Lost')
    expect(patch.closed_reason).toBe('job_deleted')
    expect(patch.closed_note).toContain('Reopen')
  })
})

describe('what must never close', () => {
  it('a genuinely open engagement is untouched — active work stays Job in Progress', () => {
    const d = deriveEngagementStage(kids({ jobs: [ACTIVE_JOB] }), { mode: 'live', ...ADVANCE })
    expect(d.stage).toBe('Job in Progress')
  })

  it('an unpaid finished job: never auto-closed, never closeable while money is owed', () => {
    // Live: rests at FP…
    const live = deriveEngagementStage(kids({ jobs: [ARCHIVED_JOB], invoices: [UNPAID_INV] }), { mode: 'live', closeWonOnDone: false, ...ADVANCE })
    expect(live.stage).toBe('Final Processing')
    // …import auto-close also refuses (fully-paid required there, unchanged)…
    const imp = deriveEngagementStage(kids({ jobs: [ARCHIVED_JOB], invoices: [UNPAID_INV] }), { mode: 'backfill', ...ADVANCE })
    expect(imp.stage).toBe('Final Processing')
    // …and the button gate refuses: an owing invoice is not settled.
    expect(invoicesSettled([UNPAID_INV])).toBe(false)
  })
})

describe('the Mark-won gate', () => {
  it('settled means paid, zero balance, or nothing invoiced — owing always refuses', () => {
    expect(invoicesSettled([])).toBe(true)                 // zero-charge / archived-no-invoice
    expect(invoicesSettled([PAID_INV])).toBe(true)          // the normal paid case
    expect(invoicesSettled([UNPAID_INV])).toBe(false)       // money owed → refused
    expect(invoicesSettled([PAID_INV, UNPAID_INV])).toBe(false)
  })

  it('the panel gates on Final Processing + invoicesSettled — the source pin', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/EngagementPanel.jsx'), 'utf8')
    expect(src).toContain("const canCloseWon = !!eng && eng.stage === 'Final Processing' && invoicesSettled(children.invoices || [])")
    // The old ≥1-paid-invoice gate is gone from the gate line.
    expect(src).not.toContain("canCloseWon = !!eng && eng.stage === 'Final Processing' && invoicesFullyPaid")
  })
})
