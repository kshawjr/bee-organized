// @vitest-environment node
//
// Unbooked job-status family + exhaustive JobStatus mapping (2026-07-10,
// follow-up to a8b7e62 / beta-unscheduled-jobs.test.ts).
//
// Jobber's ACTION_REQUIRED status was unmapped: jobs landed as status
// 'unknown' and pinned their lead at 'Job in Progress' forever (Wendy
// Blanch's Sept-2024 job — client reported no open work while the UI
// showed an open "Jul 2026" engagement). Jobber's own schema definition:
// "still active, but they have no more upcoming visits. You can think of
// action required like being 'on hold'. … a prompt to either schedule
// more visits or close the job." ON_HOLD is Jobber's alias for the same
// state. Decision: both join UNSCHEDULED as the unbooked family —
// nothing booked, nothing underway → never 'Job in Progress'; they ride
// the quote lane (fresh → live deal, aged → Nurturing / backfill
// stale-close). These tests pin:
//   1) the map entries + the broadened isUnbookedJobStatus predicate
//   2) exhaustiveness over the live-introspected JobStatusTypeEnum
//   3) determineLeadStage (lead lane) for action_required/on_hold
//   4) deriveEngagementStage (engagement lane) incl. the Wendy shape
//   5) the webhook promotion gate + the unmapped-status sync_log alarm
//   6) the script ports staying in sync
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('no DB in these tests') } },
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import {
  JOB_STATUS,
  BOOKED_JOB_STATUSES,
  isUnbookedJobStatus,
  determineLeadStage,
} from '@/lib/jobber-import'
import { deriveEngagementStage } from '@/lib/engagements'

const NOW = new Date('2026-07-10T00:00:00Z').getTime()

// ── 1. map entries + predicate ──────────────────────────────────
describe('JOB_STATUS map covers the unbooked family', () => {
  it("maps ACTION_REQUIRED → 'action_required' and ON_HOLD → 'on_hold'", () => {
    expect(JOB_STATUS['ACTION_REQUIRED']).toBe('action_required')
    expect(JOB_STATUS['ON_HOLD']).toBe('on_hold')
  })
  it('predicate: exactly unscheduled/action_required/on_hold, raw or mapped spelling', () => {
    for (const s of ['ACTION_REQUIRED', 'action_required', 'ON_HOLD', 'on_hold', 'UNSCHEDULED', 'unscheduled']) {
      expect(isUnbookedJobStatus(s)).toBe(true)
    }
    for (const s of ['ACTIVE', 'LATE', 'TODAY', 'UPCOMING', 'EXPIRING_WITHIN_30_DAYS', 'ARCHIVED', 'REQUIRES_INVOICING', 'unknown', 'completed', null, undefined]) {
      expect(isUnbookedJobStatus(s as any)).toBe(false)
    }
  })
  it('unbooked statuses are never in the booked promotion allowlist', () => {
    expect(BOOKED_JOB_STATUSES.has('ACTION_REQUIRED')).toBe(false)
    expect(BOOKED_JOB_STATUSES.has('ON_HOLD')).toBe(false)
    expect(BOOKED_JOB_STATUSES.has('UNSCHEDULED')).toBe(false)
  })
})

// ── 2. exhaustiveness over the live enum ────────────────────────
// JobStatusTypeEnum introspected live from Jobber's GraphQL schema
// (X-JOBBER-GRAPHQL-VERSION 2025-04-16, 2026-07-10). If Jobber adds a
// value, this list is stale — the runtime alarm in upsertJob is the
// production tripwire; this test is the build-time one for the values we
// know about.
const JOBBER_JOB_STATUS_ENUM = [
  'requires_invoicing', 'archived', 'late', 'today', 'upcoming',
  'action_required', 'on_hold', 'unscheduled', 'active',
  'expiring_within_30_days',
]
describe('every live JobStatusTypeEnum value is mapped and classified', () => {
  it('every enum value has an explicit JOB_STATUS entry', () => {
    for (const v of JOBBER_JOB_STATUS_ENUM) {
      expect(JOB_STATUS[v.toUpperCase()], `unmapped enum value: ${v}`).toBeTruthy()
    }
  })
  it('every open (non-terminal) enum value is exactly one of booked / unbooked', () => {
    const terminal = new Set(['requires_invoicing', 'archived'])  // work over / closed
    for (const v of JOBBER_JOB_STATUS_ENUM.filter(v => !terminal.has(v))) {
      const booked = BOOKED_JOB_STATUSES.has(v.toUpperCase())
      const unbooked = isUnbookedJobStatus(v)
      expect(booked !== unbooked, `${v} must be exactly one of booked/unbooked (booked=${booked} unbooked=${unbooked})`).toBe(true)
    }
  })
})

