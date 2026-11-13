// Automatic job channels (2026-11-12, Jobber crew → Slack, slice 3 of 3).
// lib/job-channel-auto.ts, its one caller (JOB_CREATE in
// lib/jobber-webhook-handlers.ts) and the switch's route.
//
// What is real here and what is a stand-in:
//   · REAL: the JOB_CREATE / JOB_UPDATE / VISIT_* handlers through
//     TOPIC_HANDLERS (the table the webhook route dispatches from), upsertJob
//     (the function the import calls too), auto-create, createJobChannel, the
//     crew mirror, both sweeps, the cron route, the switch's route.
//   · STAND-IN database: held to the schema snapshot (a column the table does
//     not have fails like Postgres). The three columns this slice adds are in
//     the snapshot; the real database gets them when Kevin runs
//     migrations/slack_auto_channels.sql.
//   · STAND-IN Jobber and Slack. Which deal a job belongs to is a lookup.
// Nothing here has made a real channel in a real Slack.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

const who = vi.hoisted(() => ({ user: null as any }))
vi.mock('@/lib/auth', () => ({ requireAuth: async () => ({ id: who.user?.id }), getHubUser: async () => who.user }))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: async () => null }))

import * as check from '@/lib/db-columns-check'
import { supabaseService } from '@/lib/supabase-service'
import { TOPIC_HANDLERS } from '@/lib/jobber-webhook-handlers'
import { upsertJob } from '@/lib/jobber-import'
import { sweepJobCrews } from '@/lib/jobber-crew-mirror'
import { sweepJobChannels } from '@/lib/engagement-bees'
import {
  AUTO_CHANNEL_DAILY_CAP, AUTO_CHANNEL_WINDOW_MS, canSetAutoChannels, autoCreateJobChannel, autoCreateJobChannelSafely, autoNote, capStillOn, readAutoSwitch, setAutoSwitch,
} from '@/lib/job-channel-auto'
import { GET as cronGET } from '@/app/api/cron/job-channels/route'
import { GET as switchGET, POST as switchPOST } from '@/app/api/locations/[id]/slack-auto-channels/route'

const db = supabaseService as any
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'       // reconnected
const LOC_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'     // a second reconnected location
const LOC_OLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'   // Slack connected, not reconnected
const LOC_QUIET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' // no Slack
const TOKEN = 'xoxb-test'
const NEW_SCOPES = 'chat:write,channels:read,channels:manage,users:read,users:read.email'
const OLD_SCOPES = 'chat:write,channels:read,users:read,users:read.email'
const ANA = h.gid('User', '1'), SAM = h.gid('User', '2')
const SWITCHED_ON = '2026-11-10T12:00:00.000Z'
const BEFORE = '2026-11-10T11:59:59.000Z', AFTER = '2026-11-10T12:00:01.000Z'
const SLUG: Record<string, string> = { [LOC]: 'loc_test', [LOC_B]: 'loc_b', [LOC_OLD]: 'loc_old', [LOC_QUIET]: 'loc_quiet' }
const CLIENT: Record<string, string> = { [LOC]: '7001', [LOC_B]: '7002', [LOC_OLD]: '7003', [LOC_QUIET]: '7004' }

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

const engId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const eng = (n: number, loc = LOC, over: any = {}) => ({
  id: engId(n), location_uuid: loc, client_id: `lead-${CLIENT[loc]}`, project_type: 'Pantry', stage: 'Job in Progress', closed_at: null,
  slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null, slack_channel_problems: null, slack_channel_auto_at: null, ...over,
})
const engRow = (n: number) => h.db.tables.engagements.find((e: any) => e.id === engId(n))
const locRow = (id = LOC) => h.db.tables.locations.find((l: any) => l.id === id)
// A job in Jobber (what GetJob answers), on a deal Bee Hub already has.
const jobInJobber = (jobberId: string, deal: number, loc = LOC, over: any = {}) => {
  h.jobber.records[jobberId] = { createdAt: AFTER, jobberWebUri: null, title: 'Pantry', jobStatus: 'UPCOMING', startAt: null, completedAt: null, total: '100', client: { id: h.gid('Client', CLIENT[loc]) }, request: null, quote: null, ...over }
  ;(h as any).dealFor[jobberId] = engId(deal)
  if (!h.jobber.jobs[jobberId]) h.jobber.jobs[jobberId] = { visits: [] }
}
const fire = (topic: string, type: string, id: string, loc = LOC) =>
  TOPIC_HANDLERS[topic]({ topic, itemId: h.gid(type, id), occurredAt: new Date().toISOString(), location: { id: loc, location_id: SLUG[loc], name: 'Test', timezone: null, jobber_account_id: null, jobber_access_token: null } as any })
