// The pinned job card (2026-11-12): lib/job-channel-card.ts and the one place
// it is posted from, createJobChannel in lib/engagement-bees.ts.
//
// REAL: the card's text, the reads that fill it, post-then-pin, createJobChannel
// (what the Slack mark's route calls), the JOB_CREATE handler and auto-create,
// the visit notices, the sweep. STAND-INS: the database (held to the schema
// snapshot), Jobber, Slack. No card has been posted to a real Slack: how Slack
// DRAWS this text — the map link, the quote bar, the bold — has not been seen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
    b.order = (c: string, o?: any) => { ctx.order = [c, o?.ascending !== false]; return b }
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
      if (ctx.order) hits = [...hits].sort((x: any, y: any) => (String(x[ctx.order[0]]) < String(y[ctx.order[0]]) ? -1 : 1) * (ctx.order[1] ? 1 : -1))
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
import { supabaseService } from '@/lib/supabase-service'
import { TOPIC_HANDLERS } from '@/lib/jobber-webhook-handlers'
import { createJobChannel, loadEngagementForBees, readLocationSlackFull, sweepJobChannels } from '@/lib/engagement-bees'
import { jobCardText, oneLineAddress, areaOnly, readJobCardData, postJobCard, CARD_NO_ADDRESS, CARD_DESCRIPTION_MAX, type JobCardData } from '@/lib/job-channel-card'
import { autoNote } from '@/lib/job-channel-auto'
const db = supabaseService as any

// ── the fake Slack workspace ──
type Chan = { name: string; members: Set<string>; archived: boolean }
let slack: { post?: string; pin?: string; pinBody?: any; users: Record<string, string>; channels: Map<string, Chan>; calls: { method: string; body: any }[]; down: boolean; seq: number }
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
  if (method === 'chat.postMessage') {
    if (slack.post === 'throw') throw new Error('socket hang up')
    if (slack.post) return no(slack.post)
    return ok({ ts: `1700000000.${String(slack.calls.length).padStart(6, '0')}` })
  }
  if (method === 'pins.add') {
    if (slack.pin === 'throw') throw new Error('socket hang up')
    if (slack.pin) return ({ ok: true, status: 200, json: async () => ({ ok: false, error: slack.pin, ...(slack.pinBody || {}) }) }) as any
    return ok()
  }
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
    leads: [{ id: 'lead-7001', location_id: 'loc_test', jobber_client_id: '7001', name: 'Test FailSafe', stage: 'Job in Progress', address: '6711 Calvert Commons Drive, Huntersville, NC, 28078', street2: null, city: 'Huntersville', state: 'NC', zip: '28078', phone: '(303) 751-1112', email: 'test@bmave.com' }],
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

