// WITH THE SWITCH OFF, A NEW JOB DOES EXACTLY WHAT IT DID BEFORE THE SWITCH
// EXISTED — by fingerprint (2026-11-12, slice 3 of 3).
//
// RECORDED on b557f0b, the commit before automatic job channels, by running
// THIS file there (it imports nothing that slice added) with FP_RECORD=1.
// The fingerprint is everything a new-job notice does that anyone could
// notice: what the handler answers (and so the sync_log line), every database
// WRITE in order, every Slack call, every Jobber document and its variables,
// and the database afterwards (clock times blanked).
//
// One thing is allowed to differ, and it is pinned too: ONE extra database
// READ per JOB_CREATE — the location's switch. No write, no Slack call, no
// Jobber call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => {
  const db: any = { tables: {} as Record<string, any[]>, seq: 0, seedFaults: [] as string[], writes: [] as string[], reads: [] as string[], check: null as any, fail: null as null | ((table: string, op: string) => any) }
  const match = (r: any, f: any[]) => {
    const [m, col, val] = f
    if (m === 'eq') return r[col] === val
    if (m === 'is') return val === null ? r[col] == null : r[col] === val
    if (m === 'not') return r[col] != null
    if (m === 'gte') return r[col] != null && String(r[col]) >= String(val)
    if (m === 'in') return (val as any[]).includes(r[col])
    if (m === 'ilike') return String(r[col] ?? '').toLowerCase().includes(String(val).replace(/%/g, '').toLowerCase())
    return true
  }
  const UNIQUE: Record<string, (a: any, b: any) => boolean> = {
    location_bees: (a, b) => a.location_uuid === b.location_uuid && String(a.email).toLowerCase() === String(b.email).toLowerCase(),
    engagement_bees: (a, b) => a.engagement_id === b.engagement_id && a.bee_id === b.bee_id,
    job_visits: (a, b) => a.jobber_visit_id === b.jobber_visit_id,
    jobs: (a, b) => a.location_id === b.location_id && a.jobber_job_id === b.jobber_job_id,
  }
  const DEFAULTS: Record<string, () => any> = {
    location_bees: () => ({ jobber_user_id: null, slack_user_id: null, slack_checked_at: null, is_active: true, removed_at: null }),
    engagement_bees: () => ({ assigned_at: new Date().toISOString(), removed_at: null }),
    job_visits: () => ({}),
  }
  const from = (table: string) => {
    const ctx: any = { op: 'select', filters: [] as any[], payload: null, cols: '', limit: 0 }
    const b: any = {}
    b.select = (c?: string) => { ctx.cols = c || '*'; return b }
    b.order = () => b
    b.limit = (n: number) => { ctx.limit = n; return b }
    for (const m of ['eq', 'is', 'gte', 'ilike']) b[m] = (c: string, v: any) => { ctx.filters.push([m, c, v]); return b }
    b.not = (c: string) => { ctx.filters.push(['not', c]); return b }
    b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
    b.update = (p: any) => { ctx.op = 'update'; ctx.payload = p; return b }
    b.upsert = (p: any) => { ctx.op = 'upsert'; ctx.payload = p; return b }
    b.in = (c: string, v: any[]) => { ctx.filters.push(['in', c, v]); return b }
    const run = () => {
      const failed = db.fail?.(table, ctx.op)
      if (failed) return { data: null, error: failed }
      const rows = (db.tables[table] ||= [])
      const { unknownColumns, unknownKeys, missingColumnError } = db.check
      for (const r of rows) for (const k of unknownKeys(table, r)) {
        const fault = `${table}.${k}`
        if (!db.seedFaults.includes(fault)) db.seedFaults.push(fault)
      }
      const wrong = [
        ...(ctx.cols ? unknownColumns(table, ctx.cols).map((p: any) => [p.table, p.column]) : []),
        ...ctx.filters.map((x: any) => [table, x[1]]).filter(([t, c]: any) => unknownKeys(t, { [c]: 1 }).length),
        ...(ctx.payload ? unknownKeys(table, ctx.payload).map((k: string) => [table, k]) : []),
      ][0]
      if (wrong) return { data: null, error: missingColumnError(wrong[0], wrong[1]) }
      const now = new Date().toISOString()
      if (ctx.op === 'insert' || ctx.op === 'upsert') {
        const clash = UNIQUE[table] ? rows.find((x: any) => UNIQUE[table](x, ctx.payload)) : null
        if (clash && ctx.op === 'insert') return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } }
        db.writes.push(`${ctx.op} ${table}`)
        if (clash) { Object.assign(clash, ctx.payload); return { data: [{ ...clash }], error: null } }
        const row = { id: `iiiiiiii-iiii-4iii-8iii-${String(++db.seq).padStart(12, '0')}`, created_at: now, updated_at: now, ...(DEFAULTS[table]?.() || {}), ...ctx.payload }
        rows.push(row)
        return { data: [{ ...row }], error: null }
      }
      let hits = rows.filter((r: any) => ctx.filters.every((f: any) => match(r, f)))
      if (ctx.op === 'select') db.reads.push(table)
      if (ctx.op === 'update') { if (hits.length) db.writes.push(`update ${table}`); hits.forEach((r: any) => Object.assign(r, ctx.payload)); return { data: hits.map((r: any) => ({ ...r })), error: null } }
      if (ctx.limit) hits = hits.slice(0, ctx.limit)
      return { data: hits.map((r: any) => ({ ...r })), error: null }
    }
    const one = () => { const r: any = run(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }) }
    b.single = one
    b.maybeSingle = one
    b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return b
  }
  // ── Jobber ──
  const jobber: any = { jobs: {} as Record<string, any>, people: {} as Record<string, { name: string; email: string | null }>, records: {} as Record<string, any>, said: [] as { query: string; vars: any }[], writes: [] as any[], down: false, throws: false }
  const tail = (gid: string) => (Buffer.from(String(gid), 'base64').toString('utf8').match(/\/(\d+)$/) || [])[1] || String(gid)
  const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')
  const read = async (_slug: string, query: string, vars: any) => {
    jobber.said.push({ query, vars })
    if (jobber.throws) throw new Error('Jobber GraphQL HTTP 503: busy')
    if (jobber.down) return { errors: [{ message: 'no_valid_jobber_token' }] }
    if (query.includes('GetJob')) {
      const rec = jobber.records[tail(vars.id)]
      return rec ? { data: { job: { id: vars.id, ...rec } } } : { data: { job: null } }
    }
    if (query.includes('JobCrewForMirror')) {
      const job = jobber.jobs[tail(vars.jobId)]
      if (job === 'fail') return { errors: [{ message: 'Throttled' }] }
      if (!job) return { data: { job: null } }
      const size = job.pageSize || 1000
      const start = vars.after ? Number(vars.after) : 0
      const page = job.visits.slice(start, start + size)
      return { data: { job: { id: vars.jobId, visits: {
        pageInfo: { hasNextPage: start + size < job.visits.length, endCursor: String(start + size) },
        nodes: page.map((v: any) => ({ id: gid('Visit', v.id), isComplete: !!v.done, assignedUsers: {
          pageInfo: { hasNextPage: !!v.crewOverflow },
          nodes: v.crew.map((u: string) => ({ id: u, name: { full: jobber.people[u].name }, email: { raw: jobber.people[u].email } })),
        } })),
      } } } }
    }
    if (query.includes('VisitJobForMirror')) {
      const want = tail(vars.id)
      for (const [jobId, job] of Object.entries<any>(jobber.jobs)) {
        const v = job && job !== 'fail' ? job.visits.find((x: any) => x.id === want) : null
        if (v) return { data: { visit: { id: vars.id, isComplete: !!v.done, job: { id: gid('Job', jobId) } } } }
      }
      return { data: { visit: null }, errors: [{ message: 'Visit not found', path: ['visit'] }] }
    }
    return { errors: [{ message: 'unexpected document' }] }
  }
  return { db, from, jobber, read, gid }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t) } }))
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: (...a: any[]) => (h.read as any)(...a),
  jobberMutation: async (...a: any[]) => { h.jobber.writes.push(a); return { data: {}, userErrors: [] } },
  JOBBER_API_VERSION: 'test',
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: async () => {} }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: async () => {}, stopActiveDripsForLead: async () => {} }))
// The deal a job belongs to is worked out by lib/engagements.ts (tested on its
// own). Here it is a lookup: the job's Jobber id → the deal the test seeded.
vi.mock('@/lib/engagements', () => ({
  ensureEngagementForServiceRequest: async () => null,
  resolveEngagementForChild: async (a: any) => {
    const row = h.db.tables.jobs.find((j: any) => j.id === a.childId)
    return (h as any).dealFor[row?.jobber_job_id] ?? null
  },
  attachToEngagement: async (_t: string, id: string, engId: string) => { const row = h.db.tables.jobs.find((j: any) => j.id === id); if (row) row.engagement_id = engId },
  maybeAdvanceEngagementStage: async () => {},
  refreshEngagementMoney: async () => {},
  reopenIfClosedByJobDeletion: async () => {},
}))

