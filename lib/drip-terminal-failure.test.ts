// @vitest-environment node
//
// #73 — a permanently invalid address must not retry forever.
//
// Before this fix, a failed Resend send left the lead_drip_progress row
// untouched, so the hourly cron re-selected it every tick and retried
// indefinitely (two seeded leads reached 259 / 257 failures). This suite pins:
//
//   1. TERMINAL failure (Resend name='validation_error' — invalid recipient)
//      → drip STOPPED with stopped_reason='invalid_recipient', NO reschedule.
//   2. TRANSIENT failure (rate limit / 5xx / network) → row untouched, still
//      retries; the consecutive-failure counter is bumped.
//   3. BACKSTOP cap → the 5th consecutive transient failure stops the drip with
//      a DISTINCT stopped_reason='max_send_retries' (never collapsed with the
//      terminal reason). The cap counts transient failures only; a terminal
//      failure stops first and never reaches the counter.
//   4. Reset — a successful send after a prior failure clears the counter.
//   5. A paused drip is structurally excluded from the send path (the terminal/
//      cap logic never runs for it).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock (per-table FIFO queue + call recording),
//    identical shape to lib/drip-interface-active-gate.test.ts. ──────────────
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
  const updatePayloads = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
  const selectOps = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'is'))
  return { state, reset, enqueue, makeBuilder, callsFor, opsOf, updatePayloads, selectOps }
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

import { sendDripStep, sendDripStepForRow, isTerminalSendFailure, MAX_CONSECUTIVE_SEND_FAILURES } from '@/lib/drip-send'

const LEAD_ID = 'lead-1'
const LOC_UUID = 'loc-uuid-1'

const emailStep = {
  id: 'st-2', step_order: 2, delay_days: 1, channel: 'email',
  subject: 's', body: 'b', master_template_id: null, templates: null,
}
const lead = (over: any = {}) => ({
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'bad@example.com',
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

// Enqueue the three lookups every send makes before it hits sendEmail.
const enqueueSendPreamble = (leadOver: any = {}) => {
  h.enqueue('drip_path_steps', emailStep)
  h.enqueue('leads', lead(leadOver))
  h.enqueue('locations', activeLoc)
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ═══ classifier ════════════════════════════════════════════════════
describe('isTerminalSendFailure', () => {
  it('validation_error is terminal; rate limit / 5xx / auth / undefined are transient', () => {
    expect(isTerminalSendFailure('validation_error')).toBe(true)
    expect(isTerminalSendFailure('rate_limit_exceeded')).toBe(false)
    expect(isTerminalSendFailure('internal_server_error')).toBe(false)
    expect(isTerminalSendFailure('restricted_api_key')).toBe(false)
    expect(isTerminalSendFailure(undefined)).toBe(false)
    expect(isTerminalSendFailure(null)).toBe(false)
  })
})

// ═══ 1. terminal → stop, reason recorded, no reschedule ════════════
describe('terminal failure — invalid recipient', () => {
  it('validation_error → drip stopped (invalid_recipient), NO reschedule', async () => {
    enqueueSendPreamble()
    sendEmailMock.mockResolvedValueOnce({
      success: false, error: 'Invalid `to` field.', errorName: 'validation_error', errorStatus: 422,
    })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'invalid_recipient' })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)

    // Exactly one progress-row write: the STOP. No advance (no next_send_at /
    // current_step), so the cron never re-selects this row.
    const upd = h.updatePayloads('lead_drip_progress')
    expect(upd).toHaveLength(1)
    expect(upd[0].stopped_reason).toBe('invalid_recipient')
    expect(upd[0].stopped_at).toBeTruthy()
    expect(upd[0].next_send_at).toBeUndefined()
    expect(upd[0].current_step).toBeUndefined()

    // The bad address is on the lead record for a human to see.
    const leadUpd = h.updatePayloads('leads')
    expect(leadUpd[0].drip_last_send_status).toBe('failed')
    expect(leadUpd[0].drip_last_send_error).toContain('Invalid')
  })
})

