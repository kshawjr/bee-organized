// lib/beta-email-styles-send.test.ts
//
// The Emails screen brief (2026-10-30), pinned on the REAL drip sender
// (lib/drip-send.ts sendDripStepForRow) with a queued fake database — the
// same harness as lib/drip-followups.test.ts. What reaches sendEmail is what a
// client would get.
//
//   • a location with no style set renders Soft (Kevin: everyone on Soft)
//   • a location's chosen style reaches the email
//   • a paused email stays put and does not send; step 1 can't be paused
//   • no rate set → a rate-quoting email is HELD, as today
//   • each of the three booking links reaches its own tag
//   • a button whose link is a blank booking tag holds like the wording would
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const updatePayloads = (t: string) =>
    callsFor(t).flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
const sendEmailMock = vi.hoisted(() => vi.fn(async (_a: any) => ({ success: true, id: 're-1' })))
// renderTemplate is replaced by a faithful stand-in (lib/resend.ts imports the
// Resend SDK, which tests never load): {{tag}} → ctx value or '', and the
// BODY's {{signature}} → the private marker when asked.
vi.mock('@/lib/resend', async () => {
  const { SIGNATURE_MARKER } = await vi.importActual<any>('@/lib/email-signature')
  const apply = (s: string | null | undefined, ctx: any) => String(s ?? '').replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => (ctx[k] == null ? '' : String(ctx[k])))
  return {
    sendEmail: sendEmailMock,
    renderTemplate: (tpl: any, ctx: any, opts: any = {}) => ({
      subject: apply(String(tpl.subject ?? '').replace(/\{\{signature\}\}/g, ''), ctx),
      body: apply(opts.signatureMarker ? String(tpl.body ?? '').replace(/\{\{signature\}\}/g, SIGNATURE_MARKER) : tpl.body, ctx),
    }),
  }
})
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => null) }))
vi.mock('@/lib/welcome-email', () => ({ scheduleWelcomeEmail: vi.fn(async () => undefined) }))

import { sendDripStepForRow } from '@/lib/drip-send'

const LEAD_ID = 'lead-1'
const LOC = 'loc-uuid-1'
const lead = {
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC, assigned_to: null, marketing_opt_out: false,
  import_source: null, paid_amount: null,
}
// A location row as select('*') returns it BEFORE any 2026-10-30 migration:
// no email_style, no switches, no new links.
const baseLoc = {
  id: LOC, name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: 'https://cal.example.com/in-home', reviews_link: null, rate_per_hour: '$95',
  city: 'Boulder', state: 'CO', timezone: 'America/Denver', lifecycle_status: 'active',
}
const step = (order: number, over: any = {}) => ({
  id: `st-${order}`, step_order: order, delay_days: (order - 1) * 5, channel: 'email',
  subject: `Subject ${order}`, body: `Body ${order}`, master_template_id: null, templates: null,
  is_active: true, ...over,
})
const row = (current_step: number) => ({
  id: 'prog-1', lead_id: LEAD_ID, drip_path_id: 'path-1', current_step,
  next_send_at: '2026-01-01T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'organizing-a' },
})

function queueRun(o: { step: any; loc?: any; next?: any; current?: any }) {
  h.enqueue('drip_path_steps', o.step)
  h.enqueue('leads', lead)
  h.enqueue('locations', { ...baseLoc, ...(o.loc || {}) })
  h.enqueue('locations', { drip_followups_off: false })
  if ('next' in o) h.enqueue('drip_path_steps', o.next)
  if ('current' in o) h.enqueue('drip_path_steps', o.current)
}
const sent = () => sendEmailMock.mock.calls[0]?.[0] as any
const advanced = () => h.updatePayloads('lead_drip_progress').some(u => 'current_step' in u || 'completed_at' in u)
const heldStatus = () => h.updatePayloads('leads').find(u => u.drip_last_send_status === 'failed')

beforeEach(() => { h.reset(); vi.clearAllMocks() })

const BUTTON = { button_text: 'Book a time', button_link: '{{booking_link}}' }

