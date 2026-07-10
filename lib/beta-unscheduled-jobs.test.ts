// @vitest-environment node
//
// UNSCHEDULED job-status mapping + derivation semantics (2026-07-10).
//
// Jobber's UNSCHEDULED status was unmapped: jobs landed as status
// 'unknown' and — because every non-completed job read as current work —
// pinned their lead at 'Job in Progress' forever (the dormant-2025-job
// bug). The documented decision (see JOB_STATUS / isUnscheduledJobStatus
// in lib/jobber-import.ts): an unscheduled job has no visit booked, so it
// is NOT in progress — it classifies like a quote of the same age (fresh
// → live deal, aged → Nurturing / backfill stale-close). These tests pin:
//   1) the map entry + status predicates
//   2) determineLeadStage (lead lane: quote-lane treatment)
//   3) deriveEngagementStage (engagement lane: quotes branch)
//   4) the webhook promotion gate (JOB_CREATE skip / JOB_UPDATE catch-up)
//   5) the script ports staying in sync
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('no DB in these tests') } },
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import {
  JOB_STATUS,
  BOOKED_JOB_STATUSES,
  isUnscheduledJobStatus,
  determineLeadStage,
} from '@/lib/jobber-import'
import { deriveEngagementStage } from '@/lib/engagements'

const NOW = new Date('2026-07-10T00:00:00Z').getTime()

// ── 1. map entry + predicates ───────────────────────────────────
describe('JOB_STATUS map covers UNSCHEDULED', () => {
  it("maps UNSCHEDULED → 'unscheduled' (no longer falls to 'unknown')", () => {
    expect(JOB_STATUS['UNSCHEDULED']).toBe('unscheduled')
  })
  it('predicate matches raw Jobber and mapped DB spellings, nothing else', () => {
    expect(isUnscheduledJobStatus('UNSCHEDULED')).toBe(true)
    expect(isUnscheduledJobStatus('unscheduled')).toBe(true)
    expect(isUnscheduledJobStatus('Unscheduled')).toBe(true)
    expect(isUnscheduledJobStatus('ACTIVE')).toBe(false)
    expect(isUnscheduledJobStatus('unknown')).toBe(false)
    expect(isUnscheduledJobStatus(null)).toBe(false)
    expect(isUnscheduledJobStatus(undefined)).toBe(false)
  })
  it('booked-work statuses are exactly ACTIVE/TODAY/UPCOMING/LATE', () => {
    expect([...BOOKED_JOB_STATUSES].sort()).toEqual(['ACTIVE', 'LATE', 'TODAY', 'UPCOMING'])
    expect(BOOKED_JOB_STATUSES.has('UNSCHEDULED')).toBe(false)
  })
})

// ── 2. lead derivation ──────────────────────────────────────────
describe('determineLeadStage — unscheduled jobs are not current work', () => {
  const base = { email: 'a@b.c', phone: null, clientCreatedAt: '2024-01-01T00:00:00Z', requests: [], quotes: [], jobs: [], invoices: [] }

  it('dormant unscheduled job (2025) → Nurturing, not Job in Progress (the reported bug)', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'UNSCHEDULED', createdAt: '2025-08-15T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Nurturing', isJunk: false })
  })
  it('fresh unscheduled job rides the quote lane → Estimate Sent', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'UNSCHEDULED', createdAt: '2026-07-05T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Estimate Sent', isJunk: false })
  })
  it('lowercase raw status classifies identically', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'unscheduled', createdAt: '2025-08-15T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Nurturing', isJunk: false })
  })
  it('booked-but-not-started job (UPCOMING) still pins Job in Progress', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'UPCOMING', createdAt: '2025-08-15T00:00:00Z', startAt: '2026-08-01T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Job in Progress', isJunk: false })
  })
  it('an unmapped non-completed status stays conservative → Job in Progress', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'ON_HOLD', createdAt: '2025-08-15T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Job in Progress', isJunk: false })
  })
  it('older unscheduled job does not block Closed Won from a completed+paid chain', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [
        { jobStatus: 'UNSCHEDULED', createdAt: '2026-04-01T00:00:00Z' },
        { jobStatus: 'COMPLETED', completedAt: '2026-05-01T00:00:00Z', createdAt: '2026-04-15T00:00:00Z' },
      ],
      invoices: [{ invoiceStatus: 'PAID', createdAt: '2026-05-02T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Closed Won', isJunk: false })
  })
  it('a completed_at wins over an unscheduled label — done work is job evidence', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'UNSCHEDULED', completedAt: '2026-05-01T00:00:00Z', createdAt: '2026-04-01T00:00:00Z' }],
    }, NOW)
    // done job, no invoice → money loose end, not the quote lane
    expect(r).toEqual({ stage: 'Final Processing', isJunk: false })
  })
})

