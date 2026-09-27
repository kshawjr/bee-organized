// @vitest-environment node
//
// PAID WORK CLOSED AS LOST + WRONG LIFETIME PAID TOTALS (2026-09-27).
//
// Bug one. Jobber's "action required" (alias on_hold) means the visits ran
// out. The import read every such job as unbooked, ignored the paid invoices
// on the same engagement, and applied the 30-day stale rule: 336 engagements
// with $1,259,308 paid sat at Closed Lost ('stale_on_import'), 271 of them
// Seattle. The in-app stale-Lost recovery never caught them because it only
// counted booked jobs. Now an action-required job on an engagement with a
// paid invoice (positive amount) is done work — NARROW: no paid invoice, or
// an 'unscheduled' job, reads exactly as before.
//
// Bug two. leads.paid_amount was overwritten with the last paid invoice's
// total instead of the sum (see beta-invoice-update-webhook.test.ts for the
// webhook end of it). The Seattle person below read -$92.58 lifetime.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'

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
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
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
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import {
  deriveEngagementStage,
  maybeAdvanceEngagementStage,
  recoverEngagementStageDrift,
} from '@/lib/engagements'
import { planStaleLostRecovery } from '@/lib/paid-work-repair'
import { sumPaidInvoices, sumBalanceOwing } from '@/lib/lead-paid-total'

const NOW = new Date('2026-09-27T00:00:00Z').getTime()
const kids = (over: any = {}) => ({ sr: null, quotes: [], jobs: [], invoices: [], ...over })
const job = (status: string, created_at = '2024-05-24T01:10:23Z') =>
  ({ status, completed_at: null, scheduled_start: null, created_at })
const paid = (amount: number, paid_at: string) =>
  ({ status: 'paid', total: amount, paid_amount: amount, balance_owing: 0, paid_at, issued_at: paid_at, created_at: paid_at })
const unpaid = (amount: number) =>
  ({ status: 'sent', total: amount, paid_amount: null, balance_owing: amount, paid_at: null, issued_at: '2024-06-01T00:00:00Z', created_at: '2024-06-01T00:00:00Z' })

const updatePayloads = (table: string) =>
  h.state.calls.filter(c => c.table === table)
    .flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))

beforeEach(() => { h.reset(); vi.clearAllMocks() })

// ── the rule going forward ───────────────────────────────────────
describe('an action-required job with a paid invoice is finished work', () => {
  it('import (backfill): aged action-required job + paid invoice → Closed Won, NOT stale Lost', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [job('action_required')], invoices: [paid(7455.73, '2024-06-23T18:34:28+00:00')] }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Won')
    expect(d.closed_reason).toBe('won')
    expect(d.closed_at).toBe(new Date('2024-06-23T18:34:28Z').toISOString())
  })

  it('on_hold (Jobber\'s alias) reads the same', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [job('on_hold')], invoices: [paid(500, '2024-06-23T00:00:00Z')] }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Won')
  })

  it('live (webhook): the same engagement rests at Final Processing — Mark won, never auto-Won', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [job('action_required')], invoices: [paid(500, '2024-06-23T00:00:00Z')] }),
      { closeWonOnDone: false, nowMs: NOW },
    )
    expect(d).toEqual({ stage: 'Final Processing' })
  })

  it('paid work with a second, unpaid invoice → Final Processing (money still owed), not Lost', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [job('action_required')], invoices: [paid(500, '2024-06-23T00:00:00Z'), unpaid(200)] }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d).toEqual({ stage: 'Final Processing' })
  })
})

describe('the narrow rule leaves everything else exactly as it was', () => {
  it('a genuinely stale request (no job, no invoice) still closes as Lost on import', () => {
    const d = deriveEngagementStage(
      kids({ sr: { requested_at: '2023-03-01T00:00:00Z', created_at: '2023-03-01T00:00:00Z' } }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Lost')
    expect(d.closed_reason).toBe('stale_on_import')
  })

  it('an aged action-required job with NO invoice still closes as Lost', () => {
    const d = deriveEngagementStage(kids({ jobs: [job('action_required')] }), { mode: 'backfill', nowMs: NOW })
    expect(d.stage).toBe('Closed Lost')
    expect(d.closed_reason).toBe('stale_on_import')
  })

  it('an unpaid invoice is not evidence — still Lost', () => {
    const d = deriveEngagementStage(kids({ jobs: [job('action_required')], invoices: [unpaid(300)] }), { mode: 'backfill', nowMs: NOW })
    expect(d.stage).toBe('Closed Lost')
  })

  it('a refund / credit invoice alone (paid, negative total) is not evidence of work — still Lost', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [job('action_required')], invoices: [paid(-92.58, '2025-12-19T14:29:34Z')] }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Lost')
  })

  it("an 'unscheduled' job with a paid invoice is NOT included (its visits have not happened)", () => {
    const d = deriveEngagementStage(
      kids({ jobs: [job('unscheduled')], invoices: [paid(500, '2024-06-23T00:00:00Z')] }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Lost')
  })

  it('a caller that does not select invoice amounts gets the old reading (fail-narrow)', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [job('action_required')], invoices: [{ status: 'paid', paid_at: '2024-06-23T00:00:00Z' }] }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Lost')
  })

  it('a fresh action-required job with no invoice is still a live estimate', () => {
    const d = deriveEngagementStage(kids({ jobs: [job('action_required', '2026-09-20T00:00:00Z')] }), { nowMs: NOW })
    expect(d).toEqual({ stage: 'Estimate' })
  })
})

