// WHO SLACK WOULD NOT ADD IS KEPT ON THE JOB, AND NOT ASKED ABOUT EVERY 15
// MINUTES (2026-11-13).
//
// What happened: Kevin made a channel at Test Location. The owner there has a
// Bee Hub email nobody in that Slack uses, so the owner was not added. The
// warning existed only in the page that pressed the button; closing the job's
// card lost it. A channel made automatically has no page at all, so there it
// was never seen by anyone. And one bee whose email Slack does not know was
// being put back to Slack every 15 minutes, all evening, for the same answer.
//
// REAL: the Slack mark's route (POST, PATCH), the panel's data route (GET),
// createJobChannel, the JOB_CREATE handler and automatic channels, the crew
// mirror and its sweep, the archive sweep, the paced retry
// (sweepChannelProblems). STAND-INS: sign-in, the database (held to the
// schema snapshot), Jobber, Slack, and the clock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import { createJobChannel, loadEngagementForBees, readLocationSlackFull, sweepJobChannels, sweepChannelProblems, problemDue, PROBLEM_RETRY_MS } from '@/lib/engagement-bees'
import { sweepJobCrews } from '@/lib/jobber-crew-mirror'
import { jobChannelRetriesLine } from '@/lib/cron-log-lines'
import { POST as channelPOST, PATCH as channelPATCH } from '@/app/api/engagements/[id]/slack-channel/route'
import { GET as beesGET } from '@/app/api/engagements/[id]/bees/route'
import { beeSlackNote } from '@/components/hive/shared/BeeSlackStatus'
import { GET as cronGET } from '@/app/api/cron/job-channels/route'
const db = supabaseService as any

// ── the fake Slack workspace ──
type Chan = { name: string; members: Set<string>; archived: boolean }
let slack: { users: Record<string, string>; channels: Map<string, Chan>; calls: { method: string; body: any }[]; down: boolean; seq: number; refuse: Record<string, string> }
const slackFetch = async (url: string, init: any) => {
  const u = new URL(url)
  const method = u.pathname.replace('/api/', '')
  const body = init?.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams)
  slack.calls.push({ method, body })
  const ok = (x: any = {}) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...x }) }) as any
  const no = (error: string) => ({ ok: true, status: 200, json: async () => ({ ok: false, error }) }) as any
  if (slack.down) return no('ratelimited')
  if (slack.refuse[method]) return no(slack.refuse[method])
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
  slack = { users: { 'ana@bee.test': 'U_ANA', 'sam@bee.test': 'U_SAM', 'owner@bee.test': 'U_OWNER' }, channels: new Map(), calls: [], down: false, seq: 0, refuse: {} }
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

const T0 = Date.parse('2026-11-13T02:00:00.000Z')
const MIN = 60_000, HOUR = 60 * MIN
const clock = (ms: number) => vi.setSystemTime(new Date(T0 + ms))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); clock(0)
  seed(); who.user = { id: 'u-owner', role: 'owner', location_id: LOC }
})
afterEach(() => {
  expect(h.db.seedFaults, 'a seeded row names a column the real table does not have').toEqual([])
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

// A deal with a real job in Jobber, and (optionally) people on its visit.
const BEE = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`
const CREW: Record<number, string> = { 1: ANA, 2: SAM, 4: NOR }
const deal = (n: number, bees: number[] = [], over: any = {}) => {
  h.db.tables.engagements.push(eng(n, over))
  h.db.tables.jobs.push({ id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`, location_id: 'loc_test', jobber_job_id: String(8000 + n), engagement_id: engId(n), lead_id: 'lead-7001', status: 'upcoming' })
  h.jobber.jobs[String(8000 + n)] = { visits: [{ id: String(9000 + n), crew: bees.map(b => CREW[b]) }] }
  for (const b of bees) h.db.tables.engagement_bees.push(onJob(n, b))
}
const press = (n: number) => channelPOST(new NextRequest('http://x/api', { method: 'POST' }), { params: { id: engId(n) } })
const gotIt = (n: number) => channelPATCH(new NextRequest('http://x/api', { method: 'PATCH', body: JSON.stringify({ clear_problems: true }), headers: { 'content-type': 'application/json' } }), { params: { id: engId(n) } })
// A FRESH read of the job, as a reload or the next person to open it gets.
const reload = async (n: number) => ((await (await beesGET(new NextRequest('http://x/api'), { params: { id: engId(n) } })).json()).slack.reconcile?.items ?? []) as any[]
const kept = (n: number) => (engRow(n).slack_channel_problems?.items ?? []) as any[]
const noOwnerInSlack = () => { delete slack.users['owner@bee.test'] }
// One turn of the 15-minute cron: the paced retry, then the crew sweep.
const cron = async () => {
  slack.calls = []
  const retries = await sweepChannelProblems(db)
  const crews = await sweepJobCrews(db)
  return { retries, crews, calls: slack.calls.map(c => `${c.method} ${c.body.email || c.body.users || c.body.user || ''}`.trim()) }
}
const ownerLine = (over: any = {}) => expect.objectContaining({ status: 'owner_not_in_slack', bee: 'Olive Owner', email: 'owner@bee.test', user_id: 'u-owner', from: 'created', ...over })
const noraLine = (over: any = {}) => expect.objectContaining({ status: 'not_in_slack', bee: 'Nora Nobody', email: 'nora@elsewhere.test', bee_id: BEE(4), ...over })

