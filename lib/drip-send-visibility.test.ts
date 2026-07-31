// @vitest-environment node
//
// #103/#109 — drip sends leave no visible trace.
//
// Two symptoms, one theme. This suite pins both fixes:
//
//   1. NOTEBOOK CONTEXT — sendEmail() is called with email_kind='drip',
//      lead_id and lead_name, so the drip's notification_log row is no longer
//      null-kinded (516 failed sends were invisible to the email_kind filter).
//   2. TIMELINE TOUCHPOINT — a SUCCESSFUL send writes a kind='drip' /
//      method='email' / status='sent' touchpoint (Welcome / stage-email idiom),
//      labelled with the rendered subject.
//   3. TERMINAL failure writes a status='failed' touchpoint ('Drip stopped …')
//      so the owner sees why the sequence ended; a TRANSIENT failure writes NO
//      touchpoint (retries would otherwise spam the Timeline).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock, identical shape to
//    lib/drip-terminal-failure.test.ts (per-table FIFO queue + call recording).
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
  const insertPayloads = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, opsOf, insertPayloads }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 're-1' })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => null),
}))

import { sendDripStepForRow } from '@/lib/drip-send'

const LEAD_ID = 'lead-1'
const LOC_UUID = 'loc-uuid-1'
const SUBJECT = 'Thank you for reaching out!'

const emailStep = {
  id: 'st-2', step_order: 2, delay_days: 1, channel: 'email',
  subject: SUBJECT, body: 'b', master_template_id: null, templates: null,
}
const lead = (over: any = {}) => ({
  id: LEAD_ID, name: 'Sarah Jones', first_name: 'Sarah', email: 'sarah@example.com',
  location_uuid: LOC_UUID, assigned_to: null, marketing_opt_out: false,
  project_type: null, drip_last_send_status: null, ...over,
})
// current_step 2 keeps us off the step-1 welcome-scheduling branch.
const progressRow = {
  id: 'prog-1', lead_id: LEAD_ID, drip_path_id: 'path-1', current_step: 2,
  next_send_at: '2026-01-01T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'general-a' },
}
const activeLoc = {
  id: LOC_UUID, name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Boulder', state: 'CO', timezone: 'America/Denver', lifecycle_status: 'active',
}

const enqueueSendPreamble = (leadOver: any = {}) => {
  h.enqueue('drip_path_steps', emailStep)
  h.enqueue('leads', lead(leadOver))
  h.enqueue('locations', activeLoc)
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ═══ 1. successful send → notebook context + Timeline touchpoint ════
describe('successful drip send — visibility', () => {
  it('stamps email_kind / lead_id / lead_name on the sendEmail call', async () => {
    enqueueSendPreamble()
    h.enqueue('drip_path_steps', null) // advance: no next step → completes

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ email_kind: 'drip', lead_id: LEAD_ID, lead_name: 'Sarah Jones' }),
    )
  })

  it('writes a kind=drip / method=email / status=sent touchpoint labelled with the subject', async () => {
    enqueueSendPreamble()
    h.enqueue('drip_path_steps', null)

    await sendDripStepForRow(progressRow as any)

    const tps = h.insertPayloads('touchpoints')
    expect(tps).toHaveLength(1)
    expect(tps[0]).toMatchObject({
      lead_id: LEAD_ID,
      location_uuid: LOC_UUID,
      kind: 'drip',
      method: 'email',
      status: 'sent',
      label: SUBJECT, // == outreach-timeline subject → the Timeline dedups the projection
    })
    expect(tps[0].occurred_at).toBeTruthy()
  })
})

// ═══ 2. terminal failure → a 'failed' touchpoint explains the stop ═
describe('terminal failure — invalid recipient', () => {
  it('writes ONE status=failed touchpoint (drip stopped) and no sent touchpoint', async () => {
    enqueueSendPreamble()
    sendEmailMock.mockResolvedValueOnce({
      success: false, error: 'Invalid `to` field.', errorName: 'validation_error', errorStatus: 422,
    })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'invalid_recipient' })
    const tps = h.insertPayloads('touchpoints')
    expect(tps).toHaveLength(1)
    expect(tps[0]).toMatchObject({ lead_id: LEAD_ID, kind: 'drip', method: 'email', status: 'failed' })
    expect(tps[0].label).toMatch(/stopped/i)
    expect(tps.some(t => t.status === 'sent')).toBe(false)
  })
})

// ═══ 3. transient failure → NO touchpoint (retry must not duplicate) ═
describe('transient failure — no Timeline noise', () => {
  it('a rate-limit failure writes NO touchpoint; a retry would not duplicate one', async () => {
    // First tick — transient failure. Counter read, then a bump write.
    enqueueSendPreamble()
    h.enqueue('lead_drip_progress', { consecutive_failures: 0 })
    sendEmailMock.mockResolvedValueOnce({
      success: false, error: 'Too many requests', errorName: 'rate_limit_exceeded', errorStatus: 429,
    })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'send: Too many requests' })
    expect(h.insertPayloads('touchpoints')).toHaveLength(0)

    // Second tick — the retry succeeds. Exactly one (sent) touchpoint total
    // across both ticks: the transient tick contributed none.
    h.reset()
    vi.clearAllMocks()
    enqueueSendPreamble({ drip_last_send_status: 'failed' })
    h.enqueue('drip_path_steps', null)

    const res2 = await sendDripStepForRow(progressRow as any)
    expect(res2.sent).toBe(true)
    const tps = h.insertPayloads('touchpoints')
    expect(tps).toHaveLength(1)
    expect(tps[0].status).toBe('sent')
  })
})
