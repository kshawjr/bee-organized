// @vitest-environment node
//
// #117 — an archived Jobber quote closes the engagement Closed Lost.
//
// Jobber has no QUOTE_ARCHIVE topic: archiving fires QUOTE_UPDATE, whose
// handler already upserts the quote (status → 'archived' via quote-status-map)
// and calls maybeAdvanceEngagementStage. Before #117 the derivation ignored
// quotes.status, so the archived state landed and nothing consumed it. These
// tests pin the consumer:
//
//   THE RULE — close Closed Lost (closed_reason 'quote_archived') only when
//   EVERY quote is archived and nothing advanced past them (no jobs booked or
//   unbooked, no invoices). A live quote, a job, or an invoice → untouched.
//
//   OPT-IN — the close fires only under closeOnArchivedQuote, which ONLY the
//   automated advance path (maybeAdvanceEngagementStage — webhook + import)
//   passes. The manual-reopen route and panel-open drift recovery call
//   deriveEngagementStage in live mode WITHOUT the flag, so they never
//   auto-close (reopening is a human decision, §5).
//
//   TERMINAL / NO AUTO-REOPEN — the caller's forward-only rank guard protects
//   already-terminal engagements and makes un-archive a no-op (a re-derived
//   Estimate never outranks Closed Lost).
//
//   CASCADE TRAP (#66) — soft-close only: the path UPDATEs stage/closed_*,
//   never DELETEs, so engagement_assignees is never touched.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (beta-stage-drift pattern): chainable
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
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { deriveEngagementStage, maybeAdvanceEngagementStage } from '@/lib/engagements'

const NOW = new Date('2026-07-31T00:00:00Z').getTime()
const archivedQuote = (over: any = {}) => ({ status: 'archived', created_at: '2026-07-20T00:00:00Z', sent_at: '2026-07-20T00:00:00Z', ...over })
const sentQuote = (over: any = {}) => ({ status: 'sent', created_at: '2026-07-20T00:00:00Z', sent_at: '2026-07-20T00:00:00Z', ...over })
const empty = { sr: null, quotes: [], jobs: [], invoices: [] }

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (c: any, m: string) => c.ops.filter((o: any) => o[0] === m)
const updatePayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'update').map((o: any) => o[1][0]))

// ────────────────────────────────────────────────────────────────
// deriveEngagementStage — the pure rule
// ────────────────────────────────────────────────────────────────
describe('deriveEngagementStage — archived-quote close (#117)', () => {
  it('archived-only quote, nothing advanced, flag ON → Closed Lost / quote_archived', () => {
    const d = deriveEngagementStage(
      { ...empty, quotes: [archivedQuote()] },
      { nowMs: NOW, closeOnArchivedQuote: true },
    )
    expect(d.stage).toBe('Closed Lost')
    expect(d.closed_reason).toBe('quote_archived')
    expect(d.closed_at).toBe(new Date(NOW).toISOString())
  })

  it('flag OFF (default) leaves the same engagement at Estimate — reopen + drift never auto-close', () => {
    const d = deriveEngagementStage({ ...empty, quotes: [archivedQuote()] }, { nowMs: NOW })
    expect(d.stage).toBe('Estimate')
    expect(d.closed_reason).toBeUndefined()
  })

  it('a second, non-archived quote → not every quote archived → untouched (Estimate)', () => {
    const d = deriveEngagementStage(
      { ...empty, quotes: [archivedQuote(), sentQuote()] },
      { nowMs: NOW, closeOnArchivedQuote: true },
    )
    expect(d.stage).toBe('Estimate')
    expect(d.closed_reason).toBeUndefined()
  })

  it('a booked job behind the archived quote → Job in Progress (never the archived close)', () => {
    const d = deriveEngagementStage(
      { ...empty, quotes: [archivedQuote()], jobs: [{ status: 'active', completed_at: null }] },
      { nowMs: NOW, closeOnArchivedQuote: true },
    )
    expect(d.stage).toBe('Job in Progress')
  })

  it('an unbooked job behind the archived quote → Estimate, NOT closed (a job advanced past it)', () => {
    const d = deriveEngagementStage(
      { ...empty, quotes: [archivedQuote()], jobs: [{ status: 'unscheduled', completed_at: null }] },
      { nowMs: NOW, closeOnArchivedQuote: true },
    )
    expect(d.stage).toBe('Estimate')
    expect(d.closed_reason).toBeUndefined()
  })

  it('a jobless invoice behind the archived quote → Estimate, NOT closed (money advanced past it)', () => {
    const d = deriveEngagementStage(
      { ...empty, quotes: [archivedQuote()], invoices: [{ status: 'paid', paid_at: '2026-07-25T00:00:00Z' }] },
      { nowMs: NOW, closeOnArchivedQuote: true },
    )
    expect(d.stage).toBe('Estimate')
    expect(d.closed_reason).toBeUndefined()
  })

  it('no quotes at all + flag ON → Request (guard needs ≥1 quote)', () => {
    const d = deriveEngagementStage({ ...empty }, { nowMs: NOW, closeOnArchivedQuote: true })
    expect(d.stage).toBe('Request')
  })
})

