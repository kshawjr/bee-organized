// Jobber's crew → the bees on a job → the job's Slack channel (2026-11-12).
// lib/jobber-crew-mirror.ts, the four VISIT_* webhook topics, and the crew
// half of the 15-minute sweep.
//
// What is real here and what is a stand-in:
//   · REAL: the mirror, the webhook handler (through TOPIC_HANDLERS, the same
//     table the route dispatches from), assignBee / unassignBee, the reconcile
//     that talks to Slack, the cron route.
//   · STAND-IN database: holds the code to the REAL schema
//     (lib/db-columns-check) — a select, filter or write naming a column the
//     real table does not have fails like Postgres, and a seeded row with a
//     made-up key fails the test in afterEach.
//   · STAND-IN Jobber: answers the two read queries from a small model of
//     jobs → visits → people. It records every document it is sent.
//   · STAND-IN Slack: a workspace with members per channel, behind fetch.
// Nothing here has run against a real Jobber change or a real Slack.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  const db: any = { tables: {} as Record<string, any[]>, seq: 0, seedFaults: [] as string[], writes: [] as string[], check: null as any, fail: null as null | ((table: string, op: string) => any) }
  const match = (r: any, f: any[]) => {
    const [m, col, val] = f
    if (m === 'eq') return r[col] === val
    if (m === 'is') return val === null ? r[col] == null : r[col] === val
    if (m === 'not') return r[col] != null
    if (m === 'gte') return String(r[col]) >= String(val)
    if (m === 'ilike') return String(r[col] ?? '').toLowerCase().includes(String(val).replace(/%/g, '').toLowerCase())
    return true
  }
  const UNIQUE: Record<string, (a: any, b: any) => boolean> = {
    location_bees: (a, b) => a.location_uuid === b.location_uuid && String(a.email).toLowerCase() === String(b.email).toLowerCase(),
    engagement_bees: (a, b) => a.engagement_id === b.engagement_id && a.bee_id === b.bee_id,
    job_visits: (a, b) => a.jobber_visit_id === b.jobber_visit_id,
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
  const jobber: any = { jobs: {} as Record<string, any>, people: {} as Record<string, { name: string; email: string | null }>, said: [] as { query: string; vars: any }[], writes: [] as any[], down: false, throws: false }
  const tail = (gid: string) => (Buffer.from(String(gid), 'base64').toString('utf8').match(/\/(\d+)$/) || [])[1] || String(gid)
  const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')
  const read = async (_slug: string, query: string, vars: any) => {
    jobber.said.push({ query, vars })
    if (jobber.throws) throw new Error('Jobber GraphQL HTTP 503: busy')
    if (jobber.down) return { errors: [{ message: 'no_valid_jobber_token' }] }
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

import * as check from '@/lib/db-columns-check'
import { supabaseService } from '@/lib/supabase-service'
import { TOPIC_HANDLERS, SUPPORTED_TOPICS } from '@/lib/jobber-webhook-handlers'
import {
  mirrorCrewFromJobber, mirrorCrewSafely, sweepJobCrews, handleVisitNotice, jobberRead, crewBucket,
  JOB_CREW_QUERY, VISIT_JOB_QUERY, CREW_RETRY_MARK, CREW_SWEEP_BUCKETS,
} from '@/lib/jobber-crew-mirror'
import { GET as cronGET } from '@/app/api/cron/job-channels/route'

const db = supabaseService as any
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'       // Slack connected and reconnected
const LOC_QUIET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' // no Slack at all
const LOC_OLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'   // Slack connected, not reconnected
const ENG = '00000000-0000-4000-8000-000000000001'
const ENG_QUIET = '00000000-0000-4000-8000-000000000002'
const ENG_OLD = '00000000-0000-4000-8000-000000000003'
const TOKEN = 'xoxb-test'
const NEW_SCOPES = 'chat:write,channels:read,channels:manage,users:read,users:read.email'
const OLD_SCOPES = 'chat:write,channels:read,users:read,users:read.email'
const ANA = h.gid('User', '1'), SAM = h.gid('User', '2'), ZOE = h.gid('User', '3'), NOR = h.gid('User', '4'), OWN = h.gid('User', '5')

// ── the fake Slack workspace ──
type Chan = { members: Set<string>; archived: boolean }
let slack: { users: Record<string, string>; channels: Map<string, Chan>; calls: { method: string; body: any }[]; down: boolean }
const slackFetch = async (url: string, init: any) => {
  const u = new URL(url)
  const method = u.pathname.replace('/api/', '')
  const body = init?.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams)
  slack.calls.push({ method, body })
  const ok = (x: any = {}) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...x }) }) as any
  const no = (error: string) => ({ ok: true, status: 200, json: async () => ({ ok: false, error }) }) as any
  if (slack.down) return no('ratelimited')
  if (method === 'users.lookupByEmail') { const id = slack.users[String(body.email).toLowerCase()]; return id ? ok({ user: { id } }) : no('users_not_found') }
  const ch = slack.channels.get(body.channel)
  if (!ch) return no('channel_not_found')
  if (method === 'conversations.invite') { if (ch.members.has(body.users)) return no('already_in_channel'); ch.members.add(body.users); return ok() }
  if (method === 'conversations.kick') { if (!ch.members.has(body.user)) return no('not_in_channel'); ch.members.delete(body.user); return ok() }
  return no('unknown_method')
}