const jobCreate = (id: string, loc = LOC) => fire('JOB_CREATE', 'Job', id, loc)
const switchOn = (loc = LOC, at = SWITCHED_ON) => { locRow(loc).slack_auto_channels_at = at }
const claims = () => h.db.tables.engagements.filter((e: any) => e.slack_channel_auto_at).length
const req = (body?: any) => new NextRequest('http://x/api', body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  h.db.check = check
  h.db.seq = 0; h.db.seedFaults = []; h.db.writes = []; h.db.reads = []; h.db.fail = null
  ;(h as any).dealFor = {}
  const loc = (id: string, over: any) => ({ id, location_id: SLUG[id], name: 'Test', jobber_connected: true, slack_auto_channels_at: null, slack_auto_channels_capped_at: null, ...over })
  h.db.tables = {
    locations: [
      loc(LOC, { slack_connected: true, slack_bot_token: TOKEN, slack_scopes: NEW_SCOPES }),
      loc(LOC_B, { slack_connected: true, slack_bot_token: TOKEN, slack_scopes: NEW_SCOPES }),
      loc(LOC_OLD, { slack_connected: true, slack_bot_token: TOKEN, slack_scopes: OLD_SCOPES }),
      loc(LOC_QUIET, { slack_connected: false, slack_bot_token: null, slack_scopes: null }),
    ],
    leads: Object.entries(CLIENT).map(([l, c]) => ({ id: `lead-${c}`, location_id: SLUG[l], jobber_client_id: c, name: c === '7001' ? 'Sarah McAllister' : `Client ${c}`, stage: 'Job in Progress' })),
    engagements: [], jobs: [], quotes: [], service_requests: [],
    location_bees: [], engagement_bees: [], job_visits: [], sync_log: [],
    hub_users: [{ id: 'u-owner', role: 'owner', location_id: LOC, email: 'owner@bee.test', full_name: 'Olive Owner' }],
  }
  h.jobber.said = []; h.jobber.writes = []; h.jobber.down = false; h.jobber.throws = false; h.jobber.jobs = {}; h.jobber.records = {}
  h.jobber.people = { [ANA]: { name: 'Ana Bee', email: 'ana@bee.test' }, [SAM]: { name: 'Sam Carpenter', email: 'sam@bee.test' } }
  slack = { users: { 'ana@bee.test': 'U_ANA', 'sam@bee.test': 'U_SAM', 'owner@bee.test': 'U_OWNER' }, channels: new Map(), calls: [], down: false, seq: 0 }
  who.user = { id: 'u-owner', role: 'owner', location_id: LOC }
  vi.stubGlobal('fetch', vi.fn(slackFetch))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  expect(h.db.seedFaults, 'a seeded row names a column the real table does not have').toEqual([])
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('what it does when the switch is on', () => {
  it('a job created in Jobber gets its channel: named for the client and the job type, the owner in it, a link posted', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    const r = await jobCreate('501')
    expect(r.processed).toBe(true)
    expect(r.note).toBe('auto channel made')
    expect(made().map(c => c.body)).toEqual([{ name: 'sarah-mcallister-pantry', is_private: false }])
    expect(engRow(1)).toMatchObject({ slack_channel_id: 'CNEW1', slack_channel_name: 'sarah-mcallister-pantry' })
    expect(engRow(1).slack_channel_auto_at).toBeTruthy()
    expect(Array.from(slack.channels.get('CNEW1')!.members).sort()).toEqual(['UBOT', 'U_OWNER'])
    expect(slack.calls.filter(c => c.method === 'chat.postMessage')).toHaveLength(1)
  })

  it('NO TEAM YET is fine: the channel waits, and a visit notice puts people in as they are assigned', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    await jobCreate('501')
    expect(Array.from(slack.channels.get('CNEW1')!.members).sort()).toEqual(['UBOT', 'U_OWNER'])
    h.jobber.jobs['501'] = { visits: [{ id: '9001', crew: [ANA, SAM] }] }
    await fire('VISIT_CREATE', 'Visit', '9001')
    expect(Array.from(slack.channels.get('CNEW1')!.members).sort()).toEqual(['UBOT', 'U_ANA', 'U_OWNER', 'U_SAM'])
    expect(made()).toHaveLength(1)
  })

  it('a job that arrives WITH a team: the same notice makes the channel and puts the team in', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    h.jobber.jobs['501'] = { visits: [{ id: '9001', crew: [ANA] }] }
    await jobCreate('501')
    expect(Array.from(slack.channels.get('CNEW1')!.members).sort()).toEqual(['UBOT', 'U_ANA', 'U_OWNER'])
  })

  it('UNBOOKED jobs get a channel too (nothing on the calendar yet): the trigger is the job being made', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1), eng(2), eng(3))
    jobInJobber('501', 1, LOC, { jobStatus: 'UNSCHEDULED' }); jobInJobber('502', 2, LOC, { jobStatus: 'ACTION_REQUIRED' }); jobInJobber('503', 3, LOC, { jobStatus: 'ON_HOLD' })
    for (const j of ['501', '502', '503']) await jobCreate(j)
    expect(slack.channels.size).toBe(3)
    expect(h.db.tables.engagements.every((e: any) => e.slack_channel_id)).toBe(true)
  })

  it('a SECOND job on the same deal reuses the deal’s channel: nothing is made', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1); jobInJobber('502', 1)
    await jobCreate('501')
    const r = await jobCreate('502')
    expect(made()).toHaveLength(1)
    expect(r.note).toBeUndefined()
    expect(engRow(1).slack_channel_id).toBe('CNEW1')
  })

  it('a NEW deal for the same client gets its own channel, with the name’s suffix', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1), eng(2)); jobInJobber('501', 1); jobInJobber('502', 2)
    await jobCreate('501'); await jobCreate('502')
    expect(made().map(c => c.body.name)).toEqual(['sarah-mcallister-pantry', 'sarah-mcallister-pantry', 'sarah-mcallister-pantry-2'])
    expect(engRow(2).slack_channel_name).toBe('sarah-mcallister-pantry-2')
    expect(slack.channels.size).toBe(2)
  })

  it('a closed deal gets nothing', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1, LOC, { closed_at: '2026-11-11T00:00:00Z' })); jobInJobber('501', 1)
    const r = await jobCreate('501')
    expect(made()).toEqual([])
    expect(r.note).toBe('auto channel skipped — closed')
  })

  it('Slack down: nothing is made, the job is still saved, and the claim is given back so nothing is left half-done', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1); slack.down = true
    const r = await jobCreate('501')
    expect(r.processed).toBe(true)
    expect(r.note).toBe('auto channel not made — slack_unavailable')
    expect(engRow(1)).toMatchObject({ slack_channel_id: null, slack_channel_auto_at: null })
    expect(h.db.tables.jobs).toHaveLength(1)
  })

  it('a fault inside auto-create never fails the job write', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const r = await jobCreate('501')
    expect(r.processed).toBe(true)
    expect(h.db.tables.jobs).toHaveLength(1)
    expect(await autoCreateJobChannelSafely({ from: () => { throw new Error('db gone') } } as any, { engagementId: engId(1), locationUuid: LOC, jobCreatedAt: AFTER, baseUrl: null }))
      .toEqual({ status: 'skipped', why: 'switch_unreadable' })
  })
})

