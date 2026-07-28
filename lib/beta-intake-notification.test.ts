// @vitest-environment node
// /api/leads/intake — new-lead notification gate (B2).
//
// The internal "a lead came in" notification is wired to BOTH intake outcomes:
//   • NO MATCH → new leads row → notifyNewLead is called with the captured
//     fields (name / email / phone / project_type / request_details /
//     preferred_contact) and the lead's location.
//   • SOLID merge / resubmission of an existing lead (#86) → notifyNewLead AND
//     the Slack rail are called with resubmission:true, carrying the newly
//     submitted message. (Reverses the original "returning client must not
//     re-notify" rule — a returning client with a fresh request was a silent
//     revenue leak.) No stage change; the Webform resubmission touchpoint is
//     still written.
//   • A notification failure is non-fatal on either path: the lead still lands
//     (200) and the failure surfaces as a warning, never a 500.
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
// #86 — the merge/resubmission path now ALSO fires the Slack rail (create-path
// parity). Mocked here to pin the wiring; the card copy is unit-tested in
// slack-bot.test.ts. logSlackNotification is mocked to a no-op — the route calls
// it after every Slack attempt and its own behavior is pinned in notification-log.
const slackMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true }) as any),
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
vi.mock('@/lib/slack-bot', () => ({
  notifyNewLeadSlack: slackMock,
}))
vi.mock('@/lib/notification-log', () => ({
  logSlackNotification: vi.fn(async () => {}),
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
  // Intake derives the lead-notification deep-link base from the request
  // origin (NEXT_PUBLIC_SITE_URL override falls back to this).
  nextUrl: { origin: 'https://hub.example.com' },
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
  slackMock.mockResolvedValue({ ok: true })
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

  it('a NEW lead forwards the submitted address to BOTH the email and the Slack rail (#92)', async () => {
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new' })

    await POST(makeReq(submission({ address: '123 Main St', city: 'Seattle', state: 'WA', zip: '98101' })))

    expect(notifyMock.mock.calls[0][0].lead).toMatchObject({
      address: '123 Main St', city: 'Seattle', state: 'WA', zip: '98101',
    })
    expect(slackMock.mock.calls[0][0].lead).toMatchObject({
      address: '123 Main St', city: 'Seattle', state: 'WA', zip: '98101',
    })
  })

  it('a zip-only new lead still forwards the zip (the dominant website case, #92)', async () => {
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new' })

    await POST(makeReq(submission({ zip: '98101' })))

    expect(notifyMock.mock.calls[0][0].lead).toMatchObject({ zip: '98101', address: null, city: null, state: null })
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

// #86 — the merge/resubmission path used to be silent (a returning client was
// invisible to the owner: no email, no Slack, no notification_log row — a live
// revenue leak). It now notifies via the SAME path as a new lead, marked
// resubmission:true. These pins invert the old "MERGE never notifies" contract.
describe('intake notification — MERGE/resubmission path (#86) NOW notifies', () => {
  it('a SOLID resubmission calls notifyNewLead with resubmission:true, the matched id, and the submitted message', async () => {
    // strong-key match query returns exactly one existing lead → SOLID merge
    h.enqueue('leads', [storedLead()])

    const res = await POST(makeReq(submission({ message: 'Back again, add the garage.' })))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('lead-A')

    expect(notifyMock).toHaveBeenCalledTimes(1)
    const arg = notifyMock.mock.calls[0][0]
    expect(arg.resubmission).toBe(true)
    expect(arg.location).toEqual({ id: 'loc-uuid-1', name: 'Boulder' })
    expect(arg.lead).toMatchObject({
      id: 'lead-A',
      name: 'Jane Prospect',
      // The alert carries what they JUST submitted, not the stored request_details.
      request_details: 'Back again, add the garage.',
    })
  })

  it('a SOLID resubmission carries the address to BOTH email and Slack — submitted value wins (#92)', async () => {
    // The returning client typed a fresh address on this submission — the alert
    // must carry what they JUST submitted, on both rails.
    h.enqueue('leads', [storedLead({ address: 'OLD 1 St', city: 'Denver', state: 'CO', zip: '80202' })])

    await POST(makeReq(submission({ address: '999 New Ave', city: 'Seattle', state: 'WA', zip: '98101' })))

    expect(notifyMock.mock.calls[0][0].resubmission).toBe(true)
    expect(notifyMock.mock.calls[0][0].lead).toMatchObject({
      address: '999 New Ave', city: 'Seattle', state: 'WA', zip: '98101',
    })
    expect(slackMock.mock.calls[0][0].lead).toMatchObject({
      address: '999 New Ave', city: 'Seattle', state: 'WA', zip: '98101',
    })
  })

  it('a SOLID resubmission with NO submitted address falls back to the matched lead\'s stored address (#92)', async () => {
    // Submission carries no address fields → the notification uses what the
    // matched lead already had on record (submitted-else-stored, mirroring the
    // other contact fields). A Jobber-imported match may carry a full-joined
    // address string; formatLeadAddressLabeled de-dupes it downstream.
    h.enqueue('leads', [storedLead({ address: '29659 Calle Violeta, Temecula, California, 92592', city: 'Temecula', state: 'California', zip: '92592' })])

    await POST(makeReq(submission({ address: undefined, city: undefined, state: undefined, zip: undefined })))

    expect(notifyMock.mock.calls[0][0].lead).toMatchObject({
      address: '29659 Calle Violeta, Temecula, California, 92592',
      city: 'Temecula', state: 'California', zip: '92592',
    })
  })

  it('a SOLID resubmission ALSO fires the Slack rail with resubmission:true', async () => {
    h.enqueue('leads', [storedLead()])

    await POST(makeReq(submission({ message: 'Back again, add the garage.' })))

    expect(slackMock).toHaveBeenCalledTimes(1)
    const arg = slackMock.mock.calls[0][0]
    expect(arg.resubmission).toBe(true)
    expect(arg.locationId).toBe('loc-uuid-1')
    expect(arg.lead).toMatchObject({
      id: 'lead-A',
      request_details: 'Back again, add the garage.',
    })
  })

  it('the resubmission notification is non-fatal — a send failure warns but the merge still lands (200)', async () => {
    h.enqueue('leads', [storedLead()])
    notifyMock.mockResolvedValue({ sent: false, recipientCount: 0, error: 'resend down' })

    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.merged).toBe(true)
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('lead_notification_failed: resend down')]),
    )
  })

  it('a muted location sends nothing and never flips the merge (notified_count 0, muted flagged, no warning)', async () => {
    h.enqueue('leads', [storedLead()])
    notifyMock.mockResolvedValue({ sent: false, recipientCount: 0, muted: true })
    slackMock.mockResolvedValue({ ok: false, skipped: 'notifications_off', mutedReason: 'muted' })

    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.merged).toBe(true)
    expect(body.notified_count).toBe(0)
    expect(body.notifications_muted).toBe(true)
    // A mute is not a failure — it must not surface as a warning.
    expect(body.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining('lead_notification_failed')]),
    )
  })

  it('the Webform resubmission touchpoint is STILL written — the existing dedupe behavior is preserved', async () => {
    h.enqueue('leads', [storedLead()])

    await POST(makeReq(submission({ message: 'Please add the garage.' })))

    const tpInsert = h.state.calls.find(
      (c) =>
        c.table === 'touchpoints' &&
        c.ops.some(([m, a]: any) => m === 'insert' && a[0]?.label === 'Webform resubmission'),
    )
    expect(tpInsert).toBeTruthy()
    const inserted = tpInsert!.ops.find(([m]: any) => m === 'insert')![1][0]
    expect(inserted.notes).toContain('Please add the garage.')
  })

  it('a resubmission NEVER changes the lead stage (no leads.update carries a stage key)', async () => {
    // A Nurturing client resubmitting must NOT be reset to New — moving stage is
    // Kevin's separate call (#86). The fill-empty update may still write contact
    // fields; it must never include stage.
    h.enqueue('leads', [storedLead({ stage: 'Nurturing' })])

    await POST(makeReq(submission()))

    const leadUpdates = h.state.calls.filter(
      (c) => c.table === 'leads' && c.ops.some(([m]: any) => m === 'update'),
    )
    for (const c of leadUpdates) {
      const payload = c.ops.find(([m]: any) => m === 'update')![1][0]
      expect(payload).not.toHaveProperty('stage')
    }
  })
})