// ── the Seattle person, pinned (lead 2301fa50…, Seattle, 2026-09-27 read) ──
// Three engagements, every job "action required", every invoice paid,
// $12,067.93 in all; all three stamped stale_on_import Lost on 2026-07-24.
// Lead paid_amount read -92.58 — the refund was the last invoice paid.
describe('the Seattle person, exactly as found', () => {
  const engA = kids({   // 9e7a718c · founded by quote
    jobs: [{ status: 'action_required', completed_at: null, scheduled_start: null, created_at: '2024-05-24T01:10:23+00:00' }],
    invoices: [paid(7455.73, '2024-06-23T18:34:28+00:00')],
  })
  const engB = kids({   // 1630825b · founded by job
    jobs: [{ status: 'action_required', completed_at: null, scheduled_start: null, created_at: '2024-06-25T17:57:26+00:00' }],
    invoices: [paid(3623.27, '2024-07-15T22:13:36+00:00')],
  })
  const engC = kids({   // 60fc4b96 · founded by job · the refund lives here
    jobs: [{ status: 'action_required', completed_at: null, scheduled_start: null, created_at: '2025-12-03T00:13:41+00:00' }],
    invoices: [paid(1081.51, '2025-12-05T18:18:37+00:00'), paid(-92.58, '2025-12-19T14:29:34+00:00')],
  })
  const lost = (id: string) => ({ id, stage: 'Closed Lost', closed_reason: 'stale_on_import' })

  it('all three engagements now recover to Closed Won, dated at their last payment', () => {
    expect(planStaleLostRecovery(lost('9e7a718c'), engA)).toEqual({ kind: 'flip', closedAt: '2024-06-23T18:34:28.000Z' })
    expect(planStaleLostRecovery(lost('1630825b'), engB)).toEqual({ kind: 'flip', closedAt: '2024-07-15T22:13:36.000Z' })
    // a positive paid invoice is present, so the refund beside it doesn't block Won
    expect(planStaleLostRecovery(lost('60fc4b96'), engC)).toEqual({ kind: 'flip', closedAt: '2025-12-19T14:29:34.000Z' })
  })

  it('their lifetime paid total is the sum — $12,067.93 — not the -$92.58 refund', () => {
    const all = [...engA.invoices, ...engB.invoices, ...engC.invoices]
    expect(sumPaidInvoices(all)).toBe(12067.93)
  })
})

// ── the automatic repair now catches these ──────────────────────
describe('the in-app stale-Lost recovery now catches paid action-required work', () => {
  const children = kids({
    jobs: [job('action_required')],
    invoices: [paid(3623.27, '2024-07-15T22:13:36+00:00')],
  })

  it('panel-open drift recovery flips stale-Lost → Closed Won and leaves a system touchpoint', async () => {
    const res = await recoverEngagementStageDrift(
      { id: 'eng-1', stage: 'Closed Lost', closed_reason: 'stale_on_import', client_id: 'lead-1', location_uuid: 'loc-1' },
      children,
    )
    expect(res.corrected).toBe(true)
    expect(res.stage).toBe('Closed Won')
    const patch = updatePayloads('engagements')[0]
    expect(patch.stage).toBe('Closed Won')
    expect(patch.closed_reason).toBe('won')
    expect(patch.closed_note).toBeNull()
    const tp = h.state.calls.find(c => c.table === 'touchpoints')!.ops.find(o => o[0] === 'insert')![1][0]
    expect(tp).toMatchObject({ kind: 'stage_change', label: 'Stage: Closed Lost → Closed Won', lead_id: 'lead-1' })
  })

  it('webhook advance (live) flips stale-Lost → Closed Won the same way', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Closed Lost', closed_reason: 'stale_on_import', client_id: 'lead-1' })
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', children.jobs)
    h.enqueue('invoices', children.invoices)
    const res = await maybeAdvanceEngagementStage('eng-1')
    expect(res).toEqual({ advanced: true, stage: 'Closed Won' })
    expect(updatePayloads('engagements')[0]).toMatchObject({ stage: 'Closed Won', closed_reason: 'won' })
  })

  it('a HUMAN close is never touched, paid work or not', async () => {
    const res = await recoverEngagementStageDrift(
      { id: 'eng-1', stage: 'Closed Lost', closed_reason: 'Price too high', client_id: 'lead-1', location_uuid: 'loc-1' },
      children,
    )
    expect(res.corrected).toBe(false)
    expect(updatePayloads('engagements')).toEqual([])
    expect(planStaleLostRecovery({ id: 'x', stage: 'Closed Lost', closed_reason: 'Price too high' }, children).kind).toBe('hold')
  })

  it('a genuinely stale request stays Lost under the recovery too', () => {
    const v = planStaleLostRecovery(
      { id: 'x', stage: 'Closed Lost', closed_reason: 'stale_on_import' },
      kids({ sr: { requested_at: '2023-03-01T00:00:00Z', created_at: '2023-03-01T00:00:00Z' } }),
    )
    expect(v.kind).toBe('hold')
  })
})

