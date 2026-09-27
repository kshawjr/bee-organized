// @vitest-environment node
//
// JOBS DELETED IN JOBBER (2026-09-27).
//
// JOB_DESTROY compared Jobber's ENCODED id with our plain numeric
// jobber_job_id, so it never matched: 56 deletions since 2026-07-18, none
// applied, 55 jobs ($47,421 of them still "upcoming"/"today"/"late"/"needs
// action") kept reading as live work. The old test fed the handler a plain
// '777' — exactly the one shape Jobber never sends — which is how the bug hid.
// Every handler test below sends the id the way Jobber does: encoded.
//
// Kevin's rulings pinned here:
//   · the 2026-08-29 rule stands: every job deleted + nothing invoiced →
//     Closed Lost 'job_deleted', Reopen-able — automated path only;
//   · a deal whose work was remade in Jobber under a new number must NOT
//     close ("just close them if they are not in jobber");
//   · closed deals never move — the 14 Closed Won deals with no job left
//     stay exactly as they are; the money on them is real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in', 'gt', 'lt']) {
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
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn() }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}), stopReturningSequenceForLead: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))

import { handleJobDestroy } from '@/lib/jobber-webhook-handlers'
import {
  deriveEngagementStage, stageAdvanceFor, maybeAdvanceEngagementStage, reopenIfClosedByJobDeletion,
  findJobDeletedCloseForClient, resolveEngagementForChild, JOB_DELETED_REOPEN_WINDOW_MS,
} from '@/lib/engagements'
import { jobberGraphQL } from '@/lib/jobber'
import {
  isDeletedJob, liveJobs, JOB_DELETED, findReplacementJobs, deletedJobMoveDecision,
} from '@/components/hive/shared/jobDeleted'
import { deriveStatusChip, lastActivityTs } from '@/components/hive/shared/engagementStatus'

beforeEach(() => { h.reset(); vi.clearAllMocks() })

const gid = (n: string) => Buffer.from(`gid://Jobber/Job/${n}`).toString('base64')
const ctx = (itemId: string) => ({ topic: 'JOB_DESTROY', itemId, occurredAt: '2026-09-27T12:00:00Z', location: { id: 'loc-uuid', location_id: 'loc_dallas', name: 'Dallas' } as any })
const updates = (table: string) => h.state.calls.filter(c => c.table === table)
  .flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))
const rowLookup = () => h.state.calls.find(c => c.table === 'jobs' && c.ops.some(o => o[0] === 'select'))!

const ADVANCE = { mode: 'live' as const, closeWonOnDone: false, closeOnArchivedQuote: true, closeOnDeletedJobs: true } // what maybeAdvance passes
const kids = (over: any = {}) => ({ sr: null, quotes: [], jobs: [], invoices: [], ...over })
const upcoming = (over: any = {}) => ({ status: 'upcoming', completed_at: null, scheduled_start: '2026-10-20T14:00:00Z', created_at: '2026-09-01T00:00:00Z', ...over })
const archived = (over: any = {}) => ({ status: 'archived', completed_at: '2026-09-10T00:00:00Z', scheduled_start: '2026-09-09T00:00:00Z', created_at: '2026-09-01T00:00:00Z', ...over })
const paidInv = (total: number) => ({ status: 'paid', total, paid_amount: total, balance_owing: 0, paid_at: '2026-09-12T00:00:00Z', issued_at: '2026-09-10T00:00:00Z' })

// Queue one JOB_DESTROY for a deal: the lead nullify, the row lookup, the
// row write, then maybeAdvance's five reads (jobs as they are AFTER the mark).
function destroyScenario(engagement: any, jobsAfter: any[], invoices: any[] = [], quotes: any[] = []) {
  h.enqueue('leads', { id: 'lead-1' })
  h.enqueue('leads', null)                                                  // the nullify's lead UPDATE
  h.enqueue('leads', { jobber_client_id: '999', location_id: 'loc_dallas' }) // the replacement check's read (only if it runs)
  h.enqueue('jobs', [{ id: 'job-1', engagement_id: engagement.id, status: 'upcoming' }])
  h.enqueue('jobs', null)
  h.enqueue('engagements', engagement)
  h.enqueue('service_requests', [])
  h.enqueue('quotes', quotes)
  h.enqueue('jobs', jobsAfter)
  h.enqueue('invoices', invoices)
}