beforeEach(seed)
afterEach(() => {
  expect(h.db.seedFaults, 'a seeded row names a column the real table does not have').toEqual([])
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const posts = () => slack.calls.filter(c => c.method === 'chat.postMessage')
const pins = () => slack.calls.filter(c => c.method === 'pins.add')
const NOW = new Date('2026-11-12T20:00:00Z')
const FULL: JobCardData = {
  clientName: 'Test FailSafe', projectType: 'Moving/Relocation',
  address: '6711 Calvert Commons Drive, Huntersville, NC, 28078', area: null, phone: '(303) 751-1112', email: 'test@bmave.com',
  nextAssessmentAt: '2026-11-13T17:00:00Z', timezone: 'America/New_York', description: null,
  url: 'https://beehive.beeorganized.com/clients/lead-7001?e=' + engId(1), asOf: NOW.toISOString(),
}

describe('the card’s text, exactly as Slack is sent it', () => {
  it('the real job at Test Location', () => {
    expect(jobCardText(FULL)).toBe([
      '*Test FailSafe* — Moving/Relocation',
      '*Address:* <https://www.google.com/maps/search/?api=1&query=6711%20Calvert%20Commons%20Drive%2C%20Huntersville%2C%20NC%2C%2028078|6711 Calvert Commons Drive, Huntersville, NC, 28078>',
      '*Phone:* (303) 751-1112',
      '*Email:* test@bmave.com',
      '*Next assessment:* Fri, Nov 13 at 12:00 PM',
      '',
      `<https://beehive.beeorganized.com/clients/lead-7001?e=${engId(1)}|Open the job in Bee Hub>`,
      '_Details as of Nov 12. Bee Hub has the latest._',
    ].join('\n'))
  })

  it('with a description: quoted under its own heading, every line of it', () => {
    const t = jobCardText({ ...FULL, description: 'Packing a 3-bed house.\nPiano on the ground floor.' })
    expect(t).toContain('*Next assessment:* Fri, Nov 13 at 12:00 PM\n\n*What they asked for:*\n> Packing a 3-bed house.\n> Piano on the ground floor.\n\n<https://')
  })

  it('address and phone come first, straight after the name: what a crew at the door needs', () => {
    const lines = jobCardText({ ...FULL, description: 'x' }).split('\n')
    expect(lines[0]).toMatch(/^\*Test FailSafe\*/)
    expect(lines[1]).toMatch(/^\*Address:\*/)
    expect(lines[2]).toMatch(/^\*Phone:\*/)
  })

  it('A JOB WITH NO ADDRESS still gets a usable card: it says so in words, and keeps the name, the phone and the link', () => {
    const t = jobCardText({ ...FULL, address: null })
    expect(t.split('\n').slice(0, 3)).toEqual(['*Test FailSafe* — Moving/Relocation', `*Address:* ${CARD_NO_ADDRESS}`, '*Phone:* (303) 751-1112'])
    expect(CARD_NO_ADDRESS).toBe('not on file yet. Check the job in Bee Hub before you go.')
    expect(t).toContain('|Open the job in Bee Hub>')
    expect(t).not.toContain('maps')
  })

  it('a job with nothing but a name is still a card: name, the no-address line, the link', () => {
    expect(jobCardText({ ...FULL, projectType: null, address: null, phone: null, email: null, nextAssessmentAt: null, description: null })).toBe([
      '*Test FailSafe*', `*Address:* ${CARD_NO_ADDRESS}`, '',
      `<https://beehive.beeorganized.com/clients/lead-7001?e=${engId(1)}|Open the job in Bee Hub>`, '_Details as of Nov 12. Bee Hub has the latest._',
    ].join('\n'))
    expect(jobCardText({ ...FULL, clientName: null, url: null, address: null, phone: null, email: null, nextAssessmentAt: null, timezone: null }))
      .toBe(`*this client* — Moving/Relocation\n*Address:* ${CARD_NO_ADDRESS}\n\n_Details as of when this channel was made. Bee Hub has the latest._`)
  })

  it('no time is shown when the location’s time zone is not known: a wrong hour is worse than none', () => {
    const t = jobCardText({ ...FULL, timezone: null })
    expect(t).not.toContain('Next assessment')
    expect(t).not.toMatch(/\d:\d\d/)
  })

  it('the time is the LOCATION’s, not the server’s', () => {
    expect(jobCardText({ ...FULL, timezone: 'America/Los_Angeles' })).toContain('*Next assessment:* Fri, Nov 13 at 9:00 AM')
    expect(jobCardText({ ...FULL, timezone: 'America/Chicago', asOf: '2026-11-13T05:30:00Z' })).toContain('_Details as of Nov 12.')
  })

  it('what a client typed cannot break the message or forge a link', () => {
    const t = jobCardText({ ...FULL, clientName: 'A & B <Smith>', address: '1 <Main> St | Unit 2, Town, NC 28078', description: '<!channel> call me <https://evil.test|here> & soon', email: 'a<b@x.test' })
    expect(t).toContain('*A &amp; B &lt;Smith&gt;*')
    expect(t).toContain('|1 &lt;Main&gt; St / Unit 2, Town, NC 28078>')
    expect(t).toContain('> &lt;!channel&gt; call me &lt;https://evil.test|here&gt; &amp; soon')
    expect(t).toContain('*Email:* a&lt;b@x.test')
    expect(t.match(/<https?:[^>]*>/g)).toHaveLength(2)            // the map and Bee Hub, nothing else
    expect(t).not.toMatch(/<!/)
  })

  it('a long description is cut, with a mark that it was', () => {
    const t = jobCardText({ ...FULL, description: 'word '.repeat(400) })
    const quoted = t.split('\n').find(l => l.startsWith('> '))!
    expect(quoted.length).toBeLessThanOrEqual(CARD_DESCRIPTION_MAX + 3)
    expect(quoted.endsWith('…')).toBe(true)
    expect(CARD_DESCRIPTION_MAX).toBe(400)
  })

  it('THE ADDRESS IS NEVER DOUBLED: an imported client’s street line already holds the town, state and zip (the real Test Location row)', () => {
    const real = { address: '6711 Calvert Commons Drive, Huntersville, NC, 28078', street2: null, city: 'Huntersville', state: 'NC', zip: '28078' }
    expect(oneLineAddress(real)).toBe('6711 Calvert Commons Drive, Huntersville, NC, 28078')
    expect(oneLineAddress(real)!.match(/Huntersville/g)).toHaveLength(1)
  })

  it('one-line address: a street typed on its own gets its town, state and zip; a unit is added once; no street means none', () => {
    expect(oneLineAddress({ address: '6711 Calvert Commons Drive', city: 'Huntersville', state: 'NC', zip: '28078' })).toBe('6711 Calvert Commons Drive, Huntersville, NC 28078')
    expect(oneLineAddress({ address: ' 1 Main St ', street2: 'Apt 2', city: 'Town', state: 'NC', zip: '' })).toBe('1 Main St, Town, NC (Apt 2)')
    expect(oneLineAddress({ address: '1 Main St Apt 2, Town', street2: 'Apt 2', city: 'Town' })).toBe('1 Main St Apt 2, Town')
    expect(oneLineAddress({ address: '1 Main St' })).toBe('1 Main St')
    expect(oneLineAddress({ address: '', city: 'Huntersville', state: 'NC', zip: '28078' })).toBeNull()
    expect(oneLineAddress(null)).toBeNull()
  })

  it('a town or zip with no street is not shown as an address: the card says there is no street, and names the area', () => {
    expect(areaOnly({ address: null, city: 'Huntersville', state: 'NC', zip: '28078' })).toBe('Huntersville, NC 28078')
    expect(areaOnly({ zip: '28078' })).toBe('28078')
    expect(areaOnly({ address: '1 Main St', city: 'Town' })).toBeNull()
    expect(areaOnly({})).toBeNull()
    const t = jobCardText({ ...FULL, address: null, area: 'Huntersville, NC 28078' })
    expect(t.split('\n')[1]).toBe('*Address:* no street on file yet (Huntersville, NC 28078). Check the job in Bee Hub before you go.')
    expect(t).not.toContain('maps')
  })
})

describe('what goes on it is read from what Bee Hub already holds', () => {
  const read = (over: any = {}) => readJobCardData(db, { engagementId: engId(1), locationUuid: LOC, clientId: 'lead-7001', clientName: 'Test FailSafe', projectType: 'Moving/Relocation', url: 'https://hub.test/x', now: NOW, ...over })

  it('address, phone (shown the house way) and email from the client; description from the deal; the next SCHEDULED assessment still ahead; the location’s time zone', async () => {
    h.db.tables.engagements.push(eng(1, { description: '  Packing a 3-bed house. ' }))
    h.db.tables.leads[0].phone = '3037511112'                     // stored bare: the card shows it the house way
    h.db.tables.assessments.push(
      { id: 'a1', engagement_id: engId(1), status: 'completed', scheduled_at: '2026-11-12T22:00:00Z' },   // sooner, but done
      { id: 'a2', engagement_id: engId(1), status: 'scheduled', scheduled_at: '2026-11-01T15:00:00Z' },   // already past
      { id: 'a4', engagement_id: engId(2), status: 'scheduled', scheduled_at: '2026-11-12T21:00:00Z' },   // another deal, and sooner
      { id: 'a5', engagement_id: engId(1), status: 'scheduled', scheduled_at: '2026-12-01T15:00:00Z' },   // this deal, but later
      { id: 'a3', engagement_id: engId(1), status: 'scheduled', scheduled_at: '2026-11-13T17:00:00Z' },
    )
    expect(await read()).toEqual({ ...FULL, description: 'Packing a 3-bed house.', url: 'https://hub.test/x' })
  })

  it('no address on the client, no assessment, no description: those are simply absent', async () => {
    h.db.tables.engagements.push(eng(1))
    Object.assign(h.db.tables.leads[0], { address: null, city: 'Huntersville', phone: null, email: '  ' })
    expect(await read()).toMatchObject({ address: null, area: 'Huntersville, NC 28078', phone: null, email: null, nextAssessmentAt: null, description: null, timezone: 'America/New_York' })
  })

  it('a location with no time zone, or one Bee Hub cannot read, gives none', async () => {
    h.db.tables.engagements.push(eng(1))
    h.db.tables.locations[0].timezone = null
    expect((await read()).timezone).toBeNull()
    h.db.tables.locations[0].timezone = 'Somewhere'
    expect((await read()).timezone).toBeNull()
    h.db.tables.locations[0].timezone = 'America/Chicago'
    expect((await read()).timezone).toBe('America/Chicago')
  })

  it('every read failing still leaves a card: the name, the job type and the link came from the caller', async () => {
    h.db.fail = () => ({ message: 'connection reset' })
    const d = await read()
    h.db.fail = null
    expect(d).toMatchObject({ clientName: 'Test FailSafe', projectType: 'Moving/Relocation', url: 'https://hub.test/x', address: null, phone: null })
    expect(jobCardText(d)).toContain('*Test FailSafe* — Moving/Relocation')
    const thrown = await readJobCardData({ from: () => { throw new Error('gone') } } as any, { engagementId: engId(1), locationUuid: LOC, clientId: 'lead-7001', clientName: 'X', projectType: null, url: null, now: NOW })
    expect(thrown.clientName).toBe('X')
  })
})

describe('THE CARD IS POSTED WHEN A CHANNEL IS MADE, by the Slack mark and by auto-create alike', () => {
  it('the Slack mark: one message, the card, then one pin of exactly that message', async () => {
    h.db.tables.engagements.push(eng(1, { description: 'Packing a 3-bed house.' }))
    h.db.tables.assessments.push({ id: 'a3', engagement_id: engId(1), status: 'scheduled', scheduled_at: '2099-11-13T22:00:00Z' })
    const r: any = await byHand(1)
    expect(r.ok).toBe(true)
    expect(r.card).toEqual({ posted: true, pinned: true })
    expect(posts()).toHaveLength(1)
    const post = posts()[0].body
    expect(post).toMatchObject({ channel: 'CNEW1', unfurl_links: false, unfurl_media: false })
    expect(post.text.split('\n').slice(0, 4)).toEqual([
      '*Test FailSafe* — Moving/Relocation',
      '*Address:* <https://www.google.com/maps/search/?api=1&query=6711%20Calvert%20Commons%20Drive%2C%20Huntersville%2C%20NC%2C%2028078|6711 Calvert Commons Drive, Huntersville, NC, 28078>',
      '*Phone:* (303) 751-1112',
      '*Email:* test@bmave.com',
    ])
    expect(post.text).toContain('*Next assessment:* ')
    expect(post.text).toContain('> Packing a 3-bed house.')
    expect(post.text).toContain(`<https://hub.test/clients/lead-7001?e=${engId(1)}|Open the job in Bee Hub>`)
    expect(pins()).toHaveLength(1)
    const sent = slack.calls.map(c => c.method)
    expect(sent.indexOf('pins.add')).toBe(sent.indexOf('chat.postMessage') + 1)
    expect(pins()[0].body).toEqual({ channel: 'CNEW1', timestamp: `1700000000.${String(sent.indexOf('chat.postMessage') + 1).padStart(6, '0')}` })
  })

  it('auto-create: a job created in Jobber gets THE SAME card, pinned', async () => {
    h.db.tables.engagements.push(eng(1), eng(2))
    const hand: any = await byHand(1)
    jobInJobber('502', 2)
    const auto = await fire('JOB_CREATE', 'Job', '502')
    expect(auto.note).toBe('auto channel made')
    expect(posts()).toHaveLength(2); expect(pins()).toHaveLength(2)
    const norm = (t: string) => t.replace(/https:\/\/[a-z.]+\/clients\/lead-7001\?e=[0-9a-f-]+/, 'LINK')
    expect(norm(posts()[1].body.text)).toBe(norm(posts()[0].body.text))
    expect(posts()[1].body.channel).toBe('CNEW2')
    expect(pins()[1].body.channel).toBe('CNEW2')
    expect(hand.card).toEqual({ posted: true, pinned: true })
  })

  it('the Slack mark’s route and auto-create both go through createJobChannel, and the card is posted from there and nowhere else', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
      const p = join(dir, n)
      if (n === 'node_modules' || n.startsWith('.')) return []
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|jsx|mjs)$/.test(n) && !/\.test\./.test(n) ? [p] : []
    })
    const all = ['app', 'lib', 'components', 'scripts'].flatMap(walk)
    const using = (word: RegExp, not: string) => all.filter(f => f !== not && word.test(readFileSync(f, 'utf8')))
    expect(using(/postJobCard/, 'lib/job-channel-card.ts')).toEqual(['lib/engagement-bees.ts'])
    const lib = readFileSync('lib/engagement-bees.ts', 'utf8')
    expect(lib.split('postJobCard(').length - 1).toBe(1)
    // …inside createJobChannel, after the write that only the maker wins.
    const create = lib.slice(lib.indexOf('export async function createJobChannel'), lib.indexOf('async function inviteOwners'))
    expect(create).toContain('postJobCard(')
    expect(create.indexOf('postJobCard(')).toBeGreaterThan(create.indexOf(".is('slack_channel_id', null).select('id')"))
    expect(create.indexOf('postJobCard(')).toBeGreaterThan(create.indexOf('inviteOwners(db, token, eng, created.id)'))
    expect(using(/createJobChannel\(/, 'lib/engagement-bees.ts').sort()).toEqual(['app/api/engagements/[id]/slack-channel/route.ts', 'lib/job-channel-auto.ts'])
    // No other code posts a message into a job's channel or pins anything.
    expect(using(/pins\.add/, 'lib/job-channel-card.ts')).toEqual([])
  })

  it('the "Add to Slack" link asks for the pin permission', () => {
    const src = readFileSync('app/api/slack/connect/route.ts', 'utf8')
    const scopes = src.match(/const SLACK_SCOPES =\s*'([^']+)'/)![1].split(',')
    expect(scopes).toEqual(['chat:write', 'chat:write.public', 'channels:read', 'channels:manage', 'incoming-webhook', 'users:read', 'users:read.email', 'pins:write'])
  })
})