describe('AN OWNER WHO CANNOT BE ADDED IS STILL NAMED ON THE JOB AFTER A FULL RELOAD', () => {
  it('the Slack mark: the owner is not in Slack → the line is stored on the job, and a fresh read of the job shows it', async () => {
    noOwnerInSlack(); deal(1, [1])
    const res = await press(1); const j = await res.json()
    expect(res.status).toBe(200)
    expect(members()).toEqual(['UBOT', 'U_ANA'])                 // the channel is made, the owner is not in it
    expect(kept(1)).toEqual([ownerLine()])                       // …and that is written down
    expect(j.reconcile.items).toEqual([ownerLine()])             // the page is handed the STORED line
    // The reload. Nothing from the press is carried over: this is a new request.
    const again = await reload(1)
    expect(again).toEqual([ownerLine()])
    expect(beeSlackNote(again[0])!.text).toBe('Olive Owner, the owner, wasn’t added to the channel: nobody in your Slack uses owner@bee.test, the email they sign in to Bee Hub with. Add them in Slack.')
    // …and it is still there tomorrow, and for someone else.
    clock(26 * HOUR); who.user = { id: 'u-mgr', role: 'manager', location_id: LOC }
    expect(await reload(1)).toEqual([ownerLine()])
  })

  it('an owner Slack found but would not let Bee Hub add is stored too', async () => {
    deal(1); slack.refuse['conversations.invite'] = 'restricted_action'
    await press(1)
    expect(await reload(1)).toEqual([expect.objectContaining({ status: 'owner_not_added', bee: 'Olive Owner', user_id: 'u-owner', from: 'created' })])
  })

  it('a bee Slack does not know, missed when the channel was made, is stored beside the owner — each told apart', async () => {
    noOwnerInSlack(); deal(1, [1, 4])
    await press(1)
    expect(await reload(1)).toEqual([noraLine({ from: 'created' }), ownerLine()])
    expect(kept(1).map(p => [!!p.bee_id, !!p.user_id])).toEqual([[true, false], [false, true]])
  })

  it('when everyone was added, nothing is stored and nothing is shown', async () => {
    deal(1, [1, 2])
    h.db.writes = []
    await press(1)
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_OWNER', 'U_SAM'])
    expect(engRow(1).slack_channel_problems).toBeNull()
    expect(await reload(1)).toEqual([])
    expect(h.db.writes).toEqual(['update engagements'])          // the channel itself, and nothing else
  })

  it('a second press does not lose the line, and makes no second channel', async () => {
    noOwnerInSlack(); deal(1)
    await press(1)
    const j = await (await press(1)).json()
    expect(j.already).toBe(true)
    expect(j.reconcile.items).toEqual([ownerLine()])
    expect(made()).toHaveLength(1)
  })

  it('Got it hides the line from the page and keeps it on the job', async () => {
    noOwnerInSlack(); deal(1)
    await press(1)
    expect((await gotIt(1)).status).toBe(200)
    expect(await reload(1)).toEqual([])
    expect(kept(1)).toEqual([ownerLine({ seen_at: expect.any(String) })])
  })
})