describe('TURNING THE SWITCH ON creates no channel for any job that already exists', () => {
  const existing = (count: number) => {
    for (let i = 1; i <= count; i++) { h.db.tables.engagements.push(eng(i)); jobInJobber(String(500 + i), i, LOC, { createdAt: BEFORE }); h.db.tables.jobs.push({ id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, location_id: 'loc_test', jobber_job_id: String(500 + i), engagement_id: engId(i), lead_id: 'lead-7001', status: 'upcoming' }) }
  }

  it('the act of turning it on writes ONE thing — the time on the location — and calls neither Slack nor Jobber', async () => {
    existing(40)
    const r = await setAutoSwitch(db, LOC, true, new Date(SWITCHED_ON))
    expect(r).toEqual({ ok: true, onSince: SWITCHED_ON })
    expect(h.db.writes).toEqual(['update locations'])
    expect(slack.calls).toEqual([])
    expect(h.jobber.said).toEqual([])
    expect(claims()).toBe(0)
    expect(h.db.reads.filter((t: string) => t === 'engagements' || t === 'jobs')).toEqual([])
  })

  it('through the route too: POST on → the same single write, no Slack, no Jobber', async () => {
    existing(40)
    const res = await switchPOST(req({ on: true }), { params: { id: LOC } })
    expect(res.status).toBe(200)
    expect((await res.json())).toMatchObject({ setUp: true, on: true, capped: false, cap: 15 })
    expect(h.db.writes).toEqual(['update locations'])
    expect(slack.calls).toEqual([]); expect(h.jobber.said).toEqual([]); expect(claims()).toBe(0)
  })

  it('afterwards, EVERY notice Jobber can send about those jobs still makes nothing: a replayed JOB_CREATE, JOB_UPDATE, the visit notices', async () => {
    existing(12); switchOn()
    for (let i = 1; i <= 12; i++) {
      const id = String(500 + i)
      h.jobber.jobs[id] = { visits: [{ id: String(9000 + i), crew: [ANA] }] }
      const r = await jobCreate(id)
      expect(r.note).toBe('auto channel skipped — job_older_than_switch')
      await fire('JOB_UPDATE', 'Job', id)
      for (const t of ['VISIT_CREATE', 'VISIT_UPDATE', 'VISIT_COMPLETE']) await fire(t, 'Visit', String(9000 + i))
    }
    expect(made()).toEqual([])
    expect(claims()).toBe(0)
    expect(slack.calls.filter(c => c.method.startsWith('conversations.'))).toEqual([])
  })

  it('both sweeps and the cron route make nothing for them either', async () => {
    existing(12); switchOn()
    await sweepJobChannels(db); await sweepJobCrews(db)
    process.env.CRON_SECRET = 'shh'
    const res = await cronGET(new NextRequest('http://x/api/cron/job-channels', { headers: { authorization: 'Bearer shh' } }))
    expect(res.status).toBe(200)
    expect(made()).toEqual([]); expect(claims()).toBe(0)
  })

  it('the line is Jobber’s own creation time, strictly after the switch: the same second, a second before, a year before, and no date at all are all refused', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1), eng(2), eng(3), eng(4), eng(5))
    jobInJobber('501', 1, LOC, { createdAt: SWITCHED_ON }); jobInJobber('502', 2, LOC, { createdAt: BEFORE })
    jobInJobber('503', 3, LOC, { createdAt: '2025-11-10T12:00:01.000Z' }); jobInJobber('504', 4, LOC, { createdAt: null }); jobInJobber('505', 5, LOC, { createdAt: 'yesterday-ish' })
    const notes = []
    for (const j of ['501', '502', '503', '504', '505']) notes.push((await jobCreate(j)).note)
    expect(notes).toEqual(['auto channel skipped — job_older_than_switch', 'auto channel skipped — job_older_than_switch', 'auto channel skipped — job_older_than_switch', 'auto channel skipped — job_date_unreadable', 'auto channel skipped — job_date_unreadable'])
    expect(made()).toEqual([]); expect(claims()).toBe(0)
  })

  it('a switch whose own time is unreadable makes nothing', async () => {
    switchOn(LOC, 'not-a-date'); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    expect((await jobCreate('501')).note).toBe('auto channel skipped — job_date_unreadable')
    expect(made()).toEqual([])
  })

  it('pressing ON when it is already on keeps the first time: a second press cannot move the line', async () => {
    switchOn()
    expect(await setAutoSwitch(db, LOC, true, new Date('2026-11-12T00:00:00Z'))).toEqual({ ok: true, onSince: SWITCHED_ON })
    expect(locRow().slack_auto_channels_at).toBe(SWITCHED_ON)
  })

  it('off and on again moves the line FORWARD: a job made while it was off stays without', async () => {
    switchOn()
    await setAutoSwitch(db, LOC, false)
    expect(locRow().slack_auto_channels_at).toBeNull()
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1, LOC, { createdAt: '2026-11-11T00:00:00.000Z' })
    expect((await jobCreate('501')).note).toBeUndefined()        // off: silent
    await setAutoSwitch(db, LOC, true, new Date('2026-11-12T00:00:00.000Z'))
    expect((await jobCreate('501')).note).toBe('auto channel skipped — job_older_than_switch')
    expect(made()).toEqual([])
  })
})