describe('A PIN THAT SLACK REFUSES leaves the channel, the card and the job intact', () => {
  const REFUSALS: [string, () => void, string][] = [
    ['the location has no pin permission yet (missing_scope, as Slack sends it)', () => { slack.pin = 'missing_scope'; slack.pinBody = { needed: 'pins:write', provided: NEW_SCOPES } }, 'missing_scope'],
    ['missing_scope with nothing else in the answer', () => { slack.pin = 'missing_scope' }, 'missing_scope'],
    ['Slack is rate-limiting', () => { slack.pin = 'ratelimited' }, 'ratelimited'],
    ['Slack says the bot is not in the channel', () => { slack.pin = 'not_in_channel' }, 'not_in_channel'],
    ['the call dies mid-air', () => { slack.pin = 'throw' }, 'network'],
  ]
  for (const [why, arrange, code] of REFUSALS) {
    it(`by hand — ${why}`, async () => {
      h.db.tables.engagements.push(eng(1)); h.db.tables.engagement_bees.push(onJob(1, 1), onJob(1, 2))
      arrange()
      const r: any = await byHand(1)
      expect(r.ok).toBe(true)
      expect(r.card).toEqual({ posted: true, pinned: false, pinError: code })
      // the channel
      expect(r.channel).toEqual({ id: 'CNEW1', name: 'test-failsafe-moving-relocation' })
      expect(engRow(1)).toMatchObject({ slack_channel_id: 'CNEW1', slack_channel_name: 'test-failsafe-moving-relocation', slack_channel_archived_at: null })
      expect(slack.channels.get('CNEW1')!.archived).toBe(false)
      expect(slack.calls.some(c => c.method === 'conversations.archive')).toBe(false)
      // the card: still there. Nothing is deleted, edited or undone after the refusal.
      expect(posts()).toHaveLength(1)
      expect(pins()).toHaveLength(1)                              // tried once, not retried
      expect(slack.calls.map(c => c.method).filter(m => !['conversations.create', 'conversations.invite', 'users.lookupByEmail', 'chat.postMessage', 'pins.add'].includes(m))).toEqual([])
      expect(slack.calls.at(-1)!.method).toBe('pins.add')
      // the people
      expect(members()).toEqual(['UBOT', 'U_ANA', 'U_OWNER', 'U_SAM'])
      expect(r.problems).toEqual([]); expect(r.ownerProblems).toEqual([])
      // the location can still make channels: a refused PIN is not a lost channel permission
      expect(h.db.tables.locations[0].slack_scopes).toBe(NEW_SCOPES)
      expect((await readLocationSlackFull(db, LOC)).canManageChannels).toBe(true)
      expect(h.db.writes.filter((w: string) => w === 'update locations')).toEqual([])
    })
  }

  it('automatically — the job is saved, the channel stands, the claim stands, and the log says the card is not pinned and why', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1); h.jobber.jobs['501'] = { visits: [{ id: '9001', crew: [ANA] }] }
    slack.pin = 'missing_scope'; slack.pinBody = { needed: 'pins:write', provided: NEW_SCOPES }
    const r = await fire('JOB_CREATE', 'Job', '501')
    expect(r.processed).toBe(true)
    expect(r.note).toBe('auto channel made, card not pinned (missing_scope)')
    expect(h.db.tables.jobs).toHaveLength(1)
    expect(engRow(1).slack_channel_id).toBe('CNEW1'); expect(engRow(1).slack_channel_auto_at).toBeTruthy()
    expect(members()).toEqual(['UBOT', 'U_ANA', 'U_OWNER'])
    expect(posts()).toHaveLength(1)
    expect(h.db.tables.locations[0].slack_scopes).toBe(NEW_SCOPES)
    // …and the NEXT job still gets its channel.
    h.db.tables.engagements.push(eng(2)); jobInJobber('502', 2)
    expect((await fire('JOB_CREATE', 'Job', '502')).note).toBe('auto channel made, card not pinned (missing_scope)')
    expect(slack.channels.size).toBe(2)
  })

  it('the card itself cannot be posted: the channel and the people stand, no pin is tried, and the caller is told', async () => {
    for (const [fault, code] of [['ratelimited', 'ratelimited'], ['throw', 'network']] as const) {
      seed(); slack.post = fault
      h.db.tables.engagements.push(eng(1)); h.db.tables.engagement_bees.push(onJob(1, 1))
      const r: any = await byHand(1)
      expect(r.ok, fault).toBe(true)
      expect(r.card, fault).toEqual({ posted: false, pinned: false, postError: code })
      expect(engRow(1).slack_channel_id, fault).toBe('CNEW1')
      expect(members(), fault).toEqual(['UBOT', 'U_ANA', 'U_OWNER'])
      expect(pins(), fault).toEqual([])
    }
    expect(autoNote({ status: 'created', channelId: 'C', notAdded: 0, card: 'not_posted', cardWhy: 'ratelimited' })).toBe('auto channel made, card NOT posted (ratelimited)')
    expect(autoNote({ status: 'created', channelId: 'C', notAdded: 1, card: 'pinned' })).toBe('auto channel made, 1 not added')
  })

  it('Slack answering a post with no message id: posted, nothing to pin, nothing breaks', async () => {
    const api = vi.fn(async (_t: string, method: string) => (method === 'chat.postMessage' ? { ok: true } : { ok: true }))
    const r = await postJobCard(db, { slackApi: api as any, token: TOKEN, channelId: 'C1', engagementId: engId(1), locationUuid: LOC, clientId: 'lead-7001', clientName: 'X', projectType: null, url: null })
    expect(r).toEqual({ posted: true, pinned: false, pinError: 'no_message_id' })
    expect(api.mock.calls.map(c => c[1])).toEqual(['chat.postMessage'])
  })

  it('a crash inside the post or the pin never escapes: the caller gets an answer, not an exception', async () => {
    const args = { token: TOKEN, channelId: 'C1', engagementId: engId(1), locationUuid: LOC, clientId: 'lead-7001', clientName: 'X', projectType: null, url: null }
    const pinCrash = vi.fn(async (_t: string, method: string) => { if (method === 'pins.add') throw new TypeError('boom'); return { ok: true, ts: '1.2' } })
    expect(await postJobCard(db, { ...args, slackApi: pinCrash as any })).toEqual({ posted: true, pinned: false, pinError: 'threw' })   // the card IS up
    const postCrash = vi.fn(async () => { throw new TypeError('boom') })
    expect(await postJobCard(db, { ...args, slackApi: postCrash as any })).toEqual({ posted: false, pinned: false, postError: 'threw' })
  })

  it('"already pinned" counts as pinned', async () => {
    const api = vi.fn(async (_t: string, method: string) => (method === 'chat.postMessage' ? { ok: true, ts: '1.2' } : { ok: false, error: 'already_pinned' }))
    expect(await postJobCard(db, { slackApi: api as any, token: TOKEN, channelId: 'C1', engagementId: engId(1), locationUuid: LOC, clientId: null, clientName: 'X', projectType: null, url: null })).toEqual({ posted: true, pinned: true })
  })

  it('nothing in the card’s code can reach the "this location lost its channel permission" record', () => {
    expect(readFileSync('lib/job-channel-card.ts', 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')).not.toMatch(/recordSlackMissingScope|slack-scopes|slack_scopes|conversations\.(archive|kick|invite)/)
  })
})