// ────────────────────────────────────────────────────────────────
// maybeAdvanceEngagementStage — the automated advance path (webhook + import)
// ────────────────────────────────────────────────────────────────
describe('maybeAdvanceEngagementStage — archived-quote close (#117)', () => {
  beforeEach(() => h.reset())

  const seedChildren = (quotes: any[], jobs: any[] = [], invoices: any[] = []) => {
    h.enqueue('service_requests', [])
    h.enqueue('quotes', quotes)
    h.enqueue('jobs', jobs)
    h.enqueue('invoices', invoices)
  }

  it('Estimate + archived-only quote → advances to Closed Lost with reason + note', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Estimate', closed_reason: null })
    seedChildren([{ status: 'archived', created_at: '2026-07-20T00:00:00Z' }])
    const res = await maybeAdvanceEngagementStage('eng-1')
    expect(res).toEqual({ advanced: true, stage: 'Closed Lost' })
    const patch = updatePayloads('engagements')[0]
    expect(patch.stage).toBe('Closed Lost')
    expect(patch.closed_reason).toBe('quote_archived')
    expect(patch.closed_note).toMatch(/archived in Jobber/i)
    expect(patch.closed_at).toBeTruthy()
  })

  it('engagement_assignees is NEVER queried or written — soft-close only (#66)', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Estimate', closed_reason: null })
    seedChildren([{ status: 'archived', created_at: '2026-07-20T00:00:00Z' }])
    await maybeAdvanceEngagementStage('eng-1')
    expect(callsFor('engagement_assignees').length).toBe(0)
    // and the ONLY engagements write is an UPDATE (never a delete/insert)
    const engCalls = callsFor('engagements')
    expect(engCalls.every(c => opsOf(c, 'update').length > 0 || opsOf(c, 'select').length > 0)).toBe(true)
  })

  it('already Closed Won → archived quote does NOT overwrite it (rank tie, no advance)', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Closed Won', closed_reason: 'won' })
    seedChildren([{ status: 'archived', created_at: '2026-07-20T00:00:00Z' }])
    const res = await maybeAdvanceEngagementStage('eng-1')
    expect(res.advanced).toBe(false)
    // money roll-ups still refresh, but stage is never in the patch
    const patch = updatePayloads('engagements')[0]
    expect(patch.stage).toBeUndefined()
  })

  it('already Closed Lost → not re-stamped (no advance on the rank tie)', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Closed Lost', closed_reason: 'Went with someone else' })
    seedChildren([{ status: 'archived', created_at: '2026-07-20T00:00:00Z' }])
    const res = await maybeAdvanceEngagementStage('eng-1')
    expect(res.advanced).toBe(false)
    const patch = updatePayloads('engagements')[0]
    expect(patch.stage).toBeUndefined()
    expect(patch.closed_reason).toBeUndefined()
  })

  it('un-archive AFTER a close → NO auto-reopen (quote now sent, but rank guard holds it Closed Lost)', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Closed Lost', closed_reason: 'quote_archived' })
    seedChildren([{ status: 'sent', sent_at: '2026-07-20T00:00:00Z', created_at: '2026-07-20T00:00:00Z' }])
    const res = await maybeAdvanceEngagementStage('eng-1')
    expect(res.advanced).toBe(false) // Estimate(1) never outranks Closed Lost(4)
    const patch = updatePayloads('engagements')[0]
    expect(patch.stage).toBeUndefined()
  })

  it('a job behind the archived quote → advances to Job in Progress, not the archived close', async () => {
    h.enqueue('engagements', { id: 'eng-1', stage: 'Estimate', closed_reason: null })
    seedChildren(
      [{ status: 'archived', created_at: '2026-07-20T00:00:00Z' }],
      [{ status: 'active', completed_at: null }],
    )
    const res = await maybeAdvanceEngagementStage('eng-1')
    expect(res).toEqual({ advanced: true, stage: 'Job in Progress' })
    const patch = updatePayloads('engagements')[0]
    expect(patch.closed_reason).toBeUndefined()
  })
})
