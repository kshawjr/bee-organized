// @vitest-environment node
//
// Send to Jobber → Create a Job, with an optional visit time (2026-11-14).
//
// A Jobber job with only a date has NO visit, so it never reaches Jobber's
// calendar (proven on Test Location: job #3, visits: []). The fix: when the
// owner picks a time, the route adds a visit after the job is created, in the
// LOCATION's time zone. Pinned here, against the real route with mocked
// collaborators:
//   · no time  → the jobCreate input, the Jobber calls and the reply are
//                exactly what they were (no visitCreate, no `visit` key)
//   · a time   → one visitCreate on the new job, at the owner's local clock,
//                carrying the location's IANA zone (Denver here, not Eastern)
//   · refused  → the job still stands: success, the job id, visit.booked=false,
//                and the sync_log row says so ('partial')
//   · no zone  → refused BEFORE any Jobber write
//   · read-only users and paused locations → 403, nothing sent
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn(), jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-import', async (orig) => ({
  encodeJobberId: ((await orig()) as any).encodeJobberId,
  upsertServiceRequest: vi.fn(async () => ({ id: 'sr-db-1' })),
  upsertJob: vi.fn(async () => ({ id: 'job-db-1' })),
}))
vi.mock('@/lib/engagements', () => ({ attachToEngagement: vi.fn(async () => {}), isFallbackTitle: () => false }))
vi.mock('@/lib/lead-assignment', () => ({ resolveAndPersistLeadAssigneesIfEmpty: vi.fn(async () => {}) }))
vi.mock('@/lib/engagement-assignee-sync', () => ({
  getLeadAssignees: vi.fn(async () => []),
  getEngagementAssignees: vi.fn(async () => []),
  resolveJobberAssignment: () => ({ primaryJobberUserId: null, allJobberUserIds: [], mappedCount: 0, unmappedCount: 0 }),
}))

import { POST } from '@/app/api/leads/[id]/send-to-jobber/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'
import { writeSyncLog } from '@/lib/sync-log'
import { parseVisitTimes, buildVisitSchedule } from '@/lib/jobber-job-visit'

const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')
const JOB_GID = gid('Job', '424242')
const CLIENT_GID = gid('Client', '136289662')
const PROP_GID = gid('Property', '880011')

const lead = {
  id: 'lead-1', location_id: 'loc_centraldenver', location_uuid: 'loc-uuid-1',
  name: 'Martha Wassel', first_name: 'Martha', last_name: 'Wassel', email: '', phone: '3035550100',
  addresses: [{ street: '12 Elm St', city: 'Denver', state: 'CO', zip: '80202' }],
  address: '12 Elm St', city: 'Denver', state: 'CO', zip: '80202',
  jobber_client_id: '136289662', jobber_property_id: null, jobber_request_id: null,
  jobber_assessment_id: null, jobber_job_id: null,
}

function chainFor(row: any) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'update', 'insert', 'upsert', 'in', 'order', 'limit']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: any) => resolve({ data: row, error: null })
  return chain
}

type Setup = { role?: string; timezone?: string | null; lifecycle?: string; visit?: 'ok' | 'refused' | 'throws' }