// ═══ 2. transient → still retries (row untouched, counter bumped) ══
describe('transient failure — retries', () => {
  it('rate limit → row NOT stopped, counter bumped, retries next tick', async () => {
    enqueueSendPreamble()
    h.enqueue('lead_drip_progress', { consecutive_failures: 0 }) // counter read
    sendEmailMock.mockResolvedValueOnce({
      success: false, error: 'Too many requests', errorName: 'rate_limit_exceeded', errorStatus: 429,
    })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'send: Too many requests' })
    const upd = h.updatePayloads('lead_drip_progress')
    // The only progress write is the counter bump — never a stop, never an advance.
    expect(upd).toEqual([{ consecutive_failures: 1 }])
    expect(upd.some(u => 'stopped_at' in u)).toBe(false)
  })

  it('untyped network throw (no errorName) is transient, not terminal', async () => {
    enqueueSendPreamble()
    h.enqueue('lead_drip_progress', { consecutive_failures: 2 })
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'socket hang up' })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.error).toBe('send: socket hang up')
    expect(h.updatePayloads('lead_drip_progress')).toEqual([{ consecutive_failures: 3 }])
  })

  it('cap inert when the column is absent (read errors) → still retries, no crash', async () => {
    enqueueSendPreamble()
    h.enqueue('lead_drip_progress', null, { message: 'column "consecutive_failures" does not exist' })
    sendEmailMock.mockResolvedValueOnce({
      success: false, error: '500', errorName: 'internal_server_error', errorStatus: 500,
    })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'send: 500' })
    // Read errored → helper bails before any write. No stop.
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
  })
})

// ═══ 3. backstop cap → distinct reason ═════════════════════════════
describe('retry cap backstop', () => {
  it('the Nth consecutive transient failure stops with a DISTINCT reason', async () => {
    enqueueSendPreamble()
    // One below the cap already banked; this failure trips it.
    h.enqueue('lead_drip_progress', { consecutive_failures: MAX_CONSECUTIVE_SEND_FAILURES - 1 })
    sendEmailMock.mockResolvedValueOnce({
      success: false, error: '503', errorName: 'application_error', errorStatus: 503,
    })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'max_send_retries' })
    const upd = h.updatePayloads('lead_drip_progress')
    expect(upd).toHaveLength(1)
    expect(upd[0].stopped_reason).toBe('max_send_retries')
    expect(upd[0].stopped_reason).not.toBe('invalid_recipient')
    expect(upd[0].stopped_at).toBeTruthy()
    expect(upd[0].consecutive_failures).toBe(MAX_CONSECUTIVE_SEND_FAILURES)
  })
})

// ═══ 4. reset on success ═══════════════════════════════════════════
describe('counter reset', () => {
  it('successful send after a prior failure clears the counter', async () => {
    enqueueSendPreamble({ drip_last_send_status: 'failed' })
    h.enqueue('drip_path_steps', null) // advance: no next step → completes
    // sendEmailMock default = success

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    const upd = h.updatePayloads('lead_drip_progress')
    // One reset write + one completion write (order-independent).
    expect(upd.some(u => u.consecutive_failures === 0)).toBe(true)
    expect(upd.some(u => u.completed_at)).toBe(true)
  })

  it('successful send with NO prior failure does NOT write a reset', async () => {
    enqueueSendPreamble({ drip_last_send_status: null })
    h.enqueue('drip_path_steps', null)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    const upd = h.updatePayloads('lead_drip_progress')
    expect(upd.some(u => 'consecutive_failures' in u)).toBe(false)
  })
})

// ═══ 5. paused drip is unaffected ══════════════════════════════════
describe('paused drip', () => {
  it('sendDripStep filters on paused_at → no due row, no send, no stop write', async () => {
    // The paused filter yields no due row (the real query has .is('paused_at', null)).
    h.enqueue('lead_drip_progress', null)

    const res = await sendDripStep(LEAD_ID)

    expect(res).toEqual({ sent: false })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
    // The exclusion is structural: the lookup constrains paused_at IS NULL.
    const isOps = h.selectOps('lead_drip_progress').map(o => o[1])
    expect(isOps).toContainEqual(['paused_at', null])
  })
})
