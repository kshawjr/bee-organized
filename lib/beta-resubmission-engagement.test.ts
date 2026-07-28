// @vitest-environment node
//
// #94 — a webform resubmission from an existing client now produces a visibly-
// returning ENGAGEMENT, not just a notification:
//   · client has NO open engagement (incl. a Closed Won client's next job) →
//     found ONE fresh manual engagement at Request
//   · client HAS an open engagement → do NOT found a second; surface the new
//     request onto it (touchpoint anchored to it + updated_at bump)
//   · two resubmissions in a row → still ONE engagement
//   · the #86 notification (email + Slack, resubmission:true) STILL fires in
//     every case
//   · the lead's own stage is never touched (drip-safe)
//
// The engagement internals (found vs adopt, terminality) are pinned in
// beta-returning-engagement.test.ts; here @/lib/engagements is mocked so we pin
// only the intake WIRING — which path runs, what the touchpoint carries, that
// the notification still fires.
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

const notifyMock = vi.hoisted(() => vi.fn(async () => ({ sent: true, recipientCount: 3 })))
const slackMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as any))
const findOpenMock = vi.hoisted(() => vi.fn(async () => null as any))
const foundManualMock = vi.hoisted(() => vi.fn(async () => ({ engagement: { id: 'eng-F' }, created: true }) as any))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => ({ sent: true })) }))
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

const LOC = { id: 'loc-uuid-1', name: 'Boulder', location_id: 'boulder-01', lifecycle_status: 'active' }
const makeReq = (body: any, key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => body,
  nextUrl: { origin: 'https://hub.example.com' },
}) as any
const submission = (over: any = {}) => ({
  location_slug: 'boulder-01', full_name: 'Jane Prospect', email: 'jane@example.com',
  phone: '(555) 111-2222', project_type: 'Organizing', message: 'Hoping for a quote on the playroom.', ...over,
})
const storedLead = (over: any = {}) => ({
  id: 'lead-A', name: 'Jane Prospect', email: 'jane@example.com', phone: '(555) 111-2222',
  phone_normalized: '5551112222', stage: 'Nurturing', is_junk: null, location_uuid: 'loc-uuid-1',
  created_at: '2026-01-01T00:00:00.000Z', ...over,
})

const touchpointInsert = () => {
  const c = h.state.calls.find(c => c.table === 'touchpoints' &&
    c.ops.some(([m, a]: any) => m === 'insert' && a[0]?.label === 'Webform resubmission'))
  return c ? c.ops.find(([m]: any) => m === 'insert')![1][0] : null
}
const engagementUpdate = () => {
  const c = h.state.calls.find(c => c.table === 'engagements' && c.ops.some(([m]: any) => m === 'update'))
  if (!c) return null
  return { payload: c.ops.find(([m]: any) => m === 'update')![1][0], eq: c.ops.find(([m]: any) => m === 'eq')?.[1] }
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  notifyMock.mockResolvedValue({ sent: true, recipientCount: 3 })
  slackMock.mockResolvedValue({ ok: true })
  findOpenMock.mockResolvedValue(null)
  foundManualMock.mockResolvedValue({ engagement: { id: 'eng-F' }, created: true })
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
  h.enqueue('locations', LOC)
})

describe('#94 resubmission → founds an engagement when none is open', () => {
  it('no open engagement → founds ONE manual engagement, touchpoint anchored to it, action=founded', async () => {
    h.enqueue('leads', [storedLead()]) // SOLID match
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(findOpenMock).toHaveBeenCalledWith('lead-A')
    expect(foundManualMock).toHaveBeenCalledTimes(1)
    expect(foundManualMock.mock.calls[0][0]).toMatchObject({ clientId: 'lead-A' })
    // The resubmission touchpoint lands on the new engagement's timeline.
    expect(touchpointInsert()?.engagement_id).toBe('eng-F')
    // A freshly founded engagement is already current — no updated_at bump write.
    expect(engagementUpdate()).toBeNull()
    expect(body.engagement_id).toBe('eng-F')
    expect(body.engagement_action).toBe('founded')
  })

  it('a Closed Won client founds a NEW engagement (terminal is not open → resolver returns null)', async () => {
    // findOpenEngagementForClient excludes terminals, so a won client reads as
    // "no open engagement" and founds fresh (their prior Won card is untouched).
    findOpenMock.mockResolvedValue(null)
    h.enqueue('leads', [storedLead({ stage: 'Closed Won' })])
    const res = await POST(makeReq(submission({ message: "Loved your work — playroom next." })))
    const body = await res.json()

    expect(foundManualMock).toHaveBeenCalledTimes(1)
    expect(body.engagement_action).toBe('founded')
  })
})

