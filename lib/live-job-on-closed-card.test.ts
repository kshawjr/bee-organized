// @vitest-environment node
//
// A job Jobber has not finished, on a closed card (Kevin's rulings, 2026-11-21).
//
//   1. A card a MACHINE closed (stale at import, quotes archived) reopens on
//      its own at the stage the app's rule gives — when the job arrives later
//      (job webhook) and when the import judged it stale before its job
//      attached (import pass).
//   2. A card a PERSON closed is never reopened by the machine; the client
//      page says "This person has a new job in Jobber." when a live job was
//      made after the close (lib/live-job-on-closed-card.ts).
//   3. A Won card is left exactly as it is.
// And: the auto-close cron cannot close a reopened card again; nothing here
// emails anyone or writes to Jobber.
//
// What is real: the job webhook (handleJobCreate / handleJobUpdate) with
// upsertJob, resolveEngagementForChild, both reopens and the stage advance;
// the import's per-client pass; the auto-close scan and close; the profile
// route's flag. STAND-IN: the database (one in-memory engine below), Jobber's
// read API, Slack, email.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  const db: any = { t: {} as Record<string, any[]>, seq: 0, writes: [] as string[] }
  const rows = (t: string) => (db.t[t] ||= [])
  const parseList = (v: string) => v.replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''))
  const cmp = (a: any, b: any) => (a == null ? -Infinity : a) < (b == null ? -Infinity : b) ? -1 : a === b ? 0 : 1
  const from = (table: string) => {
    const q: any = { op: 'select', f: [] as ((r: any) => boolean)[], payload: null, order: null, limit: 0, range: null, count: false, head: false, returning: false, onConflict: null }
    const b: any = {}
    b.select = (_c?: string, o?: any) => { if (q.op === 'select') { q.count = !!o?.count; q.head = !!o?.head } else q.returning = true; return b }
    b.eq = (c: string, v: any) => { q.f.push((r: any) => r[c] === v); return b }
    b.neq = (c: string, v: any) => { q.f.push((r: any) => r[c] !== v); return b }
    b.in = (c: string, v: any[]) => { q.f.push((r: any) => v.includes(r[c])); return b }
    b.is = (c: string, v: any) => { q.f.push((r: any) => (v === null ? r[c] == null : r[c] === v)); return b }
    b.not = (c: string, op: string, v: any) => {
      if (op === 'in') { const l = parseList(String(v)); q.f.push((r: any) => !l.includes(r[c])) }
      else if (op === 'is') q.f.push((r: any) => (v === null ? r[c] != null : r[c] !== v))
      else q.f.push((r: any) => r[c] !== v)
      return b
    }
    b.like = (c: string, v: string) => { const re = new RegExp('^' + v.replace(/%/g, '.*') + '$'); q.f.push((r: any) => re.test(String(r[c] ?? ''))); return b }
    b.ilike = (c: string, v: string) => { const re = new RegExp('^' + v.replace(/%/g, '.*') + '$', 'i'); q.f.push((r: any) => re.test(String(r[c] ?? ''))); return b }
    b.gte = (c: string, v: any) => { q.f.push((r: any) => r[c] != null && r[c] >= v); return b }
    b.lte = (c: string, v: any) => { q.f.push((r: any) => r[c] != null && r[c] <= v); return b }
    b.gt = (c: string, v: any) => { q.f.push((r: any) => r[c] != null && r[c] > v); return b }
    b.lt = (c: string, v: any) => { q.f.push((r: any) => r[c] != null && r[c] < v); return b }
    b.or = () => b
    b.order = (c: string, o?: any) => { q.order = [c, o?.ascending !== false]; return b }
    b.limit = (n: number) => { q.limit = n; return b }
    b.range = (a: number, z: number) => { q.range = [a, z]; return b }
    b.insert = (p: any) => { q.op = 'insert'; q.payload = p; return b }
    b.upsert = (p: any, o?: any) => { q.op = 'upsert'; q.payload = p; q.onConflict = o?.onConflict || null; return b }
    b.update = (p: any) => { q.op = 'update'; q.payload = p; return b }
    b.delete = () => { q.op = 'delete'; return b }
    const run = () => {
      const now = new Date().toISOString()
      const all = rows(table)
      if (q.op === 'insert' || q.op === 'upsert') {
        const out: any[] = []
        for (const p of Array.isArray(q.payload) ? q.payload : [q.payload]) {
          const keys = q.onConflict ? String(q.onConflict).split(',') : null
          const clash = keys ? all.find((r: any) => keys.every(k => r[k] === p[k])) : null
          db.writes.push(`${q.op} ${table}`)
          if (clash) { Object.assign(clash, p); out.push({ ...clash }); continue }
          const row = { id: `${table}-${++db.seq}`, created_at: now, updated_at: now, ...p }
          all.push(row); out.push({ ...row })
        }
        return { data: out, error: null }
      }
      let hit = all.filter((r: any) => q.f.every((f: any) => f(r)))
      if (q.op === 'update') { if (hit.length) db.writes.push(`update ${table}`); hit.forEach((r: any) => Object.assign(r, q.payload)); return { data: hit.map((r: any) => ({ ...r })), error: null } }
      if (q.op === 'delete') { db.t[table] = all.filter((r: any) => !hit.includes(r)); db.writes.push(`delete ${table}`); return { data: null, error: null } }
      if (q.order) { const [c, asc] = q.order; hit = [...hit].sort((a, z) => (asc ? 1 : -1) * cmp(a[c], z[c])) }
      if (q.range) hit = hit.slice(q.range[0], q.range[1] + 1)
      if (q.limit) hit = hit.slice(0, q.limit)
      if (q.count) return { data: q.head ? null : hit.map((r: any) => ({ ...r })), count: hit.length, error: null }
      return { data: hit.map((r: any) => ({ ...r })), error: null }
    }
    const one = () => { const r: any = run(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }) }
    b.single = one
    b.maybeSingle = one
    b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return b
  }
  const jobber: any = { job: null as any, mutations: 0 }
  return { db, rows, from, jobber }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t) } }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } } }) }, from: (t: string) => h.from(t) }) }))
