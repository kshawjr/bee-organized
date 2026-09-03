// @vitest-environment node
//
// The returning-client sequence — sending, per variant, with the holds intact.
//
// The returning variants ride the same sender as every drip
// (sendDripStepForRow), so the holds are inherited rather than re-implemented,
// and "declined" is handled the way the ordinary drips handle it: the variant
// for a "no" answer simply does not quote the tag, so there is nothing to hold.
// This pins, on real variant bodies (migrations/returning_drip_path_variants.sql):
//
//   · returning-a (rate in email, they reply):  sends with the rate, no booking
//     sentence, even with NO calendar link on the location
//   · returning-d (book online, rate on call):  sends with the link, no rate
//     paragraph, even with NO rate on the location
//   · returning-c (no / no):                    sends with neither, nothing set
//   · returning-b (yes / yes), both set:        renders both, exactly as today
//   · returning-b with a BLANK setting:         HELD (missing_rate /
//     missing_booking_link) — held is for a setting not filled in
//   · blank subject → HELD, missing_subject (issue 316), any variant
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
const sentText = () => String((sendEmailMock.mock.calls[0] as any[])[0].text)

const lead = () => ({
  id: 'lead-natalie', name: 'Natalie Miller', first_name: 'Natalie', email: 'natalie@example.com',
  location_uuid: 'loc-uuid-1', assigned_to: null, is_junk: false, paused: true, marketing_opt_out: false,
  welcome_email_sent_at: null, project_type: null, drip_last_send_status: null,
})
const row = (variant: 'a' | 'b' | 'c' | 'd') => ({
  id: 'prog-r', lead_id: 'lead-natalie', drip_path_id: `path-returning-${variant}`, current_step: 1,
  next_send_at: '2026-09-01T20:06:00.000Z',
  drip_paths: { id: `path-returning-${variant}`, path_key: `returning-${variant}` },
})
const LOC = (over: any = {}) => ({
  id: 'loc-uuid-1', name: 'Seattle', sender_name: 'Suzanne Allbee', phone: '206.627.0957',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Seattle', state: 'WA', timezone: 'America/Los_Angeles', lifecycle_status: 'active',
  ...over,
})

// Email 1 of each variant, verbatim from the migration.
const INTRO = "Hi {{first_name}},\n\nThanks for getting back in touch. We've got your enquiry and someone from the {{location_name}} team will reach out shortly.\n\nIt's been a while since we worked together, so if anything has changed at your place, feel free to reply here and fill us in. Otherwise we'll pick up where we left off."
const BOOKING = "If you'd like to get a time on the calendar now, please click HERE ({{book_assessment_link}}) to select a day and time that will work best for you."
const RATE = 'Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products on your scheduled project day, and we will include those product costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.'
const OUTRO = 'Talk soon,\n\n{{owner_name}}\n\nBe sure to check out our Google Reviews! ({{reviews_link}})'
const BODY = {
  a: [INTRO, RATE, OUTRO].join('\n\n'),
  b: [INTRO, BOOKING, RATE, OUTRO].join('\n\n'),
  c: [INTRO, OUTRO].join('\n\n'),
  d: [INTRO, BOOKING, OUTRO].join('\n\n'),
}
const step = (variant: 'a' | 'b' | 'c' | 'd', over: any = {}) => ({
  id: `st-r${variant}1`, step_order: 1, delay_days: 0, channel: 'email',
  subject: 'Good to hear from you again', body: BODY[variant],
  master_template_id: null, templates: null, ...over,
})
const RATE_LINE = 'Our rate starts at $98.00 per hour per Bee.'
const BOOKING_LINE = 'please click HERE (https://calendar.app.google/abc)'

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

