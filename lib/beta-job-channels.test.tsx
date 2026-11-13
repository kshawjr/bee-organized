// @vitest-environment happy-dom
//
// Slack job channels, slice 3 of 3 — bees on a job, and the job's channel.
// migrations/engagement_bees.sql · migrations/engagement_slack_channel.sql ·
// lib/engagement-bees.ts · lib/slack-channel-name.ts ·
// app/api/engagements/[id]/bees · app/api/engagements/[id]/slack-channel ·
// app/api/cron/job-channels · components/hive/BeesOnJob.jsx ·
// components/hive/shared/BeeSlackStatus.jsx
//
// The database is in memory and enforces engagement_bees' unique index
// (engagement_id, bee_id) with Postgres' 23505. Slack is a fake workspace
// with real membership, real archived state and real name collisions, so
// "invited", "kicked" and "archived" are checked against what Slack would
// now hold, not against a mock's say-so.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const TOKEN = 'xoxb-SECRET-TOKEN-0987654321'
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOC2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ENG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ENG2 = 'eeeeeeee-eeee-4eee-8eee-000000000002'
const ENG_NOCHAN = 'eeeeeeee-eeee-4eee-8eee-000000000003'
const SCOPES_NEW = 'chat:write,channels:read,channels:manage,users:read,users:read.email'
const SCOPES_OLD = 'chat:write,channels:read,users:read,users:read.email'

const h = vi.hoisted(() => {
  // THIS STAND-IN HOLDS THE CODE TO THE REAL SCHEMA (lib/db-columns-check).
  // It used to hand back whatever rows a test seeded and ignore the column
  // list it was asked for — so when the code selected engagements.client_name
  // (no such column) and the seed happened to give engagements a client_name,
  // 117 tests passed and production failed every read. Now, like Postgres:
  //   · a select, filter, insert or update naming a column the real table
  //     does not have → the real "column x.y does not exist" error;
  //   · a SEEDED row carrying a made-up key is recorded in db.seedFaults,
  //     and afterEach fails the test — a test may not invent the schema.
  const db: any = { tables: {} as Record<string, any[]>, seq: 0, noChannelCols: false, noBeesTable: false, failLeads: false, touched: new Set<string>(), seedFaults: [] as string[] }
  const state: any = { hubUser: null as any }
  const match = (r: any, f: any[]) => {
    const [m, col, val] = f
    if (m === 'eq') return r[col] === val
    if (m === 'is') return val === null ? r[col] == null : r[col] === val
    if (m === 'not') return r[col] != null
    return true
  }
  const makeBuilder = (table: string) => {
    db.touched.add(table)
    const ctx: any = { op: 'select', filters: [] as any[], payload: null, cols: '' }
    const b: any = {}
    b.select = (c?: string) => { if (ctx.op === 'select') ctx.cols = c || '*'; return b }
    b.order = () => b
    b.limit = () => b
    b.eq = (c: string, v: any) => { ctx.filters.push(['eq', c, v]); return b }
    b.is = (c: string, v: any) => { ctx.filters.push(['is', c, v]); return b }
    b.not = (c: string) => { ctx.filters.push(['not', c]); return b }
    b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
    b.update = (p: any) => { ctx.op = 'update'; ctx.payload = p; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    const run = () => {
      if (db.noBeesTable && (table === 'engagement_bees' || table === 'location_bees')) {
        return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
      }
      if (db.noChannelCols && table === 'engagements') {
        const keys = ctx.op === 'update' ? Object.keys(ctx.payload).join(',') : ctx.cols + ctx.filters.map((f: any) => f[1]).join(',')
        if (/slack_channel/.test(keys)) return { data: null, error: { code: '42703', message: 'column engagements.slack_channel_id does not exist' } }
      }
      const rows = (db.tables[table] ||= [])
      // ── the real schema ──
      for (const r of rows) for (const k of unknownKeys(table, r)) {
        const fault = `${table}.${k}`
        if (!db.seedFaults.includes(fault)) db.seedFaults.push(fault)
      }
      const wrong = [
        ...(ctx.op === 'select' || ctx.cols ? unknownColumns(table, ctx.cols || '*').map((p: any) => [p.table, p.column]) : []),
        ...ctx.filters.map((x: any) => [table, x[1]]).filter(([t, c]: any) => unknownKeys(t, { [c]: 1 }).length),
        ...(ctx.payload ? unknownKeys(table, ctx.payload).map((k: string) => [table, k]) : []),
      ][0]
      if (wrong) return { data: null, error: missingColumnError(wrong[0], wrong[1]) }
      if (db.failLeads && table === 'leads') return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      if (ctx.op === 'insert') {
        const now = new Date().toISOString()
        const row = { id: `iiiiiiii-iiii-4iii-8iii-${String(++db.seq).padStart(12, '0')}`, assigned_at: now, removed_at: null, created_at: now, updated_at: now, ...ctx.payload }
        if (table === 'engagement_bees' && rows.some((x: any) => x.engagement_id === row.engagement_id && x.bee_id === row.bee_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "engagement_bees_uniq"' } }
        }
        rows.push(row)
        return { data: { ...row }, error: null }
      }
      const hits = rows.filter((r: any) => ctx.filters.every((f: any) => match(r, f)))
      if (ctx.op === 'delete') { db.tables[table] = rows.filter((r: any) => !hits.includes(r)); return { data: null, error: null } }
      if (ctx.op === 'update') { hits.forEach((r: any) => Object.assign(r, ctx.payload)); return { data: hits.map((r: any) => ({ ...r })), error: null } }
      return { data: hits.map((r: any) => ({ ...r })), error: null }
    }
    const one = () => { const r: any = run(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }) }
    b.single = one
    b.maybeSingle = one
    b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return b
  }
  return { db, state, makeBuilder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => {}),
  getHubUser: vi.fn(async () => h.state.hubUser),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))
vi.mock('@/lib/read-only-access', () => ({
  readOnlyWriteBlock: vi.fn(async (u: any) => (u.role === 'lite_user' ? new Response(JSON.stringify({ error: 'forbidden_read_only_role' }), { status: 403 }) : null)),
}))

import { GET as beesGET, POST as beesPOST, DELETE as beesDELETE } from '@/app/api/engagements/[id]/bees/route'
import { POST as channelPOST, PATCH as channelPATCH } from '@/app/api/engagements/[id]/slack-channel/route'
import { GET as cronGET } from '@/app/api/cron/job-channels/route'
import { slackJobChannelName, isValidSlackChannelName, SLACK_CHANNEL_MAX } from '@/lib/slack-channel-name'
import { sweepJobChannels, reconcileChannelBees } from '@/lib/engagement-bees'
import { supabaseService } from '@/lib/supabase-service'
import { beeSlackNote } from '@/components/hive/shared/BeeSlackStatus'
import { unknownColumns, unknownKeys, missingColumnError } from '@/lib/db-columns-check'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── the fake Slack workspace ────────────────────────────────
type Chan = { id: string; name: string; members: Set<string>; archived: boolean }
let slack: {
  users: Record<string, string>      // email → id, in the CURRENT workspace
  validIds: Set<string>
  channels: Map<string, Chan>
  taken: Set<string>
  restrictKick: boolean
  missingScope: boolean
  calls: { method: string; body: any }[]
  seq: number
}
const realFetch = globalThis.fetch
const slackFetch = vi.fn(async (url: string, init: any) => {
  expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  const u = new URL(url)
  const method = u.pathname.replace('/api/', '')
  const body = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams)
  slack.calls.push({ method, body })
  const ok = (x: any = {}) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...x }) }) as any
  const no = (error: string, extra: any = {}) => ({ ok: true, status: 200, json: async () => ({ ok: false, error, ...extra }) }) as any
  if (method === 'users.lookupByEmail') {
    const id = slack.users[String(body.email).toLowerCase()]
    return id ? ok({ user: { id } }) : no('users_not_found')
  }
  if (slack.missingScope && method.startsWith('conversations.')) return no('missing_scope', { needed: 'channels:manage', provided: 'chat:write,channels:read' })
  if (method === 'conversations.create') {
    if (slack.taken.has(body.name)) return no('name_taken')
    if (!isValidSlackChannelName(body.name)) return no('invalid_name_specials')
    const id = `C${++slack.seq}`
    slack.channels.set(id, { id, name: body.name, members: new Set(['UBOT']), archived: false })
    slack.taken.add(body.name)
    return ok({ channel: { id, name: body.name } })
  }
  if (method === 'chat.postMessage') return ok({ ts: `1700000000.${String(slack.calls.length).padStart(6, '0')}` })
  if (method === 'pins.add') return ok()
  const ch = slack.channels.get(body.channel)
  if (!ch) return no('channel_not_found')
  if (method === 'conversations.archive') { if (ch.archived) return no('already_archived'); ch.archived = true; ch.members.delete('UBOT'); return ok() }
  if (method === 'conversations.unarchive') { if (!ch.archived) return no('not_archived'); ch.archived = false; ch.members.add('UBOT'); return ok() }
  if (ch.archived) return no('is_archived')
  if (method === 'conversations.invite') {
    const uid = body.users
    if (!slack.validIds.has(uid)) return no('user_not_found')
    if (ch.members.has(uid)) return no('already_in_channel')
    ch.members.add(uid); return ok()
  }
  if (method === 'conversations.kick') {
    const uid = body.user
    if (!slack.validIds.has(uid)) return no('user_not_found')
    if (slack.restrictKick) return no('restricted_action')
    if (!ch.members.has(uid)) return no('not_in_channel')
    ch.members.delete(uid); return ok()
  }
  return no('unknown_method')
})