// ── 3. engagement derivation ────────────────────────────────────
describe('deriveEngagementStage — unbooked jobs classify with the quotes', () => {
  const kids = (over: any = {}) => ({ sr: null, quotes: [], jobs: [], invoices: [], ...over })
  const unsched = (created_at: string) =>
    ({ status: 'unscheduled', completed_at: null, scheduled_start: null, created_at })
  const doneJob = { status: 'complete', completed_at: '2026-07-01T00:00:00Z', scheduled_start: null, created_at: '2026-06-01T00:00:00Z' }
  const paidInvoice = { status: 'paid', paid_at: '2026-07-02T00:00:00Z', issued_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:00Z' }

  it('only-unscheduled-job engagement → Estimate in live mode, never Job in Progress', () => {
    const d = deriveEngagementStage(kids({ jobs: [unsched('2025-09-01T00:00:00Z')] }), { nowMs: NOW })
    expect(d).toEqual({ stage: 'Estimate' })
  })
  it('backfill mode: aged unscheduled-only engagement stale-closes (Ruling A extension)', () => {
    const d = deriveEngagementStage(kids({ jobs: [unsched('2025-09-01T00:00:00Z')] }), { mode: 'backfill', nowMs: NOW })
    expect(d.stage).toBe('Closed Lost')
    expect(d.closed_reason).toBe('stale_on_import')
  })
  it('backfill mode: fresh unscheduled-only engagement stays Estimate', () => {
    const d = deriveEngagementStage(kids({ jobs: [unsched('2026-07-05T00:00:00Z')] }), { mode: 'backfill', nowMs: NOW })
    expect(d).toEqual({ stage: 'Estimate' })
  })
  it('unscheduled job does not block Closed Won when the booked job is done and paid', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [unsched('2026-04-01T00:00:00Z'), doneJob], invoices: [paidInvoice] }),
      { nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Won')
    expect(d.closed_reason).toBe('won')
  })
  it('a booked (upcoming) job still derives Job in Progress', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [{ status: 'upcoming', completed_at: null, scheduled_start: '2026-08-01T00:00:00Z', created_at: '2026-07-01T00:00:00Z' }] }),
      { nowMs: NOW },
    )
    expect(d).toEqual({ stage: 'Job in Progress' })
  })
})

// ── 4. webhook promotion gate (source pins — handlers hit Jobber/DB) ──
describe('webhook job handlers gate stage promotion on booked status', () => {
  const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')

  it('JOB_CREATE skips the Job in Progress promotion for unscheduled jobs', () => {
    expect(src).toContain("if (stagePromotion === 'Job in Progress' && isUnscheduledJobStatus(jobRec.jobStatus))")
  })
  it('JOB_UPDATE promotes when the refreshed status shows the job booked/underway', () => {
    expect(src).toContain("if (stagePromotion === null && BOOKED_JOB_STATUSES.has((jobRec.jobStatus || '').toUpperCase()))")
  })
  it('the gated value — not the raw parameter — drives the promotion', () => {
    expect(src).toContain('if (promotion) {')
    expect(src).toContain('applyStagePromotion(leadId, ctx.location.id, promotion)')
  })
})

// ── 5. script ports stay in sync ────────────────────────────────
describe('script ports carry the same unscheduled semantics', () => {
  it('backfill-requestless.mjs: map entry + both derivation ports', () => {
    const s = readFileSync('scripts/backfill-requestless.mjs', 'utf8')
    expect(s).toContain("UNSCHEDULED: 'unscheduled'")
    // lead-lane port (raw Jobber shape)
    expect(s).toContain("const jobUnbooked = j => !jobDone(j) && (j.jobStatus || '').toLowerCase() === 'unscheduled'")
    // engagement-lane port (DB shape)
    expect(s).toContain("const jobUnbooked = j => !j.completed_at && (j.status || '').toLowerCase() === 'unscheduled'")
    expect(s).toContain('if (quotes.length > 0 || unbookedJobs.length > 0)')
  })
  it('backfill-engagements.mjs: booked/unbooked split in deriveStage', () => {
    const s = readFileSync('scripts/backfill-engagements.mjs', 'utf8')
    expect(s).toContain("const jobUnbooked = j => !j.completed_at && (j.status || '').toLowerCase() === 'unscheduled'")
    expect(s).toContain('if (eQuotes.length > 0 || unbookedJobs.length > 0)')
  })
  it('repair-stale-won.mjs: unbooked jobs neither satisfy nor block the won condition', () => {
    const s = readFileSync('scripts/repair-stale-won.mjs', 'utf8')
    expect(s).toContain('(jobsBy[e.id] || []).filter(j => !jobUnbooked(j))')
  })
})