const jobberClientHas = (nodes: any[]) => (jobberGraphQL as any).mockResolvedValueOnce({ data: { client: { id: 'gid-c', jobs: { nodes } } } })
const jobGid = (n: string) => Buffer.from(`gid://Jobber/Job/${n}`).toString('base64')

// ── 1. the id ─────────────────────────────────────────────────────────────
describe('JOB_DESTROY matches on the DECODED id — the bug that hid for months', () => {
  it('Janie Stephens: Jobber sends job 155590816 encoded; the lookup asks for the plain number', async () => {
    destroyScenario({ id: 'eng-1', stage: 'Job in Progress', closed_reason: null, client_id: 'lead-1' }, [{ status: 'deleted', completed_at: null }])
    const res = await handleJobDestroy(ctx(gid('155590816')))
    expect(res.processed).toBe(true)
    expect(rowLookup().ops).toContainEqual(['eq', ['jobber_job_id', '155590816']])
    expect(rowLookup().ops).toContainEqual(['eq', ['location_id', 'loc_dallas']])
    // and never the encoded form — the exact comparison that matched nothing
    expect(rowLookup().ops).not.toContainEqual(['eq', ['jobber_job_id', gid('155590816')]])
    expect(updates('jobs')[0].status).toBe(JOB_DELETED)
    expect(res.note).toMatch(/marked 1 job row\(s\) deleted/)
  })

  it('an already-deleted row is not re-marked or re-derived (a repeated webhook is a no-op)', async () => {
    h.enqueue('leads', { id: 'lead-1' })
    h.enqueue('jobs', [{ id: 'job-1', engagement_id: 'eng-1', status: 'deleted' }])
    await handleJobDestroy(ctx(gid('155590816')))
    expect(updates('jobs')).toHaveLength(0)
    expect(updates('engagements')).toHaveLength(0)
  })

  it('the handler source decodes before matching, like INVOICE_DESTROY', () => {
    const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    const body = src.slice(src.indexOf('export async function handleJobDestroy'), src.indexOf('// INVOICE_DESTROY → null jobber_invoice_id on the lead'))
    expect(body).toMatch(/extractJobberId\(ctx\.itemId\)/)
    expect(body).not.toMatch(/\.eq\('jobber_job_id', ctx\.itemId\)/)
  })
})

// ── 2. the August 29 rule fires ───────────────────────────────────────────
describe('every job deleted, nothing invoiced → Closed Lost "job deleted", Reopen-able', () => {
  it('via the webhook: the deal closes with its reason and note; money rolled up from invoices', async () => {
    destroyScenario({ id: 'eng-1', stage: 'Job in Progress', closed_reason: null, client_id: 'lead-1' }, [{ status: 'deleted', completed_at: null }])
    jobberClientHas([])   // Jobber: the client has no other job
    await handleJobDestroy(ctx(gid('155590816')))
    const patch = updates('engagements')[0]
    expect(patch.stage).toBe('Closed Lost')
    expect(patch.closed_reason).toBe('job_deleted')
    expect(patch.closed_note).toContain('Reopen')
    expect(patch.total_invoiced).toBe(0)
  })

  it('only on the automated path: a panel open / reopen re-derive never closes it', () => {
    const jobs = [upcoming({ status: 'deleted' })]
    expect(deriveEngagementStage(kids({ jobs }), ADVANCE).stage).toBe('Closed Lost')
    expect(deriveEngagementStage(kids({ jobs }), { mode: 'live' }).stage).not.toBe('Closed Lost')
  })

  it('an invoice keeps it open — maureen welsh ($70 paid, only job deleted) does not close and does not move', () => {
    const d = deriveEngagementStage(kids({ jobs: [upcoming({ status: 'deleted' })], invoices: [paidInv(70)] }), ADVANCE)
    expect(d.stage).not.toBe('Closed Lost')
    expect(stageAdvanceFor({ stage: 'Job in Progress', closed_reason: null }, d).advance).toBe(false)
  })

  it('the deleted job was the last unfinished one → Final Processing by itself (Lucy McDermott shape)', async () => {
    destroyScenario({ id: 'eng-2', stage: 'Job in Progress', closed_reason: null, client_id: 'lead-1' },
      [upcoming({ status: 'deleted' }), archived(), archived()], [paidInv(9066.14)])
    await handleJobDestroy(ctx(gid('156427200')))
    const patch = updates('engagements')[0]
    expect(patch.stage).toBe('Final Processing')
    expect(patch.closed_reason).toBeUndefined()
    expect(patch.total_paid).toBeCloseTo(9066.14)
  })
})