// ── lifetime paid total ─────────────────────────────────────────
describe('sumPaidInvoices — the lifetime paid total', () => {
  it('adds every paid invoice', () => {
    expect(sumPaidInvoices([paid(1200, 'x'), paid(500, 'y')])).toBe(1700)
  })
  it('a refund reduces it', () => {
    expect(sumPaidInvoices([paid(1081.51, 'x'), paid(-92.58, 'y')])).toBe(988.93)
  })
  it('ignores unpaid invoices', () => {
    expect(sumPaidInvoices([paid(300, 'x'), unpaid(900)])).toBe(300)
  })
  it('never paid → null (distinct from paid-then-refunded-to-zero)', () => {
    expect(sumPaidInvoices([])).toBeNull()
    expect(sumPaidInvoices([unpaid(900)])).toBeNull()
    expect(sumPaidInvoices([paid(100, 'x'), paid(-100, 'y')])).toBe(0)
  })
  it('rounds to cents (no float noise)', () => {
    expect(sumPaidInvoices([paid(0.1, 'x'), paid(0.2, 'y')])).toBe(0.3)
  })
})

describe('sumBalanceOwing — what the person still owes', () => {
  it('no invoices → null (never invoiced is not "owes nothing")', () => {
    expect(sumBalanceOwing([])).toBeNull()
  })
  it('a missing balance falls back to total − paid, the engagement roll-up\'s formula', () => {
    expect(sumBalanceOwing([{ status: 'sent', total: 900, paid_amount: 250, balance_owing: null }])).toBe(650)
  })
  it('paid invoices add nothing; open ones add their balance', () => {
    expect(sumBalanceOwing([paid(500, 'x'), unpaid(200), unpaid(300)])).toBe(500)
  })
})

// ── every writer uses the sum ───────────────────────────────────
describe('no writer carries one invoice\'s figure into the lead money roll-up any more', () => {
  it('the import route writes both totals from the summed read, at both invoice roll-ups', () => {
    const src = readFileSync('app/api/import/jobber-clients/route.ts', 'utf8')
    expect(src.match(/await writeLeadMoneyRollup\(leadId, /g)?.length).toBe(2)
    expect(src).toContain('readLeadMoneyTotals(leadId)')
    // every paid_amount / balance_owing the route writes is the summed value — nothing else
    const paid = src.match(/paid_amount:\s*[^,}\n]+/g) ?? []
    const bal = src.match(/balance_owing:\s*[^,}\n]+/g) ?? []
    expect(paid).toEqual(['paid_amount: money.paidAmount'])
    expect(bal.map(b => b.trim())).toEqual(['balance_owing: money.balanceOwing'])
  })
  it('the invoice webhook writes both totals from the summed read', () => {
    const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    expect(src).not.toMatch(/leadPatch\.paid_amount\s*=\s*totalNum/)
    expect(src).not.toMatch(/leadPatch\.balance_owing\s*=\s*(totalNum|0)\b/)
    expect(src).toContain('readLeadMoneyTotals(leadId)')
  })
  it('reopen selects the invoice amounts, so it reads paid work the same way', () => {
    const src = readFileSync('app/api/engagements/[id]/reopen/route.ts', 'utf8')
    expect(src).toMatch(/from\('invoices'\)\.select\('[^']*paid_amount/)
  })
})