describe('THE CEILING stops creation and says so', () => {
  const freshJobs = (from: number, count: number, loc = LOC) => {
    const ids: string[] = []
    // each its own client, so each has its own channel name
    for (let i = from; i < from + count; i++) {
      h.db.tables.leads.push({ id: `lead-f${i}`, location_id: SLUG[loc], jobber_client_id: `f${i}`, name: `Client Number ${i}`, stage: 'Job in Progress' })
      h.db.tables.engagements.push(eng(i, loc, { client_id: `lead-f${i}` })); jobInJobber(String(1000 + i), i, loc); ids.push(String(1000 + i))
    }
    return ids
  }

  it('the ceiling is 15 in any 24 hours', () => {
    expect(AUTO_CHANNEL_DAILY_CAP).toBe(15)
    expect(AUTO_CHANNEL_WINDOW_MS).toBe(86_400_000)
  })

  it('15 are made; the 16th and every one after is not — Slack is not asked, the job is still saved, the log line says why', async () => {
    switchOn()
    const ids = freshJobs(1, 22)
    const notes: any[] = []
    for (const id of ids) notes.push((await jobCreate(id)).note)
    expect(made()).toHaveLength(15)
    expect(notes.slice(0, 15).every(n => n === 'auto channel made')).toBe(true)
    expect(notes.slice(15)).toEqual(Array(7).fill('auto channel NOT made — daily ceiling of 15 reached'))
    expect(h.db.tables.engagements.filter((e: any) => e.slack_channel_id)).toHaveLength(15)
    expect(h.db.tables.jobs).toHaveLength(22)
    // The stopped ones hold no claim, so they do not count against tomorrow.
    expect(claims()).toBe(15)
  })

  it('THE OWNER IS TOLD: the location is stamped, and the switch’s own route answers "capped"', async () => {
    switchOn()
    for (const id of freshJobs(1, 15)) await jobCreate(id)
    expect(locRow().slack_auto_channels_capped_at).toBeNull()
    expect((await (await switchGET(req(), { params: { id: LOC } })).json()).capped).toBe(false)
    for (const id of freshJobs(16, 1)) await jobCreate(id)
    expect(locRow().slack_auto_channels_capped_at).toBeTruthy()
    expect(await (await switchGET(req(), { params: { id: LOC } })).json()).toMatchObject({ on: true, capped: true, cap: 15 })
  })

  it('20 jobs landing in the SAME instant never go over 15', async () => {
    switchOn()
    const ids = freshJobs(1, 20)
    await Promise.all(ids.map(id => jobCreate(id)))
    expect(made().length).toBeLessThanOrEqual(15)
    expect(h.db.tables.engagements.filter((e: any) => e.slack_channel_id).length).toBeLessThanOrEqual(15)
    expect(locRow().slack_auto_channels_capped_at).toBeTruthy()
  })

  it('it is per location: one location at its ceiling does not stop another', async () => {
    switchOn(); switchOn(LOC_B)
    h.db.tables.hub_users.push({ id: 'u-owner-b', role: 'owner', location_id: LOC_B, email: 'ownerb@bee.test', full_name: 'Otto Owner' })
    for (const id of freshJobs(1, 16)) await jobCreate(id)
    const [b] = freshJobs(100, 1, LOC_B)
    expect((await jobCreate(b, LOC_B)).note).toMatch(/^auto channel made/)
    expect(locRow(LOC_B).slack_auto_channels_capped_at).toBeNull()
  })

  it('it is a rolling 24 hours: channels older than that no longer count, and the "capped" notice lapses by itself', async () => {
    switchOn()
    const old = new Date(Date.now() - AUTO_CHANNEL_WINDOW_MS - 60_000).toISOString()
    for (let i = 1; i <= 15; i++) h.db.tables.engagements.push(eng(i, LOC, { slack_channel_id: `COLD${i}`, slack_channel_name: `old-${i}`, slack_channel_auto_at: old }))
    const [id] = freshJobs(50, 1)
    expect((await jobCreate(id)).note).toBe('auto channel made')
    const now = Date.now()
    expect(capStillOn(new Date(now - 60_000).toISOString(), now)).toBe(true)
    expect(capStillOn(new Date(now - AUTO_CHANNEL_WINDOW_MS - 1).toISOString(), now)).toBe(false)
    expect(capStillOn(null, now)).toBe(false)
  })

  it('channels made by hand with the Slack mark do not count against it', async () => {
    switchOn()
    for (let i = 1; i <= 30; i++) h.db.tables.engagements.push(eng(i, LOC, { slack_channel_id: `CHAND${i}`, slack_channel_name: `hand-${i}` }))
    const [id] = freshJobs(50, 1)
    expect((await jobCreate(id)).note).toBe('auto channel made')
  })

  it('if the count cannot be read, it counts as over: nothing is made', async () => {
    switchOn()
    const [id] = freshJobs(1, 1)
    let selects = 0
    h.db.fail = (table: string, op: string) => (table === 'engagements' && op === 'select' && ++selects === 2 ? { message: 'connection reset' } : null)
    const r = await autoCreateJobChannel(db, { engagementId: engId(1), locationUuid: LOC, jobCreatedAt: AFTER, baseUrl: null })
    expect(selects).toBeGreaterThanOrEqual(2)
    expect(r).toEqual({ status: 'capped', cap: 15 })
    expect(made()).toEqual([])
    expect(engRow(1).slack_channel_auto_at).toBeNull()
    void id
  })

  it('turning the switch off clears the notice', async () => {
    switchOn(); locRow().slack_auto_channels_capped_at = new Date().toISOString()
    await setAutoSwitch(db, LOC, false)
    expect(locRow()).toMatchObject({ slack_auto_channels_at: null, slack_auto_channels_capped_at: null })
  })

  it('the log line for each outcome', () => {
    expect(autoNote({ status: 'off' })).toBeNull()
    expect(autoNote({ status: 'not_set_up_yet' })).toBeNull()
    expect(autoNote({ status: 'created', channelId: 'C', notAdded: 2 })).toBe('auto channel made, 2 not added')
    expect(autoNote({ status: 'capped', cap: 15 })).toBe('auto channel NOT made — daily ceiling of 15 reached')
    expect(autoNote({ status: 'skipped', why: 'has_channel' })).toBeNull()
    expect(autoNote({ status: 'skipped', why: 'not_reconnected' })).toBe('auto channel skipped — not_reconnected')
  })
})