// Jobber: reads only. Any mutation is counted and must stay at zero.
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: vi.fn(async (_loc: string, query: string) => {
    if (/^\s*mutation/m.test(query)) { h.jobber.mutations++; return { errors: [{ message: 'no writes in this test' }] } }
    if (/job\s*\(\s*id/.test(query) && h.jobber.job) return { data: { job: h.jobber.job } }
    return { data: {} }
  }),
}))
// The only two ways this codebase sends an email. Both stay at zero.
const resend = vi.hoisted(() => ({ sendEmail: vi.fn(), sendEmailDirect: vi.fn() }))
vi.mock('@/lib/resend', () => ({ sendEmail: resend.sendEmail, sendEmailDirect: resend.sendEmailDirect, renderTemplate: vi.fn() }))
// Slack: the job channel + crew mirror are other slices' business, pinned there.
vi.mock('@/lib/job-channel-auto', () => ({ autoCreateJobChannelSafely: vi.fn(async () => ({ outcome: 'off' })), autoNote: () => null }))
vi.mock('@/lib/jobber-crew-mirror', () => ({ mirrorCrewSafely: vi.fn(async () => {}) }))
const syncLog = vi.hoisted(() => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/sync-log', () => syncLog)

import { handleJobCreate, handleJobUpdate } from '@/lib/jobber-webhook-handlers'
import { reopenIfMachineClosedForLiveJob, reopenMachineClosedCardsForClient, maybeAdvanceEngagementStage, deriveEngagementStage } from '@/lib/engagements'
import { isLiveJob, personClosed, personClosedCardHasNewJob, machineClosedForReopen, NEW_JOB_NOTE, LIVE_JOB_STATUSES } from '@/lib/live-job-on-closed-card'
import { findStaleEnquiries, closeStaleEnquiry } from '@/lib/auto-close'
import { GET as profileGET } from '@/app/api/clients/[id]/profile/route'

const LOC = 'loc-uuid-1'
const SLUG = 'loc_test_city'
const DAY = 24 * 60 * 60 * 1000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`).toString('base64')
const ctx = (topic: string, n: string) => ({ topic, itemId: gid('Job', n), occurredAt: new Date().toISOString(), location: { id: LOC, location_id: SLUG, name: 'Test City' } as any })
const eng = (id: string) => h.rows('engagements').find((e: any) => e.id === id)
const touches = (id: string) => h.rows('touchpoints').filter((t: any) => t.engagement_id === id)

function seed(card: Partial<any>, opts: { jobs?: any[]; quotes?: any[]; sr?: boolean } = {}) {
  h.db.t = {}; h.db.seq = 0; h.db.writes = []
  h.rows('locations').push({ id: LOC, location_id: SLUG, name: 'Test City', lifecycle_status: 'active', subscription_status: 'active' })
  h.rows('leads').push({ id: 'lead-1', name: 'Pat Client', location_id: SLUG, location_uuid: LOC, jobber_client_id: '900', created_at: iso(400 * DAY), import_source: 'jobber_initial', email: 'pat@example.com', phone: '5551234567' })
  h.rows('engagements').push({ id: 'card-1', client_id: 'lead-1', location_uuid: LOC, founded_by: 'request', title: 'Garage', created_at: iso(200 * DAY), stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: iso(100 * DAY), closed_note: 'Closed automatically at import: no activity within 30 days (Ruling A for quote-only).', ...card })
  if (opts.sr !== false) h.rows('service_requests').push({ id: 'sr-1', lead_id: 'lead-1', location_id: SLUG, jobber_request_id: '700', engagement_id: 'card-1', requested_at: iso(200 * DAY), created_at: iso(200 * DAY) })
  for (const q of opts.quotes ?? [{ status: 'approved', created_at: iso(190 * DAY), sent_at: iso(190 * DAY), approved_at: iso(5 * DAY) }]) h.rows('quotes').push({ id: `q-${h.rows('quotes').length + 1}`, lead_id: 'lead-1', location_id: SLUG, engagement_id: 'card-1', jobber_quote_id: '800', ...q })
  for (const j of opts.jobs ?? []) h.rows('jobs').push({ id: `job-${h.rows('jobs').length + 1}`, lead_id: 'lead-1', location_id: SLUG, engagement_id: 'card-1', completed_at: null, ...j })
}
// A job Jobber is about to tell us about, made from the card's request.
const jobberJob = (n: string, status: string, over: any = {}) => ({
  id: gid('Job', n), title: 'Garage clear-out', jobStatus: status, startAt: new Date(Date.now() + 5 * DAY).toISOString(), completedAt: null,
  createdAt: new Date().toISOString(), total: '900', client: { id: gid('Client', '900') }, request: { id: gid('Request', '700') }, quote: null, ...over,
})

beforeEach(() => { vi.clearAllMocks(); h.jobber.job = null; h.jobber.mutations = 0 })

// ── the predicates ───────────────────────────────────────────────────────
describe('what counts as live, machine and person', () => {
  it('live = the five statuses Kevin named, and never once completed', () => {
    expect(Array.from(LIVE_JOB_STATUSES).sort()).toEqual(['in_progress', 'late', 'today', 'unscheduled', 'upcoming'])
    for (const s of Array.from(LIVE_JOB_STATUSES)) expect(isLiveJob({ status: s })).toBe(true)
    for (const s of ['completed', 'archived', 'deleted', 'action_required', 'on_hold', 'unknown', '']) expect(isLiveJob({ status: s })).toBe(false)
    expect(isLiveJob({ status: 'upcoming', completed_at: '2026-11-01T00:00:00Z' })).toBe(false)
  })
  it('machine closes that reopen: stale at import and quote archived, Closed Lost only', () => {
    expect(machineClosedForReopen({ stage: 'Closed Lost', closed_reason: 'stale_on_import' })).toBe(true)
    expect(machineClosedForReopen({ stage: 'Closed Lost', closed_reason: 'quote_archived' })).toBe(true)
    for (const r of ['No response', 'Project cancelled', 'duplicate', 'job_deleted', 'request_destroyed', 'written_off', null]) expect(machineClosedForReopen({ stage: 'Closed Lost', closed_reason: r })).toBe(false)
    expect(machineClosedForReopen({ stage: 'Closed Won', closed_reason: 'won' })).toBe(false)
  })
  it("a person's close is any Lost reason nobody's machine wrote; Won is never one", () => {
    for (const r of ['No response', 'Project cancelled', 'Price too high', 'duplicate', 'written_off', 'Junk Lead']) expect(personClosed({ stage: 'Closed Lost', closed_reason: r })).toBe(true)
    for (const r of ['stale_on_import', 'quote_archived', 'job_deleted', 'request_destroyed']) expect(personClosed({ stage: 'Closed Lost', closed_reason: r })).toBe(false)
    expect(personClosed({ stage: 'Closed Won', closed_reason: 'won' })).toBe(false)
  })
  it('the note needs a live job made AFTER the close (one already there when they closed it, they saw)', () => {
    const closed = { stage: 'Closed Lost', closed_reason: 'No response', closed_at: '2026-09-28T12:00:00Z' }
    expect(personClosedCardHasNewJob(closed, [{ status: 'upcoming', created_at: '2026-11-13T00:00:00Z' }])).toBe(true)
    expect(personClosedCardHasNewJob(closed, [{ status: 'upcoming', created_at: '2026-09-01T00:00:00Z' }])).toBe(false)
    expect(personClosedCardHasNewJob(closed, [{ status: 'completed', created_at: '2026-11-13T00:00:00Z' }])).toBe(false)
    expect(personClosedCardHasNewJob(closed, [{ status: 'upcoming', created_at: null }])).toBe(false)
    expect(personClosedCardHasNewJob({ ...closed, closed_at: null }, [{ status: 'upcoming', created_at: '2026-11-13T00:00:00Z' }])).toBe(false)
    expect(personClosedCardHasNewJob({ stage: 'Closed Won', closed_reason: 'won', closed_at: '2026-09-28T12:00:00Z' }, [{ status: 'upcoming', created_at: '2026-11-13T00:00:00Z' }])).toBe(false)
    expect(NEW_JOB_NOTE).toBe('This person has a new job in Jobber.')
  })
})

// ── ruling 1, a job that arrives later: the job webhook ──────────────────
describe('ruling 1 — a live job arriving on a machine-closed card reopens it (job webhook, real handler)', () => {
  it('stale at import + a booked job made from its request → Job in Progress, one Reopened touchpoint', async () => {
    seed({})
    h.jobber.job = jobberJob('5001', 'UPCOMING')
    const res = await handleJobCreate(ctx('JOB_CREATE', '5001'))
    expect(res.processed).toBe(true)
    const c = eng('card-1')
    expect(c).toMatchObject({ stage: 'Job in Progress', closed_at: null, closed_reason: null, closed_note: null, nurture_started_at: null })
    expect(touches('card-1').map((t: any) => t.label)).toEqual(['Reopened: Closed Lost → Job in Progress (a job in Jobber is still to do; it was closed as stale at import)'])
    expect(h.rows('jobs').find((j: any) => j.jobber_job_id === '5001').engagement_id).toBe('card-1')
    expect(h.rows('engagements')).toHaveLength(1) // no second card
  })

  it('quote archived + an unscheduled job → Estimate (the app\'s own rule for unbooked work)', async () => {
    seed({ closed_reason: 'quote_archived', closed_note: 'Closed automatically: the quote was archived in Jobber (#117).' }, { quotes: [{ status: 'archived', created_at: iso(60 * DAY) }] })
    h.jobber.job = jobberJob('5002', 'UNSCHEDULED', { startAt: null })
    await handleJobCreate(ctx('JOB_CREATE', '5002'))
    expect(eng('card-1')).toMatchObject({ stage: 'Estimate', closed_reason: null })
    expect(touches('card-1')[0].label).toMatch(/the quote was archived/)
  })

  it('a job ALREADY on the card that Jobber updates to live reopens it too (JOB_UPDATE)', async () => {
    seed({}, { jobs: [{ jobber_job_id: '5003', status: 'archived', completed_at: iso(150 * DAY), created_at: iso(180 * DAY) }] })
    h.jobber.job = jobberJob('5003', 'LATE', { createdAt: iso(180 * DAY), startAt: iso(3 * DAY) })
    await handleJobUpdate(ctx('JOB_UPDATE', '5003'))
    expect(eng('card-1').stage).toBe('Job in Progress')
  })

  for (const status of ['COMPLETED', 'ARCHIVED', 'ACTION_REQUIRED', 'ON_HOLD']) {
    it(`a ${status} job does not reopen it`, async () => {
      seed({})
      h.jobber.job = jobberJob('5004', status, { completedAt: status === 'COMPLETED' || status === 'ARCHIVED' ? iso(DAY) : null })
      await handleJobCreate(ctx('JOB_CREATE', '5004'))
      expect(eng('card-1')).toMatchObject({ stage: 'Closed Lost', closed_reason: 'stale_on_import' })
      expect(touches('card-1')).toHaveLength(0)
    })
  }

  it('the stage advance right after does not close it again, and a second notice changes nothing', async () => {
    seed({})
    h.jobber.job = jobberJob('5005', 'UPCOMING')
    await handleJobCreate(ctx('JOB_CREATE', '5005'))
    await handleJobUpdate(ctx('JOB_UPDATE', '5005'))
    await maybeAdvanceEngagementStage('card-1')
    expect(eng('card-1').stage).toBe('Job in Progress')
    expect(touches('card-1')).toHaveLength(1)
  })

  it('nothing emails anyone, nothing writes to Jobber', async () => {
    seed({})
    h.jobber.job = jobberJob('5006', 'UPCOMING')
    await handleJobCreate(ctx('JOB_CREATE', '5006'))
    expect(eng('card-1').stage).toBe('Job in Progress')
    expect(resend.sendEmail).not.toHaveBeenCalled()
    expect(resend.sendEmailDirect).not.toHaveBeenCalled()
    expect(h.jobber.mutations).toBe(0)
    expect(h.db.writes.filter((w: string) => /email|drip|notification/.test(w))).toEqual([])
  })
})

// ── ruling 2 and 3 on the webhook: never reopened by the machine ─────────
describe("rulings 2 and 3 — a person's close and a Won are never reopened by a job", () => {
  for (const reason of ['No response', 'Project cancelled', 'duplicate', 'Price too high']) {
    it(`closed "${reason}" by a person stays closed`, async () => {
      seed({ closed_reason: reason, closed_note: null, closed_at: iso(50 * DAY) })
      h.jobber.job = jobberJob('6001', 'UPCOMING')
      await handleJobCreate(ctx('JOB_CREATE', '6001'))
      expect(eng('card-1')).toMatchObject({ stage: 'Closed Lost', closed_reason: reason })
      expect(touches('card-1')).toHaveLength(0)
    })
  }
  it('Won stays Won', async () => {
    seed({ stage: 'Closed Won', closed_reason: 'won', closed_note: null, closed_at: iso(40 * DAY) })
    h.jobber.job = jobberJob('6002', 'UPCOMING')
    await handleJobCreate(ctx('JOB_CREATE', '6002'))
    expect(eng('card-1')).toMatchObject({ stage: 'Closed Won', closed_reason: 'won' })
    expect(touches('card-1')).toHaveLength(0)
  })
  it('the reopen refuses a person-closed card directly as well', async () => {
    seed({ closed_reason: 'No response' }, { jobs: [{ jobber_job_id: '1', status: 'upcoming', created_at: iso(1 * DAY) }] })
    expect(await reopenIfMachineClosedForLiveJob('card-1')).toEqual({ reopened: false })
    expect(eng('card-1').stage).toBe('Closed Lost')
  })
  it('a card someone changed in the meantime is not overwritten (the write is guarded on the close it read)', async () => {
    seed({}, { jobs: [{ jobber_job_id: '1', status: 'upcoming', created_at: iso(DAY) }] })
    const real = h.from
    let flipped = false
    // Between the read and the write, a person closes it with their own reason.
    ;(h as any).from = (t: string) => {
      if (t === 'jobs' && !flipped) { flipped = true; eng('card-1').closed_reason = 'Project cancelled' }
      return real(t)
    }
    try { expect((await reopenIfMachineClosedForLiveJob('card-1')).reopened).toBe(false) } finally { (h as any).from = real }
    expect(eng('card-1')).toMatchObject({ stage: 'Closed Lost', closed_reason: 'Project cancelled' })
  })
})

// ── ruling 1, the import order ───────────────────────────────────────────
describe('ruling 1 — the import: a card judged stale before its live job attached is kept open', () => {
  it('found → judged stale (real backfill derive) → live job attaches → a later quote re-judges it stale → the per-client pass keeps it open, with no Reopened touchpoint', async () => {
    seed({ stage: 'Request', closed_reason: null, closed_at: null, closed_note: null }, { quotes: [{ status: 'awaiting_response', created_at: iso(120 * DAY), sent_at: iso(120 * DAY) }] })
    const started = new Date(Date.now() - 1000).toISOString()
    await maybeAdvanceEngagementStage('card-1', { mode: 'backfill' })
    expect(eng('card-1')).toMatchObject({ stage: 'Closed Lost', closed_reason: 'stale_on_import' })
    h.rows('jobs').push({ id: 'job-x', lead_id: 'lead-1', location_id: SLUG, engagement_id: 'card-1', jobber_job_id: '7001', status: 'unscheduled', completed_at: null, created_at: iso(90 * DAY) })
    await maybeAdvanceEngagementStage('card-1', { mode: 'backfill' }) // the unbooked job is old: still stale on the backfill clock
    expect(eng('card-1').stage).toBe('Closed Lost')
    expect(await reopenMachineClosedCardsForClient('lead-1', { closedSinceIso: started })).toBe(1)
    expect(eng('card-1')).toMatchObject({ stage: 'Estimate', closed_reason: null, closed_at: null })
    expect(touches('card-1')).toHaveLength(0) // closed and reopened inside one import: not news
    expect(syncLog.writeSyncLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/the import closed this card stale_on_import before its live job attached/) }))
  })
  it('a card closed by an EARLIER import, re-imported with a live job, reopens with the Reopened touchpoint', async () => {
    seed({ closed_at: iso(100 * DAY) }, { jobs: [{ jobber_job_id: '7002', status: 'upcoming', created_at: iso(3 * DAY) }] })
    expect(await reopenMachineClosedCardsForClient('lead-1', { closedSinceIso: iso(1000) })).toBe(1)
    expect(touches('card-1')).toHaveLength(1)
  })
  it('the pass touches nothing else: person closes, Won, and machine closes with no live job', async () => {
    seed({ closed_reason: 'No response' }, { jobs: [{ jobber_job_id: '1', status: 'upcoming', created_at: iso(DAY) }] })
    h.rows('engagements').push({ id: 'card-2', client_id: 'lead-1', location_uuid: LOC, founded_by: 'quote', stage: 'Closed Won', closed_reason: 'won', closed_at: iso(10 * DAY) })
    h.rows('jobs').push({ id: 'j2', lead_id: 'lead-1', engagement_id: 'card-2', status: 'upcoming', created_at: iso(DAY), completed_at: null })
    h.rows('engagements').push({ id: 'card-3', client_id: 'lead-1', location_uuid: LOC, founded_by: 'quote', stage: 'Closed Lost', closed_reason: 'stale_on_import', closed_at: iso(10 * DAY) })
    h.rows('jobs').push({ id: 'j3', lead_id: 'lead-1', engagement_id: 'card-3', status: 'completed', created_at: iso(30 * DAY), completed_at: iso(20 * DAY) })
    const before = JSON.stringify(h.rows('engagements'))
    expect(await reopenMachineClosedCardsForClient('lead-1')).toBe(0)
    expect(JSON.stringify(h.rows('engagements'))).toBe(before)
  })
  it('the import route runs the pass once per client, after every record is in and before the lead stage', () => {
    const src = readFileSync('app/api/import/jobber-clients/route.ts', 'utf8')
    const start = src.indexOf('const clientStartedIso = new Date().toISOString()')
    const upsert = src.indexOf('await upsertLead(client, locSlug, locUuid, {', start)
    const reqless = src.indexOf('for (const job of (reqlessJobsByClient[client.id] || []))')
    const pass = src.indexOf('await reopenMachineClosedCardsForClient(leadId, { closedSinceIso: clientStartedIso })')
    const stage = src.indexOf('// ─── lead-level stage classification ──')
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThan(upsert)
    expect(reqless).toBeLessThan(pass)
    expect(pass).toBeLessThan(stage)
    expect(src.split('reopenMachineClosedCardsForClient(').length - 1).toBe(1)
  })
})

// ── the auto-close cron cannot re-close it ───────────────────────────────
describe('the auto-close cron never closes a reopened card', () => {
  it('a website enquiry, 70 days later, with the reopened card: spared as open Jobber work, and its run changes nothing', async () => {
    // Pat filled in the website form again 60 days ago (so the old job is not
    // an "exit"), and the card was reopened by a live job.
    seed({}, { jobs: [{ jobber_job_id: '8001', status: 'upcoming', created_at: iso(90 * DAY) }] })
    h.rows('touchpoints').push({ id: 'tp-r', lead_id: 'lead-1', kind: 'system', label: 'Webform resubmission', occurred_at: iso(60 * DAY) })
    expect((await reopenIfMachineClosedForLiveJob('card-1')).reopened).toBe(true)
    // the reopen itself spares it for 35 days; 40 days on it is the open card that holds it
    const later = new Date(Date.now() + 40 * DAY)
    for (const t of h.rows('touchpoints')) if (/^Reopened/.test(t.label)) t.occurred_at = iso(0)
    const scan = await findStaleEnquiries({ now: later })
    expect(scan.toClose.map(x => x.leadId)).not.toContain('lead-1')
    expect(scan.spared.find(x => x.leadId === 'lead-1')?.reason).toBe('open_jobber_work')
    for (const item of scan.toClose) await closeStaleEnquiry(item, { now: later })
    expect(eng('card-1').stage).toBe('Job in Progress')
  })
  it('and a close it is handed can only ever touch hand-made empty cards (the ids it found), never this one', () => {
    const src = readFileSync('lib/auto-close.ts', 'utf8')
    expect(src).toMatch(/\(e\) => e\.founded_by !== 'manual' \|\| rows\.some\(\(w\) => w\.engagementId === e\.id\)/)
    expect(src).toMatch(/\.in\('id', item\.openEngagementIds\)/)
  })
})

// ── ruling 2 on the client page: the flag ─────────────────────────────────
describe('ruling 2 — the client page is told, and nothing is written', () => {
  const get = async () => (await profileGET(new Request('http://x/api/clients/lead-1/profile') as any, { params: Promise.resolve({ id: 'lead-1' }) } as any)).json()
  const owner = () => h.rows('hub_users').push({ id: 'owner-1', role: 'owner', location_id: LOC })
  it('Anna Hauter\'s shape: closed "No response", a job made from her request afterwards → new_job_in_jobber, card untouched', async () => {
    seed({ closed_reason: 'No response', closed_at: iso(50 * DAY), closed_note: null }, { jobs: [{ jobber_job_id: '9001', status: 'upcoming', created_at: iso(8 * DAY) }] })
    owner()
    const writesBefore = h.db.writes.length
    const body = await get()
    const card = body.engagements.find((e: any) => e.id === 'card-1')
    expect(card.new_job_in_jobber).toBe(true)
    expect(card.stage).toBe('Closed Lost')
    expect(h.db.writes.slice(writesBefore).filter((w: string) => /engagements/.test(w))).toEqual([])
  })
  it("Jessie Delaney's shape: the job was already there when they closed it → no flag", async () => {
    seed({ closed_reason: 'Project cancelled', closed_at: iso(10 * DAY), closed_note: null }, { jobs: [{ jobber_job_id: '9002', status: 'unscheduled', created_at: iso(20 * DAY) }] })
    owner()
    expect((await get()).engagements.find((e: any) => e.id === 'card-1').new_job_in_jobber).toBeUndefined()
  })
  it('Won and machine closes never carry the flag', async () => {
    for (const card of [{ stage: 'Closed Won', closed_reason: 'won' }, { closed_reason: 'stale_on_import' }, { closed_reason: 'quote_archived' }]) {
      seed({ ...card, closed_at: iso(50 * DAY) }, { jobs: [{ jobber_job_id: '9003', status: 'upcoming', created_at: iso(DAY) }] })
      owner()
      expect((await get()).engagements.find((e: any) => e.id === 'card-1').new_job_in_jobber).toBeUndefined()
    }
  })
})

describe('the derivation the reopen relies on is unchanged', () => {
  it('a live booked job is Job in Progress; an unscheduled one is Estimate (live mode, never auto-Won)', () => {
    const kids = (jobs: any[]) => ({ sr: null, quotes: [], jobs, invoices: [] })
    expect(deriveEngagementStage(kids([{ status: 'upcoming' }]), { mode: 'live', closeWonOnDone: false }).stage).toBe('Job in Progress')
    expect(deriveEngagementStage(kids([{ status: 'unscheduled', created_at: '2020-01-01T00:00:00Z' }]), { mode: 'live', closeWonOnDone: false }).stage).toBe('Estimate')
  })
})
