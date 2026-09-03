// @vitest-environment node
//
// Fresh-lead guard (3 Sept 2026) — a webform resubmission founds a Request
// engagement ONLY for a past client.
//
// The #94 founding was built for a past client's genuine next job. It had no
// check for history, so a brand-new website lead whose form arrived twice
// (1½–3 minutes apart in three prod cases, a day later in one) got a Request
// engagement, derived Active, and vanished from the Inbox, the badge and the
// Home tile — six uncalled leads, one invisible for 36 days. The guard asks
// isPastClient (Jobber-imported, or a closed engagement on record — the same
// test the returning-client sequence already applied) BEFORE founding, once,
// and reuses the answer.
//
// Pinned here:
//   · a second form from a lead with NO history → nothing founded; the merge,
//     the notification and the lead-level touchpoint all still happen; the
//     log line and response say why
//   · a second form from a genuine past client → founds ONE engagement, as today
//   · a FIRST form from a new lead → the create path, untouched
//   · the returning-client sequence enrols exactly the same people as before:
//     past client → enrolled; fresh lead → not; open engagement → not asked
//   · the check failing → nothing founded (fail toward visibility), a warning,
//     and the merge + notification still stand
//
// Same harness as beta-resubmission-engagement.test.ts: @/lib/engagements and
// @/lib/drip-lifecycle are mocked so only the intake WIRING is pinned.
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
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
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

const LOC = { id: 'loc-uuid-1', name: 'NW Arkansas', location_id: 'loc_nwarkansas', lifecycle_status: 'active' }
const makeReq = (body: any, key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => body,
  nextUrl: { origin: 'https://hub.example.com' },
}) as any
// Jane Cater's second form: same name, email and phone, no message this time.
const submission = (over: any = {}) => ({
  location_slug: 'loc_nwarkansas', full_name: 'Jane Cater', email: 'jane@example.com',
  phone: '(479) 555-0100', project_type: 'Moving', ...over,
})
const storedLead = (over: any = {}) => ({
  id: 'lead-A', name: 'Jane Cater', email: 'jane@example.com', phone: '(479) 555-0100',
  phone_normalized: '4795550100', stage: 'New', is_junk: null, location_uuid: 'loc-uuid-1',
  import_source: 'manual', created_at: '2026-08-09T17:49:17.000Z',
  request_details: 'Early stages of deciding where I will move.', ...over,
})
const intakeLogLine = () => {
  const call = syncLogMock.mock.calls.find((c: any[]) => String(c[0]?.message || '').startsWith('[intake] topic=LEAD_INTAKE'))
  return call ? String((call as any[])[0].message) : ''
}
const touchpointInsert = () => {
  const c = h.state.calls.find(c => c.table === 'touchpoints' &&
    c.ops.some(([m, a]: any) => m === 'insert' && a[0]?.label === 'Webform resubmission'))
  return c ? c.ops.find(([m]: any) => m === 'insert')![1][0] : null
}
const leadInserts = () => h.state.calls
  .filter(c => c.table === 'leads' && c.ops.some(([m]: any) => m === 'insert'))
  .map(c => c.ops.find(([m]: any) => m === 'insert')![1][0])

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

describe('a second form from a lead with NO history founds nothing', () => {
  it('merges, notifies, leaves a lead-level touchpoint — and founds no engagement', async () => {
    isPastClientMock.mockResolvedValue(false)
    h.enqueue('leads', [storedLead()]) // SOLID match on email+phone
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('lead-A')
    expect(isPastClientMock).toHaveBeenCalledWith('lead-A')
    expect(foundManualMock).not.toHaveBeenCalled()
    // No second leads row either — the merge is untouched.
    expect(leadInserts()).toHaveLength(0)
    // The resubmission trace still lands, at LEAD level (nothing to anchor to).
    const tp = touchpointInsert()
    expect(tp).toMatchObject({ lead_id: 'lead-A', label: 'Webform resubmission', kind: 'system' })
    expect(tp.engagement_id).toBeNull()
    // The owner is still told — a second form is still a signal.
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(slackMock).toHaveBeenCalledTimes(1)
    // And the record says why nothing was founded, in both places.
    expect(body.engagement_id).toBeUndefined()
    expect(body.engagement_action).toBe('skipped')
    expect(body.engagement_skipped).toBe('not_past_client')
    expect(intakeLogLine()).toContain('engagement=skipped:not_past_client')
    expect(intakeLogLine()).not.toContain('engagement=founded')
  })

  it('a day later with a real message: still no founding (the gap is not the test — history is)', async () => {
    isPastClientMock.mockResolvedValue(false)
    h.enqueue('leads', [storedLead({ request_details: null })])
    const body = await (await POST(makeReq(submission({ message: 'I have used your service before and it was amazing!' })))).json()
    expect(foundManualMock).not.toHaveBeenCalled()
    expect(body.engagement_action).toBe('skipped')
    // The message still backfills the empty request_details, as the merge always did.
    const upd = h.state.calls.find(c => c.table === 'leads' && c.ops.some(([m]: any) => m === 'update'))
    expect(upd!.ops.find(([m]: any) => m === 'update')![1][0].request_details).toContain('used your service before')
  })
})