describe('a replayed or racing notice never makes a second channel', () => {
  it('JOB_CREATE delivered twice: one channel', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    await jobCreate('501')
    const r = await jobCreate('501')
    expect(made()).toHaveLength(1)
    expect(r.note).toBeUndefined()
    expect(slack.channels.size).toBe(1)
  })

  it('the same JOB_CREATE delivered five times in the same instant: one channel', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    await Promise.all([1, 2, 3, 4, 5].map(() => jobCreate('501')))
    expect(made()).toHaveLength(1)
    expect(Array.from(slack.channels.values()).filter(c => !c.archived)).toHaveLength(1)
  })

  it('VISIT_CREATE lands BEFORE JOB_CREATE, in the same second: one channel, and the visit’s people end up in it', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    h.jobber.jobs['501'] = { visits: [{ id: '9001', crew: [ANA, SAM] }] }
    const early = await fire('VISIT_CREATE', 'Visit', '9001')          // the job is not in Bee Hub yet
    expect(early.note).toMatch(/not in Bee Hub/)
    expect(made()).toEqual([])
    await Promise.all([jobCreate('501'), fire('VISIT_UPDATE', 'Visit', '9001')])
    await fire('VISIT_UPDATE', 'Visit', '9001')
    expect(made()).toHaveLength(1)
    expect(Array.from(slack.channels.get('CNEW1')!.members).sort()).toEqual(['UBOT', 'U_ANA', 'U_OWNER', 'U_SAM'])
  })

  it('a deal that belongs to a different location than the notice came from is left alone', async () => {
    switchOn(); switchOn(LOC_B); h.db.tables.engagements.push(eng(1, LOC_B))
    expect(await autoCreateJobChannel(db, { engagementId: engId(1), locationUuid: LOC, jobCreatedAt: AFTER, baseUrl: null })).toEqual({ status: 'skipped', why: 'no_engagement' })
    expect(await autoCreateJobChannel(db, { engagementId: engId(99), locationUuid: LOC, jobCreatedAt: AFTER, baseUrl: null })).toEqual({ status: 'skipped', why: 'no_engagement' })
    expect(slack.calls).toEqual([]); expect(claims()).toBe(0)
  })

  it('a job whose deal was put in Slack by hand first: the notice makes nothing', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1, LOC, { slack_channel_id: 'CHAND', slack_channel_name: 'by-hand' })); jobInJobber('501', 1)
    const r = await jobCreate('501')
    expect(made()).toEqual([]); expect(r.note).toBeUndefined()
    expect(engRow(1).slack_channel_auto_at).toBeNull()
  })

  it('a channel an owner deleted in Slack is not quietly remade by a later notice', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1); jobInJobber('502', 1)
    await jobCreate('501')
    Object.assign(engRow(1), { slack_channel_id: null, slack_channel_name: null })   // what forgetChannel leaves
    await jobCreate('501'); await jobCreate('502')
    expect(made()).toHaveLength(1)
  })
})