// ── 3. lead derivation ──────────────────────────────────────────
describe('determineLeadStage — action_required/on_hold jobs are not current work', () => {
  const base = { email: 'a@b.c', phone: null, clientCreatedAt: '2024-01-01T00:00:00Z', requests: [], quotes: [], jobs: [], invoices: [] }

  it('dormant action_required job (2024) → Nurturing, not Job in Progress (the Wendy Blanch bug)', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'ACTION_REQUIRED', createdAt: '2024-09-16T00:00:00Z', startAt: '2024-09-26T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Nurturing', isJunk: false })
  })
  it('the full Wendy shape: paid history beats a dormant action_required job → Closed Won', () => {
    const r = determineLeadStage({
      ...base,
      requests: [{ createdAt: '2024-08-29T00:00:00Z' }],
      quotes: [{ createdAt: '2024-09-16T00:00:00Z' }],
      jobs: [
        { jobStatus: 'ARCHIVED', completedAt: '2024-09-26T21:40:21Z', createdAt: '2024-09-16T00:00:00Z' },
        { jobStatus: 'ACTION_REQUIRED', createdAt: '2024-09-16T23:09:44Z', startAt: '2024-09-26T00:00:00Z' },
      ],
      invoices: [{ invoiceStatus: 'PAID', createdAt: '2024-09-26T21:40:50Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Closed Won', isJunk: false })
  })
  it('fresh action_required job rides the quote lane → Estimate Sent (genuinely between visits)', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'ACTION_REQUIRED', createdAt: '2026-07-05T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Estimate Sent', isJunk: false })
  })
  it('on_hold classifies identically (Jobber alias), lowercase raw spelling too', () => {
    expect(determineLeadStage({
      ...base, jobs: [{ jobStatus: 'on_hold', createdAt: '2025-01-15T00:00:00Z' }],
    }, NOW)).toEqual({ stage: 'Nurturing', isJunk: false })
  })
  it('a completed_at wins over an action_required label — done work is job evidence', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'ACTION_REQUIRED', completedAt: '2026-05-01T00:00:00Z', createdAt: '2026-04-01T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Final Processing', isJunk: false })
  })
  it('EXPIRING_WITHIN_30_DAYS is booked (active subset) → Job in Progress', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'EXPIRING_WITHIN_30_DAYS', createdAt: '2026-06-01T00:00:00Z' }],
    }, NOW)
    expect(r).toEqual({ stage: 'Job in Progress', isJunk: false })
  })
})

