// @vitest-environment node
//
// The returning-client sequence — the send holds apply to it unchanged.
//
// The 'returning' path rides the same sender as every drip (sendDripStepForRow),
// so the three holds are inherited rather than re-implemented. This pins that
// inheritance on a returning-path row, because the whole point of the holds is
// that a client never reads a hole:
//
//   · blank subject → HELD, missing_subject (issue 316)
//   · rate paragraph + location has no rate → HELD, missing_rate
//   · booking link + nothing resolves → HELD, missing_booking_link
//
// Held = the progress row is untouched (retried next tick), no send happens,
// and the owner-readable reason lands on the lead. Harness follows
// lib/beta-email-subject-hold-316.test.ts; renderTemplate is REAL.
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'in', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 'msg-1' })))
vi.mock('@/lib/resend', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, sendEmail: sendEmailMock }
})
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own-1', full_name: 'Suzanne Allbee', phone: '206.627.0957' })),
}))

import { sendDripStepForRow } from '@/lib/drip-send'

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const updatePayloads = (table: string) => callsFor(table).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))

const lead = () => ({
  id: 'lead-natalie', name: 'Natalie Miller', first_name: 'Natalie', email: 'natalie@example.com',
  location_uuid: 'loc-uuid-1', assigned_to: null, is_junk: false, paused: true, marketing_opt_out: false,
  welcome_email_sent_at: null, project_type: null, drip_last_send_status: null,
})
const returningRow = () => ({
  id: 'prog-r', lead_id: 'lead-natalie', drip_path_id: 'path-returning', current_step: 1,
  next_send_at: '2026-09-01T20:06:00.000Z',
  drip_paths: { id: 'path-returning', path_key: 'returning' },
})
const LOC = (over: any = {}) => ({
  id: 'loc-uuid-1', name: 'Seattle', sender_name: 'Suzanne Allbee', phone: '206.627.0957',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Seattle', state: 'WA', timezone: 'America/Los_Angeles', lifecycle_status: 'active',
  ...over,
})
const step = (over: any = {}) => ({
  id: 'st-r1', step_order: 1, delay_days: 0, channel: 'email',
  subject: 'Good to hear from you again', body: 'Hi {{first_name}},\n\nThanks for getting back in touch.',
  master_template_id: null, templates: null, ...over,
})

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('returning path — the holds are inherited', () => {
  it('a paused lead is NOT a send-time gate: with everything set, step 1 sends', async () => {
    h.enqueue('drip_path_steps', step())
    h.enqueue('leads', lead())           // paused: true — the import pause
    h.enqueue('locations', LOC())
    const res = await sendDripStepForRow(returningRow() as any)
    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('blank subject → HELD (missing_subject), no send, row untouched', async () => {
    h.enqueue('drip_path_steps', step({ subject: null }))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC())
    const res = await sendDripStepForRow(returningRow() as any)
    expect(res).toEqual({ sent: false, error: 'missing_subject' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('lead_drip_progress')).toHaveLength(0)
    expect(updatePayloads('leads')[0].drip_last_send_error).toMatch(/subject/i)
  })

  it('rate paragraph + no location rate → HELD (missing_rate), exactly like the ordinary drips', async () => {
    h.enqueue('drip_path_steps', step({ body: 'Hi {{first_name}},\n\nOur rate starts at {{rate_per_hour}} per hour per Bee.' }))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ rate_per_hour: null }))
    const res = await sendDripStepForRow(returningRow() as any)
    expect(res).toEqual({ sent: false, error: 'missing_rate' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('booking link + nothing resolves → HELD (missing_booking_link), no fallback', async () => {
    h.enqueue('drip_path_steps', step({ body: 'Hi {{first_name}},\n\nPlease click HERE ({{book_assessment_link}}) to select a day and time.' }))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: null, rate_per_hour: '$98.00' }))
    const res = await sendDripStepForRow(returningRow() as any)
    expect(res).toEqual({ sent: false, error: 'missing_booking_link' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('with the rate and calendar link set, the blocks render filled in and the email goes', async () => {
    h.enqueue('drip_path_steps', step({
      body: 'Hi {{first_name}},\n\nPlease click HERE ({{book_assessment_link}}) to select a day and time.\n\nOur rate starts at {{rate_per_hour}} per hour per Bee.\n\n{{owner_name}}',
    }))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: 'https://calendar.app.google/abc', rate_per_hour: '$98.00' }))
    const res = await sendDripStepForRow(returningRow() as any)
    expect(res.sent).toBe(true)
    const sent = (sendEmailMock.mock.calls[0] as any[])[0]
    expect(sent.subject).toBe('Good to hear from you again')
    expect(sent.text).toContain('(https://calendar.app.google/abc)')
    expect(sent.text).toContain('Our rate starts at $98.00 per hour per Bee.')
    expect(sent.text).toContain('Suzanne Allbee')
    expect(sent.text).not.toMatch(/\{\{/)
  })
})