describe('THE AUTOMATIC PATH RECORDS THE SAME THING, WITH NO PAGE INVOLVED', () => {
  const newJob = (n: number, crew: string[] = []) => { h.db.tables.engagements.push(eng(n)); jobInJobber(String(500 + n), n); h.jobber.jobs[String(500 + n)] = { visits: [{ id: String(9500 + n), crew }] } }

  it('a job arrives from Jobber, the channel is made, the owner is not in Slack → the line is on the job for whoever opens it', async () => {
    noOwnerInSlack(); newJob(2, [ANA])
    const r: any = await fire('JOB_CREATE', 'Job', '502')
    expect(String(r.note)).toContain('auto channel made, 1 not added')
    expect(made()).toHaveLength(1)
    expect(kept(2)).toEqual([ownerLine()])
    expect(await reload(2)).toEqual([ownerLine()])               // the first time ANYONE looks
  })

  it('…and a bee Slack does not know, arriving with the job, is on the job too', async () => {
    newJob(2, [ANA, NOR])
    await fire('JOB_CREATE', 'Job', '502')
    expect((await reload(2)).map(p => [p.status, p.bee])).toEqual([['not_in_slack', 'Nora Nobody']])
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_OWNER'])
  })

  it('the crew changing afterwards does not wipe the owner’s line', async () => {
    noOwnerInSlack(); newJob(2, [ANA])
    await fire('JOB_CREATE', 'Job', '502')
    h.jobber.jobs['502'] = { visits: [{ id: '9502', crew: [ANA, SAM] }] }
    await fire('VISIT_UPDATE', 'Visit', '9502')
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_SAM'])
    expect(kept(2)).toEqual([ownerLine()])
    h.jobber.jobs['502'] = { visits: [{ id: '9502', crew: [ANA, SAM, NOR] }] }
    await fire('VISIT_UPDATE', 'Visit', '9502')
    expect(kept(2)).toEqual([ownerLine(), noraLine({ from: 'crew' })])
  })
})

