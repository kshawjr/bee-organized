// A CHANNEL IS FOR A JOB, NOT A REQUEST (2026-11-12).
//
// Kevin pressed the Slack mark on two records at Request with no job and got
// two channels. Nothing built since assumes anything but a job: the crew comes
// from a job's visits, so a request's channel never fills, and the job card is
// spent before there is a job.
//
// REAL: the Slack mark's route (POST), the panel's data route (GET),
// createJobChannel, engagementHasJob, the JOB_CREATE handler and auto-create.
// STAND-INS: sign-in, the database (held to the schema snapshot), Jobber,
// Slack. "Has a job" is the same test the crew mirror uses: a row in `jobs` on
// this deal, with a Jobber job id, that is not deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

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

const who = vi.hoisted(() => ({ user: { id: 'u-owner', role: 'owner', location_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as any }))
vi.mock('@/lib/auth', () => ({ requireAuth: async () => ({ id: who.user?.id }), getHubUser: async () => who.user, isAdmin: (r: string) => r === 'admin' || r === 'super_admin' }))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: async () => null }))

import * as check from '@/lib/db-columns-check'
import { supabaseService } from '@/lib/supabase-service'
import { TOPIC_HANDLERS } from '@/lib/jobber-webhook-handlers'
import { createJobChannel, loadEngagementForBees, readLocationSlackFull, sweepJobChannels } from '@/lib/engagement-bees'
import { engagementHasJob } from '@/lib/engagement-has-job'
import { autoCreateJobChannel } from '@/lib/job-channel-auto'
import { POST as channelPOST } from '@/app/api/engagements/[id]/slack-channel/route'
import { GET as beesGET } from '@/app/api/engagements/[id]/bees/route'
import { NO_JOB_LINE } from '@/components/hive/BeesOnJob'
const db = supabaseService as any

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
  if (method === 'chat.postMessage') return ok({ ts: `1700000000.${String(slack.calls.length).padStart(6, '0')}` })
  if (method === 'pins.add') return ok()
  if (method === 'conversations.archive') { ch.archived = true; return ok() }
  if (method === 'conversations.unarchive') { ch.archived = false; return ok() }
  return no('unknown_method')
}
const made = () => slack.calls.filter(c => c.method === 'conversations.create')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TOKEN = 'xoxb-test'
const NEW_SCOPES = 'chat:write,chat:write.public,channels:read,channels:manage,incoming-webhook,users:read,users:read.email'
const ANA = h.gid('User', '1'), SAM = h.gid('User', '2'), NOR = h.gid('User', '4')
const SWITCHED_ON = '2026-11-10T12:00:00.000Z', AFTER = '2026-11-10T12:00:01.000Z'
const engId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const eng = (n: number, over: any = {}) => ({
  id: engId(n), location_uuid: LOC, client_id: 'lead-7001', project_type: 'Moving/Relocation', stage: 'Job in Progress', closed_at: null, description: null,
  slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null, slack_channel_problems: null, slack_channel_auto_at: null, ...over,
})
const engRow = (n: number) => h.db.tables.engagements.find((e: any) => e.id === engId(n))
const jobInJobber = (jobberId: string, deal: number, over: any = {}) => {
  h.jobber.records[jobberId] = { createdAt: AFTER, jobberWebUri: null, title: 'Move', jobStatus: 'UPCOMING', startAt: null, completedAt: null, total: '100', client: { id: h.gid('Client', '7001') }, request: null, quote: null, ...over }
  ;(h as any).dealFor[jobberId] = engId(deal)
  if (!h.jobber.jobs[jobberId]) h.jobber.jobs[jobberId] = { visits: [] }
}
const fire = (topic: string, type: string, id: string) =>
  TOPIC_HANDLERS[topic]({ topic, itemId: h.gid(type, id), occurredAt: new Date().toISOString(), location: { id: LOC, location_id: 'loc_test', name: 'Test', timezone: null, jobber_account_id: null, jobber_access_token: null } as any })
