// @vitest-environment node
// /api/leads/intake — new-lead notification gate (B2).
//
// The internal "a lead came in" email is wired to the CREATE path ONLY:
//   • NO MATCH → new leads row → notifyNewLead is called with the captured
//     fields (name / email / phone / project_type / request_details /
//     preferred_contact) and the lead's location.
//   • SOLID merge / resubmission of an existing lead → notifyNewLead is
//     NEVER called (a returning client must not re-notify).
//   • A notification failure is non-fatal: the lead still lands (200) and
//     the failure surfaces as a warning, never a 500.
// notifyNewLead itself (recipient fan-out, one-email-to-all, zero-recipient
// quiet no-send) is unit-tested in lead-notification-email.test.ts; here it
// is mocked so we pin only the CREATE-vs-MERGE wiring.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock supabaseService: same recording builder as beta-intake-dedup.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
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

const notifyMock = vi.hoisted(() =>
  vi.fn(async () => ({ sent: true, recipientCount: 3 })),
)

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-send', () => ({
  sendDripStep: vi.fn(async () => ({ sent: true })),
}))
vi.mock('@/lib/lead-notification-email', () => ({
  notifyNewLead: notifyMock,
}))

import { POST } from '@/app/api/leads/intake/route'

const LOC = {
  id: 'loc-uuid-1',
  name: 'Boulder',
  location_id: 'boulder-01',
  lifecycle_status: 'onboarding',
}

const makeReq = (body: any, key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => body,
}) as any

const submission = (over: any = {}) => ({
  location_slug: 'boulder-01',
  full_name: 'Jane Prospect',
  email: 'jane@example.com',
  phone: '(555) 111-2222',
  project_type: 'Moving',
  message: 'Need help packing a 3-bedroom.',
  preferred_contact: 'Text',
  ...over,
})

const storedLead = (over: any = {}) => ({
  id: 'lead-A',
  name: 'Jane Prospect',
  email: 'jane@example.com',
  phone: null,
  phone_normalized: '',
  stage: 'New',
  is_junk: null,
  location_uuid: 'loc-uuid-1',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  notifyMock.mockResolvedValue({ sent: true, recipientCount: 3 })
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
  h.enqueue('locations', LOC)
})

describe('intake notification — CREATE path', () => {
  it('a NEW lead calls notifyNewLead once with the captured fields + location', async () => {
    // dedup match query returns nothing → NO MATCH → create
    h.enqueue('leads', []) // strong-key match query
    h.enqueue('leads', []) // name-only match query
    h.enqueue('leads', { id: 'lead-new' }) // insert .select().single()

    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.merged).toBeUndefined()
    expect(body.lead_id).toBe('lead-new')

    expect(notifyMock).toHaveBeenCalledTimes(1)
    const arg = notifyMock.mock.calls[0][0]
    expect(arg.location).toEqual({ id: 'loc-uuid-1', name: 'Boulder' })
    expect(arg.lead).toMatchObject({
      id: 'lead-new',
      name: 'Jane Prospect',
      email: 'jane@example.com',
      phone: '(555) 111-2222',
      project_type: 'Moving',
      request_details: 'Need help packing a 3-bedroom.',
      preferred_contact: 'Text',
    })
  })

  it('a notification failure is non-fatal — lead still lands (200) with a warning', async () => {
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new' })
    notifyMock.mockResolvedValue({ sent: false, recipientCount: 0, error: 'resend down' })

    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.lead_id).toBe('lead-new')
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('lead_notification_failed: resend down')]),
    )
  })

  it('a notification THROW is caught — lead still lands with a warning', async () => {
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new' })
    notifyMock.mockRejectedValue(new Error('boom'))

    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('lead_notification_failed: boom')]),
    )
  })
})

describe('intake notification — MERGE path never notifies', () => {
  it('a SOLID resubmission of an existing lead does NOT call notifyNewLead', async () => {
    // strong-key match query returns exactly one existing lead → SOLID merge
    h.enqueue('leads', [storedLead()])

    const res = await POST(makeReq(submission({ message: 'Back again, add the garage.' })))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('lead-A')

    expect(notifyMock).not.toHaveBeenCalled()
  })
})