describe('A CHANNEL NEVER GETS TWO CARDS', () => {
  it('pressing the Slack mark again on a job that has a channel: no second card', async () => {
    h.db.tables.engagements.push(eng(1))
    await byHand(1)
    const again: any = await byHand(1)
    expect(again).toMatchObject({ ok: true, already: true })
    expect(again.card).toBeUndefined()
    expect(posts()).toHaveLength(1); expect(pins()).toHaveLength(1)
  })

  it('two presses in the same instant: one channel survives, with one card', async () => {
    h.db.tables.engagements.push(eng(1))
    const [a, b]: any[] = await Promise.all([byHand(1), byHand(1)])
    expect([a.ok, b.ok]).toEqual([true, true])
    const live = Array.from(slack.channels.entries()).filter(([, c]) => !c.archived)
    expect(live).toHaveLength(1)
    expect(posts().filter(p => p.body.channel === live[0][0])).toHaveLength(1)
    expect(pins().filter(p => p.body.channel === live[0][0])).toHaveLength(1)
  })

  it('the same JOB_CREATE five times at once, then again later: one card', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    await Promise.all([1, 2, 3, 4, 5].map(() => fire('JOB_CREATE', 'Job', '501')))
    await fire('JOB_CREATE', 'Job', '501')
    expect(posts()).toHaveLength(1); expect(pins()).toHaveLength(1)
  })

  it('a SECOND job on the same deal: the channel is reused and the card is left as it is', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1); jobInJobber('502', 1)
    await fire('JOB_CREATE', 'Job', '501'); await fire('JOB_CREATE', 'Job', '502'); await fire('JOB_UPDATE', 'Job', '502')
    expect(posts()).toHaveLength(1); expect(pins()).toHaveLength(1)
    expect(slack.calls.some(c => c.method === 'chat.update')).toBe(false)
  })

  it('a REOPENED channel (closed, archived, reopened, unarchived) gets no second card', async () => {
    h.db.tables.engagements.push(eng(1)); h.db.tables.engagement_bees.push(onJob(1, 1))
    await byHand(1)
    engRow(1).closed_at = '2026-11-11T00:00:00Z'
    expect((await sweepJobChannels(db)).archived).toBe(1)
    engRow(1).closed_at = null
    expect((await sweepJobChannels(db)).unarchived).toBe(1)
    await byHand(1)                                              // and the mark pressed again for good measure
    expect(posts()).toHaveLength(1); expect(pins()).toHaveLength(1)
  })

  it('people coming and going on the job’s visits post nothing', async () => {
    h.db.tables.engagements.push(eng(1)); jobInJobber('501', 1)
    await fire('JOB_CREATE', 'Job', '501')
    h.jobber.jobs['501'] = { visits: [{ id: '9001', crew: [ANA, SAM] }] }
    await fire('VISIT_CREATE', 'Visit', '9001')
    h.jobber.jobs['501'] = { visits: [{ id: '9001', crew: [SAM] }] }
    await fire('VISIT_UPDATE', 'Visit', '9001'); await fire('VISIT_COMPLETE', 'Visit', '9001')
    expect(posts()).toHaveLength(1); expect(pins()).toHaveLength(1)
    expect(members()).toEqual(['UBOT', 'U_OWNER', 'U_SAM'])
  })
})

describe('needs no migration: the card writes nothing to the database', () => {
  it('making a channel with a card writes exactly what it wrote before the card existed', async () => {
    h.db.tables.engagements.push(eng(1)); h.db.tables.engagement_bees.push(onJob(1, 1))
    await byHand(1)
    expect(h.db.writes).toEqual(['update engagements'])
  })
  it('the card’s code has no insert, update, upsert or delete', () => {
    expect(readFileSync('lib/job-channel-card.ts', 'utf8')).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })
})