describe('THE SWEEP never creates a channel, only maintains one', () => {
  it('switch on, fresh jobs with no channel and a team in Jobber: three runs of both sweeps and the cron route make nothing', async () => {
    switchOn()
    for (let i = 1; i <= 8; i++) {
      h.db.tables.engagements.push(eng(i)); jobInJobber(String(500 + i), i)
      h.db.tables.jobs.push({ id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, location_id: 'loc_test', jobber_job_id: String(500 + i), engagement_id: engId(i), lead_id: 'lead-7001', status: 'upcoming' })
      h.jobber.jobs[String(500 + i)] = { visits: [{ id: String(9000 + i), crew: [ANA] }] }
    }
    process.env.CRON_SECRET = 'shh'
    for (let run = 0; run < 3; run++) {
      await sweepJobChannels(db); await sweepJobCrews(db)
      for (let k = 0; k < 12; k++) await cronGET(new NextRequest('http://x/api/cron/job-channels', { headers: { authorization: 'Bearer shh' } }))
    }
    expect(made()).toEqual([])
    expect(claims()).toBe(0)
    expect(h.db.tables.engagements.every((e: any) => !e.slack_channel_id)).toBe(true)
  })

  it('it still maintains: a closed job’s channel is archived by the sweep', async () => {
    h.db.tables.engagements.push(eng(1, LOC, { slack_channel_id: 'C1', slack_channel_name: 'one', closed_at: '2026-11-11T00:00:00Z' }))
    slack.channels.set('C1', { name: 'one', members: new Set(['UBOT']), archived: false })
    const r = await sweepJobChannels(db)
    expect(r.archived).toBe(1)
    expect(made()).toEqual([])
  })

  it('in the source: nothing the sweep runs can reach channel creation', () => {
    const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
    for (const f of ['app/api/cron/job-channels/route.ts', 'lib/jobber-crew-mirror.ts', 'lib/cron-log-lines.ts']) {
      expect(code(f), f).not.toMatch(/createJobChannel|job-channel-auto|autoCreate|conversations\.create/)
    }
    // sweepJobChannels lives beside createJobChannel; its own body must not call it.
    const lib = code('lib/engagement-bees.ts')
    const sweep = lib.slice(lib.indexOf('export async function sweepJobChannels'), lib.indexOf('export type ChannelProblem'))
    expect(sweep.length).toBeGreaterThan(500)
    expect(sweep).not.toMatch(/createJobChannel|conversations\.create/)
    const rec = lib.slice(lib.indexOf('export async function reconcileChannelBees'))
    expect(rec).not.toMatch(/createJobChannel|conversations\.create/)
  })
})

