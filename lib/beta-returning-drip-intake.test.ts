// @vitest-environment node
//
// The returning-client sequence — intake wiring.
//
// Pins WHICH sequence a website resubmission lands in, at the one place the
// decision is made (the merge path of POST /api/leads/intake):
//
//   · a PAST client whose resubmission founds a fresh Request engagement →
//     the returning sequence (enrolReturningSequence), never the ordinary
//     drip, and step 1 is attempted inline
//   · a NEW lead who submitted the form twice (not a past client) → the
//     ordinary drip exactly as before, never the returning sequence
//   · a client MID-JOB (open engagement → request surfaced onto it, nothing
//     founded) → neither
//   · the log line carries returning_drip=<outcome> so a silent skip is
//     visible on the Webhooks tab
//
// The lifecycle internals are pinned in beta-returning-drip-lifecycle.test.ts;
// @/lib/drip-lifecycle is mocked here so only the wiring is under test.
// Harness follows lib/beta-resubmission-engagement.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const syncLogMock = vi.hoisted(() => vi.fn(async () => {}))
const notifyMock = vi.hoisted(() => vi.fn(async () => ({ sent: true, recipientCount: 3 })))
const slackMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as any))
const findOpenMock = vi.hoisted(() => vi.fn(async () => null as any))
const foundManualMock = vi.hoisted(() => vi.fn(async () => ({ engagement: { id: 'eng-F' }, created: true }) as any))
const startDripMock = vi.hoisted(() => vi.fn(async () => {}))
const isPastClientMock = vi.hoisted(() => vi.fn(async () => true))
const enrolReturningMock = vi.hoisted(() => vi.fn(async () => ({ enrolled: true }) as any))
const sendDripStepMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: syncLogMock }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: startDripMock,
  isPastClient: isPastClientMock,
  enrolReturningSequence: enrolReturningMock,
}))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: sendDripStepMock }))
vi.mock('@/lib/lead-notification-email', () => ({ notifyNewLead: notifyMock }))
vi.mock('@/lib/slack-bot', () => ({ notifyNewLeadSlack: slackMock }))
vi.mock('@/lib/notification-log', () => ({ logSlackNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/lead-assignment', () => ({
  assignIncomingLead: vi.fn(async () => ({ hubUserIds: ['u1'], basis: 'config', warnings: [] })),
  getLeadAssigneeIds: vi.fn(async () => ['u1']),
}))
vi.mock('@/lib/engagements', () => ({
  findOpenEngagementForClient: findOpenMock,
  foundManualEngagement: foundManualMock,
}))

import { POST } from '@/app/api/leads/intake/route'

const LOC = { id: 'loc-uuid-1', name: 'Seattle', location_id: 'loc_seattle', lifecycle_status: 'active' }
const makeReq = (body: any, key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => body,
  nextUrl: { origin: 'https://hub.example.com' },
}) as any
const submission = (over: any = {}) => ({
  location_slug: 'loc_seattle', full_name: 'Natalie Miller', email: 'natalie@example.com',
  phone: '(206) 555-0100', project_type: 'Organizing', message: 'Back for the garage this time.', ...over,
})
const storedLead = (over: any = {}) => ({
  id: 'lead-A', name: 'Natalie Miller', email: 'natalie@example.com', phone: '(206) 555-0100',
  phone_normalized: '2065550100', stage: 'Closed Won', is_junk: null, location_uuid: 'loc-uuid-1',
  created_at: '2025-04-07T00:00:00.000Z', ...over,
})
const intakeLogLine = () => {
  const call = syncLogMock.mock.calls.find((c: any[]) => String(c[0]?.message || '').startsWith('[intake] topic=LEAD_INTAKE'))
  return call ? String((call as any[])[0].message) : ''
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  notifyMock.mockResolvedValue({ sent: true, recipientCount: 3 })
  slackMock.mockResolvedValue({ ok: true })
  findOpenMock.mockResolvedValue(null)
  foundManualMock.mockResolvedValue({ engagement: { id: 'eng-F' }, created: true })
  isPastClientMock.mockResolvedValue(true)
  enrolReturningMock.mockResolvedValue({ enrolled: true })
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
  h.enqueue('locations', LOC)
})