// ── 3. a deleted job is ignored everywhere ────────────────────────────────
describe('a deleted job is not work: no stage, chip, activity or screen counts it', () => {
  it('the shared rule', () => {
    expect(isDeletedJob({ status: 'deleted' })).toBe(true)
    expect(isDeletedJob({ status: 'DELETED' })).toBe(true)
    expect(isDeletedJob({ status: 'archived' })).toBe(false)
    expect(liveJobs([{ status: 'deleted' }, { status: 'upcoming' }, null as any].filter(Boolean))).toEqual([{ status: 'upcoming' }])
  })

  it('stage: a deleted job never holds a deal at Job in Progress, and a deleted DONE job (completed_at set) is not done work', () => {
    const withDeletedUpcoming = deriveEngagementStage(kids({ jobs: [upcoming({ status: 'deleted' }), archived()] }), ADVANCE)
    expect(withDeletedUpcoming.stage).toBe('Final Processing')
    // 15 of the 55 carry completed_at — it must not make the deal look done
    const onlyDeletedDone = deriveEngagementStage(kids({ jobs: [archived({ status: 'deleted' })], quotes: [{ status: 'approved' }] }), { mode: 'live' })
    expect(onlyDeletedDone.stage).toBe('Estimate')
  })

  it('board chip: a deleted upcoming job never reads "Scheduled …"', () => {
    const e = { stage: 'Job in Progress', jobs: [upcoming({ status: 'deleted' })] }
    const chip = deriveStatusChip(e, { nowMs: Date.parse('2026-09-27T00:00:00Z') })
    expect(chip.label).not.toMatch(/Scheduled/)
    const live = deriveStatusChip({ ...e, jobs: [upcoming()] }, { nowMs: Date.parse('2026-09-27T00:00:00Z') })
    expect(live.label).toMatch(/Scheduled/)
  })

  it('last activity: a deleted job\'s dates are not activity on the deal', () => {
    const e = { stage_entered_at: '2026-08-01T00:00:00Z', jobs: [archived({ status: 'deleted', completed_at: '2026-09-20T00:00:00Z' })] }
    expect(lastActivityTs(e)).toBe(Date.parse('2026-08-01T00:00:00Z'))
  })

  it('every screen fetch leaves deleted jobs out (panel, board, Home/people, person, timeline, client card, crew push)', () => {
    const pins: [string, RegExp][] = [
      ['app/api/engagements/[id]/route.ts', /from\('jobs'\)\.select\('\*'\)\.eq\('engagement_id', id\)\.neq\('status', 'deleted'\)/],     // deal panel + drift
      ['app/api/engagements/route.ts', /byEng\(jobsRaw\.filter\(\(j: any\) => j\.status !== 'deleted'\)\)/],                           // board / list chips
      ['app/api/leads/[id]/route.ts', /from\('jobs'\)\.select\('\*'\)\.eq\('lead_id', id\)\.neq\('status', 'deleted'\)/],                 // person refetch
      ['app/api/leads/[id]/timeline/route.ts', /completed_at, created_at, engagement_id'\)\s*\.eq\('lead_id', id\)\s*\.neq\('status', 'deleted'\)/], // timeline
      ['app/api/clients/[id]/profile/route.ts', /from\('jobs'\)\.select\('id, engagement_id, status, title, scheduled_start, completed_at'\)\.in\('engagement_id', openIds\)\.neq\('status', 'deleted'\)/], // client card
      ['lib/engagement-assignee-sync.ts', /liveJobs\(jobRes\.data/],                                                                   // never push a crew to a deleted job
    ]
    for (const [f, re] of pins) expect(readFileSync(f, 'utf8'), f).toMatch(re)
    const hub = readFileSync('app/_hub-page.tsx', 'utf8')                                                                             // Home / people load
    expect(hub).toMatch(/const liveJobRows\s+= liveJobs\(jobsRaw\)/)
    expect(hub).toMatch(/groupBy\(liveJobRows\)/)
    expect(hub).toMatch(/byEngagement\(liveJobRows\)/)
    expect(hub).not.toMatch(/groupBy\(jobsRaw\)|byEngagement\(jobsRaw\)/)
  })
})

// ── 4. the replacement check ──────────────────────────────────────────────
describe('a deal whose work was remade in Jobber does NOT close', () => {
  const deletedCreatedAt = '2026-09-01T00:00:00Z'
  it('a newer job for the same client (remade under a new number) is a replacement → held', () => {
    const reps = findReplacementJobs({
      clientJobs: [{ id: '160000001', jobStatus: 'upcoming', createdAt: '2026-09-04T00:00:00Z' }],
      deletedJobberIds: ['155590816'], deletedCreatedAt,
    })
    expect(reps).toHaveLength(1)
    expect(deletedJobMoveDecision({ readable: true, replacements: reps })).toBe('hold_replacement')
  })

  it('an archived job made the SAME DAY is still a replacement (a day of slack)', () => {
    expect(findReplacementJobs({ clientJobs: [{ id: '9', jobStatus: 'archived', createdAt: '2026-08-31T12:00:00Z' }], deletedCreatedAt })).toHaveLength(1)
  })

  it('any still-open job is a replacement, however old', () => {
    expect(findReplacementJobs({ clientJobs: [{ id: '9', jobStatus: 'requires_invoicing', createdAt: '2025-01-01T00:00:00Z' }], deletedCreatedAt })).toHaveLength(1)
  })

  it('old finished work is not (Erin Stevanus: ten archived jobs, all before the deleted one) → closes', () => {
    const clientJobs = ['2026-07-10', '2026-06-09', '2025-09-08'].map((d, i) => ({ id: String(i), jobStatus: 'archived', createdAt: `${d}T00:00:00Z` }))
    const reps = findReplacementJobs({ clientJobs, deletedCreatedAt })
    expect(reps).toEqual([])
    expect(deletedJobMoveDecision({ readable: true, replacements: reps })).toBe('move')
  })

  it('a job Bee Hub already has ON THIS DEAL is not a replacement (it is why the deal moves to Final Processing)', () => {
    const clientJobs = [{ id: '506', jobStatus: 'archived', createdAt: '2026-09-09T00:00:00Z' }]
    expect(findReplacementJobs({ clientJobs, deletedCreatedAt })).toHaveLength(1)
    expect(findReplacementJobs({ clientJobs, deletedCreatedAt, onThisDeal: ['506'] })).toEqual([])
  })

  it('the other deleted jobs are not replacements for each other', () => {
    expect(findReplacementJobs({ clientJobs: [{ id: '155590816', jobStatus: 'upcoming', createdAt: '2026-09-05T00:00:00Z' }], deletedJobberIds: ['155590816'], deletedCreatedAt })).toEqual([])
  })

  it('Jobber unreadable is not "gone" — the deal is held', () => {
    expect(deletedJobMoveDecision({ readable: false, replacements: [] })).toBe('hold_unreadable')
  })

  it('the repair moves a deal only on a "move" decision, and asks Jobber about the client first', () => {
    const src = readFileSync('scripts/repair-deleted-jobs.mjs', 'utf8')
    expect(src).toMatch(/report\.deals\.filter\(d => d\.decision === 'move'\)/)
    expect(src).toMatch(/del\.findReplacementJobs\(/)
    expect(src).toMatch(/client\(id:\$id\)\{id jobs\(first:100\)/)
  })
})

// ── 5. closed deals never move ────────────────────────────────────────────
describe('the 14 Closed Won deals with no job left are untouched', () => {
  it('Nick Holda shape: Closed Won, only job deleted, paid invoice on it → no stage in the patch, money stays', async () => {
    destroyScenario({ id: 'eng-3', stage: 'Closed Won', closed_reason: 'won', client_id: 'lead-1' },
      [archived({ status: 'deleted' })], [paidInv(1478.93)], [{ status: 'approved' }])
    await handleJobDestroy(ctx(gid('118628064')))
    const patch = updates('engagements')[0]
    expect(patch.stage).toBeUndefined()
    expect(patch.closed_reason).toBeUndefined()
    expect(patch.closed_note).toBeUndefined()
    expect(patch.total_paid).toBeCloseTo(1478.93)   // the invoice is real even though the job is not
    expect(patch.balance_owing).toBe(0)
  })

  it('Sam Musto shape: Closed Won, nothing paid, only job deleted → derives Closed Lost but a close never overwrites a close', () => {
    const d = deriveEngagementStage(kids({ jobs: [upcoming({ status: 'deleted' })] }), ADVANCE)
    expect(d.stage).toBe('Closed Lost')
    expect(stageAdvanceFor({ stage: 'Closed Won', closed_reason: 'won' }, d)).toEqual({ advance: false, patch: {} })
  })

  it('a human Closed Lost ("Price too high") keeps its reason', () => {
    const d = deriveEngagementStage(kids({ jobs: [upcoming({ status: 'deleted' })] }), ADVANCE)
    expect(stageAdvanceFor({ stage: 'Closed Lost', closed_reason: 'Price too high' }, d).advance).toBe(false)
  })

  it('the repair re-derives through the webhook\'s own decision and writes no money', () => {
    const src = readFileSync('scripts/repair-deleted-jobs.mjs', 'utf8')
    expect(src).toMatch(/stageAdvanceFor\(e, derived, at\)/)
    expect(src).not.toMatch(/total_paid|total_invoiced|paid_amount['"]?\s*:/)
    expect(src).toMatch(/const EXECUTE = argv\.includes\('--execute'\)/)   // dry run unless asked
    expect(src).toMatch(/--undo/)
    expect(src).toMatch(/job\(id:\$id\)\{id jobStatus\}/)                     // each job re-checked in Jobber at run time
  })
})

// ── 6. the live replacement check (2026-09-27) ─────────────────────────────
describe('before a deletion closes a deal, Jobber is asked whether the work was remade', () => {
  const JIP = { id: 'eng-9', stage: 'Job in Progress', closed_reason: null, client_id: 'lead-1' }
  const deletedJob = [{ jobber_job_id: '155590816', status: 'deleted', completed_at: null, created_at: '2026-09-20T00:00:00Z' }]

  it('a deletion with a LIVE replacement in Jobber does not close the deal', async () => {
    destroyScenario(JIP, deletedJob)
    jobberClientHas([{ id: jobGid('160000001'), jobNumber: 1200, jobStatus: 'upcoming', createdAt: '2026-09-27T12:01:00Z' }])
    const res = await handleJobDestroy(ctx(gid('155590816')))
    const patch = updates('engagements')[0]
    expect(patch.stage).toBeUndefined()
    expect(patch.closed_reason).toBeUndefined()
    expect(res.note).toMatch(/NOT closed — client still has 1 possible replacement/)
    // it asked about the CLIENT's jobs, by the stored client id
    const call = (jobberGraphQL as any).mock.calls.find((c: any[]) => /client\(id:\$id\)\{id jobs/.test(c[1]))
    expect(call[0]).toBe('loc_dallas')
    expect(Buffer.from(call[2].id, 'base64').toString()).toBe('gid://Jobber/Client/999')
  })

  it('a deletion with nothing left in Jobber still closes it (the August rule)', async () => {
    destroyScenario(JIP, deletedJob)
    jobberClientHas([{ id: jobGid('1058'), jobNumber: 1058, jobStatus: 'archived', createdAt: '2026-06-28T00:00:00Z' }]) // old, finished
    await handleJobDestroy(ctx(gid('155590816')))
    expect(updates('engagements')[0]).toMatchObject({ stage: 'Closed Lost', closed_reason: 'job_deleted' })
  })

  it('Jobber cannot be read → not closed (unreadable is not "gone")', async () => {
    destroyScenario(JIP, deletedJob)
    ;(jobberGraphQL as any).mockResolvedValueOnce({ errors: [{ message: 'no_valid_jobber_token' }] })
    const res = await handleJobDestroy(ctx(gid('155590816')))
    expect(updates('engagements')[0].stage).toBeUndefined()
    expect(res.note).toMatch(/NOT closed — Jobber could not be read/)
  })

  it('no Jobber client id on the person → asked through the deal\'s quote', async () => {
    h.enqueue('engagements', JIP)
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [{ jobber_quote_id: '65073712', status: 'approved' }])
    h.enqueue('jobs', deletedJob)
    h.enqueue('invoices', [])
    h.enqueue('leads', { jobber_client_id: null, location_id: 'loc_ctshoreline' })
    ;(jobberGraphQL as any).mockResolvedValueOnce({ data: { quote: { client: { id: Buffer.from('gid://Jobber/Client/4242').toString('base64') } } } })
    jobberClientHas([])
    const r = await maybeAdvanceEngagementStage('eng-9')
    expect(r).toMatchObject({ advanced: true, stage: 'Closed Lost' })
    const clientCall = (jobberGraphQL as any).mock.calls.find((c: any[]) => /client\(id:\$id\)\{id jobs/.test(c[1]))
    expect(Buffer.from(clientCall[2].id, 'base64').toString()).toBe('gid://Jobber/Client/4242')
  })

  it('Jobber is only asked when the deal would actually close — never for an ordinary move', async () => {
    destroyScenario({ id: 'eng-2', stage: 'Job in Progress', closed_reason: null, client_id: 'lead-1' },
      [upcoming({ status: 'deleted' }), archived()], [paidInv(9066.14)])
    await handleJobDestroy(ctx(gid('156427200')))
    expect(updates('engagements')[0].stage).toBe('Final Processing')
    expect(jobberGraphQL).not.toHaveBeenCalled()
  })
})

// ── 7. the race: a job remade AFTER the close reopens the deal ─────────────
describe('the race — Jobber sends the deletion before the replacement exists', () => {
  it('pinned: the live check does not wait — no timer, no sleep, no retry loop in the webhook path', () => {
    for (const f of ['lib/deleted-job-replacement.ts', 'lib/engagements.ts', 'lib/jobber-webhook-handlers.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/setTimeout|\bsleep\(/)
    }
  })

  it('a remade job that lands on the closed deal (same quote/request) reopens it — re-derived, trail written', async () => {
    h.enqueue('engagements', { id: 'eng-c', stage: 'Closed Lost', closed_reason: 'job_deleted', client_id: 'lead-1', location_uuid: 'loc-uuid' })
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [{ status: 'approved' }])
    h.enqueue('jobs', [upcoming({ status: 'deleted' }), upcoming()])   // the old one deleted, the remade one live
    h.enqueue('invoices', [])
    h.enqueue('engagements', [{ id: 'eng-c' }])                          // the guarded UPDATE ... select
    const r = await reopenIfClosedByJobDeletion('eng-c')
    expect(r).toEqual({ reopened: true, stage: 'Job in Progress' })
    const patch = updates('engagements')[0]
    expect(patch).toMatchObject({ stage: 'Job in Progress', closed_reason: null, closed_at: null, closed_note: null })
    const guard = h.state.calls.find(c => c.table === 'engagements' && c.ops.some(o => o[0] === 'update'))!
    expect(guard.ops).toContainEqual(['eq', ['closed_reason', 'job_deleted']])
    const tp = h.state.calls.find(c => c.table === 'touchpoints')!.ops.find(o => o[0] === 'insert')![1][0]
    expect(tp).toMatchObject({ kind: 'stage_change', engagement_id: 'eng-c', label: 'Reopened: Closed Lost → Job in Progress (the job was remade in Jobber)' })
  })

  it('a remade job made fresh on the client (no quote/request link) lands on the recently closed deal, not a second one', async () => {
    const now = Date.now()
    h.enqueue('jobs', { engagement_id: null })                                        // not attached yet
    h.enqueue('engagements', [])                                                      // no open deal
    h.enqueue('engagements', [], { count: 1 } as any)                                 // priorCount
    h.enqueue('engagements', [{ id: 'eng-c', closed_at: new Date(now - 3 * 864e5).toISOString() }]) // closed by deletion 3 days ago
    const id = await resolveEngagementForChild({ childTable: 'jobs', childId: 'job-new', leadId: 'lead-1', locationSlug: 'loc_kc' })
    expect(id).toBe('eng-c')
    expect(h.state.calls.some(c => c.table === 'engagements' && c.ops.some(o => o[0] === 'insert'))).toBe(false)
  })

  it('the landing window is 14 days — the longest measured gap was about 5 days', async () => {
    expect(JOB_DELETED_REOPEN_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000)
    const now = Date.parse('2026-10-01T00:00:00Z')
    h.enqueue('engagements', [{ id: 'eng-c', closed_at: '2026-09-20T00:00:00Z' }])
    expect(await findJobDeletedCloseForClient('lead-1', now)).toEqual({ id: 'eng-c' })
    h.enqueue('engagements', [{ id: 'eng-c', closed_at: '2026-09-01T00:00:00Z' }])
    expect(await findJobDeletedCloseForClient('lead-1', now)).toBeNull()
    const q = h.state.calls.filter(c => c.table === 'engagements')[0].ops
    expect(q).toContainEqual(['eq', ['stage', 'Closed Lost']])
    expect(q).toContainEqual(['eq', ['closed_reason', 'job_deleted']])
  })

  it('only a job-deletion close reopens: a human Lost, a written-off deal and Closed Won never do', async () => {
    for (const eng of [
      { stage: 'Closed Lost', closed_reason: 'Price too high' },
      { stage: 'Closed Lost', closed_reason: 'written_off' },
      { stage: 'Closed Won', closed_reason: 'won' },
    ]) {
      h.reset()
      h.enqueue('engagements', { id: 'e', client_id: 'lead-1', ...eng })
      expect(await reopenIfClosedByJobDeletion('e')).toEqual({ reopened: false })
      expect(updates('engagements')).toHaveLength(0)
    }
  })

  it('the job webhook reopens before it re-derives, on every job create/update', () => {
    const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    const core = src.slice(src.indexOf('async function handleJobCore'), src.indexOf('// Lead-level: jobber_job_id'))
    expect(core).toMatch(/await reopenIfClosedByJobDeletion\(engId\)\s*\n\s*await maybeAdvanceEngagementStage\(engId\)/)
  })
})

// ── 8. the 8 already closed stay closed ────────────────────────────────────
describe('the 8 deals the repair closed stay closed', () => {
  const CLOSED = { id: 'eng-8', stage: 'Closed Lost', closed_reason: 'job_deleted', client_id: 'lead-1', location_uuid: 'u' }
  it('any re-derive leaves them: no stage written, Jobber not asked', async () => {
    h.enqueue('engagements', CLOSED)
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [upcoming({ status: 'deleted' })])
    h.enqueue('invoices', [])
    expect(await maybeAdvanceEngagementStage('eng-8')).toEqual({ advanced: false })
    expect(updates('engagements')[0].stage).toBeUndefined()
    expect(jobberGraphQL).not.toHaveBeenCalled()
  })

  it('no reopen without a live job on the deal — only a remade job can reopen one', async () => {
    h.enqueue('engagements', CLOSED)
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [upcoming({ status: 'deleted' })])
    h.enqueue('invoices', [])
    expect(await reopenIfClosedByJobDeletion('eng-8')).toEqual({ reopened: false })
    expect(updates('engagements')).toHaveLength(0)
  })

  it('nothing runs over existing deals: the reopen is called from ONE place, the job webhook', () => {
    const { execSync } = require('child_process')
    const hits = execSync("grep -rln 'reopenIfClosedByJobDeletion(' app lib scripts components --include=*.ts --include=*.tsx --include=*.js --include=*.mjs | grep -v '\\.test\\.'").toString().trim().split('\n').sort()
    expect(hits).toEqual(['lib/engagements.ts', 'lib/jobber-webhook-handlers.ts'])   // defined + the one caller
  })
})