describe('A JOB CREATED BY THE IMPORT creates no channel', () => {
  it('the import’s own job write (upsertJob), switch on, a brand-new job dated after the switch: no Slack call, no claim', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    const r = await upsertJob({ id: h.gid('Job', '501'), ...h.jobber.records['501'] }, null, 'lead-7001', 'loc_test')
    expect(r.created).toBe(true)
    expect(h.db.tables.jobs).toHaveLength(1)
    expect(slack.calls).toEqual([])
    expect(claims()).toBe(0)
  })

  const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    if (n === 'node_modules' || n.startsWith('.')) return []
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|jsx|mjs)$/.test(n) && !/\.test\./.test(n) ? [p] : []
  })
  const all = ['app', 'lib', 'components', 'scripts'].flatMap(walk)

  it('auto-create has exactly ONE caller in the whole app, and it is inside the JOB_CREATE branch', () => {
    const callers = all.filter(f => f !== 'lib/job-channel-auto.ts' && /autoCreateJobChannel/.test(readFileSync(f, 'utf8')))
    expect(callers).toEqual(['lib/jobber-webhook-handlers.ts'])
    const src = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    expect(src.split('autoCreateJobChannelSafely(').length - 1).toBe(1)
    expect(src.split('autoCreateJobChannel(').length - 1).toBe(0)
    const at = src.indexOf('autoCreateJobChannelSafely(')
    const guard = src.lastIndexOf("if (ctx.topic === 'JOB_CREATE') {", at)
    expect(guard).toBeGreaterThan(0)
    expect(at - guard).toBeLessThan(120)
    expect(src.slice(guard, at)).not.toContain('}')
  })

  it('the import, Send to Jobber and the backfill scripts cannot reach it: none of them touches the webhook handlers or channel creation', () => {
    const importers = all.filter(f => /^app\/api\/import\//.test(f) || /^scripts\//.test(f) || f === 'lib/jobber-import.ts' || f === 'app/api/leads/[id]/send-to-jobber/route.ts')
    expect(importers).toContain('app/api/import/jobber-clients/route.ts')
    expect(importers.length).toBeGreaterThan(5)
    for (const f of importers) {
      const code = readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
      expect(code, f).not.toMatch(/jobber-webhook-handlers|TOPIC_HANDLERS|handleJobCreate|job-channel-auto|autoCreateJobChannel|createJobChannel|conversations\.create/)
    }
    // …and the import does write jobs, by this door.
    expect(readFileSync('app/api/import/jobber-clients/route.ts', 'utf8')).toMatch(/await upsertJob\(/)
  })

  it('JOB_UPDATE and JOB_COMPLETE go through the same code as JOB_CREATE and make nothing', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    await fire('JOB_UPDATE', 'Job', '501'); await fire('JOB_COMPLETE', 'Job', '501')
    expect(made()).toEqual([]); expect(claims()).toBe(0)
  })
})