// ── seed ────────────────────────────────────────────────────
const bee = (id: string, loc: string, name: string, email: string, slack_user_id: string | null = null, extra: any = {}) => ({
  id, location_uuid: loc, name, email, jobber_user_id: null, slack_user_id, slack_checked_at: slack_user_id ? '2026-11-01T00:00:00Z' : null,
  is_active: true, removed_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...extra,
})
const B_SAM = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'
const B_ANA = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'
const B_NOBODY = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003'
const B_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000009'
const owner = { id: 'u-owner', role: 'owner', location_id: LOC, email: 'owner@bee.com' }

let logs: string[] = []
beforeEach(() => {
  h.db.noChannelCols = false
  h.db.noBeesTable = false
  h.db.failLeads = false
  h.db.seedFaults = []
  h.db.touched = new Set()
  h.db.seq = 0
  h.db.tables = {
    locations: [
      { id: LOC, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: SCOPES_NEW },
      { id: LOC2, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: SCOPES_OLD },
    ],
    engagements: [
      { id: ENG, location_uuid: LOC, client_id: 'lead-1', project_type: 'Pantry', closed_at: null, slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null },
      { id: ENG2, location_uuid: LOC2, client_id: 'lead-2', project_type: 'Garage', closed_at: null, slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null },
      { id: ENG_NOCHAN, location_uuid: LOC, client_id: 'lead-3', project_type: 'Office', closed_at: '2026-11-02T00:00:00Z', slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null },
    ],
    // An engagement has NO name of its own: client_id points at a lead, and
    // the lead carries the name. (The seed used to put client_name straight
    // on the engagement — a column the real table never had.)
    leads: [
      { id: 'lead-1', name: 'Sarah McAllister' },
      { id: 'lead-2', name: 'Joe Two' },
      { id: 'lead-3', name: 'Closed No Channel' },
      { id: 'lead-9', name: 'Second Job' },
    ],
    location_bees: [
      bee(B_SAM, LOC, 'Sam Bee', 'sam@bee.com', 'U_SAM'),
      bee(B_ANA, LOC, 'Ana Bee', 'ana@bee.com', null),
      bee(B_NOBODY, LOC, 'Nora Nobody', 'nora@elsewhere.com', null, { slack_checked_at: '2026-11-01T00:00:00Z' }),
      bee(B_OTHER, LOC2, 'Otto Other', 'otto@bee.com', 'U_OTTO'),
    ],
    engagement_bees: [],
    // Every deal here HAS a job (a channel is for a job, not a request —
    // lib/beta-job-channel-needs-job.test.ts covers the ones that have none).
    jobs: [ENG, ENG2, ENG_NOCHAN].map((e, i) => ({ id: `job-${i + 1}`, engagement_id: e, jobber_job_id: String(500 + i), status: 'upcoming' })),
    hub_users: [owner, { id: 'u-mgr', role: 'manager', location_id: LOC, email: 'mgr@bee.com' }],
    engagement_assignees: [],
  }
  h.state.hubUser = owner
  slack = {
    users: { 'sam@bee.com': 'U_SAM', 'ana@bee.com': 'U_ANA', 'owner@bee.com': 'U_OWNER', 'otto@bee.com': 'U_OTTO' },
    validIds: new Set(['U_SAM', 'U_ANA', 'U_OWNER', 'U_OTTO']),
    channels: new Map(), taken: new Set(), restrictKick: false, missingScope: false, calls: [], seq: 0,
  }
  slackFetch.mockClear()
  vi.stubGlobal('fetch', slackFetch)
  process.env.CRON_SECRET = 'cron-secret'
  logs = []
  for (const m of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')) })
  }
})
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  // A test may not invent the schema: every seeded row is held to the real one.
  expect(h.db.seedFaults, 'rows seeded with columns the real table does not have').toEqual([])
})

