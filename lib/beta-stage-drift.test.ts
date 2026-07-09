// @vitest-environment node
//
// AUTOMATED stage writers stay silent + drift recovery (2026-07-09).
//
// Three writers can set an engagement to Closed Won — import backfill,
// webhook derivation (both via maybeAdvanceEngagementStage), and the
// panel-open drift recovery (recoverEngagementStageDrift). ALL are
// automated: they write engagements.stage DIRECTLY, no popup, no
// confirm — an import of hundreds of clients must never raise hundreds
// of dialogs. The human close confirm binds to UI intent only (see
// beta-stage-control.test.tsx for that side).
//
// Drift recovery exists because the webhook's stage write is swallow-
// and-log with no reconciliation job — a failed webhook advance used to
// strand a linked engagement's stage forever. Panel open re-derives:
// forward-only, silent, touchpoint ONLY when the stage actually moved.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'

// ── recording supabaseService mock (intake-test pattern): chainable
//    builder, per-table FIFO response queues. ────────────────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
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
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))

import {
  deriveEngagementStage,
  maybeAdvanceEngagementStage,
  recoverEngagementStageDrift,
} from '@/lib/engagements'

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const updatePayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
const insertPayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))

const ENG = { id: 'eng-1', stage: 'Estimate', client_id: 'lead-1', location_uuid: 'loc-uuid-1' }
const kids = (over: any = {}) => ({ sr: null, quotes: [], jobs: [], invoices: [], ...over })
const doneJob = { status: 'complete', completed_at: '2026-07-01T00:00:00Z', scheduled_start: null, created_at: '2026-06-01T00:00:00Z' }
const paidInvoice = { status: 'paid', paid_at: '2026-07-02T00:00:00Z', issued_at: '2026-07-01T00:00:00Z', total: 900, paid_amount: 900, balance_owing: 0 }

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ── the webhook/import path: silent, direct, unchanged ─────────
describe('maybeAdvanceEngagementStage — automated Won is a direct silent write', () => {
  it('all invoices paid → writes Closed Won + reason won straight to the row (no popup exists server-side)', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Final Processing' }) // the select
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [doneJob])
    h.enqueue('invoices', [paidInvoice])
    const res = await maybeAdvanceEngagementStage('eng-1')
    expect(res).toEqual({ advanced: true, stage: 'Closed Won' })
    const patches = updatePayloads('engagements')
    expect(patches.length).toBe(1)
    expect(patches[0].stage).toBe('Closed Won')
    expect(patches[0].closed_reason).toBe('won')
    expect(patches[0].closed_at).toBeTruthy()
  })

  it('no writer on the automated path imports the human close popup', () => {
    for (const f of ['lib/engagements.ts', 'lib/jobber-webhook-handlers.ts', 'app/api/import/jobber-clients/route.ts']) {
      expect(readFileSync(f, 'utf8')).not.toContain('CloseEngagementConfirm')
    }
  })
})

// ── drift recovery: forward-only, silent, touchpoint only on change ──
describe('recoverEngagementStageDrift — panel-open self-heal for missed webhooks', () => {
  it('lagging stage corrects FORWARD and writes exactly one stage_change touchpoint', async () => {
    const res = await recoverEngagementStageDrift(ENG, kids({
      quotes: [{ status: 'approved', sent_at: '2026-07-01T00:00:00Z' }],
      jobs: [{ ...doneJob, completed_at: null, status: 'active' }],
    }))
    expect(res.corrected).toBe(true)
    expect(res.stage).toBe('Job in Progress')
    const patches = updatePayloads('engagements')
    expect(patches.length).toBe(1)
    expect(patches[0].stage).toBe('Job in Progress')
    expect(patches[0].stage_entered_at).toBeTruthy()
    const tps = insertPayloads('touchpoints')
    expect(tps.length).toBe(1)
    expect(tps[0]).toMatchObject({
      lead_id: 'lead-1',
      engagement_id: 'eng-1',
      kind: 'stage_change',
      label: 'Stage: Estimate → Job in Progress',
    })
    expect(tps[0].user_id).toBeUndefined() // system correction — nobody clicked
  })

  it('no-op re-derive writes NOTHING — no update, no touchpoint, not even updated_at', async () => {
    const res = await recoverEngagementStageDrift(ENG, kids({
      quotes: [{ status: 'sent', sent_at: new Date().toISOString() }],
    }))
    expect(res.corrected).toBe(false)
    expect(updatePayloads('engagements').length).toBe(0)
    expect(insertPayloads('touchpoints').length).toBe(0)
  })

  it('never moves BACKWARD — a stage ahead of its children stays put', async () => {
    const ahead = { ...ENG, stage: 'Final Processing' }
    const res = await recoverEngagementStageDrift(ahead, kids({
      quotes: [{ status: 'sent', sent_at: new Date().toISOString() }], // derives Estimate
    }))
    expect(res.corrected).toBe(false)
    expect(updatePayloads('engagements').length).toBe(0)
  })

  it('a legitimate Won derivation just BECOMES Won — silent direct write, same as the webhook', async () => {
    const res = await recoverEngagementStageDrift({ ...ENG, stage: 'Job in Progress' }, kids({
      jobs: [doneJob],
      invoices: [paidInvoice],
    }))
    expect(res.corrected).toBe(true)
    expect(res.stage).toBe('Closed Won')
    const patches = updatePayloads('engagements')
    expect(patches[0].stage).toBe('Closed Won')
    expect(patches[0].closed_reason).toBe('won')
    // The touchpoint records the move; no confirm was ever involved.
    expect(insertPayloads('touchpoints').length).toBe(1)
  })

  it('uses THE derivation authority (deriveEngagementStage) — spot-check the shared rules', () => {
    expect(deriveEngagementStage(kids()).stage).toBe('Request')
    expect(deriveEngagementStage(kids({ quotes: [{ status: 'sent', sent_at: new Date().toISOString() }] })).stage).toBe('Estimate')
    expect(deriveEngagementStage(kids({ jobs: [{ status: 'active' }] })).stage).toBe('Job in Progress')
    expect(deriveEngagementStage(kids({ jobs: [doneJob], invoices: [{ ...paidInvoice, status: 'sent', balance_owing: 900 }] })).stage).toBe('Final Processing')
    expect(deriveEngagementStage(kids({ jobs: [doneJob], invoices: [paidInvoice] })).stage).toBe('Closed Won')
  })
})

// ── the GET route is the drift-recovery caller ─────────────────
describe('engagement GET route — drift recovery wired on panel open', () => {
  it('calls recoverEngagementStageDrift for linked, non-terminal engagements and returns the corrected row', () => {
    const src = readFileSync('app/api/engagements/[id]/route.ts', 'utf8')
    expect(src).toContain('recoverEngagementStageDrift')
    expect(src).toContain('hasAnyChild')
    expect(src).toMatch(/hasAnyChild && !isTerminalStage/)
    expect(src).toContain('engagement: engagementOut')
  })
})
