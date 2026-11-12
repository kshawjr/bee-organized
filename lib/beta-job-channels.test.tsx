// @vitest-environment happy-dom
//
// Slack job channels, slice 3 of 3 — bees on a job, and the job's channel.
// migrations/engagement_bees.sql · migrations/engagement_slack_channel.sql ·
// lib/engagement-bees.ts · lib/slack-channel-name.ts ·
// app/api/engagements/[id]/bees · app/api/engagements/[id]/slack-channel ·
// app/api/cron/job-channels · components/hive/BeesOnJob.jsx ·
// components/hive/shared/BeePicker.jsx · components/hive/shared/BeeSlackStatus.jsx
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
  const db: any = { tables: {} as Record<string, any[]>, seq: 0, noChannelCols: false, noBeesTable: false, touched: new Set<string>() }
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
import BeesOnJob, { MAX_BEE_FACES } from '@/components/hive/BeesOnJob'
import { beeSlackNote } from '@/components/hive/shared/BeeSlackStatus'

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
  if (method === 'chat.postMessage') return ok()
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
  h.db.touched = new Set()
  h.db.seq = 0
  h.db.tables = {
    locations: [
      { id: LOC, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: SCOPES_NEW },
      { id: LOC2, slack_connected: true, slack_bot_token: TOKEN, slack_scopes: SCOPES_OLD },
    ],
    engagements: [
      { id: ENG, location_uuid: LOC, client_id: 'lead-1', client_name: 'Sarah McAllister', project_type: 'Pantry', closed_at: null, slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null },
      { id: ENG2, location_uuid: LOC2, client_id: 'lead-2', client_name: 'Joe Two', project_type: 'Garage', closed_at: null, slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null },
      { id: ENG_NOCHAN, location_uuid: LOC, client_id: 'lead-3', client_name: 'Closed No Channel', project_type: 'Office', closed_at: '2026-11-02T00:00:00Z', slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null },
    ],
    location_bees: [
      bee(B_SAM, LOC, 'Sam Bee', 'sam@bee.com', 'U_SAM'),
      bee(B_ANA, LOC, 'Ana Bee', 'ana@bee.com', null),
      bee(B_NOBODY, LOC, 'Nora Nobody', 'nora@elsewhere.com', null, { slack_checked_at: '2026-11-01T00:00:00Z' }),
      bee(B_OTHER, LOC2, 'Otto Other', 'otto@bee.com', 'U_OTTO'),
    ],
    engagement_bees: [],
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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

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
    h.db.tables.engagements.push({ id: 'eeeeeeee-eeee-4eee-8eee-0000000000aa', location_uuid: LOC, client_id: 'lead-9', client_name: 'Second Job', project_type: 'Attic', closed_at: null, slack_channel_id: null, slack_channel_name: null, slack_channel_archived_at: null })
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
      { status: 'still_in_channel', bee: 'Sam Bee', channel: 'sarah-mcallister-pantry', bee_id: B_SAM },
    ])
    const g = await read(ENG)
    expect(g.j.slack.reconcile.items[0]).toMatchObject({ status: 'still_in_channel', bee: 'Sam Bee' })
    expect(g.j.bees.map((b: any) => b.id)).not.toContain(B_SAM)
    // the same words the live toggle uses
    expect(beeSlackNote(g.j.slack.reconcile.items[0])!.text).toMatch(/STILL IN #sarah-mcallister-pantry/)
    const { jobChannelsLine } = await import('@/lib/cron-log-lines')
    expect(jobChannelsLine(r)).toContain('bee problems stored for owners 1')
  })

  it('a stored line clears on Got it, and a line about one bee clears when the owner re-ticks that bee', async () => {
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
    expect(engRow(ENG).slack_channel_problems).toBeNull()
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
describe('the Bees cell', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  let uiCalls: { url: string; method: string; body: any }[]
  let getBody: any

  const mkBees = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `bee-${i}`, name: `Bee Number${i}`, email: `b${i}@x.com`, is_active: true, removed_at: null,
    slack_user_id: `U${i}`, slack_checked_at: '2026-11-01', assigned_at: `2026-11-01T00:00:${String(i).padStart(2, '0')}Z`,
  }))

  const mount = async (props: any = {}) => {
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(<BeesOnJob engagementId={ENG} locationUuid={LOC} clientName="Sarah McAllister" projectType="Pantry" {...props} />) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
  const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 0)) }) }
  const type = async (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  beforeEach(() => {
    uiCalls = []
    getBody = {
      setUp: true, bees: [], canAddBees: true,
      roster: [
        { id: 'r1', name: 'Ana Bee', email: 'ana@bee.com', is_active: true, slack_user_id: 'U_ANA', slack_checked_at: '2026-11-01' },
        { id: 'r2', name: 'Nora Nobody', email: 'nora@elsewhere.com', is_active: true, slack_user_id: null, slack_checked_at: '2026-11-01' },
        { id: 'r3', name: 'Una Unchecked', email: 'una@bee.com', is_active: true, slack_user_id: null, slack_checked_at: null },
      ],
      slack: { connected: true, canManageChannels: true, channelsSetUp: true, channel: null, closed: false },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
      const method = init.method || 'GET'
      const body = init.body ? JSON.parse(init.body) : null
      uiCalls.push({ url, method, body })
      const res = (j: any, status = 200) => ({ ok: status < 400, status, json: async () => j }) as any
      if (method === 'GET' && url.endsWith('/bees')) return res(getBody)
      if (method === 'POST' && url === `/api/locations/${LOC}/bees`) {
        return res({ ok: true, bee: { id: 'new1', name: body.name, email: body.email, is_active: true, slack_user_id: null, slack_checked_at: '2026-11-04' }, slackCheck: 'not_found' })
      }
      if (method === 'POST' && url.endsWith('/bees')) {
        const r = [...getBody.roster, { id: 'new1', name: 'Newt New', email: 'newt@x.com' }].find((b: any) => b.id === body.bee_id)
        return res({ bees: [{ ...r, assigned_at: 'now' }], slack_sync: null })
      }
      if (method === 'PATCH' && url.endsWith('/slack-channel')) return res({ ok: true })
      if (method === 'POST' && url.endsWith('/slack-channel')) return res({ ok: true, channel: { id: 'C1', name: 'sarah-mcallister-pantry', archived: false }, bees: [], problems: [] })
      return res({}, 404)
    }))
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  it('is visually distinct from the assignee corner: labelled "Bees", in the deal band beside Type, at the smaller inline disc size', async () => {
    getBody.bees = mkBees(2)
    await mount()
    const cell = host.querySelector('[data-bee-bees]')!
    expect(cell.querySelector('p')!.textContent).toBe('Bees')
    const disc = cell.querySelector('[data-bee-face] span') as HTMLElement
    expect(disc.style.width).toBe('18px')
    // The corner is untouched: still label-free, still 24px, and the panel
    // mounts the bees in the deal band (after Type), not in the corner's row.
    const corner = readFileSync('components/hive/shared/AssigneeCorner.jsx', 'utf8')
    expect(corner).not.toMatch(/Bee|bee/)
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    const iCorner = panel.indexOf('<AssigneeCorner')
    const iType = panel.indexOf('label="Type"')
    const iBees = panel.indexOf('<BeesOnJob')
    expect(iCorner).toBeGreaterThan(0)
    expect(iBees).toBeGreaterThan(iType)
    expect(iType).toBeGreaterThan(iCorner)
  })

  it('shows at most 3 faces then +N, and 15 bees renders tidily (three faces, "+12", every name in the title)', async () => {
    getBody.bees = mkBees(15)
    await mount()
    expect(MAX_BEE_FACES).toBe(3)
    expect(host.querySelectorAll('[data-bee-face]')).toHaveLength(3)
    expect(host.querySelector('[data-bee-more]')!.textContent).toBe('+12')
    const trigger = host.querySelector('[data-bee-bees-trigger]') as HTMLElement
    expect(trigger.title.split(', ')).toHaveLength(15)
    expect((host.querySelector('[data-bee-more]') as HTMLElement).style.whiteSpace).toBe('nowrap')
  })

  it('the picker and the create dialog are the same component', async () => {
    await mount()
    await click(host.querySelector('[data-bee-bees-trigger]'))
    const inPopover = host.querySelector('[data-bee-bees-popover] [data-bee-picker]')
    expect(inPopover).not.toBeNull()
    await click(host.querySelector('[data-bee-make-channel]'))
    const dialogPicker = document.querySelectorAll('[data-bee-picker]')
    expect(dialogPicker.length).toBeGreaterThanOrEqual(1)
    expect(document.body.textContent).toContain('#sarah-mcallister-pantry')
    const src = readFileSync('components/hive/BeesOnJob.jsx', 'utf8')
    expect(src.match(/<BeePicker\b/g)).toHaveLength(1)
    // A tick in the dialog is the same immediate write as in the corner.
    const row = Array.from(document.querySelectorAll('[data-bee-picker] [data-bee-id="r1"]')).pop()!
    await click(row)
    expect(uiCalls.some(c => c.method === 'POST' && c.url === `/api/engagements/${ENG}/bees` && c.body.bee_id === 'r1')).toBe(true)
    await click(document.querySelector('[data-bee-make-channel-confirm]'))
    expect(uiCalls.some(c => c.method === 'POST' && c.url === `/api/engagements/${ENG}/slack-channel`)).toBe(true)
    expect(host.querySelector('[data-bee-channel]')!.textContent).toBe('#sarah-mcallister-pantry')
  })

  it('adding a bee inline saves to the roster and selects them', async () => {
    await mount()
    await click(host.querySelector('[data-bee-bees-trigger]'))
    await click(host.querySelector('[data-bee-add-open]'))
    const [nameIn, emailIn] = Array.from(host.querySelectorAll('[data-bee-add-form] input')) as HTMLInputElement[]
    await type(nameIn, 'Newt New')
    await type(emailIn, 'newt@x.com')
    const form = host.querySelector('[data-bee-add-form]') as HTMLFormElement
    await act(async () => { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const rosterPost = uiCalls.findIndex(c => c.method === 'POST' && c.url === `/api/locations/${LOC}/bees`)
    const assignPost = uiCalls.findIndex(c => c.method === 'POST' && c.url === `/api/engagements/${ENG}/bees` && c.body.bee_id === 'new1')
    expect(rosterPost).toBeGreaterThanOrEqual(0)
    expect(uiCalls[rosterPost].body).toEqual({ name: 'Newt New', email: 'newt@x.com' })
    expect(assignPost).toBeGreaterThan(rosterPost)
    expect(host.querySelector('[data-bee-face]')).not.toBeNull()
    // The same Slack check as Settings › Bees speaks right away.
    expect(host.querySelector('[data-bee-add-msg]')!.textContent).toContain('Nobody in your Slack uses newt@x.com')
  })

  it('a bee whose email matches nobody in Slack is selectable and marked; an unchecked bee is not marked', async () => {
    await mount()
    await click(host.querySelector('[data-bee-bees-trigger]'))
    const nora = host.querySelector('[data-bee-id="r2"]') as HTMLButtonElement
    const una = host.querySelector('[data-bee-id="r3"]') as HTMLButtonElement
    expect(nora.querySelector('[data-bee-not-in-slack]')!.textContent).toBe('not in Slack')
    expect(una.querySelector('[data-bee-not-in-slack]')).toBeNull()
    expect(nora.disabled).toBe(false)
    await click(nora)
    expect(uiCalls.some(c => c.method === 'POST' && c.body?.bee_id === 'r2')).toBe(true)
  })

  it('a location that has not reconnected: the Bees cell, NO "Put this job in Slack" button, and the reconnect line for someone who can reconnect', async () => {
    getBody.slack = { connected: true, canManageChannels: false, canReconnect: true, channelsSetUp: true, channel: null, closed: false }
    await mount()
    expect(host.querySelector('[data-bee-bees-trigger]')).not.toBeNull()
    expect(host.querySelector('[data-bee-make-channel]')).toBeNull()
    expect(host.textContent).not.toContain('Put this job in Slack')
    expect(host.querySelector('[data-bee-reconnect]')!.textContent).toContain('Reconnect Slack to turn on channels for your jobs.')
  })

  // The line is an instruction. A manager or a read-only user has no Slack
  // settings to go to, so for them it is noise — the server says who can act
  // (slack.canReconnect) and the cell shows it to nobody else.
  it('the reconnect line is NOT shown to someone who cannot reconnect — they still get the Bees cell, and still no create button', async () => {
    getBody.slack = { connected: true, canManageChannels: false, canReconnect: false, channelsSetUp: true, channel: null, closed: false }
    await mount()
    expect(host.querySelector('[data-bee-bees-trigger]')).not.toBeNull()
    expect(host.querySelector('[data-bee-reconnect]')).toBeNull()
    expect(host.textContent).not.toMatch(/reconnect/i)
    expect(host.querySelector('[data-bee-make-channel]')).toBeNull()
  })

  it('…nor on a read-only panel, nor when the server says nothing about who can reconnect (fails closed)', async () => {
    getBody.slack = { connected: true, canManageChannels: false, canReconnect: true, channelsSetUp: true, channel: null, closed: false }
    await mount({ readOnly: true })
    expect(host.querySelector('[data-bee-reconnect]')).toBeNull()
    act(() => root.unmount()); host.remove()
    getBody.slack = { connected: true, canManageChannels: false, channelsSetUp: true, channel: null, closed: false }
    await mount()
    expect(host.querySelector('[data-bee-reconnect]')).toBeNull()
  })

  it('a location with NO Slack at all sees the Bees cell — and not a word about Slack, picker open included', async () => {
    getBody.slack = { connected: false, canManageChannels: false, canReconnect: true, channelsSetUp: true, channel: null, closed: false }
    await mount()
    expect(host.querySelector('[data-bee-bees-trigger]')).not.toBeNull()
    await click(host.querySelector('[data-bee-bees-trigger]'))
    expect(host.querySelectorAll('[data-bee-picker] [data-bee-id]').length).toBe(3)   // the roster is there to tick
    expect(host.querySelector('[data-bee-not-in-slack]')).toBeNull()
    expect(host.querySelector('[data-bee-make-channel]')).toBeNull()
    expect(host.querySelector('[data-bee-reconnect]')).toBeNull()
    expect(host.textContent).not.toMatch(/slack/i)
    for (const el of Array.from(host.querySelectorAll('[title],[aria-label]'))) {
      expect((el.getAttribute('title') || '') + (el.getAttribute('aria-label') || '')).not.toMatch(/slack/i)
    }
  })

  it('an owner who could not be added to the new channel is NAMED, with the email Slack did not know', async () => {
    const f = globalThis.fetch as any
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
      if ((init.method || 'GET') === 'POST' && url.endsWith('/slack-channel')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, channel: { id: 'C1', name: 'sarah-mcallister-pantry', archived: false }, bees: [], problems: [{ status: 'owner_not_in_slack', bee: 'Olive Owner', email: 'olive@home.com' }] }) } as any
      }
      return f(url, init)
    }))
    await mount()
    await click(host.querySelector('[data-bee-make-channel]'))
    expect(host.textContent).toContain('The location owner is added too, as long as Slack knows the email they use for Bee Hub.')
    await click(host.querySelector('[data-bee-make-channel-confirm]'))
    const line = host.querySelector('[data-bee-bees-slack]')!
    expect(line.textContent).toBe('Olive Owner, the owner, wasn’t added to the channel: nobody in your Slack uses olive@home.com, the email they sign in to Bee Hub with. Add them in Slack.')
  })

  it('shows what the sweep could not do when the job reopened, in the live toggle’s words, until Got it', async () => {
    getBody.slack.channel = { id: 'C1', name: 'sarah-mcallister-pantry', archived: false }
    getBody.slack.reconcile = { at: '2026-11-04T12:00:00Z', items: [{ status: 'still_in_channel', bee: 'Sam Bee', channel: 'sarah-mcallister-pantry', bee_id: 'r1' }] }
    await mount()
    const box = host.querySelector('[data-bee-reconcile]')!
    expect(box.textContent).toMatch(/When this job reopened/)
    expect(box.textContent).toMatch(/Sam Bee is off this job in Bee Hub, but is STILL IN #sarah-mcallister-pantry/)
    await click(host.querySelector('[data-bee-reconcile-ok]'))
    expect(uiCalls.some(c => c.method === 'PATCH' && c.url === `/api/engagements/${ENG}/slack-channel` && c.body?.clear_problems === true)).toBe(true)
    expect(host.querySelector('[data-bee-reconcile]')).toBeNull()
  })

  it('before the migrations run it renders nothing — the panel is as it was', async () => {
    getBody = { setUp: false }
    await mount()
    expect(host.innerHTML).toBe('')
  })
})

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