import * as check from '@/lib/db-columns-check'
import { TOPIC_HANDLERS } from '@/lib/jobber-webhook-handlers'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', LOC_OLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const TOKEN = 'xoxb-test'
const NEW_SCOPES = 'chat:write,channels:read,channels:manage,users:read,users:read.email'
const OLD_SCOPES = 'chat:write,channels:read,users:read,users:read.email'
const ANA = h.gid('User', '1'), SAM = h.gid('User', '2')
const SLUG: Record<string, string> = { [LOC]: 'loc_test', [LOC_OLD]: 'loc_old' }
const CLIENT: Record<string, string> = { [LOC]: '7001', [LOC_OLD]: '7003' }

// ── the fake Slack workspace ──
type Chan = { name: string; members: Set<string>; archived: boolean }
let slack: { users: Record<string, string>; channels: Map<string, Chan>; calls: { method: string; body: any }[]; down: boolean; seq: number }
const slackFetch = async (url: string, init: any) => {
  const u = new URL(url)
  const method = u.pathname.replace('/api/', '')
  const body = init?.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams)
  slack.calls.push({ method, body })
  const ok = (x: any = {}) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...x }) }) as any
  const no = (error: string) => ({ ok: true, status: 200, json: async () => ({ ok: false, error }) }) as any
  if (slack.down) return no('ratelimited')
  if (method === 'users.lookupByEmail') { const id = slack.users[String(body.email).toLowerCase()]; return id ? ok({ user: { id } }) : no('users_not_found') }
  if (method === 'conversations.create') {
    if (Array.from(slack.channels.values()).some(c => c.name === body.name)) return no('name_taken')
    const id = `CNEW${++slack.seq}`
    slack.channels.set(id, { name: body.name, members: new Set(['UBOT']), archived: false })
    return ok({ channel: { id, name: body.name } })
  }
  const ch = slack.channels.get(body.channel)
  if (!ch) return no('channel_not_found')
  if (method === 'conversations.invite') { if (ch.members.has(body.users)) return no('already_in_channel'); ch.members.add(body.users); return ok() }
  if (method === 'conversations.kick') { if (!ch.members.has(body.user)) return no('not_in_channel'); ch.members.delete(body.user); return ok() }
  if (method === 'chat.postMessage') return ok()
  if (method === 'conversations.archive') { ch.archived = true; return ok() }
  if (method === 'conversations.unarchive') { ch.archived = false; return ok() }
  return no('unknown_method')
}
const made = () => slack.calls.filter(c => c.method === 'conversations.create')