describe('a past client whose resubmission founds a Request engagement', () => {
  it('enrols in the RETURNING sequence, sends step 1 inline, never touches the ordinary drip', async () => {
    h.enqueue('leads', [storedLead({ stage: 'Closed Won' })]) // SOLID match on email
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(foundManualMock).toHaveBeenCalledTimes(1)
    expect(isPastClientMock).toHaveBeenCalledWith('lead-A')
    expect(enrolReturningMock).toHaveBeenCalledWith('lead-A', 'loc-uuid-1')
    expect(sendDripStepMock).toHaveBeenCalledWith('lead-A')
    // The ordinary drip is not for a Closed Won client — unchanged behaviour.
    expect(startDripMock).not.toHaveBeenCalled()
    expect(intakeLogLine()).toContain('returning_drip=enrolled')
  })

  it('a paused (imported) client is still enrolled — the pause is the lifecycle\'s to bypass, not the intake\'s to check', async () => {
    h.enqueue('leads', [storedLead({ stage: 'Nurturing', paused: true })])
    await POST(makeReq(submission()))
    expect(enrolReturningMock).toHaveBeenCalledWith('lead-A', 'loc-uuid-1')
  })

  it('a lifecycle skip is reported on the log line, never hidden', async () => {
    enrolReturningMock.mockResolvedValue({ enrolled: false, reason: 'location_not_active' })
    h.enqueue('leads', [storedLead()])
    await POST(makeReq(submission()))
    expect(sendDripStepMock).not.toHaveBeenCalled()
    expect(intakeLogLine()).toContain('returning_drip=skipped:location_not_active')
  })
})

describe('a NEW lead who submitted the form twice', () => {
  it('is not a past client → ordinary drip as before, returning sequence never called', async () => {
    isPastClientMock.mockResolvedValue(false)
    // Stage New, no progress row → the existing merge-path branch enrols the
    // ordinary drip (startDripForLead) exactly as it did before this change.
    h.enqueue('leads', [storedLead({ stage: 'New', created_at: '2026-09-01T00:00:00.000Z' })])
    h.enqueue('lead_drip_progress', null)        // anyProgress → none
    h.enqueue('lead_drip_progress', { id: 'p1' }) // seeded re-check → yes
    await POST(makeReq(submission()))

    expect(foundManualMock).toHaveBeenCalledTimes(1) // the engagement is still founded (#94)
    expect(enrolReturningMock).not.toHaveBeenCalled()
    expect(startDripMock).toHaveBeenCalledWith('lead-A', 'loc-uuid-1')
    expect(intakeLogLine()).toContain('returning_drip=skipped:not_past_client')
    expect(intakeLogLine()).toContain('drip_enrolled=true')
  })
})

describe('a client MID-JOB (open engagement)', () => {
  it('request is surfaced onto the open engagement; nothing founded; no sequence of either kind', async () => {
    findOpenMock.mockResolvedValue({ id: 'eng-O', stage: 'Job in Progress', founded_by: 'job', created_at: '2026-08-01T00:00:00Z' })
    h.enqueue('leads', [storedLead({ stage: 'Closed Won' })])
    await POST(makeReq(submission()))

    expect(foundManualMock).not.toHaveBeenCalled()
    expect(isPastClientMock).not.toHaveBeenCalled()
    expect(enrolReturningMock).not.toHaveBeenCalled()
    expect(startDripMock).not.toHaveBeenCalled()
    expect(intakeLogLine()).toContain('returning_drip=skipped:not_founded')
  })
})

describe('the resubmission itself is never at risk', () => {
  it('an enrol throw is a warning on the response, and the merge + notification still stand', async () => {
    enrolReturningMock.mockRejectedValue(new Error('boom'))
    h.enqueue('leads', [storedLead()])
    const body = await (await POST(makeReq(submission()))).json()
    expect(body.merged).toBe(true)
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(body.warnings).toEqual(expect.arrayContaining([expect.stringContaining('returning_drip_failed: boom')]))
  })
})