const bee = (n: number, name: string, email: string, jobberId: string, slackId: string | null) =>
  ({ id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`, location_uuid: LOC, name, email, jobber_user_id: jobberId, slack_user_id: slackId, slack_checked_at: '2026-11-01T00:00:00Z', is_active: true, removed_at: null })
const onJob = (deal: number, beeN: number) => ({ id: `cccccccc-cccc-4ccc-8ccc-${String(deal * 100 + beeN).padStart(12, '0')}`, engagement_id: engId(deal), bee_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(beeN).padStart(12, '0')}`, assigned_at: `2026-11-01T00:00:0${beeN}Z`, removed_at: null })

function seed() {
  h.db.check = check
  h.db.seq = 0; h.db.seedFaults = []; h.db.writes = []; h.db.reads = []; h.db.fail = null
  ;(h as any).dealFor = {}
  h.db.tables = {
    locations: [{ id: LOC, location_id: 'loc_test', name: 'Test Location', timezone: 'Eastern Time (ET)', jobber_connected: true, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: NEW_SCOPES, slack_auto_channels_at: SWITCHED_ON, slack_auto_channels_capped_at: null }],
    leads: [{ id: 'lead-7001', location_id: 'loc_test', jobber_client_id: '7001', name: 'Test FailSafe', stage: 'Job in Progress', address: '6711 Calvert Commons Drive', street2: null, city: 'Huntersville', state: 'NC', zip: '28078', phone: '3037511112', email: 'test@bmave.com' }],
    engagements: [], jobs: [], quotes: [], service_requests: [], assessments: [],
    location_bees: [bee(1, 'Ana Bee', 'ana@bee.test', ANA, 'U_ANA'), bee(2, 'Sam Carpenter', 'sam@bee.test', SAM, 'U_SAM'), bee(4, 'Nora Nobody', 'nora@elsewhere.test', NOR, null)],
    engagement_bees: [], job_visits: [], sync_log: [],
    hub_users: [{ id: 'u-owner', role: 'owner', location_id: LOC, email: 'owner@bee.test', full_name: 'Olive Owner' }],
  }
  h.jobber.said = []; h.jobber.writes = []; h.jobber.down = false; h.jobber.throws = false; h.jobber.jobs = {}; h.jobber.records = {}
  h.jobber.people = { [ANA]: { name: 'Ana Bee', email: 'ana@bee.test' }, [SAM]: { name: 'Sam Carpenter', email: 'sam@bee.test' }, [NOR]: { name: 'Nora Nobody', email: 'nora@elsewhere.test' } }
  slack = { users: { 'ana@bee.test': 'U_ANA', 'sam@bee.test': 'U_SAM', 'owner@bee.test': 'U_OWNER' }, channels: new Map(), calls: [], down: false, seq: 0 }
  vi.stubGlobal('fetch', vi.fn(slackFetch))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}
const members = (id = 'CNEW1') => Array.from(slack.channels.get(id)!.members).sort()
const byHand = async (deal: number) => {
  const e = await loadEngagementForBees(db, engId(deal))
  return createJobChannel(db, { eng: e!, slack: await readLocationSlackFull(db, LOC), baseUrl: 'https://hub.test' })
}