describe('#94 resubmission → surfaces onto the existing open engagement', () => {
  it('open engagement exists → NO second founded; touchpoint anchored + updated_at bumped; action=updated', async () => {
    findOpenMock.mockResolvedValue({ id: 'eng-O', stage: 'Request', founded_by: 'manual', created_at: '2026-07-20T00:00:00Z' })
    h.enqueue('leads', [storedLead()])
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(foundManualMock).not.toHaveBeenCalled()
    expect(touchpointInsert()?.engagement_id).toBe('eng-O')
    const upd = engagementUpdate()
    expect(upd?.eq).toEqual(['id', 'eng-O'])
    expect(upd?.payload).toHaveProperty('updated_at')
    expect(body.engagement_id).toBe('eng-O')
    expect(body.engagement_action).toBe('updated')
  })

  it('two resubmissions in a row → still ONE engagement (second surfaces onto the first)', async () => {
    // First: nothing open → founds. Second: the founded one is now open → surface.
    findOpenMock.mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'eng-F', stage: 'Request', founded_by: 'manual', created_at: '2026-07-28T00:00:00Z' })
    h.enqueue('leads', [storedLead()])
    await POST(makeReq(submission()))
    h.enqueue('locations', LOC)
    h.enqueue('leads', [storedLead()])
    const body2 = await (await POST(makeReq(submission({ message: 'Any update?' })))).json()

    expect(foundManualMock).toHaveBeenCalledTimes(1) // founded exactly once across both
    expect(body2.engagement_action).toBe('updated')
  })
})

describe('#94 keeps the #86 notification and the no-stage-change contract', () => {
  it('the resubmission notification (email + Slack, resubmission:true) fires whether founded OR surfaced', async () => {
    // founded case
    h.enqueue('leads', [storedLead()])
    await POST(makeReq(submission()))
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ resubmission: true }))
    expect(slackMock).toHaveBeenCalledWith(expect.objectContaining({ resubmission: true }))

    // surfaced case
    vi.clearAllMocks()
    notifyMock.mockResolvedValue({ sent: true, recipientCount: 3 })
    slackMock.mockResolvedValue({ ok: true })
    findOpenMock.mockResolvedValue({ id: 'eng-O', stage: 'Estimate', founded_by: 'manual', created_at: '2026-07-20T00:00:00Z' })
    h.enqueue('locations', LOC)
    h.enqueue('leads', [storedLead()])
    await POST(makeReq(submission()))
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ resubmission: true }))
    expect(slackMock).toHaveBeenCalledWith(expect.objectContaining({ resubmission: true }))
  })

  it('a founding failure is non-fatal — lead still 200s, warns, and the notification STILL fires', async () => {
    foundManualMock.mockResolvedValue({ error: 'engagement insert: boom' })
    h.enqueue('leads', [storedLead()])
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.merged).toBe(true)
    expect(body.engagement_id).toBeUndefined()
    expect(body.warnings).toEqual(expect.arrayContaining([expect.stringContaining('engagement_found_failed: engagement insert: boom')]))
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ resubmission: true }))
  })

  it('never writes a stage: no leads.update in the merge carries a stage key', async () => {
    findOpenMock.mockResolvedValue(null)
    h.enqueue('leads', [storedLead({ stage: 'Nurturing' })])
    await POST(makeReq(submission()))
    const leadUpdates = h.state.calls.filter(c => c.table === 'leads' && c.ops.some(([m]: any) => m === 'update'))
    for (const c of leadUpdates) {
      const payload = c.ops.find(([m]: any) => m === 'update')![1][0]
      expect(payload).not.toHaveProperty('stage')
    }
  })
})