describe('the look', () => {
  it('a location with NO style set renders Soft — the sage button, the gold script heading', async () => {
    queueRun({ step: step(2, BUTTON), next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res.sent).toBe(true)
    const html = sent().html as string
    expect(html).toContain('bgcolor="#A8C9C4" style="background-color:#A8C9C4;border:2px solid #A8C9C4;border-radius:10px;"')
    expect(html).toContain('color:#3A3C39')
    expect(html).toContain('font-family:Corinthia')
    expect(html).toContain('>Subject 2</h1>')
    expect(html).not.toContain('email-honeycomb-footer.png')
  })

  it('the location’s chosen style reaches the email (Classic: Arvo heading, gold-outline button)', async () => {
    queueRun({ step: step(2, BUTTON), loc: { email_style: 'classic' }, next: step(3), current: step(2) })
    await sendDripStepForRow(row(2) as any)
    const html = sent().html as string
    expect(html).toContain('font-family:Arvo')
    expect(html).not.toContain('font-family:Corinthia')
    expect(html).toContain('border:2px solid #C99B50')
  })

  it('the button points at the real link, and the text half carries it too', async () => {
    queueRun({ step: step(2, BUTTON), next: step(3), current: step(2) })
    await sendDripStepForRow(row(2) as any)
    expect(sent().html).toContain('href="https://cal.example.com/in-home" target="_blank"')
    expect(sent().text).toContain('BOOK A TIME:\nhttps://cal.example.com/in-home')
  })

  it('no button text or no button link → no button', async () => {
    queueRun({ step: step(2, { button_text: 'Book a time' }), next: step(3), current: step(2) })
    await sendDripStepForRow(row(2) as any)
    expect(sent().html).not.toContain('target="_blank"')
  })
})

describe('Pause one email', () => {
  it('a paused email does not send — it is passed over and the client moves on', async () => {
    queueRun({ step: step(2, { is_paused: true }), next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res).toMatchObject({ sent: false, error: 'step_paused' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(advanced()).toBe(true)
    expect(heldStatus()).toBeUndefined()
  })

  it('step 1 always sends, even flagged paused', async () => {
    queueRun({ step: step(1, { is_paused: true }), next: step(2), current: step(1) })
    const res = await sendDripStepForRow(row(1) as any)
    expect(res.sent).toBe(true)
  })
})

// A rate-quoting email at a location with no rate is HELD, as it always was.
// (Whether a location quotes its rate at all is its sequence variant — a
// no-rate variant's wording never contains the tag — so there is no
// separate "don't show rates" rule here any more: 2026-10-30 follow-up.)
const RATE_BODY = 'Following the assessment, we will provide an estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products.'

describe('a blank rate holds, exactly as today', () => {
  it('no rate set: the rate-quoting email is HELD, not sent, not advanced', async () => {
    queueRun({ step: step(2, { body: RATE_BODY }), loc: { rate_per_hour: null }, next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res).toMatchObject({ sent: false, error: 'missing_rate' })
    expect(advanced()).toBe(false)
    expect(heldStatus()).toBeTruthy()
  })
})

describe('three booking links, three tags', () => {
  const LINKS = { discovery_booking_link: 'https://cal.example.com/discovery', virtual_booking_link: 'https://cal.example.com/virtual' }
  it('each link reaches its own tag', async () => {
    queueRun({
      step: step(2, { body: 'Call: {{discovery_booking_link}}\n\nVisit: {{booking_link}}\n\nVideo: {{virtual_booking_link}}' }),
      loc: LINKS, next: step(3), current: step(2),
    })
    await sendDripStepForRow(row(2) as any)
    const text = sent().text as string
    expect(text).toContain('Call: https://cal.example.com/discovery')
    expect(text).toContain('Visit: https://cal.example.com/in-home')
    expect(text).toContain('Video: https://cal.example.com/virtual')
  })

  it('a blank discovery link holds only the email that asks for it', async () => {
    queueRun({ step: step(2, { body: 'Call: {{discovery_booking_link}}' }), next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res).toMatchObject({ sent: false, error: 'missing_booking_link' })
  })

  it('a button pointing at a blank booking link holds like the wording would', async () => {
    queueRun({ step: step(2, { button_text: 'Book', button_link: '{{virtual_booking_link}}' }), next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res).toMatchObject({ sent: false, error: 'missing_booking_link' })
  })
})