describe('a second form from a genuine past client still founds one, as today', () => {
  it('past client (Jobber-imported or a closed engagement) → ONE engagement founded, touchpoint anchored to it', async () => {
    isPastClientMock.mockResolvedValue(true)
    h.enqueue('leads', [storedLead({ name: 'Natalie Miller', stage: 'Closed Won', import_source: 'jobber_initial' })])
    const body = await (await POST(makeReq(submission({ full_name: 'Natalie Miller', message: 'Back for the garage.' })))).json()

    expect(isPastClientMock).toHaveBeenCalledWith('lead-A')
    expect(foundManualMock).toHaveBeenCalledTimes(1)
    expect(foundManualMock.mock.calls[0][0]).toMatchObject({ clientId: 'lead-A' })
    expect(touchpointInsert()?.engagement_id).toBe('eng-F')
    expect(body.engagement_id).toBe('eng-F')
    expect(body.engagement_action).toBe('founded')
    expect(body.engagement_skipped).toBeUndefined()
    expect(intakeLogLine()).toContain('engagement=founded:eng-F')
  })

  it('the past-client question is asked ONCE per resubmission', async () => {
    h.enqueue('leads', [storedLead({ stage: 'Closed Won' })])
    await POST(makeReq(submission()))
    expect(isPastClientMock).toHaveBeenCalledTimes(1)
  })
})

describe('a FIRST form from a new lead behaves exactly as today', () => {
  it('no match → a new leads row, no founding, no past-client question, no resubmission touchpoint', async () => {
    h.enqueue('leads', []) // strong keys: nothing
    h.enqueue('leads', []) // name: nothing
    h.enqueue('leads', { id: 'lead-new-1' }) // insert
    const body = await (await POST(makeReq(submission({ message: 'Early stages of deciding where I will move.' })))).json()

    expect(body.success).toBe(true)
    expect(body.lead_id).toBe('lead-new-1')
    expect(body.merged).toBeUndefined()
    expect(leadInserts()).toHaveLength(1)
    expect(isPastClientMock).not.toHaveBeenCalled()
    expect(findOpenMock).not.toHaveBeenCalled()
    expect(foundManualMock).not.toHaveBeenCalled()
    expect(touchpointInsert()).toBeNull()
    expect(body.engagement_action).toBeUndefined()
    expect(notifyMock).toHaveBeenCalledTimes(1)
  })
})

describe('the returning-client email sequence enrols exactly the same people as before', () => {
  it('past client → founded AND enrolled, step 1 sent inline', async () => {
    isPastClientMock.mockResolvedValue(true)
    h.enqueue('leads', [storedLead({ stage: 'Closed Won' })])
    await POST(makeReq(submission()))
    expect(foundManualMock).toHaveBeenCalledTimes(1)
    expect(enrolReturningMock).toHaveBeenCalledWith('lead-A', 'loc-uuid-1')
    expect(sendDripStepMock).toHaveBeenCalledWith('lead-A')
    expect(intakeLogLine()).toContain('returning_drip=enrolled')
  })

  it('fresh lead → not founded, NOT enrolled; the log token reads exactly as it did before the guard', async () => {
    isPastClientMock.mockResolvedValue(false)
    h.enqueue('leads', [storedLead()])
    await POST(makeReq(submission()))
    expect(enrolReturningMock).not.toHaveBeenCalled()
    expect(sendDripStepMock).not.toHaveBeenCalled()
    expect(intakeLogLine()).toContain('returning_drip=skipped:not_past_client')
  })

  it('open engagement → surfaced onto it; the past-client question is never asked; nothing enrolled', async () => {
    findOpenMock.mockResolvedValue({ id: 'eng-O', stage: 'Request', founded_by: 'manual', created_at: '2026-09-01T00:00:00Z' })
    h.enqueue('leads', [storedLead()])
    const body = await (await POST(makeReq(submission()))).json()
    expect(isPastClientMock).not.toHaveBeenCalled()
    expect(foundManualMock).not.toHaveBeenCalled()
    expect(enrolReturningMock).not.toHaveBeenCalled()
    expect(body.engagement_action).toBe('updated')
    expect(touchpointInsert()?.engagement_id).toBe('eng-O')
    expect(intakeLogLine()).toContain('returning_drip=skipped:not_founded')
  })
})

describe('the check failing fails toward visibility', () => {
  it('isPastClient throws → nothing founded, a warning on the response, merge + notification still stand', async () => {
    isPastClientMock.mockRejectedValue(new Error('db down'))
    h.enqueue('leads', [storedLead({ stage: 'Closed Won' })])
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.merged).toBe(true)
    expect(foundManualMock).not.toHaveBeenCalled()
    expect(enrolReturningMock).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(touchpointInsert()?.engagement_id).toBeNull()
    expect(body.engagement_skipped).toBe('past_client_check_failed')
    expect(body.warnings.some((w: string) => w.startsWith('past_client_check_failed: db down'))).toBe(true)
    expect(intakeLogLine()).toContain('engagement=skipped:past_client_check_failed')
  })
})