describe('A user_not_found INVITE IS NOT RETRIED EVERY 15 MINUTES', () => {
  it('a bee Slack does not know: eight turns of the cron, two hours, and Slack is not asked about them once', async () => {
    deal(1, [1, 4]); await press(1)
    expect(kept(1)).toEqual([noraLine()])
    const asked: string[] = []
    for (let i = 1; i <= 8; i++) {
      clock(i * 15 * MIN)
      const turn = await cron()
      asked.push(...turn.calls)
      expect(turn.retries).toMatchObject({ ok: true, jobs: 1, tried: 0, fixed: 0, waiting: 1 })
    }
    expect(asked).toEqual([])                                    // not a lookup, not an invite
    expect(kept(1)).toEqual([noraLine()])                        // still said on the job
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_OWNER'])
  })

  it('…then once, a day later; and if Slack still does not know them, not again until the day after', async () => {
    deal(1, [1, 4]); await press(1)
    clock(PROBLEM_RETRY_MS - MIN); expect((await cron()).calls).toEqual([])
    clock(PROBLEM_RETRY_MS + MIN)
    const day1 = await cron()
    expect(day1.calls).toEqual(['users.lookupByEmail nora@elsewhere.test'])
    expect(day1.retries).toMatchObject({ tried: 1, fixed: 0 })
    expect(kept(1)).toEqual([noraLine({ from: 'created', since: new Date(T0).toISOString() })])
    for (const h2 of [1, 6, 12, 23]) { clock(PROBLEM_RETRY_MS + h2 * HOUR); expect((await cron()).calls).toEqual([]) }
    clock(2 * PROBLEM_RETRY_MS + 2 * MIN)
    expect((await cron()).calls).toEqual(['users.lookupByEmail nora@elsewhere.test'])
  })

  it('the owner Slack does not know is paced the same way', async () => {
    noOwnerInSlack(); deal(1); await press(1)
    for (let i = 1; i <= 8; i++) { clock(i * 15 * MIN); expect((await cron()).calls).toEqual([]) }
    clock(PROBLEM_RETRY_MS + MIN)
    expect((await cron()).calls).toEqual(['users.lookupByEmail owner@bee.test'])
    expect(kept(1)).toEqual([ownerLine()])
  })

  it('a workspace that does not let apps add people (restricted_action) is not asked again every run either', async () => {
    deal(1, [1]); slack.refuse['conversations.invite'] = 'restricted_action'
    await press(1)
    expect(kept(1).map(p => p.status)).toEqual(['add_refused', 'owner_not_added'])
    // The owner's is "not added, reason unknown to the page": tried for its first hour…
    clock(15 * MIN); expect((await cron()).calls).toEqual(['users.lookupByEmail owner@bee.test', 'conversations.invite U_OWNER'])
    // …and after that hour, neither line is put to Slack until tomorrow.
    for (const m of [75, 90, 180, 600]) { clock(m * MIN); expect((await cron()).calls, `${m} min`).toEqual([]) }
  })

  it('Slack simply being down IS tried again on the next run — for an hour, then daily like everything else', async () => {
    deal(1, [1]); slack.down = true
    await press(1).catch(() => null)
    // (the channel could not be made at all with Slack down; make it, then lose Slack for the people)
    slack.down = false; slack.refuse['conversations.invite'] = 'ratelimited'
    await press(1)
    expect(kept(1).map(p => p.status)).toEqual(['unavailable', 'owner_not_added'])
    clock(15 * MIN); expect((await cron()).calls.length).toBeGreaterThan(0)
    clock(30 * MIN); expect((await cron()).calls.length).toBeGreaterThan(0)
    clock(61 * MIN); expect((await cron()).calls).toEqual([])    // an hour of "down" is not a blip any more
    slack.refuse = {}
    clock(PROBLEM_RETRY_MS + 45 * MIN)
    const r = await cron()
    expect(r.retries.fixed).toBe(2)
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_OWNER'])
    expect(engRow(1).slack_channel_problems).toBeNull()
  })

  it('THE REAL CRON ROUTE runs the paced retry on every turn, writes its line, and asks Slack nothing while nothing is due', async () => {
    deal(1, [1, 4]); await press(1)
    vi.stubEnv('CRON_SECRET', 's3cret')
    const turn = async () => { slack.calls = []; const res = await cronGET(new NextRequest('http://x/api/cron/job-channels?secret=s3cret')); return { status: res.status, j: await res.json(), asked: slack.calls.map(c => c.method) } }
    clock(15 * MIN)
    const quiet = await turn()
    expect(quiet.status).toBe(200)
    expect(quiet.j.retries).toEqual({ ok: true, jobs: 1, tried: 0, fixed: 0, waiting: 1 })
    expect(quiet.asked).toEqual([])
    expect((console.log as any).mock.calls.map((c: any[]) => c[0])).toContain('[cron job-channels] not-added lines on 1 job: tried again 0, now fixed 0, not due yet 1')
    slack.users['nora@elsewhere.test'] = 'U_NORA'
    clock(PROBLEM_RETRY_MS + MIN)
    const due = await turn()
    expect(due.j.retries).toEqual({ ok: true, jobs: 1, tried: 1, fixed: 1, waiting: 0 })
    expect(members()).toContain('U_NORA')
    vi.unstubAllEnvs()
  })

  it('the line the cron writes says how many were left alone', () => {
    expect(jobChannelRetriesLine({ ok: true, jobs: 1, tried: 0, fixed: 0, waiting: 1 })).toBe('[cron job-channels] not-added lines on 1 job: tried again 0, now fixed 0, not due yet 1')
    expect(jobChannelRetriesLine({ ok: false, jobs: 3, tried: 2, fixed: 1, waiting: 4 })).toBe('[cron job-channels] not-added lines on 3 jobs: tried again 2, now fixed 1, not due yet 4, failed')
  })

  it('a job that is closed, archived or at a location that has not reconnected is not asked about at all', async () => {
    deal(1, [1, 4]); await press(1)
    engRow(1).closed_at = new Date(T0).toISOString()
    clock(2 * PROBLEM_RETRY_MS); slack.calls = []
    expect(await sweepChannelProblems(db)).toMatchObject({ jobs: 0, tried: 0 })
    engRow(1).closed_at = null; engRow(1).slack_channel_archived_at = new Date(T0).toISOString()
    expect(await sweepChannelProblems(db)).toMatchObject({ jobs: 0, tried: 0 })
    engRow(1).slack_channel_archived_at = null; h.db.tables.locations[0].slack_scopes = 'chat:write,incoming-webhook'
    expect(await sweepChannelProblems(db)).toMatchObject({ jobs: 1, tried: 0, waiting: 1 })
    expect(slack.calls).toEqual([])
  })

  it('problemDue, case by case', () => {
    const t = (ms: number) => new Date(T0 + ms).toISOString()
    const nora = { status: 'not_in_slack', bee: 'N', email: 'n@x.test', bee_id: 'b', since: t(0), tried_at: t(0) } as any
    expect(problemDue(nora, T0 + 15 * MIN, { email: 'n@x.test', slackUserId: null })).toBe(false)
    expect(problemDue(nora, T0 + PROBLEM_RETRY_MS - 1, { email: 'N@X.test ' })).toBe(false)     // same email, different capitals
    expect(problemDue(nora, T0 + PROBLEM_RETRY_MS, { email: 'n@x.test' })).toBe(true)
    expect(problemDue(nora, T0 + MIN, { email: 'n@right.test' })).toBe(true)                    // email corrected
    expect(problemDue(nora, T0 + MIN, { email: 'n@x.test', slackUserId: 'U1', slackCheckedAt: t(30_000) })).toBe(true)  // found since
    expect(problemDue(nora, T0 + MIN, { email: 'n@x.test', slackUserId: 'U1', slackCheckedAt: t(-30_000) })).toBe(false) // an id from BEFORE the refusal proves nothing
    expect(problemDue({ ...nora, tried_at: undefined }, T0 + MIN)).toBe(true)                    // stored before pacing existed: once
    const down = { status: 'unavailable', bee: 'N', action: 'add', bee_id: 'b', since: t(0), tried_at: t(50 * MIN) } as any
    expect(problemDue(down, T0 + 59 * MIN)).toBe(true)
    expect(problemDue(down, T0 + 61 * MIN)).toBe(false)
    for (const status of ['add_refused', 'still_in_channel', 'owner_not_in_slack']) expect(problemDue({ ...nora, status } as any, T0 + 30 * MIN, { email: 'n@x.test' }), status).toBe(false)
  })
})