describe('declined preferences send — the variant has nothing to hold', () => {
  it('rate off (returning-d): sends with the booking link and NO rate paragraph, location rate blank', async () => {
    h.enqueue('drip_path_steps', step('d'))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: 'https://calendar.app.google/abc', rate_per_hour: null }))
    const res = await sendDripStepForRow(row('d') as any)
    expect(res.sent).toBe(true)
    expect(sentText()).toContain(BOOKING_LINE)
    expect(sentText()).not.toMatch(/per hour per Bee/)
    expect(sentText()).not.toMatch(/\{\{/)
  })

  it('booking link off (returning-a): sends with the rate and NO booking sentence, location link blank', async () => {
    h.enqueue('drip_path_steps', step('a'))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: null, rate_per_hour: '$98.00' }))
    const res = await sendDripStepForRow(row('a') as any)
    expect(res.sent).toBe(true)
    expect(sentText()).toContain(RATE_LINE)
    expect(sentText()).not.toMatch(/click HERE/)
    expect(sentText()).not.toMatch(/\{\{/)
  })

  it('both off (returning-c): still sends, nothing set on the location at all', async () => {
    h.enqueue('drip_path_steps', step('c'))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: null, rate_per_hour: null }))
    const res = await sendDripStepForRow(row('c') as any)
    expect(res.sent).toBe(true)
    expect(sentText()).toContain('Thanks for getting back in touch.')
    expect(sentText()).toContain('someone from the Seattle team')
    expect(sentText()).toContain('Suzanne Allbee')
    expect(sentText()).not.toMatch(/per hour per Bee|click HERE|\{\{/)
    // Untouched row, no hold recorded.
    expect(updatePayloads('lead_drip_progress').length).toBeGreaterThan(0) // the advance after a send
    expect(updatePayloads('leads').some(u => u.drip_last_send_status === 'failed')).toBe(false)
  })

  it('both set (returning-b): renders both blocks exactly as before', async () => {
    h.enqueue('drip_path_steps', step('b'))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: 'https://calendar.app.google/abc', rate_per_hour: '$98.00' }))
    const res = await sendDripStepForRow(row('b') as any)
    expect(res.sent).toBe(true)
    const sent = (sendEmailMock.mock.calls[0] as any[])[0]
    expect(sent.subject).toBe('Good to hear from you again')
    expect(sentText()).toContain(BOOKING_LINE)
    expect(sentText()).toContain(RATE_LINE)
    expect(sentText()).toContain('Suzanne Allbee')
    expect(sentText()).not.toMatch(/\{\{/)
  })
})

describe('a BLANK setting on a variant that quotes it is still held — same as the ordinary drips', () => {
  it('returning-b, rate blank → HELD (missing_rate), no send, row untouched', async () => {
    h.enqueue('drip_path_steps', step('b'))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: 'https://calendar.app.google/abc', rate_per_hour: null }))
    const res = await sendDripStepForRow(row('b') as any)
    expect(res).toEqual({ sent: false, error: 'missing_rate' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('returning-b, link blank → HELD (missing_booking_link), no fallback', async () => {
    h.enqueue('drip_path_steps', step('b'))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC({ calendar_link: null, rate_per_hour: '$98.00' }))
    const res = await sendDripStepForRow(row('b') as any)
    expect(res).toEqual({ sent: false, error: 'missing_booking_link' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('a paused lead is NOT a send-time gate on any variant', async () => {
    h.enqueue('drip_path_steps', step('c'))
    h.enqueue('leads', lead()) // paused: true — the import pause
    h.enqueue('locations', LOC())
    expect((await sendDripStepForRow(row('c') as any)).sent).toBe(true)
  })

  it('blank subject → HELD (missing_subject), issue 316, any variant', async () => {
    h.enqueue('drip_path_steps', step('c', { subject: null }))
    h.enqueue('leads', lead())
    h.enqueue('locations', LOC())
    const res = await sendDripStepForRow(row('c') as any)
    expect(res).toEqual({ sent: false, error: 'missing_subject' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('lead_drip_progress')).toHaveLength(0)
    expect(updatePayloads('leads')[0].drip_last_send_error).toMatch(/subject/i)
  })
})