function wire(s: Setup = {}) {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor({ id: 'u1', role: s.role ?? 'owner', location_id: 'loc-uuid-1' })),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(lead)
    if (table === 'locations') {
      return chainFor({
        id: 'loc-uuid-1', location_id: 'loc_centraldenver', name: 'Central Denver',
        timezone: s.timezone === undefined ? 'Mountain Time (MT)' : s.timezone, jobber_access_token: 'tok',
        lifecycle_status: s.lifecycle ?? 'active', subscription_status: 'active',
      })
    }
    return chainFor(null)
  })
  ;(jobberGraphQL as any).mockImplementation(async (_loc: string, query: string) => {
    if (query.includes('GetClientById')) {
      return { data: { client: { id: CLIENT_GID, firstName: 'Martha', lastName: 'Wassel', companyName: null, emails: [], phones: [{ id: 'ph', number: '303-555-0100', primary: true }] } } }
    }
    if (query.includes('GetClientProperties')) {
      return { data: { client: { clientProperties: { nodes: [{ id: PROP_GID, address: { street1: '12 Elm St', street2: '', city: 'Denver', province: 'CO', postalCode: '80202' } }] } } } }
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`)
  })
  ;(jobberMutation as any).mockImplementation(async (_loc: string, mutation: string, vars: any) => {
    if (mutation.includes('clientEdit')) return { data: { clientEdit: { client: { id: vars.clientId } } } }
    if (mutation.includes('propertyCreate')) return { data: { propertyCreate: { properties: [{ id: PROP_GID }] } } }
    if (mutation.includes('jobCreate')) {
      return { data: { jobCreate: { job: { id: JOB_GID, createdAt: '2026-11-14T00:00:00Z', jobberWebUri: 'x', title: 't', jobStatus: 'upcoming', startAt: null, completedAt: null, total: 450, client: { id: CLIENT_GID }, property: { id: PROP_GID } } } } }
    }
    if (mutation.includes('visitCreate')) {
      if (s.visit === 'throws') throw new Error('Jobber GraphQL HTTP 503: busy')
      if (s.visit === 'refused') return { data: { visitCreate: { createdVisits: [], userErrors: [{ message: 'startAt needs to be before endAt' }] } }, userErrors: [{ message: 'startAt needs to be before endAt' }] }
      return { data: { visitCreate: { createdVisits: [{ id: gid('Visit', '9'), startAt: '2026-11-20T09:00:00-07:00', endAt: '2026-11-20T12:00:00-07:00' }], userErrors: [] } } }
    }
    throw new Error(`unexpected mutation: ${mutation.slice(0, 60)}`)
  })
}

async function send(extra: any = {}) {
  const req: any = new Request('http://test/api/leads/lead-1/send-to-jobber', {
    method: 'POST',
    body: JSON.stringify({ creation_type: 'job_direct', line_items: [{ name: 'Garage', unitPrice: 450, quantity: 1 }], ...extra }),
    headers: { 'Content-Type': 'application/json' },
  })
  req.nextUrl = new URL('http://test/api/leads/lead-1/send-to-jobber')
  const res = await POST(req, { params: Promise.resolve({ id: 'lead-1' }) } as any)
  return { status: res.status, json: await res.json() }
}

const calls = (name: string) => (jobberMutation as any).mock.calls.filter((c: any[]) => (c[1] as string).includes(name))
const lastLog = () => (writeSyncLog as any).mock.calls.map((c: any[]) => c[0]).filter((r: any) => String(r.message).startsWith('Send-to-Jobber')).pop()

beforeEach(() => { vi.clearAllMocks() })

describe('no time picked — exactly today\'s send', () => {
  it('a date alone: jobCreate carries the date only, NO visitCreate, NO visit key in the reply', async () => {
    wire()
    const r = await send({ scheduled_at: '2026-11-20' })
    expect(r.status).toBe(200)
    expect(r.json.success).toBe(true)
    expect(calls('jobCreate')).toHaveLength(1)
    const input = calls('jobCreate')[0][2].input
    expect(input.timeframe).toEqual({ startAt: '2026-11-20' })
    expect(input.scheduling, 'jobCreate itself is never asked to schedule').toBeUndefined()
    expect(calls('visitCreate')).toHaveLength(0)
    expect('visit' in r.json).toBe(false)
    expect(lastLog().message).not.toContain('visit=')
    expect(lastLog().status).toBe('success')
  })

  it('no date, no time: unscheduled exactly as before', async () => {
    wire()
    const r = await send()
    expect(r.json.success).toBe(true)
    expect(calls('jobCreate')[0][2].input.timeframe).toBeUndefined()
    expect(calls('visitCreate')).toHaveLength(0)
    expect('visit' in r.json).toBe(false)
  })

  it('a location with NO time zone still sends a date-only job (the zone is only needed for a time)', async () => {
    wire({ timezone: null })
    const r = await send({ scheduled_at: '2026-11-20' })
    expect(r.json.success).toBe(true)
  })
})

describe('a time picked — a real visit at the owner\'s local time', () => {
  it('books ONE visit on the new job, 9:00–12:00 on the LOCATION clock, with the location zone (Denver, not Eastern, not UTC)', async () => {
    wire()
    const r = await send({ scheduled_at: '2026-11-20', visit_start: '09:00', visit_end: '12:00' })
    expect(r.json.success).toBe(true)
    expect(calls('visitCreate')).toHaveLength(1)
    const [, , vars] = calls('visitCreate')[0]
    expect(vars.jobId).toBe(JOB_GID)
    expect(vars.input).toEqual({ visits: [{ schedule: {
      startAt: { date: '2026-11-20', time: '09:00:00', timezone: 'America/Denver' },
      endAt:   { date: '2026-11-20', time: '12:00:00', timezone: 'America/Denver' },
    } }] })
    expect(vars.input.visits[0].schedule.notifyTeam, 'never emails the team without Kevin').toBeUndefined()
    expect(r.json.visit).toEqual({ booked: true, date: '2026-11-20', start: '09:00', end: '12:00' })
    expect(lastLog().message).toContain('visit=booked 09:00-12:00')
  })

  it('the visit is created AFTER the job, on the job Jobber returned', async () => {
    wire()
    await send({ scheduled_at: '2026-11-20', visit_start: '09:00' })
    const order = (jobberMutation as any).mock.calls.map((c: any[]) => (c[1].includes('jobCreate') ? 'job' : c[1].includes('visitCreate') ? 'visit' : 'other'))
    expect(order.indexOf('job')).toBeLessThan(order.indexOf('visit'))
  })

  it('no end time: endAt is left off, so Jobber applies its own usual length', async () => {
    wire()
    const r = await send({ scheduled_at: '2026-11-20', visit_start: '14:30' })
    const sched = calls('visitCreate')[0][2].input.visits[0].schedule
    expect(sched.startAt).toEqual({ date: '2026-11-20', time: '14:30:00', timezone: 'America/Denver' })
    expect('endAt' in sched).toBe(false)
    expect(r.json.visit).toEqual({ booked: true, date: '2026-11-20', start: '14:30', end: null })
  })
})

describe('a refused visit never loses the job', () => {
  it('Jobber refuses the visit → the send still succeeds with the job id, says booked:false, and the log row is partial', async () => {
    wire({ visit: 'refused' })
    const r = await send({ scheduled_at: '2026-11-20', visit_start: '09:00', visit_end: '12:00' })
    expect(r.status).toBe(200)
    expect(r.json.success).toBe(true)
    expect(r.json.jobber_job_id).toBe('424242')
    expect(r.json.visit).toEqual({ booked: false, error: 'startAt needs to be before endAt' })
    expect(lastLog().status).toBe('partial')
    expect(lastLog().message).toContain('job=424242')
    expect(lastLog().message).toContain('visit=NOT booked (startAt needs to be before endAt)')
  })

  it('Jobber does not answer the visit call at all → same: job kept, booked:false', async () => {
    wire({ visit: 'throws' })
    const r = await send({ scheduled_at: '2026-11-20', visit_start: '09:00' })
    expect(r.status).toBe(200)
    expect(r.json.success).toBe(true)
    expect(r.json.jobber_job_id).toBe('424242')
    expect(r.json.visit.booked).toBe(false)
    expect(r.json.visit.error).toContain('503')
  })
})

describe('refused before any Jobber write', () => {
  it('a time but the location has no time zone → 400, nothing created', async () => {
    wire({ timezone: null })
    const r = await send({ scheduled_at: '2026-11-20', visit_start: '09:00' })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain("time zone isn't set")
    expect(calls('jobCreate')).toHaveLength(0)
    expect(calls('visitCreate')).toHaveLength(0)
  })

  it.each([
    [{ visit_start: '09:00' }, 'a start time needs a date'],
    [{ scheduled_at: '2026-11-20', visit_end: '12:00' }, 'an end time needs a start time'],
    [{ scheduled_at: '2026-11-20', visit_start: '9am' }, 'start time is not a valid time'],
    [{ scheduled_at: '2026-11-20', visit_start: '12:00', visit_end: '09:00' }, 'end time must be after the start time'],
    [{ scheduled_at: '2026-11-20', visit_start: '12:00', visit_end: '12:00' }, 'end time must be after the start time'],
  ])('%o → 400 (%s), no Jobber write', async (extra, msg) => {
    wire()
    const r = await send(extra)
    expect(r.status).toBe(400)
    expect(r.json.error).toContain(msg)
    expect((jobberMutation as any).mock.calls).toHaveLength(0)
  })
})

describe('read-only users cannot send', () => {
  it('a lite_user (read-only role) gets 403 and nothing reaches Jobber', async () => {
    wire({ role: 'lite_user' })
    const r = await send({ scheduled_at: '2026-11-20', visit_start: '09:00' })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe('forbidden_read_only_role')
    expect((jobberMutation as any).mock.calls).toHaveLength(0)
    expect((jobberGraphQL as any).mock.calls).toHaveLength(0)
  })

  it('an owner at a paused (read-only) location gets 403 and nothing reaches Jobber', async () => {
    wire({ lifecycle: 'paused' })
    const r = await send({ scheduled_at: '2026-11-20', visit_start: '09:00' })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe('forbidden_read_only_location')
    expect((jobberMutation as any).mock.calls).toHaveLength(0)
  })
})

describe('the pure pieces', () => {
  it('parseVisitTimes: nothing asked → null (the date-only path)', () => {
    expect(parseVisitTimes('2026-11-20', undefined, undefined)).toEqual({ ok: true, times: null })
    expect(parseVisitTimes(null, '', '  ')).toEqual({ ok: true, times: null })
  })
  it('buildVisitSchedule keeps the wall clock and names the zone — no UTC conversion anywhere', () => {
    expect(buildVisitSchedule('2026-03-08', { start: '09:00', end: null }, 'America/Phoenix'))
      .toEqual({ startAt: { date: '2026-03-08', time: '09:00:00', timezone: 'America/Phoenix' } })
  })
})