// ── 4. engagement derivation ────────────────────────────────────
describe('deriveEngagementStage — action_required jobs classify with the quotes', () => {
  const kids = (over: any = {}) => ({ sr: null, quotes: [], jobs: [], invoices: [], ...over })
  const ar = (created_at: string) =>
    ({ status: 'action_required', completed_at: null, scheduled_start: null, created_at })
  const doneJob = { status: 'archived', completed_at: '2024-09-26T21:40:21Z', scheduled_start: null, created_at: '2024-09-16T00:00:00Z' }
  const paidInvoice = { status: 'paid', paid_at: '2024-09-26T21:40:50Z', issued_at: '2024-09-26T00:00:00Z', created_at: '2024-09-26T00:00:00Z' }

  it("the phantom 'Jul 2026' engagement: aged action_required-only job stale-closes in backfill mode", () => {
    const d = deriveEngagementStage(kids({ jobs: [ar('2024-09-16T23:09:44Z')] }), { mode: 'backfill', nowMs: NOW })
    expect(d.stage).toBe('Closed Lost')
    expect(d.closed_reason).toBe('stale_on_import')
  })
  it('live mode: action_required-only engagement → Estimate, never Job in Progress', () => {
    const d = deriveEngagementStage(kids({ jobs: [ar('2025-09-01T00:00:00Z')] }), { nowMs: NOW })
    expect(d).toEqual({ stage: 'Estimate' })
  })
  it('backfill mode: fresh action_required-only engagement stays Estimate', () => {
    const d = deriveEngagementStage(kids({ jobs: [ar('2026-07-05T00:00:00Z')] }), { mode: 'backfill', nowMs: NOW })
    expect(d).toEqual({ stage: 'Estimate' })
  })
  it('an action_required job does not block Closed Won when the booked job is done and paid', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [ar('2024-09-16T23:09:44Z'), doneJob], invoices: [paidInvoice] }),
      { nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Won')
    expect(d.closed_reason).toBe('won')
  })
  it('on_hold classifies identically', () => {
    const d = deriveEngagementStage(
      kids({ jobs: [{ status: 'on_hold', completed_at: null, scheduled_start: null, created_at: '2025-09-01T00:00:00Z' }] }),
      { mode: 'backfill', nowMs: NOW },
    )
    expect(d.stage).toBe('Closed Lost')
  })
})

// ── 5. webhook gate + unmapped-status alarm (source pins) ───────
describe('webhook promotion gate + unmapped-status sync_log alarm', () => {
  const handlers = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
  const importLib = readFileSync('lib/jobber-import.ts', 'utf8')

  it('JOB_CREATE promotion gate uses the broadened unbooked predicate', () => {
    expect(handlers).toContain("if (stagePromotion === 'Job in Progress' && isUnbookedJobStatus(jobRec.jobStatus))")
  })
  it('JOB_UPDATE still promotes off the booked allowlist', () => {
    expect(handlers).toContain("if (stagePromotion === null && BOOKED_JOB_STATUSES.has((jobRec.jobStatus || '').toUpperCase()))")
  })
  it("upsertJob raises a status='error' sync_log row with a topic= token when a status is unmapped", () => {
    expect(importLib).toContain("if (mappedStatus === undefined && existing?.status !== 'unknown')")
    expect(importLib).toContain('topic=JOB_STATUS_UNMAPPED unmapped Jobber job status:')
    expect(importLib).toContain("status: 'error',")
  })
})

// ── 6. script ports stay in sync ────────────────────────────────
describe('script ports carry the same unbooked semantics', () => {
  const UNBOOKED_DB = "['unscheduled', 'action_required', 'on_hold'].includes((j.status || '').toLowerCase())"
  const UNBOOKED_RAW = "['unscheduled', 'action_required', 'on_hold'].includes((j.jobStatus || '').toLowerCase())"

  it('backfill-requestless.mjs: map entries + both derivation ports', () => {
    const s = readFileSync('scripts/backfill-requestless.mjs', 'utf8')
    expect(s).toContain("ACTION_REQUIRED: 'action_required', ON_HOLD: 'on_hold'")
    expect(s).toContain("EXPIRING_WITHIN_30_DAYS: 'in_progress'")
    expect(s).toContain(UNBOOKED_RAW)
    expect(s).toContain(UNBOOKED_DB)
  })
  it('backfill-engagements.mjs, repair-stale-won.mjs, repair-unscheduled-jobs.mjs, scan-unscheduled-unknown.mjs: DB-shape port', () => {
    for (const f of ['scripts/backfill-engagements.mjs', 'scripts/repair-stale-won.mjs', 'scripts/repair-unscheduled-jobs.mjs', 'scripts/scan-unscheduled-unknown.mjs']) {
      expect(readFileSync(f, 'utf8'), f).toContain(UNBOOKED_DB)
    }
  })
})