describe('A CORRECTED EMAIL OR A NEWLY ADDED SLACK ACCOUNT IS STILL PICKED UP', () => {
  const noraBee = () => h.db.tables.location_bees.find((b: any) => b.id === BEE(4))
  const owner = () => h.db.tables.hub_users[0]

  it('a bee’s email is corrected in Bee Hub → the next run adds them and the line goes', async () => {
    deal(1, [1, 4]); await press(1)
    slack.users['nora@right.test'] = 'U_NORA'
    clock(15 * MIN); expect((await cron()).calls).toEqual([])    // nothing has changed yet
    noraBee().email = 'nora@right.test'                          // Settings › Team and Seats
    clock(30 * MIN)
    const turn = await cron()
    expect(turn.calls).toEqual(['users.lookupByEmail nora@right.test', 'conversations.invite U_NORA'])
    expect(turn.retries).toMatchObject({ tried: 1, fixed: 1, waiting: 0 })
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_NORA', 'U_OWNER'])
    expect(engRow(1).slack_channel_problems).toBeNull()
    expect(await reload(1)).toEqual([])
  })

  it('two bees Slack does not know, ONE is fixed: that one is added, the other keeps its line and is not asked about', async () => {
    const PAT = h.gid('User', '5')
    h.db.tables.location_bees.push(bee(5, 'Pat Absent', 'pat@nowhere.test', PAT, null)); h.jobber.people[PAT] = { name: 'Pat Absent', email: 'pat@nowhere.test' }; CREW[5] = PAT
    deal(1, [1, 4, 5]); await press(1)
    expect(kept(1).map(p => p.bee)).toEqual(['Nora Nobody', 'Pat Absent'])
    slack.users['nora@right.test'] = 'U_NORA'; noraBee().email = 'nora@right.test'
    clock(15 * MIN)
    const turn = await cron()
    expect(turn.calls).toEqual(['users.lookupByEmail nora@right.test', 'conversations.invite U_NORA'])
    expect(turn.retries).toMatchObject({ tried: 1, fixed: 1, waiting: 1 })
    expect(kept(1)).toEqual([expect.objectContaining({ bee: 'Pat Absent', status: 'not_in_slack', bee_id: BEE(5), tried_at: new Date(T0).toISOString() })])
  })

  it('a bee’s email is corrected to one Slack STILL does not know → asked once, and the line now names the new email', async () => {
    deal(1, [1, 4]); await press(1); await gotIt(1)
    noraBee().email = 'nora@also-wrong.test'
    clock(15 * MIN)
    expect((await cron()).calls).toEqual(['users.lookupByEmail nora@also-wrong.test'])
    // a different email is a different line: it shows again even though the old one was hidden
    expect(await reload(1)).toEqual([expect.objectContaining({ status: 'not_in_slack', email: 'nora@also-wrong.test' })])
    clock(30 * MIN); expect((await cron()).calls).toEqual([])
  })

  it('the bee joins Slack with the email Bee Hub already has → Bee Hub cannot see that happen, so the daily try finds them', async () => {
    deal(1, [1, 4]); await press(1)
    slack.users['nora@elsewhere.test'] = 'U_NORA'                // done in Slack; nothing changes in Bee Hub
    clock(6 * HOUR); expect((await cron()).calls).toEqual([])
    clock(PROBLEM_RETRY_MS + MIN)
    expect((await cron()).calls).toEqual(['users.lookupByEmail nora@elsewhere.test', 'conversations.invite U_NORA'])
    expect(members()).toContain('U_NORA')
    expect(engRow(1).slack_channel_problems).toBeNull()
  })

  it('…and at once if Bee Hub learns of it sooner (Settings checked the bee against Slack and found them)', async () => {
    deal(1, [1, 4]); await press(1)
    slack.users['nora@elsewhere.test'] = 'U_NORA'
    clock(20 * MIN); Object.assign(noraBee(), { slack_user_id: 'U_NORA', slack_checked_at: new Date(T0 + 20 * MIN).toISOString() })
    clock(30 * MIN)
    expect((await cron()).calls).toEqual(['conversations.invite U_NORA'])
    expect(members()).toContain('U_NORA')
    expect(engRow(1).slack_channel_problems).toBeNull()
  })

  it('…or at once when the crew changes or the job reopens, which bring the whole channel in line', async () => {
    deal(1, [1, 4]); await press(1)
    slack.users['nora@elsewhere.test'] = 'U_NORA'
    clock(20 * MIN)
    h.jobber.jobs['8001'] = { visits: [{ id: '9001', crew: [ANA, NOR, SAM] }] }
    await cron()
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_NORA', 'U_OWNER', 'U_SAM'])
    expect(engRow(1).slack_channel_problems).toBeNull()
  })

  it('the owner’s email is corrected in Bee Hub → the next run adds them and the line goes', async () => {
    noOwnerInSlack(); deal(1); await press(1)
    slack.users['olive@slack-email.test'] = 'U_OLIVE'
    owner().email = 'olive@slack-email.test'
    clock(15 * MIN)
    const turn = await cron()
    expect(turn.calls).toEqual(['users.lookupByEmail olive@slack-email.test', 'conversations.invite U_OLIVE'])
    expect(members()).toEqual(['UBOT', 'U_OLIVE'])
    expect(engRow(1).slack_channel_problems).toBeNull()
    expect(await reload(1)).toEqual([])
  })

  it('the owner joins Slack with their Bee Hub email → found on the daily try', async () => {
    noOwnerInSlack(); deal(1); await press(1)
    slack.users['owner@bee.test'] = 'U_OWNER'
    clock(3 * HOUR); expect((await cron()).calls).toEqual([])
    clock(PROBLEM_RETRY_MS + MIN); await cron()
    expect(members()).toEqual(['UBOT', 'U_OWNER'])
    expect(engRow(1).slack_channel_problems).toBeNull()
  })

  it('someone added the owner to the channel by hand, under their Bee Hub email → the daily try sees they are in and the line goes', async () => {
    noOwnerInSlack(); deal(1); await press(1)
    slack.users['owner@bee.test'] = 'U_OWNER'; slack.channels.get('CNEW1')!.members.add('U_OWNER')
    clock(PROBLEM_RETRY_MS + MIN); await cron()
    expect(engRow(1).slack_channel_problems).toBeNull()
  })

  it('a fix is picked up even after someone tapped Got it — and a line that is still true stays hidden', async () => {
    noOwnerInSlack(); deal(1, [1, 4]); await press(1); await gotIt(1)
    clock(PROBLEM_RETRY_MS + MIN); await cron()
    expect(kept(1).map(p => [p.status, !!p.seen_at])).toEqual([['owner_not_in_slack', true], ['not_in_slack', true]])
    expect(await reload(1)).toEqual([])                          // still hidden: nothing new to say
    slack.users['owner@bee.test'] = 'U_OWNER'
    clock(2 * PROBLEM_RETRY_MS + 2 * MIN); await cron()
    expect(members()).toContain('U_OWNER')
    expect(kept(1).map(p => p.status)).toEqual(['not_in_slack'])
  })

  it('someone who is no longer the owner has no line: it is not true any more, and Slack is not asked', async () => {
    noOwnerInSlack(); deal(1); await press(1)
    owner().role = 'manager'
    clock(15 * MIN)
    expect((await cron()).calls).toEqual([])
    expect(engRow(1).slack_channel_problems).toBeNull()
  })

  it('the channel was deleted in Slack: the lines go with it, and nothing is asked again', async () => {
    noOwnerInSlack(); deal(1); await press(1)
    slack.users['owner@bee.test'] = 'U_OWNER'; slack.channels.delete('CNEW1')
    clock(PROBLEM_RETRY_MS + MIN); await cron()
    expect(engRow(1)).toMatchObject({ slack_channel_id: null, slack_channel_problems: null })
    clock(2 * PROBLEM_RETRY_MS + 2 * MIN); slack.calls = []
    expect(await sweepChannelProblems(db)).toMatchObject({ jobs: 0 })
    expect(slack.calls).toEqual([])
  })
})

