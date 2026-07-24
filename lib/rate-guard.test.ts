// @vitest-environment node
//
// RATE GUARD — {{rate_per_hour}} blank-rate send suppression.
//
// locations.rate_per_hour is free-form text ("$95") rendered verbatim into
// client emails. An unresolved tag substitutes as empty string, so a blank
// rate used to ship "Our rate starts at  per hour per Bee." — a silent
// hole only the client saw. The guard (lib/rate-guard.ts) holds any send
// whose template SOURCE quotes the tag while the location's rate is blank:
//
//   drip    (sendDripStepForRow) — HELD: progress row untouched (retries
//           next tick, resumes when the rate is entered); the lead gets a
//           drip_last_send_status='failed' observability write.
//   welcome (sendWelcomeEmail)   — HELD: scheduled_at intact, retried.
//   stage   (sendStageEmail)     — HELD: send_at intact, retried.
//
// All three return error='missing_rate', which the cron counts as
// held_missing_rate (expected skip, own counter — never a silent skip,
// never a failure alarm). No placeholder rate is ever invented.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock (per-table FIFO queue + call recording),
//    same shape as drip-interface-active-gate.test.ts. ────────────────────
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
  const opsOf = (call: { ops: [string, any[]][] }, m: string) =>
    call.ops.filter(o => o[0] === m)
  const updatePayloads = (t: string) =>
    callsFor(t).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, updatePayloads }
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

import { blockedOnMissingRate } from '@/lib/rate-guard'
import { sendDripStepForRow } from '@/lib/drip-send'
import { sendWelcomeEmail } from '@/lib/welcome-email'
import { sendStageEmail } from '@/lib/stage-emails'

const LEAD_ID = 'lead-1'
const LOC_UUID = 'loc-uuid-1'

// The live sentence from the -a/-b master templates.
const RATE_BODY = 'Our rate starts at {{rate_per_hour}} per hour per Bee.'

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ═══ 1. The predicate itself ═══════════════════════════════════════
describe('blockedOnMissingRate', () => {
  const tpl = (subject: string | null, body: string | null) => ({ subject, body })

  it('tag in body + blank rate → blocked', () => {
    expect(blockedOnMissingRate(tpl(null, RATE_BODY), null)).toBe(true)
    expect(blockedOnMissingRate(tpl(null, RATE_BODY), undefined)).toBe(true)
    expect(blockedOnMissingRate(tpl(null, RATE_BODY), '')).toBe(true)
    expect(blockedOnMissingRate(tpl(null, RATE_BODY), '   ')).toBe(true)
  })

  it('tag in subject only + blank rate → blocked', () => {
    expect(blockedOnMissingRate(tpl('Rates from {{rate_per_hour}}', 'hi'), null)).toBe(true)
  })

  it('tag + real rate → not blocked (free-form text passes through)', () => {
    expect(blockedOnMissingRate(tpl(null, RATE_BODY), '$95')).toBe(false)
    expect(blockedOnMissingRate(tpl(null, RATE_BODY), '$85/hr (3-hour minimum)')).toBe(false)
  })

  it('no tag → never blocked, whatever the rate', () => {
    expect(blockedOnMissingRate(tpl('s', 'no pricing here'), null)).toBe(false)
    expect(blockedOnMissingRate(tpl(null, null), null)).toBe(false)
  })
})

// ═══ 2. Drip sender — HELD, observable, resumes on retry ═══════════
const rateStep = {
  id: 'st-1', step_order: 2, delay_days: 1, channel: 'email',
  subject: 's', body: RATE_BODY, master_template_id: null, templates: null,
}
const lead = {
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC_UUID, assigned_to: null, marketing_opt_out: false, project_type: null,
}
const progressRow = {
  id: 'prog-1', lead_id: LEAD_ID, drip_path_id: 'path-1', current_step: 2,
  next_send_at: '2026-01-01T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'organizing-a' },
}
const locBase = {
  id: LOC_UUID, name: 'Seattle', sender_name: 'Bee Seattle', phone: '555',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Seattle', state: 'WA', timezone: 'America/Los_Angeles', lifecycle_status: 'active',
}