// ── helpers ─────────────────────────────────────────────────
const responses: string[] = []
const call = async (p: Promise<Response>) => { const r = await p; const t = await r.text(); responses.push(t); return { status: r.status, j: JSON.parse(t) } }
const reqJson = (body: any) => ({ json: async () => body, url: 'http://x/' }) as any
const reqUrl = (q: string) => ({ json: async () => ({}), url: `http://x/api?${q}` }) as any
const tick = (eng: string, beeId: string) => call(beesPOST(reqJson({ bee_id: beeId }), { params: { id: eng } }))
const untick = (eng: string, beeId: string) => call(beesDELETE(reqUrl(`bee_id=${beeId}`), { params: { id: eng } }))
const read = (eng: string) => call(beesGET(reqJson({}), { params: { id: eng } }))
const create = (eng: string) => call(channelPOST(reqJson({}), { params: { id: eng } }))
const engRow = (id: string) => h.db.tables.engagements.find((e: any) => e.id === id)
const ebRow = (eng: string, beeId: string) => h.db.tables.engagement_bees.find((r: any) => r.engagement_id === eng && r.bee_id === beeId)
const chanOf = (id: string) => slack.channels.get(engRow(id).slack_channel_id)!

// ═══════════════════════════════════════════════════════════
describe('Part A — which bees are on a job', () => {
  it('ticking puts a bee on the job; GET lists them with the roster', async () => {
    const r = await tick(ENG, B_SAM)
    expect(r.status).toBe(200)
    expect(r.j.bees.map((b: any) => b.id)).toEqual([B_SAM])
    expect(r.j.slack_sync).toBeNull() // no channel yet → silent
    const g = await read(ENG)
    expect(g.j.setUp).toBe(true)
    expect(g.j.bees.map((b: any) => b.name)).toEqual(['Sam Bee'])
    expect(g.j.roster.map((b: any) => b.name)).toEqual(['Ana Bee', 'Nora Nobody', 'Sam Bee'])
  })

  it('unassigning never deletes the row — it stamps removed_at; reassigning clears it on the SAME row', async () => {
    await tick(ENG, B_SAM)
    const id = ebRow(ENG, B_SAM).id
    const r = await untick(ENG, B_SAM)
    expect(r.j.bees).toEqual([])
    expect(h.db.tables.engagement_bees).toHaveLength(1)
    expect(ebRow(ENG, B_SAM).removed_at).toBeTruthy()
    await tick(ENG, B_SAM)
    expect(h.db.tables.engagement_bees).toHaveLength(1)
    expect(ebRow(ENG, B_SAM)).toMatchObject({ id, removed_at: null })
  })

  it('the route has no delete at all on engagement_bees', () => {
    const src = readFileSync('lib/engagement-bees.ts', 'utf8') + readFileSync('app/api/engagements/[id]/bees/route.ts', 'utf8')
    expect(src).not.toMatch(/\.delete\(\)/)
  })

  it('a bee from another location cannot be assigned, even by a direct API call, even by an admin', async () => {
    const r = await tick(ENG, B_OTHER)
    expect(r.status).toBe(400)
    expect(r.j.error).toBe('bee_wrong_location')
    h.state.hubUser = { id: 'kev', role: 'super_admin', location_id: null }
    expect((await tick(ENG, B_OTHER)).status).toBe(400)
    expect(h.db.tables.engagement_bees).toHaveLength(0)
  })

  it('someone from another location cannot touch this job at all', async () => {
    h.state.hubUser = { id: 'x', role: 'owner', location_id: LOC2 }
    expect((await tick(ENG, B_SAM)).status).toBe(403)
  })

  it('changing bees never writes engagement_assignees and never calls Jobber', async () => {
    await create(ENG)
    await tick(ENG, B_SAM)
    await untick(ENG, B_SAM)
    expect(h.db.touched.has('engagement_assignees')).toBe(false)
    expect(h.db.tables.engagement_assignees).toEqual([])
    expect(slackFetch.mock.calls.every(([u]) => String(u).startsWith('https://slack.com/api/'))).toBe(true)
    for (const f of ['lib/engagement-bees.ts', 'app/api/engagements/[id]/bees/route.ts', 'app/api/engagements/[id]/slack-channel/route.ts']) {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/engagement_assignees|jobber/i)
    }
  })

  it('a location WITHOUT the scope still assigns bees, and its GET offers no create button', async () => {
    const engBee = bee('bbbbbbbb-bbbb-4bbb-8bbb-000000000010', LOC2, 'Lou', 'lou@bee.com')
    h.db.tables.location_bees.push(engBee)
    h.state.hubUser = { id: 'o2', role: 'owner', location_id: LOC2 }
    expect((await tick(ENG2, engBee.id)).status).toBe(200)
    const g = await read(ENG2)
    expect(g.j.bees.map((b: any) => b.name)).toEqual(['Lou'])
    expect(g.j.slack).toMatchObject({ connected: true, canManageChannels: false, channel: null })
    // …and the create route refuses without touching Slack.
    slack.calls = []
    const c = await create(ENG2)
    expect(c.status).toBe(409)
    expect(c.j.error).toBe('not_ready')
    expect(slack.calls).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════
describe('the channel name', () => {
  it('is client-projecttype, lowercase, hyphens only, no prefix', () => {
    expect(slackJobChannelName('Sarah McAllister', 'Pantry')).toBe('sarah-mcallister-pantry')
    expect(slackJobChannelName("O'Brien & Sons", 'Garage / Shed')).toBe('o-brien-and-sons-garage-shed')
    expect(slackJobChannelName('José Núñez Jr.', 'Kids’ Rooms')).toBe('jose-nunez-jr-kids-rooms')
    expect(slackJobChannelName('Sarah McAllister', null)).toBe('sarah-mcallister')
    expect(slackJobChannelName('!!!', '...')).toBe('job')
  })

  it('a name over 80 characters is trimmed, keeps the project type, and is still valid — even with a retry suffix', () => {
    const long = 'Bartholomew Montgomery-Fitzwilliam Hargreaves-Worthington the Third of Pemberley Estates'
    const n = slackJobChannelName(long, 'Whole Home Move Unpack')
    expect(n.length).toBeLessThanOrEqual(SLACK_CHANNEL_MAX)
    expect(isValidSlackChannelName(n)).toBe(true)
    expect(n.endsWith('-whole-home-move-unpack')).toBe(true)
    const s = slackJobChannelName(long, 'Whole Home Move Unpack', '-12')
    expect(s.length).toBeLessThanOrEqual(SLACK_CHANNEL_MAX)
    expect(isValidSlackChannelName(s)).toBe(true)
    const huge = slackJobChannelName('x'.repeat(200), 'y'.repeat(200), '-99')
    expect(huge.length).toBeLessThanOrEqual(SLACK_CHANNEL_MAX)
    expect(isValidSlackChannelName(huge)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// 2026-11-12, production: "column engagements.client_name does not exist".
// The code asked the engagement for a name it does not have. The Bees cell
// never rendered and the sweep failed every 15 minutes.
describe('against the real schema — the engagement has no name; the lead does', () => {
  it('this stand-in refuses a column the real table does not have, with Postgres’s own words', async () => {
    const r: any = await (supabaseService as any).from('engagements').select('id, client_name').eq('id', ENG).maybeSingle()
    expect(r.data).toBeNull()
    expect(r.error).toEqual({ code: '42703', message: 'column engagements.client_name does not exist' })
    // …for a filter and for a write, too.
    expect((await (supabaseService as any).from('engagements').select('id').eq('client_name', 'x')).error.message).toBe('column engagements.client_name does not exist')
    expect((await (supabaseService as any).from('engagements').update({ client_name: 'x' }).eq('id', ENG)).error.message).toBe('column engagements.client_name does not exist')
    // A real column still reads.
    expect((await (supabaseService as any).from('engagements').select('id, client_id').eq('id', ENG).maybeSingle()).data).toEqual(expect.objectContaining({ id: ENG, client_id: 'lead-1' }))
  })

  it('the Bees cell’s read works: GET answers for a real-shaped engagement (it 404’d on every job in production)', async () => {
    const g = await read(ENG)
    expect(g.status).toBe(200)
    expect(g.j.setUp).toBe(true)
    expect(g.j.roster.map((b: any) => b.name)).toEqual(['Ana Bee', 'Nora Nobody', 'Sam Bee'])
    expect(logs.join('\n')).not.toMatch(/does not exist/)
  })

  it('the sweep reads without error and logs its ordinary line (it failed every 15 minutes in production)', async () => {
    const r = await sweepJobChannels(supabaseService as any)
    expect(r).toMatchObject({ ok: true, archived: 0, unarchived: 0, failed: 0 })
    expect(r.not_set_up_yet).toBeUndefined()
    expect(logs.join('\n')).not.toMatch(/sweep read failed|does not exist/)
    const res = await cronGET({ headers: { get: () => 'Bearer cron-secret' }, nextUrl: { searchParams: { get: () => null } } } as any)
    expect(res.status).toBe(200)
    expect(logs.some(l => l.startsWith('[cron job-channels] archived 0, unarchived 0'))).toBe(true)
  })

  it('the channel is named for the client, and the client’s name is read from the LEAD', async () => {
    h.db.tables.leads[0].name = 'Priya Raman'
    const r = await create(ENG)
    expect(r.status).toBe(200)
    expect(r.j.channel.name).toBe('priya-raman-pantry')
    expect(slack.calls.find(c => c.method === 'chat.postMessage')!.body.text).toContain('*Priya Raman* — Pantry')
    expect(h.db.touched.has('leads')).toBe(true)
  })

  it('a lead with no name still gets a channel, named for the project type', async () => {
    h.db.tables.leads[0].name = null
    const r = await create(ENG)
    expect(r.status).toBe(200)
    expect(r.j.channel.name).toBe('pantry')
    expect(slack.calls.find(c => c.method === 'chat.postMessage')!.body.text).toContain('*this client* — Pantry')
  })

  it('if the client cannot be read, NOTHING is made — no channel named for the project alone, no Slack call, a plain message', async () => {
    h.db.failLeads = true
    slack.calls = []
    const r = await create(ENG)
    expect(r.status).toBe(500)
    expect(r.j).toEqual({ error: 'client_unreadable', message: 'Couldn’t read this job’s client just now — nothing was made. Try again.' })
    expect(slack.calls).toEqual([])
    expect(engRow(ENG).slack_channel_id).toBeNull()
  })

  it('opening a job (the GET) and ticking a bee never read the lead at all — only making a channel needs the name', async () => {
    h.db.touched = new Set()
    await read(ENG); await tick(ENG, B_SAM)
    expect(h.db.touched.has('leads')).toBe(false)
  })
})

describe('Part B — making the channel', () => {
  it('creates a public channel, stores its id and name, invites ticked bees + the owner, posts one opening message', async () => {
    await tick(ENG, B_SAM)
    await tick(ENG, B_ANA)
    const r = await create(ENG)
    expect(r.status).toBe(200)
    expect(r.j.channel.name).toBe('sarah-mcallister-pantry')
    const create1 = slack.calls.find(c => c.method === 'conversations.create')!
    expect(create1.body).toEqual({ name: 'sarah-mcallister-pantry', is_private: false })
    expect(engRow(ENG)).toMatchObject({ slack_channel_id: r.j.channel.id, slack_channel_name: 'sarah-mcallister-pantry' })
    const ch = chanOf(ENG)
    expect(Array.from(ch.members).sort()).toEqual(['UBOT', 'U_ANA', 'U_OWNER', 'U_SAM'])
    const posts = slack.calls.filter(c => c.method === 'chat.postMessage')
    expect(posts).toHaveLength(1)
    expect(posts[0].body.text).toContain('*Sarah McAllister* — Pantry')
    expect(posts[0].body.text).toContain(`/clients/lead-1?e=${ENG}|Open the job in Bee Hub>`)
    expect(r.j.owners).toEqual({ invited: 1, notInSlack: 0 })
  })

  // The dialog says "the location owner is added too". When they are not,
  // the answer says who and why — the commonest reason being that the email
  // they sign in to Bee Hub with is not the one their Slack knows.
  it('an owner whose Bee Hub email is not in Slack is NOT silently skipped: the create names them and that email', async () => {
    delete slack.users['owner@bee.com']
    h.db.tables.hub_users[0] = { ...owner, full_name: 'Olive Owner' }
    const r = await create(ENG)
    expect(r.status).toBe(200)                                  // the channel is still made
    expect(Array.from(chanOf(ENG).members)).not.toContain('U_OWNER')
    expect(r.j.problems).toEqual([{ status: 'owner_not_in_slack', bee: 'Olive Owner', email: 'owner@bee.com' }])
    expect(r.j.owners).toEqual({ invited: 0, notInSlack: 1 })
  })

  it('an owner with no name on file is named by their email; one Slack will not let the app add is reported too; one who was added is not mentioned', async () => {
    delete slack.users['owner@bee.com']
    expect((await create(ENG)).j.problems).toEqual([{ status: 'owner_not_in_slack', bee: 'owner@bee.com', email: 'owner@bee.com' }])
    // A second job, owner now in Slack → nothing to say.
    slack.users['owner@bee.com'] = 'U_OWNER'
    h.db.tables.engagements.push({ id: 'eeeeeeee-eeee-4eee-8eee-0000000000aa', location_uuid: LOC, client_id: 'lead-9', project_type: 'Attic', closed_at: null, slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null })
    h.db.tables.jobs.push({ id: 'job-aa', engagement_id: 'eeeeeeee-eeee-4eee-8eee-0000000000aa', jobber_job_id: '599', status: 'upcoming' })
    expect((await create('eeeeeeee-eeee-4eee-8eee-0000000000aa')).j.problems).toEqual([])
  })

  it('the GET says who can reconnect Slack: the owner and an admin, never a manager or anyone else', async () => {
    const can = async (hubUser: any) => { h.state.hubUser = hubUser; return (await read(ENG)).j.slack.canReconnect }
    expect(await can(owner)).toBe(true)
    expect(await can({ id: 'a1', role: 'super_admin', location_id: null })).toBe(true)
    expect(await can({ id: 'a2', role: 'admin', location_id: null })).toBe(true)
    expect(await can({ id: 'u-mgr', role: 'manager', location_id: LOC })).toBe(false)
    expect(await can({ id: 'u-lite', role: 'lite_user', location_id: LOC })).toBe(false)
  })

  it('a location with no Slack: bees still assign, the GET says not connected, and nothing is sent to Slack', async () => {
    h.db.tables.locations[0] = { id: LOC, slack_connected: false, slack_bot_token: null, slack_scopes: null }
    slack.calls = []
    expect((await tick(ENG, B_SAM)).status).toBe(200)
    const g = await read(ENG)
    expect(g.j.bees.map((b: any) => b.name)).toEqual(['Sam Bee'])
    expect(g.j.slack).toMatchObject({ connected: false, canManageChannels: false, channel: null })
    const c = await create(ENG)
    expect(c.status).toBe(409)
    expect(slack.calls).toEqual([])
  })

  it('name_taken retries with a suffix and succeeds', async () => {
    slack.taken.add('sarah-mcallister-pantry')
    slack.taken.add('sarah-mcallister-pantry-2')
    const r = await create(ENG)
    expect(r.status).toBe(200)
    expect(r.j.channel.name).toBe('sarah-mcallister-pantry-3')
    expect(slack.calls.filter(c => c.method === 'conversations.create').map(c => c.body.name))
      .toEqual(['sarah-mcallister-pantry', 'sarah-mcallister-pantry-2', 'sarah-mcallister-pantry-3'])
  })

  it('a second press returns the same channel and makes no second one', async () => {
    const a = await create(ENG)
    const b = await create(ENG)
    expect(b.j.already).toBe(true)
    expect(b.j.channel.id).toBe(a.j.channel.id)
    expect(slack.channels.size).toBe(1)
  })

  it('a bee whose email matches nobody in Slack is still assigned, and the create reports them', async () => {
    await tick(ENG, B_NOBODY)
    const r = await create(ENG)
    expect(r.j.bees.map((b: any) => b.id)).toEqual([B_NOBODY])
    expect(r.j.problems).toEqual([{ status: 'not_in_slack', bee: 'Nora Nobody', email: 'nora@elsewhere.com' }])
  })
})

// ═══════════════════════════════════════════════════════════
describe('mirroring membership, live', () => {
  beforeEach(async () => { await create(ENG) })

  it('ticking invites, unticking removes', async () => {
    await tick(ENG, B_SAM)
    expect(chanOf(ENG).members.has('U_SAM')).toBe(true)
    const r = await untick(ENG, B_SAM)
    expect(r.j.slack_sync).toBeNull()
    expect(chanOf(ENG).members.has('U_SAM')).toBe(false)
  })

  it('a bee never checked is looked up by email at tick time and their id stored', async () => {
    await tick(ENG, B_ANA)
    expect(chanOf(ENG).members.has('U_ANA')).toBe(true)
    expect(h.db.tables.location_bees.find((b: any) => b.id === B_ANA).slack_user_id).toBe('U_ANA')
  })

  it('restricted_action: the bee is OFF the job in Bee Hub, and the answer says they are STILL in the channel', async () => {
    await tick(ENG, B_SAM)
    slack.restrictKick = true
    const r = await untick(ENG, B_SAM)
    expect(r.status).toBe(200)
    expect(r.j.bees).toEqual([])
    expect(ebRow(ENG, B_SAM).removed_at).toBeTruthy()
    expect(r.j.slack_sync).toEqual({ status: 'still_in_channel', bee: 'Sam Bee', channel: 'sarah-mcallister-pantry' })
    expect(chanOf(ENG).members.has('U_SAM')).toBe(true)
    expect(beeSlackNote(r.j.slack_sync)!.text).toMatch(/Sam Bee is off this job in Bee Hub, but is STILL IN #sarah-mcallister-pantry/)
  })

  it('missing_scope flips the location to not-ready', async () => {
    slack.missingScope = true
    const r = await tick(ENG, B_SAM)
    expect(r.status).toBe(200)
    expect(r.j.bees.map((b: any) => b.id)).toEqual([B_SAM]) // the assignment is the truth
    expect(r.j.slack_sync).toEqual({ status: 'scope_lost' })
    expect(h.db.tables.locations.find((l: any) => l.id === LOC).slack_scopes).not.toContain('channels:manage')
    expect((await read(ENG)).j.slack.canManageChannels).toBe(false)
  })

  it('a cached Slack id from a DIFFERENT workspace is looked up again by email, stored, and the invite retried once', async () => {
    // The location reconnected to another workspace: Sam's old id is dead, Sam is U_SAM_NEW here.
    slack.users['sam@bee.com'] = 'U_SAM_NEW'
    slack.validIds = new Set(['U_SAM_NEW', 'U_ANA', 'U_OWNER'])
    const r = await tick(ENG, B_SAM)
    expect(r.j.slack_sync).toBeNull()
    expect(chanOf(ENG).members.has('U_SAM_NEW')).toBe(true)
    expect(h.db.tables.location_bees.find((b: any) => b.id === B_SAM).slack_user_id).toBe('U_SAM_NEW')
    const invites = slack.calls.filter(c => c.method === 'conversations.invite' && /U_SAM/.test(c.body.users))
    expect(invites.map(c => c.body.users)).toEqual(['U_SAM', 'U_SAM_NEW'])
  })

  it('user_not_found for a bee nobody in Slack has: assigned, and pointed at their email', async () => {
    const r = await tick(ENG, B_NOBODY)
    expect(r.j.bees.map((b: any) => b.id)).toEqual([B_NOBODY])
    expect(r.j.slack_sync).toEqual({ status: 'not_in_slack', bee: 'Nora Nobody', email: 'nora@elsewhere.com' })
  })

  it('already_in_channel and not_in_channel succeed quietly', async () => {
    chanOf(ENG).members.add('U_SAM')
    expect((await tick(ENG, B_SAM)).j.slack_sync).toBeNull()
    chanOf(ENG).members.delete('U_SAM')
    expect((await untick(ENG, B_SAM)).j.slack_sync).toBeNull()
  })

  it('channel_not_found clears the stored channel and offers a new one', async () => {
    slack.channels.clear()
    const r = await tick(ENG, B_SAM)
    expect(r.j.slack_sync).toEqual({ status: 'channel_gone' })
    expect(engRow(ENG).slack_channel_id).toBeNull()
    expect((await read(ENG)).j.slack.channel).toBeNull()
    expect((await create(ENG)).status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════
describe('the sweep', () => {
  it('archives a closed job’s channel and unarchives a reopened one; safe to run twice', async () => {
    await create(ENG)
    engRow(ENG).closed_at = '2026-11-04T10:00:00Z'
    let r = await sweepJobChannels(supabaseService as any)
    expect(r).toMatchObject({ archived: 1, unarchived: 0, failed: 0 })
    expect(chanOf(ENG).archived).toBe(true)
    expect(engRow(ENG).slack_channel_archived_at).toBeTruthy()

    slack.calls = []
    r = await sweepJobChannels(supabaseService as any)
    expect(r).toMatchObject({ archived: 0, unarchived: 0, failed: 0 })
    expect(slack.calls).toEqual([])

    engRow(ENG).closed_at = null
    await tick(ENG, B_SAM) // changed while archived — can't be mirrored yet
    r = await sweepJobChannels(supabaseService as any)
    expect(r).toMatchObject({ archived: 0, unarchived: 1 })
    expect(chanOf(ENG).archived).toBe(false)
    expect(engRow(ENG).slack_channel_archived_at).toBeNull()
    expect(chanOf(ENG).members.has('U_SAM')).toBe(true) // brought in after the unarchive

    slack.calls = []
    r = await sweepJobChannels(supabaseService as any)
    expect(r).toMatchObject({ archived: 0, unarchived: 0 })
    expect(slack.calls).toEqual([])
  })

  it('already_archived / not_archived / channel_not_found are no-ops, not failures', async () => {
    await create(ENG)
    chanOf(ENG).archived = true
    engRow(ENG).closed_at = '2026-11-04T10:00:00Z'
    expect(await sweepJobChannels(supabaseService as any)).toMatchObject({ archived: 1, failed: 0, ok: true })
    slack.channels.clear()
    engRow(ENG).closed_at = null
    expect(await sweepJobChannels(supabaseService as any)).toMatchObject({ gone: 1, failed: 0, ok: true })
  })

  it('an engagement with no channel is untouched by the sweep', async () => {
    const before = JSON.stringify(engRow(ENG_NOCHAN))
    await sweepJobChannels(supabaseService as any)
    expect(JSON.stringify(engRow(ENG_NOCHAN))).toBe(before)
    expect(slack.calls).toEqual([])
  })

  it('the cron route uses the cron secret and logs one line every run', async () => {
    const bad = await cronGET({ headers: new Headers(), nextUrl: new URL('http://x/api/cron/job-channels') } as any)
    expect(bad.status).toBe(401)
    const good = await cronGET({ headers: new Headers({ authorization: 'Bearer cron-secret' }), nextUrl: new URL('http://x/api/cron/job-channels') } as any)
    expect(good.status).toBe(200)
    expect(logs.some(l => l.startsWith('[cron job-channels] archived 0, unarchived 0'))).toBe(true)
    expect(readFileSync('vercel.json', 'utf8')).toContain('"/api/cron/job-channels"')
  })
})

// ═══════════════════════════════════════════════════════════
// Slack's unarchive restores the channel WITH its old members. Reconcile
// both ways against the bees on the job at that moment.
describe('reconcile on unarchive', () => {
  const B_OWNERBEE = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000004'
  // Channel made with Sam on the job; job closes; the sweep archives.
  const closeAndArchive = async (ticked: string[] = [B_SAM]) => {
    for (const b of ticked) await tick(ENG, b)
    await create(ENG)
    engRow(ENG).closed_at = '2026-11-04T10:00:00Z'
    expect(await sweepJobChannels(supabaseService as any)).toMatchObject({ archived: 1 })
  }
  const reopen = async () => {
    engRow(ENG).closed_at = null
    slack.calls = []
    return sweepJobChannels(supabaseService as any)
  }
  const kicks = () => slack.calls.filter(c => c.method === 'conversations.kick').map(c => c.body.user)
  const invites = () => slack.calls.filter(c => c.method === 'conversations.invite').map(c => c.body.users)

  it('a bee taken off the job while the channel was archived is removed on unarchive', async () => {
    await closeAndArchive()
    expect(chanOf(ENG).members.has('U_SAM')).toBe(true) // archive keeps members
    await untick(ENG, B_SAM)                             // archived: can't be mirrored now
    expect(chanOf(ENG).members.has('U_SAM')).toBe(true)
    const r = await reopen()
    expect(r).toMatchObject({ unarchived: 1, failed: 0, reconcile_problems: 0 })
    expect(chanOf(ENG).members.has('U_SAM')).toBe(false)
    expect(kicks()).toEqual(['U_SAM'])
  })

  it('a bee added while the channel was archived is invited on unarchive', async () => {
    await closeAndArchive([])
    await tick(ENG, B_ANA)
    await reopen()
    expect(chanOf(ENG).members.has('U_ANA')).toBe(true)
    expect(invites()).toContain('U_ANA')
  })

  it('a bee on the job throughout is left alone — never removed and re-added', async () => {
    await closeAndArchive()
    await reopen()
    expect(chanOf(ENG).members.has('U_SAM')).toBe(true)
    expect(kicks()).toEqual([])
    expect(ebRow(ENG, B_SAM).removed_at).toBeNull()
  })

  it('the owners and the Bee Hub app are never removed — even an owner who is also a bee taken off the job', async () => {
    h.db.tables.location_bees.push(bee(B_OWNERBEE, LOC, 'Olive Owner', 'Owner@Bee.com', 'U_OWNER'))
    await closeAndArchive([B_SAM, B_OWNERBEE])
    await untick(ENG, B_OWNERBEE); await untick(ENG, B_SAM)
    await reopen()
    expect(chanOf(ENG).members.has('U_OWNER')).toBe(true)
    expect(chanOf(ENG).members.has('UBOT')).toBe(true)
    expect(kicks()).toEqual(['U_SAM'])
  })

  it('someone added by hand in Slack, who is not a bee on this job, is never removed — even if they are on the roster', async () => {
    await closeAndArchive()
    slack.validIds.add('U_HAND')
    chanOf(ENG).members.add('U_HAND') // a person who isn't a bee at all
    chanOf(ENG).members.add('U_ANA')  // a roster bee never put on this job
    await untick(ENG, B_SAM)
    await reopen()
    expect(chanOf(ENG).members.has('U_HAND')).toBe(true)
    expect(chanOf(ENG).members.has('U_ANA')).toBe(true)
    expect(kicks()).toEqual(['U_SAM'])
  })

  it('restricted_action surfaces: stored on the job, shown by GET, counted in the cron line — and the bee stays OFF the job', async () => {
    await closeAndArchive()
    await untick(ENG, B_SAM)
    slack.restrictKick = true
    const r = await reopen()
    expect(r).toMatchObject({ unarchived: 1, reconcile_problems: 1 })
    expect(chanOf(ENG).members.has('U_SAM')).toBe(true)       // Slack refused
    expect(ebRow(ENG, B_SAM).removed_at).toBeTruthy()          // Bee Hub is the truth
    expect(engRow(ENG).slack_channel_problems.items).toEqual([
      expect.objectContaining({ status: 'still_in_channel', bee: 'Sam Bee', channel: 'sarah-mcallister-pantry', bee_id: B_SAM, from: 'reopened' }),
    ])
    const g = await read(ENG)
    expect(g.j.slack.reconcile.items[0]).toMatchObject({ status: 'still_in_channel', bee: 'Sam Bee' })
    expect(g.j.bees.map((b: any) => b.id)).not.toContain(B_SAM)
    // the same words the live toggle uses
    expect(beeSlackNote(g.j.slack.reconcile.items[0])!.text).toMatch(/STILL IN #sarah-mcallister-pantry/)
    const { jobChannelsLine } = await import('@/lib/cron-log-lines')
    expect(jobChannelsLine(r)).toContain('bee problems stored for owners 1')
  })

  // Changed on purpose 2026-11-13: Got it HIDES the lines from the page; it no
  // longer deletes them, so a fix made later is still picked up by the paced
  // retry. A line is deleted only when it stops being true.
  it('Got it hides a stored line from the page without deleting it, and a line about one bee clears when the owner re-ticks that bee', async () => {
    await closeAndArchive([B_SAM, B_ANA])
    await untick(ENG, B_SAM); await untick(ENG, B_ANA)
    slack.restrictKick = true
    await reopen()
    expect(engRow(ENG).slack_channel_problems.items).toHaveLength(2)
    slack.restrictKick = false
    await tick(ENG, B_SAM)
    expect(engRow(ENG).slack_channel_problems.items.map((p: any) => p.bee_id)).toEqual([B_ANA])
    const p = await call(channelPATCH(reqJson({ clear_problems: true }), { params: { id: ENG } }))
    expect(p.status).toBe(200)
    expect(engRow(ENG).slack_channel_problems.items.map((x: any) => [x.bee_id, !!x.seen_at])).toEqual([[B_ANA, true]])
    expect((await read(ENG)).j.slack.reconcile).toBeNull()
  })

  it('a clean reconcile clears an old stored list', async () => {
    await closeAndArchive()
    engRow(ENG).slack_channel_problems = { at: 'old', items: [{ status: 'add_refused', bee: 'Sam Bee', bee_id: B_SAM }] }
    await reopen()
    expect(engRow(ENG).slack_channel_problems).toBeNull()
  })

  it('reconciling twice changes nothing the second time', async () => {
    await closeAndArchive([B_SAM])
    await untick(ENG, B_SAM); await tick(ENG, B_ANA)
    await reopen()
    const members = Array.from(chanOf(ENG).members).sort()
    const rows = JSON.stringify(h.db.tables.engagement_bees)
    const eng = JSON.stringify(engRow(ENG))
    slack.calls = []
    const again = await reconcileChannelBees(supabaseService as any, { token: TOKEN, engagementId: ENG, locationUuid: LOC, channelId: engRow(ENG).slack_channel_id, channelName: engRow(ENG).slack_channel_name })
    expect(again.problems).toEqual([])
    expect(Array.from(chanOf(ENG).members).sort()).toEqual(members)
    expect(JSON.stringify(h.db.tables.engagement_bees)).toBe(rows)
    expect(JSON.stringify(engRow(ENG))).toBe(eng)
    // Slack was asked, and said "already in" / "not in" — nothing moved.
    expect(slack.calls.map(c => c.method).sort()).toEqual(['conversations.invite', 'conversations.kick'])
  })
})

// ═══════════════════════════════════════════════════════════
describe('everything works before either migration runs', () => {
  it('without the channel columns: bees still assign, no create offered, create refuses before calling Slack, sweep does nothing', async () => {
    h.db.noChannelCols = true
    expect((await tick(ENG, B_SAM)).status).toBe(200)
    const g = await read(ENG)
    expect(g.status).toBe(200)
    expect(g.j.slack).toMatchObject({ channelsSetUp: false, channel: null })
    slack.calls = []
    const c = await create(ENG)
    expect(c.status).toBe(409)
    expect(c.j.error).toBe('not_set_up_yet')
    expect(slack.calls).toEqual([])
    expect(await sweepJobChannels(supabaseService as any)).toMatchObject({ not_set_up_yet: true, archived: 0 })
  })

  it('without the bee tables: GET says setUp:false, writes refuse plainly, create refuses before calling Slack', async () => {
    h.db.noBeesTable = true
    expect((await read(ENG)).j).toEqual({ setUp: false })
    const t = await tick(ENG, B_SAM)
    expect(t.status).toBe(400) // the bee can't even be read
    slack.calls = []
    expect((await create(ENG)).j.error).toBe('not_set_up_yet')
    expect(slack.calls).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════
describe('slack_bot_token stays on the server', () => {
  it('appears in no API response and no log line', async () => {
    responses.length = 0
    await read(ENG); await create(ENG); await tick(ENG, B_SAM); await tick(ENG, B_NOBODY)
    slack.restrictKick = true; await untick(ENG, B_SAM)
    slack.missingScope = true; await tick(ENG, B_ANA)
    engRow(ENG).closed_at = 'x'; slack.missingScope = false; await sweepJobChannels(supabaseService as any)
    expect(responses.length).toBeGreaterThan(5)
    for (const r of responses) expect(r).not.toContain(TOKEN)
    for (const l of logs) expect(l).not.toContain(TOKEN)
    expect(logs.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════
// The screen.
// The panel's bees row, its Slack lines and the ··· menu item are pinned in
// lib/beta-bees-row.test.tsx (2026-11-12: the row became a read-only mirror
// under the assignee corner; the picker these tests drove no longer exists).

describe('what the owner reads for each Slack answer', () => {
  it('every failure speaks; success and no-channel are silent', () => {
    expect(beeSlackNote(null)).toBeNull()
    expect(beeSlackNote({ status: 'ok' })).toBeNull()
    for (const s of [
      { status: 'still_in_channel', bee: 'Sam', channel: 'c' },
      { status: 'add_refused', bee: 'Sam' },
      { status: 'not_in_slack', bee: 'Sam', email: 's@x' },
      { status: 'scope_lost' },
      { status: 'channel_gone' },
      { status: 'archived' },
      { status: 'unavailable', bee: 'Sam', action: 'remove' },
      { status: 'unavailable', bee: 'Sam', action: 'add' },
    ]) {
      const n = beeSlackNote(s)
      expect(n, s.status).not.toBeNull()
      expect(n!.text).not.toMatch(/restricted_action|missing_scope|channel_not_found|user_not_found/)
    }
  })
})