describe('ARCHIVE ON CLOSE: Closed Won and Closed Lost both archive; reopening unarchives', () => {
  const closeAs = (n: number, stage: string) => Object.assign(engRow(n), { stage, closed_at: new Date(Date.now()).toISOString(), closed_reason: stage === 'Closed Lost' ? 'Went with someone else' : null })
  const reopenTo = (n: number) => Object.assign(engRow(n), { stage: 'Job in Progress', closed_at: null, closed_reason: null })
  const chan = (id = 'CNEW1') => slack.channels.get(id)!

  for (const stage of ['Closed Won', 'Closed Lost']) {
    it(`${stage}: the next sweep archives the channel, once, and touches nothing else`, async () => {
      deal(1, [1, 2]); await press(1)
      const before = members()
      closeAs(1, stage); clock(15 * MIN); slack.calls = []
      const r = await sweepJobChannels(db)
      expect(r).toMatchObject({ ok: true, archived: 1, unarchived: 0, failed: 0 })
      expect(slack.calls.map(c => [c.method, c.body.channel])).toEqual([['conversations.archive', 'CNEW1']])
      expect(chan().archived).toBe(true)
      expect(engRow(1).slack_channel_archived_at).toBeTruthy()
      expect(members()).toEqual(before)                          // nobody is removed by Bee Hub
      // Safe to run again: a stamped job no longer matches.
      slack.calls = []
      expect(await sweepJobChannels(db)).toMatchObject({ archived: 0, unarchived: 0 })
      expect(slack.calls).toEqual([])
      // The panel says so.
      const j = await (await beesGET(new NextRequest('http://x/api'), { params: { id: engId(1) } })).json()
      expect(j.slack).toMatchObject({ closed: true, channel: { name: 'test-failsafe-moving-relocation', archived: true } })
    })

    it(`${stage}, then reopened: the next sweep unarchives it and brings the people back in line`, async () => {
      deal(1, [1, 2]); await press(1)
      closeAs(1, stage); await sweepJobChannels(db)
      // while it was closed, Sam was taken off the job
      h.db.tables.engagement_bees.find((r: any) => r.bee_id === BEE(2)).removed_at = new Date(T0).toISOString()
      reopenTo(1); clock(30 * MIN); slack.calls = []
      const r = await sweepJobChannels(db)
      expect(r).toMatchObject({ ok: true, archived: 0, unarchived: 1, failed: 0 })
      expect(slack.calls[0]).toEqual({ method: 'conversations.unarchive', body: { channel: 'CNEW1' } })
      expect(chan().archived).toBe(false)
      expect(engRow(1).slack_channel_archived_at).toBeNull()
      expect(members()).toEqual(['UBOT', 'U_ANA', 'U_OWNER'])     // Sam out, the owner never removed
    })
  }

  it('it goes by the job being CLOSED (closed_at), not by a stage name: Final Processing keeps its channel open', async () => {
    deal(1, [1]); await press(1)
    engRow(1).stage = 'Final Processing'
    slack.calls = []
    expect(await sweepJobChannels(db)).toMatchObject({ archived: 0 })
    expect(slack.calls).toEqual([])
    expect(chan().archived).toBe(false)
    // …and a stage that SAYS closed with no closed_at is not archived either.
    engRow(1).stage = 'Closed Won'
    expect(await sweepJobChannels(db)).toMatchObject({ archived: 0 })
  })

  it('THE PINNED CARD: archiving and unarchiving never post, pin, unpin or delete anything — one card, made once', async () => {
    deal(1, [1]); await press(1)
    const cards = () => slack.calls.filter(c => c.method === 'chat.postMessage' || c.method.startsWith('pins.') || c.method === 'chat.delete' || c.method === 'chat.update')
    expect(cards().map(c => c.method)).toEqual(['chat.postMessage', 'pins.add'])
    slack.calls = []
    closeAs(1, 'Closed Won'); await sweepJobChannels(db)
    reopenTo(1); await sweepJobChannels(db)
    closeAs(1, 'Closed Lost'); await sweepJobChannels(db)
    reopenTo(1); await sweepJobChannels(db)
    expect(slack.calls.map(c => c.method).filter(m => m.startsWith('conversations.archive') || m.startsWith('conversations.unarchive'))).toEqual(['conversations.archive', 'conversations.unarchive', 'conversations.archive', 'conversations.unarchive'])
    expect(cards()).toEqual([])                                  // Bee Hub never touches the card again
    expect(made()).toEqual([])                                   // and never makes a second channel
  })

  it('a line stored before the close is still on the job after a reopen, and the reopen’s own misses say where they came from', async () => {
    noOwnerInSlack(); deal(1, [1, 4]); await press(1)
    closeAs(1, 'Closed Won'); await sweepJobChannels(db)
    reopenTo(1); await sweepJobChannels(db)
    expect(kept(1)).toEqual([ownerLine(), noraLine({ from: 'created' })])
  })

  it('IF SLACK REFUSES THE UNARCHIVE (its documentation says a bot token cannot unarchive): the job stays marked archived, nobody is invited, and it is counted as a failure', async () => {
    deal(1, [1]); await press(1)
    closeAs(1, 'Closed Won'); await sweepJobChannels(db)
    const stamp = engRow(1).slack_channel_archived_at
    reopenTo(1); slack.refuse['conversations.unarchive'] = 'not_allowed_token_type'; slack.calls = []
    const r = await sweepJobChannels(db)
    expect(r).toMatchObject({ ok: false, unarchived: 0, failed: 1 })
    expect(slack.calls.map(c => c.method)).toEqual(['conversations.unarchive'])
    expect(engRow(1).slack_channel_archived_at).toBe(stamp)
    expect(chan().archived).toBe(true)
  })
})