describe('A LOCATION THAT HAS NOT RECONNECTED cannot turn it on', () => {
  it('the server refuses, and writes nothing, even when the browser is forced', async () => {
    who.user = { id: 'u-old', role: 'owner', location_id: LOC_OLD }
    const res = await switchPOST(req({ on: true }), { params: { id: LOC_OLD } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_reconnected', message: 'Reconnect Slack first. Bee Hub can’t make channels for this location yet.' })
    expect(h.db.writes).toEqual([])
    expect(locRow(LOC_OLD).slack_auto_channels_at).toBeNull()
    expect(await setAutoSwitch(db, LOC_QUIET, true)).toEqual({ ok: false, reason: 'not_reconnected' })
    expect(h.db.writes).toEqual([])
  })

  it('an admin cannot force it on for such a location either', async () => {
    who.user = { id: 'u-admin', role: 'super_admin', location_id: null }
    expect((await switchPOST(req({ on: true }), { params: { id: LOC_OLD } })).status).toBe(409)
    expect(locRow(LOC_OLD).slack_auto_channels_at).toBeNull()
  })

  it('and if the time were written straight into the database anyway, a new job still makes nothing', async () => {
    switchOn(LOC_OLD); switchOn(LOC_QUIET)
    h.db.tables.engagements.push(eng(1, LOC_OLD), eng(2, LOC_QUIET)); jobInJobber('501', 1, LOC_OLD); jobInJobber('502', 2, LOC_QUIET)
    expect((await jobCreate('501', LOC_OLD)).note).toBe('auto channel skipped — not_reconnected')
    expect((await jobCreate('502', LOC_QUIET)).note).toBe('auto channel skipped — not_reconnected')
    expect(slack.calls).toEqual([]); expect(claims()).toBe(0)
  })

  it('a location that loses the permission after turning it on stops making channels', async () => {
    switchOn(); locRow().slack_scopes = OLD_SCOPES
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    expect((await jobCreate('501')).note).toBe('auto channel skipped — not_reconnected')
    expect(made()).toEqual([])
  })

  it('the route tells the screen so it can grey the switch; turning OFF is always allowed', async () => {
    who.user = { id: 'u-old', role: 'owner', location_id: LOC_OLD }
    expect(await (await switchGET(req(), { params: { id: LOC_OLD } })).json()).toMatchObject({ setUp: true, on: false, connected: true, reconnected: false, canSet: true })
    switchOn(LOC_OLD)
    const off = await switchPOST(req({ on: false }), { params: { id: LOC_OLD } })
    expect(off.status).toBe(200)
    expect(locRow(LOC_OLD).slack_auto_channels_at).toBeNull()
  })
})

describe('who can set it: the people who can reconnect', () => {
  it('owner of the location, admin, super_admin — and nobody else', () => {
    expect(canSetAutoChannels({ role: 'owner', location_id: LOC }, LOC)).toBe(true)
    expect(canSetAutoChannels({ role: 'admin', location_id: null }, LOC)).toBe(true)
    expect(canSetAutoChannels({ role: 'super_admin', location_id: null }, LOC)).toBe(true)
    expect(canSetAutoChannels({ role: 'owner', location_id: LOC_B }, LOC)).toBe(false)
    expect(canSetAutoChannels({ role: 'manager', location_id: LOC }, LOC)).toBe(false)
    expect(canSetAutoChannels({ role: 'lite_user', location_id: LOC }, LOC)).toBe(false)
    expect(canSetAutoChannels(null, LOC)).toBe(false)
  })

  it('a manager can see it and is refused when changing it; another location’s owner sees nothing', async () => {
    who.user = { id: 'u-mgr', role: 'manager', location_id: LOC }
    expect(await (await switchGET(req(), { params: { id: LOC } })).json()).toMatchObject({ on: false, canSet: false })
    const res = await switchPOST(req({ on: true }), { params: { id: LOC } })
    expect(res.status).toBe(403)
    expect(h.db.writes).toEqual([])
    who.user = { id: 'u-other', role: 'owner', location_id: LOC_B }
    expect((await switchGET(req(), { params: { id: LOC } })).status).toBe(403)
    expect((await switchPOST(req({ on: true }), { params: { id: LOC } })).status).toBe(403)
    expect(locRow().slack_auto_channels_at).toBeNull()
  })

  it('a body that is not a plain on/off is refused, never read as "on"', async () => {
    for (const body of [{}, { on: 'true' }, { on: 1 }, { enabled: true }, null]) {
      expect((await switchPOST(req(body), { params: { id: LOC } })).status, JSON.stringify(body)).toBe(400)
    }
    expect((await switchPOST(req({ on: true }), { params: { id: 'not-a-uuid' } })).status).toBe(400)
    expect(h.db.writes).toEqual([])
  })

  it('the route never sends the Slack token', async () => {
    const text = await (await switchPOST(req({ on: true }), { params: { id: LOC } })).text()
    expect(text).not.toContain(TOKEN); expect(text).not.toMatch(/xoxb|token|scopes/i)
  })
})

describe('OFF BY DEFAULT, and before the migration has run', () => {
  it('every location starts off: a new job makes nothing and the log line is what it always was', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    const r = await jobCreate('501')
    expect(r).toEqual({ processed: true, lead_id: 'lead-7001', lead_stage: 'Job in Progress', prev_stage: 'Job in Progress' })
    expect(slack.calls.filter(c => c.method !== 'users.lookupByEmail')).toEqual([])
    expect(claims()).toBe(0)
    expect(await readAutoSwitch(db, LOC)).toEqual({ setUp: true, onSince: null, cappedAt: null })
  })

  it('columns not there yet: the switch reads "not set up", the route refuses to save, and a new job makes nothing', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    // Only the switch's own read names the new columns; fail just that one,
    // exactly as Postgres would.
    const realFrom = h.from
    const spy = vi.spyOn(supabaseService as any, 'from').mockImplementation((t: any) => {
      const b = realFrom(t)
      const sel = b.select
      b.select = (c?: string) => { if (t === 'locations' && /slack_auto_channels/.test(c || '')) { return { eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'column locations.slack_auto_channels_at does not exist' } }) }) } } return sel(c) }
      return b
    })
    expect(await readAutoSwitch(db, LOC)).toEqual({ setUp: false })
    expect(await setAutoSwitch(db, LOC, true)).toEqual({ ok: false, reason: 'not_set_up_yet' })
    expect(await (await switchGET(req(), { params: { id: LOC } })).json()).toEqual({ setUp: false })
    expect((await switchPOST(req({ on: true }), { params: { id: LOC } })).status).toBe(409)
    const r = await jobCreate('501')
    expect(r.processed).toBe(true); expect(r.note).toBeUndefined()
    expect(made()).toEqual([])
    spy.mockRestore()
  })

  it('the claim column not there yet (half-run migration): the switch may be on, and still nothing is made', async () => {
    switchOn(); h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    h.db.fail = (table: string, op: string) => (table === 'engagements' && op === 'update' ? { message: 'column "slack_channel_auto_at" of relation "engagements" does not exist' } : null)
    expect(await autoCreateJobChannel(db, { engagementId: engId(1), locationUuid: LOC, jobCreatedAt: AFTER, baseUrl: null })).toEqual({ status: 'not_set_up_yet' })
    expect(made()).toEqual([])
  })

  it('the migration adds exactly the three columns the code names, and nothing is dropped or rewritten', () => {
    const sql = readFileSync('migrations/slack_auto_channels.sql', 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(sql.match(/add column if not exists (\w+)/g)).toEqual(['add column if not exists slack_auto_channels_at', 'add column if not exists slack_auto_channels_capped_at', 'add column if not exists slack_channel_auto_at'])
    expect(sql).not.toMatch(/\b(drop|update|delete|insert|truncate)\b/i)
    const undo = readFileSync('migrations/slack_auto_channels_undo.sql', 'utf8')
    for (const c of ['slack_auto_channels_at', 'slack_auto_channels_capped_at', 'slack_channel_auto_at']) expect(undo).toContain(`drop column if exists ${c}`)
  })
})