describe('rate guard — drip (sendDripStepForRow)', () => {
  it('rate-quoting template + blank rate → NO send, missing_rate, progress row UNTOUCHED, status write on lead', async () => {
    h.enqueue('drip_path_steps', rateStep)
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, rate_per_hour: null })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'missing_rate' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // HELD: no stop, no advance — retried next tick, resumes once the
    // rate is entered in Settings.
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
    // VISIBLE: the lead carries an owner-actionable send status.
    const leadWrites = h.updatePayloads('leads')
    expect(leadWrites).toHaveLength(1)
    expect(leadWrites[0].drip_last_send_status).toBe('failed')
    expect(leadWrites[0].drip_last_send_error).toMatch(/rate/i)
  })

  it('same template + rate set → SENDS (guard is rate-conditional, not template-conditional)', async () => {
    h.enqueue('drip_path_steps', rateStep)
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, rate_per_hour: '$95' })
    h.enqueue('drip_path_steps', null) // advance: no next step → complete

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('blank rate + template WITHOUT the tag → SENDS (guard only fires for templates that quote a rate)', async () => {
    h.enqueue('drip_path_steps', { ...rateStep, body: 'No pricing in this one.' })
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, rate_per_hour: null })
    h.enqueue('drip_path_steps', null)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })
})

// ═══ 3. Welcome sender — HELD, scheduled_at intact ═════════════════
const welcomeLead = {
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC_UUID, assigned_to: null, welcome_email_sent_at: null,
  is_junk: false, paused: false, marketing_opt_out: false,
}

describe('rate guard — welcome (sendWelcomeEmail)', () => {
  it('welcome template quoting the tag + blank rate → NO send, missing_rate, lead row UNTOUCHED', async () => {
    h.enqueue('leads', welcomeLead)
    h.enqueue('locations', { ...locBase, rate_per_hour: null })
    h.enqueue('templates', { subject: 'Welcome!', body: RATE_BODY })

    const res = await sendWelcomeEmail(LEAD_ID)

    expect(res).toEqual({ sent: false, error: 'missing_rate' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // scheduled_at intact (no welcome_email_sent_at stamp) → cron retries.
    expect(h.updatePayloads('leads')).toHaveLength(0)
  })

  it('rate set → sends and stamps welcome_email_sent_at', async () => {
    h.enqueue('leads', welcomeLead)
    h.enqueue('locations', { ...locBase, rate_per_hour: '$95' })
    h.enqueue('templates', { subject: 'Welcome!', body: RATE_BODY })
    h.enqueue('leads', null)        // mark-sent update
    h.enqueue('touchpoints', null)  // touchpoint insert

    const res = await sendWelcomeEmail(LEAD_ID)

    expect(res).toEqual({ sent: true })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const upd = h.updatePayloads('leads')
    expect(upd).toHaveLength(1)
    expect(upd[0].welcome_email_sent_at).toBeTruthy()
  })
})

// ═══ 4. Stage sender — HELD, send_at intact ════════════════════════
describe('rate guard — stage (sendStageEmail)', () => {
  it('stage template quoting the tag + blank rate → NO send, missing_rate, scheduled row UNTOUCHED', async () => {
    h.enqueue('scheduled_stage_emails', {
      id: 'sse-1', lead_id: LEAD_ID, stage_email_key: 'opp_organizing_estimate_3d',
      sent_at: null, cancelled_at: null,
    })
    h.enqueue('templates', { subject: 'Checking in', body: RATE_BODY, name: 'Estimate 3d' })
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, rate_per_hour: null })

    const res = await sendStageEmail('sse-1')

    expect(res).toEqual({ sent: false, error: 'missing_rate' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // send_at intact → cron retries; goes out once the rate is entered.
    expect(h.updatePayloads('scheduled_stage_emails')).toHaveLength(0)
  })

  it('rate set → sends and stamps sent_at', async () => {
    h.enqueue('scheduled_stage_emails', {
      id: 'sse-1', lead_id: LEAD_ID, stage_email_key: 'opp_organizing_estimate_3d',
      sent_at: null, cancelled_at: null,
    })
    h.enqueue('templates', { subject: 'Checking in', body: RATE_BODY, name: 'Estimate 3d' })
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, rate_per_hour: '$95' })
    h.enqueue('scheduled_stage_emails', null) // mark-sent update
    h.enqueue('touchpoints', null)

    const res = await sendStageEmail('sse-1')

    expect(res).toEqual({ sent: true })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const upd = h.updatePayloads('scheduled_stage_emails')
    expect(upd).toHaveLength(1)
    expect(upd[0].sent_at).toBeTruthy()
  })
})