const engId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const eng = (n: number, loc = LOC, over: any = {}) => ({
  id: engId(n), location_uuid: loc, client_id: `lead-${CLIENT[loc]}`, project_type: 'Pantry', stage: 'Job in Progress', closed_at: null,
  slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null, slack_channel_problems: null, ...over,
})
const jobInJobber = (jobberId: string, deal: number, loc = LOC, over: any = {}) => {
  h.jobber.records[jobberId] = { createdAt: '2026-11-10T12:00:01.000Z', jobberWebUri: null, title: 'Pantry', jobStatus: 'UPCOMING', startAt: null, completedAt: null, total: '100', client: { id: h.gid('Client', CLIENT[loc]) }, request: null, quote: null, ...over }
  ;(h as any).dealFor[jobberId] = engId(deal)
  if (!h.jobber.jobs[jobberId]) h.jobber.jobs[jobberId] = { visits: [] }
}
const fire = (topic: string, type: string, id: string, loc = LOC) =>
  TOPIC_HANDLERS[topic]({ topic, itemId: h.gid(type, id), occurredAt: '2026-11-10T12:00:02.000Z', location: { id: loc, location_id: SLUG[loc], name: 'Test', timezone: null, jobber_account_id: null, jobber_access_token: null } as any })

beforeEach(() => {
  h.db.check = check
  h.db.seq = 0; h.db.seedFaults = []; h.db.writes = []; h.db.reads = []; h.db.fail = null
  ;(h as any).dealFor = {}
  h.db.tables = {
    // No switch columns in these rows at all: every location is as it was.
    locations: [
      { id: LOC, location_id: 'loc_test', name: 'Test', jobber_connected: true, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: NEW_SCOPES },
      { id: LOC_OLD, location_id: 'loc_old', name: 'Old', jobber_connected: true, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: OLD_SCOPES },
    ],
    leads: Object.entries(CLIENT).map(([l, c]) => ({ id: `lead-${c}`, location_id: SLUG[l], jobber_client_id: c, name: 'Sarah McAllister', stage: 'Quote Sent' })),
    engagements: [eng(1), eng(2), eng(3, LOC, { slack_channel_id: 'C1', slack_channel_name: 'sarah-pantry' }), eng(4, LOC_OLD)],
    jobs: [], quotes: [], service_requests: [], location_bees: [], engagement_bees: [], job_visits: [], sync_log: [],
    hub_users: [{ id: 'u-owner', role: 'owner', location_id: LOC, email: 'owner@bee.test', full_name: 'Olive Owner' }],
  }
  h.jobber.said = []; h.jobber.writes = []; h.jobber.down = false; h.jobber.throws = false; h.jobber.jobs = {}; h.jobber.records = {}
  h.jobber.people = { [ANA]: { name: 'Ana Bee', email: 'ana@bee.test' }, [SAM]: { name: 'Sam Carpenter', email: 'sam@bee.test' } }
  slack = { users: { 'ana@bee.test': 'U_ANA', 'sam@bee.test': 'U_SAM', 'owner@bee.test': 'U_OWNER' }, channels: new Map([['C1', { name: 'sarah-pantry', members: new Set(['UBOT']), archived: false }]]), calls: [], down: false, seq: 0 }
  vi.stubGlobal('fetch', vi.fn(slackFetch))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const blank = (x: any) => JSON.parse(JSON.stringify(x).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'T'))
const doc = (q: string) => (q.match(/query\s+(\w+)/) || [])[1] || 'unknown'

// The scenarios: every kind of new-job notice this slice could have changed.
async function run() {
  const steps: any[] = []
  const step = async (label: string, topic: string, type: string, id: string, loc = LOC) => {
    const w0 = h.db.writes.length, s0 = slack.calls.length, j0 = h.jobber.said.length, r0 = h.db.reads.length
    const result = await fire(topic, type, id, loc)
    steps.push({
      label, result,
      writes: h.db.writes.slice(w0), slack: slack.calls.slice(s0),
      jobber: h.jobber.said.slice(j0).map((x: any) => [doc(x.query), x.vars]),
      reads: h.db.reads.slice(r0),
    })
  }
  jobInJobber('501', 1); h.jobber.jobs['501'] = { visits: [{ id: '9001', crew: [ANA, SAM] }] }
  jobInJobber('502', 2, LOC, { jobStatus: 'UNSCHEDULED' })
  jobInJobber('503', 3); h.jobber.jobs['503'] = { visits: [{ id: '9003', crew: [ANA] }] }
  jobInJobber('504', 4, LOC_OLD); h.jobber.jobs['504'] = { visits: [{ id: '9004', crew: [ANA] }] }
  await step('new booked job with a team, reconnected location, no channel', 'JOB_CREATE', 'Job', '501')
  await step('new unbooked job, nobody on it', 'JOB_CREATE', 'Job', '502')
  await step('new job on a deal that has a channel', 'JOB_CREATE', 'Job', '503')
  await step('new job at a location that has not reconnected', 'JOB_CREATE', 'Job', '504', LOC_OLD)
  await step('the same JOB_CREATE delivered again', 'JOB_CREATE', 'Job', '501')
  await step('JOB_UPDATE', 'JOB_UPDATE', 'Job', '501')
  await step('a visit notice', 'VISIT_UPDATE', 'Visit', '9001')
  return blank({ steps, tables: h.db.tables })
}
const noReads = (fp: any) => ({ ...fp, steps: fp.steps.map(({ reads, ...rest }: any) => rest) })
const sha = (x: any) => createHash('sha256').update(JSON.stringify(x)).digest('hex')

// sha256 of the fingerprint WITHOUT reads, and the reads per step, as recorded on b557f0b.
const RECORDED_SHA = '6227e91cf7c1ea0ad49c3b089ede9ce962443e6922cc9caecebb7bc476959b61'
const RECORDED_READS: string[][] = [
  ["leads", "jobs", "engagements", "locations", "locations", "jobs", "location_bees", "engagement_bees", "location_bees", "engagement_bees", "engagement_bees", "leads"],
  ["leads", "jobs", "engagements", "locations", "locations", "jobs", "location_bees", "engagement_bees", "location_bees", "leads"],
  ["leads", "jobs", "engagements", "locations", "locations", "jobs", "location_bees", "engagement_bees", "location_bees", "engagement_bees", "engagement_bees", "location_bees", "leads"],
  ["leads", "jobs", "engagements", "locations", "leads"],
  ["leads", "jobs", "engagements", "locations", "locations", "jobs", "location_bees", "engagement_bees", "location_bees", "leads"],
  ["leads", "jobs", "engagements", "locations", "locations", "jobs", "location_bees", "engagement_bees", "location_bees", "leads"],
  ["locations", "jobs", "engagements", "locations", "locations", "jobs", "location_bees", "engagement_bees", "location_bees"],
]

describe('with the switch off, a new job behaves exactly as it did before the switch existed', () => {
  it('answers, writes, Slack calls, Jobber calls and the database afterwards: identical to b557f0b', async () => {
    const fp = await run()
    if (process.env.FP_RECORD) { writeFileSync(process.env.FP_RECORD, JSON.stringify({ sha: sha(noReads(fp)), reads: fp.steps.map((s: any) => s.reads), fp }, null, 1)); return }
    expect(sha(noReads(fp))).toBe(RECORDED_SHA)
    // Nothing in any answer mentions a channel, and Slack was never asked to make one.
    expect(JSON.stringify(fp.steps.map((s: any) => s.result))).not.toMatch(/auto channel/)
    expect(fp.steps.flatMap((s: any) => s.slack).filter((c: any) => c.method === 'conversations.create')).toEqual([])
    expect(fp.steps).toHaveLength(7)
  })

  it('the ONLY difference is one extra read of the location per JOB_CREATE, at the same point each time — none on JOB_UPDATE or a visit notice', async () => {
    const fp = await run()
    if (process.env.FP_RECORD) return
    const now = fp.steps.map((s: any) => s.reads as string[])
    now.forEach((reads: string[], i: number) => {
      const before = RECORDED_READS[i]
      const isCreate = fp.steps[i].label.includes('JOB_CREATE') || i < 4
      if (!isCreate) { expect(reads, fp.steps[i].label).toEqual(before); return }
      expect(reads.length, fp.steps[i].label).toBe(before.length + 1)
      const at = reads.findIndex((t, k) => t !== before[k])
      expect(reads[at], fp.steps[i].label).toBe('locations')
      expect([...reads.slice(0, at), ...reads.slice(at + 1)], fp.steps[i].label).toEqual(before)
    })
  })
})