const eng = (id: string, loc: string, over: any = {}) => ({
  id, location_uuid: loc, client_id: 'lead-1', project_type: 'Pantry', stage: 'Job in Progress', closed_at: null,
  slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null, slack_channel_problems: null, ...over,
})
const jobRow = (id: string, slug: string, jobberJobId: string, engagementId: string | null, over: any = {}) => ({
  id, location_id: slug, jobber_job_id: jobberJobId, engagement_id: engagementId, lead_id: 'lead-1', status: 'upcoming', ...over,
})

beforeEach(() => {
  h.db.check = check
  h.db.seq = 0; h.db.seedFaults = []; h.db.writes = []; h.db.fail = null
  h.db.tables = {
    locations: [
      { id: LOC, location_id: 'loc_test', jobber_connected: true, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: NEW_SCOPES },
      { id: LOC_QUIET, location_id: 'loc_quiet', jobber_connected: true, slack_connected: false, slack_bot_token: null, slack_scopes: null },
      { id: LOC_OLD, location_id: 'loc_old', jobber_connected: true, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: OLD_SCOPES },
    ],
    engagements: [
      eng(ENG, LOC, { slack_channel_id: 'C1', slack_channel_name: 'sarah-pantry' }),
      eng(ENG_QUIET, LOC_QUIET),
      eng(ENG_OLD, LOC_OLD, { slack_channel_id: 'C9', slack_channel_name: 'old-one' }),
    ],
    jobs: [
      jobRow('10000000-0000-4000-8000-000000000001', 'loc_test', '501', ENG),
      jobRow('10000000-0000-4000-8000-000000000002', 'loc_quiet', '601', ENG_QUIET),
      jobRow('10000000-0000-4000-8000-000000000003', 'loc_old', '701', ENG_OLD),
    ],
    location_bees: [], engagement_bees: [], job_visits: [], sync_log: [],
    hub_users: [{ id: 'u-owner', role: 'owner', location_id: LOC, email: 'owner@bee.test', full_name: 'Olive Owner' }],
  }
  h.jobber.said = []; h.jobber.writes = []; h.jobber.down = false; h.jobber.throws = false
  h.jobber.people = {
    [ANA]: { name: 'Ana Bee', email: 'ana@bee.test' }, [SAM]: { name: 'Sam Carpenter', email: 'sam@bee.test' },
    [ZOE]: { name: 'Zoe New', email: 'zoe@bee.test' }, [NOR]: { name: 'Nora Nobody', email: 'nora@elsewhere.test' },
    [OWN]: { name: 'Olive Owner', email: 'owner@bee.test' },
  }
  h.jobber.jobs = {
    '501': { visits: [{ id: '9001', crew: [ANA, SAM] }] },
    '601': { visits: [{ id: '9101', crew: [ANA] }] },
    '701': { visits: [{ id: '9201', crew: [ANA] }] },
  }
  slack = {
    users: { 'ana@bee.test': 'U_ANA', 'sam@bee.test': 'U_SAM', 'zoe@bee.test': 'U_ZOE', 'owner@bee.test': 'U_OWNER' },
    channels: new Map([['C1', { members: new Set(['UBOT', 'U_OWNER', 'U_HAND']), archived: false }], ['C9', { members: new Set(['UBOT']), archived: false }]]),
    calls: [], down: false,
  }
  vi.stubGlobal('fetch', vi.fn(slackFetch))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  expect(h.db.seedFaults, 'a seeded row names a column the real table does not have').toEqual([])
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const notice = (topic: string, visit: string, slug = 'loc_test', locId = LOC) =>
  TOPIC_HANDLERS[topic]({ topic, itemId: h.gid('Visit', visit), occurredAt: new Date().toISOString(), location: { id: locId, location_id: slug, name: 'Test' } as any })
const beeByEmail = (email: string) => h.db.tables.location_bees.find((b: any) => b.email === email)
const onJob = (engagementId = ENG) => h.db.tables.engagement_bees
  .filter((r: any) => r.engagement_id === engagementId && !r.removed_at)
  .map((r: any) => h.db.tables.location_bees.find((b: any) => b.id === r.bee_id).name).sort()
const inChannel = (id = 'C1') => Array.from(slack.channels.get(id)!.members).sort()
const snapshot = () => JSON.stringify(h.db.tables)

describe('a crew change in Jobber reaches the job and its Slack channel with nobody touching Bee Hub', () => {
  it('the four visit topics are handled, not discarded', () => {
    for (const t of ['VISIT_CREATE', 'VISIT_UPDATE', 'VISIT_COMPLETE', 'VISIT_DESTROY']) {
      expect(SUPPORTED_TOPICS, t).toContain(t)
      expect(TOPIC_HANDLERS[t], t).toBe(TOPIC_HANDLERS.VISIT_UPDATE)
    }
  })

  it('a visit notice puts everyone on the unfinished visit onto the job as bees, and into the channel', async () => {
    const r = await notice('VISIT_UPDATE', '9001')
    expect(r.processed).toBe(true)
    expect(r.error).toBeUndefined()
    expect(onJob()).toEqual(['Ana Bee', 'Sam Carpenter'])
    // Added as bees the first time they are seen: Jobber id, name and email from Jobber.
    expect(beeByEmail('ana@bee.test')).toMatchObject({ location_uuid: LOC, name: 'Ana Bee', jobber_user_id: ANA, is_active: true, slack_user_id: 'U_ANA' })
    expect(beeByEmail('sam@bee.test')).toMatchObject({ jobber_user_id: SAM, slack_user_id: 'U_SAM' })
    expect(inChannel()).toEqual(['UBOT', 'U_ANA', 'U_HAND', 'U_OWNER', 'U_SAM'])
    expect(r.note).toContain('crew 2 on job, +2 -0')
    expect(r.note).toContain(`engagement=${ENG}`)
    // Counts and ids only in the log line: no names, no emails.
    expect(r.note).not.toMatch(/Ana|Sam|@/)
  })

  it('then Jobber swaps one person for another: the bees and the channel follow, and the owner, the app and a hand-added member stay', async () => {
    await notice('VISIT_UPDATE', '9001')
    h.jobber.jobs['501'].visits[0].crew = [ANA, ZOE]   // Sam off, Zoe on — done in Jobber
    const r = await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Zoe New'])
    expect(inChannel()).toEqual(['UBOT', 'U_ANA', 'U_HAND', 'U_OWNER', 'U_ZOE'])
    expect(r.note).toContain('+1 -1')
    // Sam's row is stamped, never deleted.
    const sam = beeByEmail('sam@bee.test')
    expect(h.db.tables.engagement_bees.find((x: any) => x.bee_id === sam.id).removed_at).toBeTruthy()
  })

  it('the same notice twice changes nothing the second time and makes no Slack call', async () => {
    await notice('VISIT_UPDATE', '9001')
    const before = snapshot(); slack.calls = []; h.db.writes = []
    const r = await notice('VISIT_UPDATE', '9001')
    expect(r.note).toContain('+0 -0')
    expect(r.note).toContain('slack unchanged')
    expect(slack.calls).toEqual([])
    expect(h.db.writes.filter((w: string) => !/job_visits/.test(w))).toEqual([])
    expect(JSON.parse(snapshot()).engagement_bees).toEqual(JSON.parse(before).engagement_bees)
  })
})

describe('who counts as on the job: everyone on any visit that is not finished', () => {
  it('someone taken off every unfinished visit leaves the job and the channel', async () => {
    h.jobber.jobs['501'].visits = [{ id: '9001', crew: [ANA, SAM] }, { id: '9002', crew: [SAM] }]
    await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Sam Carpenter'])
    // Off ONE of two unfinished visits: still on the job.
    h.jobber.jobs['501'].visits[0].crew = [ANA]
    await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Sam Carpenter'])
    expect(inChannel()).toContain('U_SAM')
    // Off the other one too: gone.
    h.jobber.jobs['501'].visits[1].crew = []
    await notice('VISIT_UPDATE', '9002')
    expect(onJob()).toEqual(['Ana Bee'])
    expect(inChannel()).not.toContain('U_SAM')
  })

  it('someone on a FINISHED visit only is not on the job', async () => {
    h.jobber.jobs['501'].visits = [{ id: '9001', done: true, crew: [SAM, ZOE] }, { id: '9002', crew: [ANA] }]
    await notice('VISIT_CREATE', '9002')
    expect(onJob()).toEqual(['Ana Bee'])
    expect(beeByEmail('sam@bee.test')).toBeUndefined()
    expect(inChannel()).toEqual(['UBOT', 'U_ANA', 'U_HAND', 'U_OWNER'])
  })

  it('when a visit is finished, the people who were only on it come off', async () => {
    h.jobber.jobs['501'].visits = [{ id: '9001', crew: [SAM] }, { id: '9002', crew: [ANA] }]
    await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Sam Carpenter'])
    h.jobber.jobs['501'].visits[0].done = true
    await notice('VISIT_COMPLETE', '9001')
    expect(onJob()).toEqual(['Ana Bee'])
    expect(inChannel()).not.toContain('U_SAM')
  })

  it('every live job of the engagement counts; a job deleted in Jobber does not', async () => {
    h.db.tables.jobs.push(jobRow('10000000-0000-4000-8000-000000000011', 'loc_test', '502', ENG), jobRow('10000000-0000-4000-8000-000000000012', 'loc_test', '503', ENG, { status: 'deleted' }))
    h.jobber.jobs['502'] = { visits: [{ id: '9050', crew: [ZOE] }] }
    h.jobber.jobs['503'] = { visits: [{ id: '9060', crew: [NOR] }] }
    await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Sam Carpenter', 'Zoe New'])
    expect(h.jobber.said.some((s: any) => s.vars.jobId === h.gid('Job', '503'))).toBe(false)
  })

  it('a job with more visits than one page reads every page before deciding', async () => {
    h.jobber.jobs['501'] = { pageSize: 2, visits: [{ id: '1', done: true, crew: [SAM] }, { id: '2', done: true, crew: [SAM] }, { id: '3', done: true, crew: [] }, { id: '4', crew: [ZOE] }, { id: '5', crew: [ANA] }] }
    const r = await mirrorCrewFromJobber(db, ENG)
    expect(r).toMatchObject({ ok: true, onJob: 2 })
    expect(onJob()).toEqual(['Ana Bee', 'Zoe New'])
    expect(h.jobber.said.filter((s: any) => s.query.includes('JobCrewForMirror')).map((s: any) => s.vars.after)).toEqual([null, '2', '4'])
  })
})

describe('a visit notice for a job Bee Hub does not have', () => {
  it('changes nothing, creates nothing, and says so', async () => {
    h.jobber.jobs['888'] = { visits: [{ id: '9900', crew: [ANA, SAM] }] }   // real in Jobber, unknown here
    const before = snapshot()
    const r = await notice('VISIT_CREATE', '9900')
    expect(snapshot()).toBe(before)
    expect(h.db.writes).toEqual([])
    expect(slack.calls).toEqual([])
    expect(r).toMatchObject({ processed: true })
    expect(r.error).toBeUndefined()
    expect(r.note).toBe('visit of job 888 — that job is not in Bee Hub (yet); nothing changed')
  })

  it('a job row with no engagement yet is treated the same way', async () => {
    h.db.tables.jobs.push(jobRow('10000000-0000-4000-8000-000000000020', 'loc_test', '889', null))
    h.jobber.jobs['889'] = { visits: [{ id: '9901', crew: [ANA] }] }
    const r = await notice('VISIT_UPDATE', '9901')
    expect(h.db.tables.engagement_bees).toEqual([])
    expect(h.db.tables.location_bees).toEqual([])
    expect(r.note).toContain('not in Bee Hub (yet)')
  })

  it('the same job id at ANOTHER location is not this location’s job', async () => {
    h.jobber.jobs['601'].visits.push({ id: '9102', crew: [SAM] })
    // Notice arrives for loc_test, but job 601 belongs to loc_quiet.
    const r = await notice('VISIT_UPDATE', '9102', 'loc_test', LOC)
    expect(r.note).toContain('not in Bee Hub (yet)')
    expect(h.db.tables.engagement_bees).toEqual([])
  })

  it('the visit arrives BEFORE its job: nothing happens; when the job lands, the same call JOB_CREATE makes brings the crew in', async () => {
    const NEW_ENG = '00000000-0000-4000-8000-000000000050'
    h.jobber.jobs['900'] = { visits: [{ id: '9990', crew: [ANA, ZOE] }] }
    const first = await notice('VISIT_CREATE', '9990')
    expect(first.note).toContain('not in Bee Hub (yet)')
    expect(h.db.tables.engagement_bees).toEqual([])
    // JOB_CREATE lands a second later: the job row and its engagement exist.
    h.db.tables.engagements.push(eng(NEW_ENG, LOC))
    h.db.tables.jobs.push(jobRow('10000000-0000-4000-8000-000000000050', 'loc_test', '900', NEW_ENG))
    const r = await mirrorCrewSafely(db, NEW_ENG)
    expect(r).toMatchObject({ ok: true, added: 2 })
    expect(onJob(NEW_ENG)).toEqual(['Ana Bee', 'Zoe New'])
  })

  it('the job handler really makes that call, after the job is attached to its engagement', () => {
    const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    const core = src.slice(src.indexOf('async function handleJobCore'), src.indexOf('export function handleJobCreate'))
    const attach = core.indexOf("await attachToEngagement('jobs', jRes.id, engId)")
    const mirror = core.indexOf('await mirrorCrewSafely(supabaseService, engId)')
    expect(attach).toBeGreaterThan(-1)
    expect(mirror).toBeGreaterThan(attach)
  })
})

describe('a location with no Slack', () => {
  it('records who is on the job and makes no Slack call at all', async () => {
    const r = await notice('VISIT_UPDATE', '9101', 'loc_quiet', LOC_QUIET)
    expect(r.processed).toBe(true)
    expect(onJob(ENG_QUIET)).toEqual(['Ana Bee'])
    expect(beeByEmail('ana@bee.test')).toMatchObject({ location_uuid: LOC_QUIET, jobber_user_id: ANA, slack_user_id: null, slack_checked_at: null })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(r.note).toContain('slack no_slack')
  })

  it('connected but not reconnected: bees recorded, the channel is not touched', async () => {
    const r = await notice('VISIT_UPDATE', '9201', 'loc_old', LOC_OLD)
    expect(onJob(ENG_OLD)).toEqual(['Ana Bee'])
    expect(r.note).toContain('slack not_reconnected')
    expect(slack.calls.filter(c => c.method.startsWith('conversations.'))).toEqual([])
    expect(inChannel('C9')).toEqual(['UBOT'])
  })

  it('a job with no channel yet: bees recorded, nobody invited anywhere', async () => {
    h.db.tables.engagements[0].slack_channel_id = null
    const r = await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Sam Carpenter'])
    expect(r.note).toContain('slack no_channel')
    expect(slack.calls.filter(c => c.method.startsWith('conversations.'))).toEqual([])
  })
})

describe('nothing in this path writes to Jobber', () => {
  it('every document sent to Jobber across notices and a sweep is a query; the write function is never called', async () => {
    await notice('VISIT_CREATE', '9001')
    h.jobber.jobs['501'].visits[0].crew = [ZOE]
    await notice('VISIT_UPDATE', '9001')
    await notice('VISIT_COMPLETE', '9001')
    await notice('VISIT_DESTROY', '9001')
    await sweepJobCrews(db, { now: 0, max: 500 })
    expect(h.jobber.said.length).toBeGreaterThan(5)
    for (const s of h.jobber.said) expect(s.query.trim()).toMatch(/^query\b/)
    expect(h.jobber.writes).toEqual([])
  })

  it('the door to Jobber refuses a mutation before sending it', async () => {
    const sent = vi.fn()
    await expect(jobberRead(sent as any, 'loc_test', 'mutation X { visitEditAssignedUsers { visit { id } } }')).rejects.toThrow(/read-only/)
    expect(sent).not.toHaveBeenCalled()
  })

  it('the module has no mutation and does not import the function that sends one', () => {
    const src = readFileSync('lib/jobber-crew-mirror.ts', 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/\bmutation\b/)
    expect(code).not.toMatch(/jobberMutation|visitEditAssignedUsers|EditInput/)
    expect(JOB_CREW_QUERY.trim()).toMatch(/^query\b/)
    expect(VISIT_JOB_QUERY.trim()).toMatch(/^query\b/)
    // The job-level default team is not what is read.
    expect(JOB_CREW_QUERY).not.toContain('visitSchedule')
  })

  it('the page sizes keep a read inside Jobber’s allowance (it prices a query by what it could return)', () => {
    const visits = Number(JOB_CREW_QUERY.match(/visits\(first: (\d+)/)![1])
    const crew = Number(JOB_CREW_QUERY.match(/assignedUsers\(first: (\d+)/)![1])
    // Measured live: 50 x 25 was priced at 6,557 of a 10,000 allowance, and
    // 25 x 15 at 2,032. Three reads run at once, so the product must stay here.
    expect(visits * crew).toBeLessThanOrEqual(400)
    expect(readFileSync('lib/jobber-crew-mirror.ts', 'utf8')).toMatch(/const JOB_READS_AT_ONCE = [123]\b/)
  })
})

describe('a failed read never looks like an empty crew', () => {
  const seedCrew = async () => { await notice('VISIT_UPDATE', '9001'); slack.calls = []; h.db.writes = [] }

  it('Jobber does not answer: nobody is taken off the job or out of the channel, and the notice is an error with a retry mark', async () => {
    await seedCrew()
    const before = snapshot()
    h.jobber.jobs['501'] = 'fail'
    const r = await mirrorCrewFromJobber(db, ENG)
    expect(r).toEqual({ ok: false, engagementId: ENG, reason: 'jobber_unread' })
    expect(snapshot()).toBe(before)
    expect(slack.calls).toEqual([])
    expect(inChannel()).toEqual(['UBOT', 'U_ANA', 'U_HAND', 'U_OWNER', 'U_SAM'])
  })

  it('ONE unreadable job among several stops the whole engagement — a partial crew would take real people off', async () => {
    await seedCrew()
    h.db.tables.jobs.push(jobRow('10000000-0000-4000-8000-000000000011', 'loc_test', '502', ENG))
    h.jobber.jobs['502'] = 'fail'
    h.jobber.jobs['501'].visits[0].crew = []
    const before = snapshot()
    expect(await mirrorCrewFromJobber(db, ENG)).toMatchObject({ ok: false, reason: 'jobber_unread' })
    expect(snapshot()).toBe(before)
  })

  it('the token blip: the visit read works, the crew read throws a 503 — the row is an error carrying the engagement for the sweep', async () => {
    await seedCrew()
    const realRead = h.read
    let n = 0
    const flaky = vi.fn(async (slug: string, query: string, vars: any) => {
      if (query.includes('JobCrewForMirror') && n++ === 0) throw new Error('Jobber GraphQL HTTP 503: busy')
      return realRead(slug, query, vars)
    })
    const out = await handleVisitNotice(db, { locationSlug: 'loc_test', visitId: h.gid('Visit', '9001'), read: flaky as any })
    expect(out).toEqual({ status: 'mirrored', result: { ok: false, engagementId: ENG, reason: 'jobber_unread' } })
    // Through the handler, the same failure is an error row with the mark.
    h.jobber.throws = false; h.jobber.jobs['501'] = 'fail'
    const r = await notice('VISIT_UPDATE', '9001')
    expect(r.processed).toBe(false)
    expect(r.error).toBe('crew_read_failed')
    expect(r.note).toContain(`${CREW_RETRY_MARK}${ENG}`)
  })

  it('the visit itself cannot be read: an error row, nothing changed', async () => {
    await seedCrew()
    const before = snapshot()
    h.jobber.throws = true
    const r = await notice('VISIT_UPDATE', '9001')
    expect(r).toMatchObject({ processed: false, error: 'crew_read_failed' })
    expect(snapshot()).toBe(before)
  })

  it('a visit with more people than one page holds is not half-read', async () => {
    await seedCrew()
    const before = snapshot()
    h.jobber.jobs['501'].visits[0] = { id: '9001', crew: [ANA], crewOverflow: true }
    expect(await mirrorCrewFromJobber(db, ENG)).toMatchObject({ ok: false, reason: 'too_many_visits' })
    expect(snapshot()).toBe(before)
  })

  it('Jobber ANSWERS that a job no longer exists: that job has nobody on it, and the rest of the engagement still syncs', async () => {
    await seedCrew()
    h.db.tables.jobs.push(jobRow('10000000-0000-4000-8000-000000000011', 'loc_test', '502', ENG))   // never in fake Jobber → { job: null }
    h.jobber.jobs['501'].visits[0].crew = [ANA]
    const r = await mirrorCrewFromJobber(db, ENG)
    expect(r).toMatchObject({ ok: true, onJob: 1, removed: 1 })
    expect(onJob()).toEqual(['Ana Bee'])
  })

  it('a closed job is left alone', async () => {
    h.db.tables.engagements[0].closed_at = '2026-11-10T00:00:00Z'
    expect(await mirrorCrewFromJobber(db, ENG)).toEqual({ ok: false, engagementId: ENG, reason: 'closed' })
    expect(h.jobber.said).toEqual([])
  })
})

describe('people → bees', () => {
  it('a bee typed by hand with the same email IS that person: linked, not duplicated, and what the owner typed is kept', async () => {
    h.db.tables.location_bees.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', location_uuid: LOC, name: 'Ana (nights)', email: 'Ana@Bee.test', jobber_user_id: null, slack_user_id: 'U_ANA', slack_checked_at: '2026-11-01T00:00:00Z', is_active: true, removed_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' })
    await notice('VISIT_UPDATE', '9001')
    const anas = h.db.tables.location_bees.filter((b: any) => b.email.toLowerCase() === 'ana@bee.test')
    expect(anas).toHaveLength(1)
    expect(anas[0]).toMatchObject({ name: 'Ana (nights)', email: 'Ana@Bee.test', jobber_user_id: ANA })
    expect(onJob()).toEqual(['Ana (nights)', 'Sam Carpenter'])
  })

  it('a bee typed by hand for someone NOT in Jobber is never taken off the job by Jobber', async () => {
    const HAND = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000007'
    h.db.tables.location_bees.push({ id: HAND, location_uuid: LOC, name: 'Hattie Hand', email: 'hattie@home.test', jobber_user_id: null, slack_user_id: 'U_HAND', slack_checked_at: '2026-11-01T00:00:00Z', is_active: true, removed_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' })
    h.db.tables.engagement_bees.push({ id: 'eb-1', engagement_id: ENG, bee_id: HAND, assigned_at: '2026-11-01T00:00:00Z', removed_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' })
    await notice('VISIT_UPDATE', '9001')
    h.jobber.jobs['501'].visits[0].crew = []
    await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Hattie Hand'])
    expect(inChannel()).toContain('U_HAND')
  })

  it('once added, an owner’s correction to the email is not overwritten from Jobber', async () => {
    await notice('VISIT_UPDATE', '9001')
    const sam = beeByEmail('sam@bee.test')
    sam.email = 'sam.personal@gmail.test'; sam.name = 'Sam C.'
    h.jobber.jobs['501'].visits[0].crew = [SAM, ZOE]
    await notice('VISIT_UPDATE', '9001')
    expect(h.db.tables.location_bees.filter((b: any) => b.jobber_user_id === SAM)).toHaveLength(1)
    expect(h.db.tables.location_bees.find((b: any) => b.jobber_user_id === SAM)).toMatchObject({ email: 'sam.personal@gmail.test', name: 'Sam C.' })
  })

  it('a removed bee who turns up on a visit comes back, as the same row', async () => {
    await notice('VISIT_UPDATE', '9001')
    const sam = beeByEmail('sam@bee.test')
    sam.is_active = false; sam.removed_at = '2026-11-11T00:00:00Z'
    h.jobber.jobs['501'].visits.push({ id: '9002', crew: [SAM] })
    await notice('VISIT_CREATE', '9002')
    expect(h.db.tables.location_bees.filter((b: any) => b.jobber_user_id === SAM)).toHaveLength(1)
    expect(sam).toMatchObject({ is_active: true, removed_at: null })
  })

  it('a person Slack does not know is on the job, and is REPORTED on the job, not dropped', async () => {
    h.jobber.jobs['501'].visits[0].crew = [ANA, NOR]
    const r = await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Nora Nobody'])
    expect(beeByEmail('nora@elsewhere.test')).toMatchObject({ slack_user_id: null })
    expect(beeByEmail('nora@elsewhere.test').slack_checked_at).toBeTruthy()
    const stored = h.db.tables.engagements[0].slack_channel_problems
    expect(stored.items).toEqual([{ status: 'not_in_slack', bee: 'Nora Nobody', email: 'nora@elsewhere.test', bee_id: beeByEmail('nora@elsewhere.test').id }])
    expect(r.note).toContain('slack problems (1)')
  })

  it('the owner, when on a visit and then taken off it, is never removed from the channel', async () => {
    h.jobber.jobs['501'].visits[0].crew = [ANA, OWN]
    await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee', 'Olive Owner'])
    h.jobber.jobs['501'].visits[0].crew = [ANA]
    await notice('VISIT_UPDATE', '9001')
    expect(onJob()).toEqual(['Ana Bee'])
    expect(inChannel()).toContain('U_OWNER')
    expect(slack.calls.filter(c => c.method === 'conversations.kick' && c.body.user === 'U_OWNER')).toEqual([])
  })

  it('a Jobber user with no email cannot be a bee: counted, not invented', async () => {
    h.jobber.people[ZOE].email = null
    h.jobber.jobs['501'].visits[0].crew = [ANA, ZOE]
    const r = await mirrorCrewFromJobber(db, ENG)
    expect(r).toMatchObject({ ok: true, unresolved: 1, added: 1 })
    expect(onJob()).toEqual(['Ana Bee'])
  })
})

describe('a deleted visit', () => {
  it('cannot be read back from Jobber, so the note left by an earlier notice finds its job', async () => {
    h.jobber.jobs['501'].visits = [{ id: '9001', crew: [ANA] }, { id: '9002', crew: [SAM] }]
    await notice('VISIT_CREATE', '9002')
    expect(h.db.tables.job_visits.map((v: any) => v.jobber_visit_id)).toEqual(['9002'])
    expect(onJob()).toEqual(['Ana Bee', 'Sam Carpenter'])
    h.jobber.jobs['501'].visits.pop()                    // deleted in Jobber
    const r = await notice('VISIT_DESTROY', '9002')
    expect(r.processed).toBe(true)
    expect(onJob()).toEqual(['Ana Bee'])
    expect(inChannel()).not.toContain('U_SAM')
  })

  it('never seen before: nothing changes and the row says the sweep covers it', async () => {
    const before = snapshot()
    const r = await notice('VISIT_DESTROY', '4242')
    expect(snapshot()).toBe(before)
    expect(r).toEqual({ processed: true, note: 'visit deleted in Jobber before Bee Hub saw it; the 15-minute crew sweep covers its job' })
  })
})

describe('the 15-minute sweep is the backstop', () => {
  const slotFor = (id: string) => crewBucket(id)                 // a run whose slot reaches this engagement
  const at = (slot: number) => slot * 15 * 60 * 1000

  it('a crew change that sent NO notice is still mirrored: a job with a channel is checked on every run', async () => {
    await notice('VISIT_UPDATE', '9001')
    h.jobber.jobs['501'].visits[0].crew = [ANA, ZOE]            // changed in Jobber; no notice arrives
    for (const slot of [0, 1, 2]) {
      h.jobber.said = []
      await sweepJobCrews(db, { now: at(slot) })
      expect(h.jobber.said.some((s: any) => s.vars.jobId === h.gid('Job', '501')), `slot ${slot}`).toBe(true)
    }
    expect(onJob()).toEqual(['Ana Bee', 'Zoe New'])
    expect(inChannel()).toEqual(['UBOT', 'U_ANA', 'U_HAND', 'U_OWNER', 'U_ZOE'])
  })

  it('a job with NO channel is checked one run in twelve, not every run', async () => {
    const seen: number[] = []
    for (let slot = 0; slot < CREW_SWEEP_BUCKETS; slot++) {
      h.jobber.said = []
      await sweepJobCrews(db, { now: at(slot) })
      if (h.jobber.said.some((s: any) => s.vars.jobId === h.gid('Job', '601'))) seen.push(slot)
    }
    expect(seen).toEqual([slotFor(ENG_QUIET)])
    expect(onJob(ENG_QUIET)).toEqual(['Ana Bee'])
  })

  it('an engagement a notice could not finish is picked up from its retry mark on the next run, whatever its turn', async () => {
    const wrongSlot = (slotFor(ENG_QUIET) + 1) % CREW_SWEEP_BUCKETS
    const now = at(wrongSlot + CREW_SWEEP_BUCKETS * 1000)
    h.db.tables.sync_log.push({ id: 's1', direction: 'inbound', created_at: new Date(now - 5 * 60 * 1000).toISOString(), message: `topic=VISIT_UPDATE item=x error=crew_read_failed — crew not changed (jobber_unread) engagement=${ENG_QUIET} — ${CREW_RETRY_MARK}${ENG_QUIET}` })
    const r = await sweepJobCrews(db, { now })
    expect(onJob(ENG_QUIET)).toEqual(['Ana Bee'])
    expect(r.changed).toBeGreaterThanOrEqual(1)
    // An old mark is not chased forever.
    h.db.tables.engagement_bees = []; h.db.tables.sync_log[0].created_at = new Date(now - 3 * 60 * 60 * 1000).toISOString()
    await sweepJobCrews(db, { now })
    expect(onJob(ENG_QUIET)).toEqual([])
  })

  it('a stored Slack problem is tried again by the sweep even when the crew has not changed', async () => {
    slack.down = true
    await notice('VISIT_UPDATE', '9001')
    expect(inChannel()).toEqual(['UBOT', 'U_HAND', 'U_OWNER'])
    expect(h.db.tables.engagements[0].slack_channel_problems.items.length).toBeGreaterThan(0)
    slack.down = false
    const mine = () => JSON.stringify(h.db.tables.engagement_bees.filter((x: any) => x.engagement_id === ENG))
    const before = mine()
    await sweepJobCrews(db, { now: 0 })
    expect(mine()).toBe(before)                                  // the crew did not change
    expect(inChannel()).toEqual(['UBOT', 'U_ANA', 'U_HAND', 'U_OWNER', 'U_SAM'])
    expect(h.db.tables.engagements[0].slack_channel_problems).toBeNull()
  })

  it('a location whose Jobber does not answer is skipped for the rest of the run, counted, and nothing of theirs changes', async () => {
    const E2 = '00000000-0000-4000-8000-000000000060'
    h.db.tables.engagements.push(eng(E2, LOC, { slack_channel_id: 'C1b' }))
    h.db.tables.jobs.push(jobRow('10000000-0000-4000-8000-000000000060', 'loc_test', '560', E2))
    h.jobber.jobs['501'] = 'fail'; h.jobber.jobs['560'] = { visits: [{ id: '1', crew: [ANA] }] }
    const r = await sweepJobCrews(db, { now: 0 })
    expect(r.unread).toBe(2)
    expect(h.jobber.said.some((s: any) => s.vars.jobId === h.gid('Job', '560'))).toBe(false)
    expect(h.db.tables.engagement_bees.filter((x: any) => x.engagement_id === E2)).toEqual([])
    // The other location still ran.
    expect(h.jobber.said.some((s: any) => s.vars.jobId === h.gid('Job', '701'))).toBe(true)
  })

  it('the run stops at its limit and says how many were left', async () => {
    for (let i = 0; i < 6; i++) {
      const id = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
      h.db.tables.engagements.push(eng(id, LOC, { slack_channel_id: `CX${i}` }))
      h.db.tables.jobs.push(jobRow(`10000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, 'loc_test', `8${i}`, id))
    }
    const r = await sweepJobCrews(db, { now: 0, max: 3 })
    expect(r.checked).toBe(3)
    expect(r.deferred).toBeGreaterThanOrEqual(5)
  })

  it('the cron route runs it after the archive sweep and logs its own line, every run', async () => {
    process.env.CRON_SECRET = 'shh'
    const logs: string[] = []
    ;(console.log as any).mockImplementation((...a: any[]) => { logs.push(a.join(' ')) })
    const res = await cronGET(new NextRequest('http://x/api/cron/job-channels', { headers: { authorization: 'Bearer shh' } }))
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.crews).toMatchObject({ ok: true })
    expect(logs.some(l => l.startsWith('[cron job-channels] archived'))).toBe(true)
    expect(logs.some(l => l.startsWith('[cron job-channels] crews checked'))).toBe(true)
  })
})