beforeEach(() => { seed(); who.user = { id: 'u-owner', role: 'owner', location_id: LOC } })
afterEach(() => {
  expect(h.db.seedFaults, 'a seeded row names a column the real table does not have').toEqual([])
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
void sweepJobChannels; void createJobChannel; void loadEngagementForBees; void readLocationSlackFull; void byHand

const job = (deal: number, over: any = {}) => ({ id: `10000000-0000-4000-8000-${String(deal).padStart(12, '0')}`, location_id: 'loc_test', jobber_job_id: String(8000 + deal), engagement_id: engId(deal), lead_id: 'lead-7001', status: 'upcoming', ...over })
const press = (deal: number) => channelPOST(new NextRequest('http://x/api', { method: 'POST' }), { params: { id: engId(deal) } })
const panel = async (deal: number) => (await beesGET(new NextRequest('http://x/api'), { params: { id: engId(deal) } })).json()

// Every way a record can look like it might have a job, and not have one.
const NO_JOB: [string, () => void][] = [
  ['no job at all (Dup One, Pizza Hut)', () => {}],
  ['its only job was deleted', () => { h.db.tables.jobs.push(job(1, { status: 'deleted' })) }],
  ['its only job was deleted, whatever the capitals', () => { h.db.tables.jobs.push(job(1, { status: 'Deleted' })) }],
  ['a job row with no Jobber job behind it', () => { h.db.tables.jobs.push(job(1, { jobber_job_id: null })) }],
  ['the only jobs belong to OTHER deals of the same client', () => { h.db.tables.engagements.push(eng(2)); h.db.tables.jobs.push(job(2), job(3)) }],
  ['a job attached to no deal', () => { h.db.tables.jobs.push(job(1, { engagement_id: null })) }],
  ['it has a quote, an assessment and a request — and no job', () => {
    h.db.tables.quotes.push({ id: 'q1', engagement_id: engId(1) }); h.db.tables.service_requests.push({ id: 's1', engagement_id: engId(1) })
    h.db.tables.assessments.push({ id: 'a1', engagement_id: engId(1), status: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z' })
  }],
]
const STAGES = ['Request', 'Assessment', 'Quote', 'Job in Progress', 'Closed Won', 'Nurturing', null]

describe('THE SERVER refuses a channel for a record with no job, even when the request is forged', () => {
  for (const [why, arrange] of NO_JOB) {
    it(`refused before Slack is asked — ${why}`, async () => {
      h.db.tables.engagements.push(eng(1, { stage: 'Request' }))
      arrange()
      const before = JSON.stringify(h.db.tables)
      const res = await press(1)                                    // straight at the route: no screen involved
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'no_job', message: 'This isn’t a job yet. A Slack channel can be made once it is a job.' })
      expect(slack.calls).toEqual([])                              // not one call: no lookup, no create, no card
      expect(h.db.writes).toEqual([])
      expect(JSON.stringify(h.db.tables)).toBe(before)
    })
  }

  it('THE STAGE NAME DECIDES NOTHING: with no job it is refused at every stage, "Job in Progress" included', async () => {
    for (const stage of STAGES) {
      seed(); h.db.tables.engagements.push(eng(1, { stage }))
      const res = await press(1)
      expect(res.status, String(stage)).toBe(409)
      expect((await res.json()).error, String(stage)).toBe('no_job')
      expect(slack.calls, String(stage)).toEqual([])
    }
  })

  it('…and with a job it is made at every stage, "Request" included', async () => {
    for (const stage of STAGES.filter(s => s !== 'Closed Won')) {
      seed(); h.db.tables.engagements.push(eng(1, { stage })); h.db.tables.jobs.push(job(1))
      const res = await press(1)
      expect(res.status, String(stage)).toBe(200)
      expect((await res.json()).channel.name, String(stage)).toBe('test-failsafe-moving-relocation')
      expect(made(), String(stage)).toHaveLength(1)
    }
  })

  it('one live job among deleted ones is enough', async () => {
    h.db.tables.engagements.push(eng(1)); h.db.tables.jobs.push(job(1, { status: 'deleted' }), job(1, { id: '10000000-0000-4000-8000-0000000000ff', jobber_job_id: '8999', status: 'unscheduled' }))
    expect((await press(1)).status).toBe(200)
  })

  it('if the jobs cannot be read, nothing is made (it does not guess "yes")', async () => {
    h.db.tables.engagements.push(eng(1)); h.db.tables.jobs.push(job(1))
    h.db.fail = (table: string) => (table === 'jobs' ? { message: 'connection reset' } : null)
    const res = await press(1)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'job_unreadable', message: 'Couldn’t check whether this has a job just now — nothing was made. Try again.' })
    expect(slack.calls).toEqual([]); expect(h.db.writes).toEqual([])
    expect(await engagementHasJob(db, engId(1))).toBe('unknown')
    expect(await engagementHasJob({ from: () => { throw new Error('gone') } } as any, engId(1))).toBe('unknown')
  })

  it('an admin forcing it gets the same refusal', async () => {
    who.user = { id: 'u-admin', role: 'super_admin', location_id: null }
    h.db.tables.engagements.push(eng(1))
    expect((await press(1)).status).toBe(409)
    expect(slack.calls).toEqual([])
  })

  it('a location that has not reconnected still hears THAT first (the older refusal is unchanged)', async () => {
    h.db.tables.locations[0].slack_scopes = 'chat:write'
    h.db.tables.engagements.push(eng(1))
    expect((await (await press(1)).json()).error).toBe('not_ready')
  })

  it('a stray channel that already exists on a no-job record is left exactly as it is: no second channel, no card, no error', async () => {
    h.db.tables.engagements.push(eng(1, { stage: 'Request', slack_channel_id: 'CSTRAY', slack_channel_name: 'dup-one-organizing' }))
    const res = await press(1)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ already: true, channel: { id: 'CSTRAY', name: 'dup-one-organizing' } })
    expect(slack.calls).toEqual([]); expect(h.db.writes).toEqual([])
  })

  it('the rule itself: a row in jobs, on this deal, with a Jobber job id, not deleted — the crew mirror’s own test', async () => {
    h.db.tables.engagements.push(eng(1))
    expect(await engagementHasJob(db, engId(1))).toBe(false)
    h.db.tables.jobs.push(job(1))
    expect(await engagementHasJob(db, engId(1))).toBe(true)
    const rule = readFileSync('lib/engagement-has-job.ts', 'utf8'), mirror = readFileSync('lib/jobber-crew-mirror.ts', 'utf8')
    const read = ".from('jobs').select('jobber_job_id, status').eq('engagement_id', engagementId).not('jobber_job_id', 'is', null)"
    expect(rule).toContain(read); expect(mirror).toContain(read)
    expect(rule).toContain('!isDeletedJob(j)'); expect(mirror).toContain('!isDeletedJob(j)')
    expect(rule.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')).not.toMatch(/stage/i)
  })

  it('the refusal lives in the one function both doors use, ahead of every Slack call', () => {
    const lib = readFileSync('lib/engagement-bees.ts', 'utf8')
    const create = lib.slice(lib.indexOf('export async function createJobChannel'), lib.indexOf('async function inviteOwners'))
    const gate = create.indexOf("if (!hasJob) return { ok: false, reason: 'no_job' }")
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(create.indexOf('slackApi('))
    expect(gate).toBeLessThan(create.indexOf('readEngagementBees('))
    expect(create.slice(0, gate)).not.toMatch(/slackApi\(|lookupSlackUserByEmail|mirrorBee\(/)
  })

  it('the screen and the server say the same words', () => {
    expect(NO_JOB_LINE).toBe('This isn’t a job yet. A Slack channel can be made once it is a job.')
    expect(readFileSync('app/api/engagements/[id]/slack-channel/route.ts', 'utf8')).toContain(`no_job: [409, '${NO_JOB_LINE}']`)
  })
})

describe('what the server tells the panel, so the mark is only offered on a job', () => {
  for (const [why, arrange] of NO_JOB) {
    it(`hasJob is false — ${why}`, async () => {
      h.db.tables.engagements.push(eng(1)); arrange()
      expect((await panel(1)).slack.hasJob).toBe(false)
    })
  }
  it('hasJob is true with a live job, at any stage', async () => {
    h.db.tables.engagements.push(eng(1, { stage: 'Request' })); h.db.tables.jobs.push(job(1))
    expect((await panel(1)).slack).toMatchObject({ hasJob: true, connected: true, canManageChannels: true, channel: null })
  })
  it('hasJob is false when the jobs cannot be read', async () => {
    h.db.tables.engagements.push(eng(1)); h.db.tables.jobs.push(job(1))
    h.db.fail = (table: string) => (table === 'jobs' ? { message: 'connection reset' } : null)
    expect((await panel(1)).slack.hasJob).toBe(false)
  })
})

describe('AUTO-CREATE cannot make a channel for a record with no job', () => {
  it('asked directly for a deal with no job (switch on, reconnected, job dated after the switch): refused, Slack not asked, nothing left claimed', async () => {
    for (const [why, arrange] of NO_JOB) {
      seed(); h.db.tables.engagements.push(eng(1)); arrange()
      const r = await autoCreateJobChannel(db, { engagementId: engId(1), locationUuid: LOC, jobCreatedAt: AFTER, baseUrl: null })
      expect(r, why).toEqual({ status: 'failed', reason: 'no_job' })
      expect(slack.calls, why).toEqual([])
      expect(engRow(1).slack_channel_auto_at, why).toBeNull()
      expect(engRow(1).slack_channel_id, why).toBeNull()
    }
  })

  it('the real notice: the job is saved and tied to its deal BEFORE auto-create looks, so a real new job gets its channel', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    expect(h.db.tables.jobs).toEqual([])                          // Bee Hub has never heard of this job
    const r = await fire('JOB_CREATE', 'Job', '501')
    expect(r.note).toBe('auto channel made')
    expect(h.db.tables.jobs).toHaveLength(1)
    expect(h.db.tables.jobs[0]).toMatchObject({ engagement_id: engId(1), jobber_job_id: '501' })
    expect(made()).toHaveLength(1)
  })

  it('in the source, auto-create comes after the job is attached to its deal', () => {
    const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    const core = src.slice(src.indexOf('async function handleJobCore('), src.indexOf('export function handleJobCreate'))
    expect(core.indexOf("await attachToEngagement('jobs', jRes.id, engId)")).toBeGreaterThan(core.indexOf('const jRes = await upsertJob('))
    expect(core.indexOf('autoCreateJobChannelSafely(')).toBeGreaterThan(core.indexOf("await attachToEngagement('jobs', jRes.id, engId)"))
  })

  it('a JOB_CREATE whose job lands already deleted makes nothing', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    h.db.tables.jobs.push(job(1, { jobber_job_id: '501', status: 'deleted' }))
    // the stand-in upsert keeps the stored status when Jobber's maps to the same row; force the deleted state back after the write
    const realFrom = h.from
    vi.spyOn(supabaseService as any, 'from').mockImplementation((t: any) => {
      const b = realFrom(t)
      if (t !== 'jobs') return b
      const up = b.upsert
      b.upsert = (p: any) => up({ ...p, status: 'deleted' })
      return b
    })
    const r = await fire('JOB_CREATE', 'Job', '501')
    expect(r.processed).toBe(true)
    expect(r.note).toBe('auto channel not made — no_job')
    expect(made()).toEqual([]); expect(engRow(1).slack_channel_auto_at).toBeNull()
  })

  it('JOB_UPDATE, visit notices and the sweep still make nothing for a record with or without a job', async () => {
    h.db.tables.engagements.push(eng(1), eng(2)); h.db.tables.jobs.push(job(2))
    jobInJobber('8002', 2); h.jobber.jobs['8002'] = { visits: [{ id: '9002', crew: [ANA] }] }
    await fire('JOB_UPDATE', 'Job', '8002'); await fire('VISIT_CREATE', 'Visit', '9002'); await sweepJobChannels(db)
    expect(made()).toEqual([])
  })
})
