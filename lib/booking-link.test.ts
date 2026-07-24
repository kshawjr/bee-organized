// @vitest-environment node
//
// PER-USER BOOKING LINK — {{owner_booking_link}} resolution + send guard.
//
// Today {{book_assessment_link}} and {{booking_link}} both render
// locations.calendar_link, so every owner at a location sends the same
// calendar. {{owner_booking_link}} resolves per ASSIGNEE:
//
//   1. lead.assigned_to → that hub_user's booking_link
//   2. the location's primary owner's booking_link
//   3. locations.calendar_link                      (today's behavior, kept)
//
// And because an unresolved tag substitutes as EMPTY STRING, a booking
// template with nothing in the chain would ship "click here () to select a
// day and time" — the same hole class as the blank-rate bug. The guard
// (lib/booking-link) holds those sends in all three rails:
//
//   drip    (sendDripStepForRow) — HELD: progress row untouched (retries
//           next tick); the lead gets a drip_last_send_status='failed' write.
//   welcome (sendWelcomeEmail)   — HELD: scheduled_at intact, retried.
//   stage   (sendStageEmail)     — HELD: send_at intact, retried.
//
// All three return error='missing_booking_link', counted by the cron as
// held_missing_booking_link.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock (per-table FIFO queue + call recording),
//    same shape as rate-guard.test.ts. ────────────────────────────────────
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
  return { state, reset, enqueue, makeBuilder, callsFor, opsOf, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 're-1' })))
const renderTemplateMock = vi.hoisted(() =>
  vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
)
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: renderTemplateMock,
}))
const getPrimaryOwnerMock = vi.hoisted(() => vi.fn(async () => null as any))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: getPrimaryOwnerMock,
}))

import {
  resolveOwnerBookingLink,
  blockedOnMissingBookingLink,
  fetchUserBookingLink,
} from '@/lib/booking-link'
import { sendDripStepForRow } from '@/lib/drip-send'
import { sendWelcomeEmail } from '@/lib/welcome-email'
import { sendStageEmail } from '@/lib/stage-emails'

const LEAD_ID = 'lead-1'
const LOC_UUID = 'loc-uuid-1'
const ASSIGNEE_ID = 'user-assignee'
const OWNER_ID = 'user-owner'

const ASSIGNEE_LINK = 'https://calendly.com/assignee'
const OWNER_LINK = 'https://calendly.com/owner'
const LOC_LINK = 'https://calendly.com/location'

// The live sentence from the -b/-d master templates.
const BOOKING_BODY =
  'Please click HERE ({{book_assessment_link}}) to select a day and time that will work best for you.'
// The same sentence rewritten onto the new per-assignee tag.
const OWNER_BOOKING_BODY =
  'Please click HERE ({{owner_booking_link}}) to select a day and time that will work best for you.'

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  getPrimaryOwnerMock.mockResolvedValue(null)
})

// ═══ 1. The resolution chain ═══════════════════════════════════════
describe('resolveOwnerBookingLink — assignee → location owner → calendar_link', () => {
  it('TIER 1: the assignee has their own link → that link wins', async () => {
    h.enqueue('hub_users', { booking_link: ASSIGNEE_LINK })

    const link = await resolveOwnerBookingLink({
      assignedToUserId: ASSIGNEE_ID,
      locationOwnerUserId: OWNER_ID,
      locationCalendarLink: LOC_LINK,
    })

    expect(link).toBe(ASSIGNEE_LINK)
    // Short-circuits: the owner is never even read.
    expect(h.callsFor('hub_users')).toHaveLength(1)
  })

  it('TIER 2: assignee has no link → the location owner’s link', async () => {
    h.enqueue('hub_users', { booking_link: null })   // assignee
    h.enqueue('hub_users', { booking_link: OWNER_LINK }) // owner

    const link = await resolveOwnerBookingLink({
      assignedToUserId: ASSIGNEE_ID,
      locationOwnerUserId: OWNER_ID,
      locationCalendarLink: LOC_LINK,
    })

    expect(link).toBe(OWNER_LINK)
    expect(h.callsFor('hub_users')).toHaveLength(2)
  })

  it('TIER 3: neither user has a link → locations.calendar_link (today’s behavior)', async () => {
    h.enqueue('hub_users', { booking_link: null })
    h.enqueue('hub_users', { booking_link: '   ' })   // whitespace is blank

    const link = await resolveOwnerBookingLink({
      assignedToUserId: ASSIGNEE_ID,
      locationOwnerUserId: OWNER_ID,
      locationCalendarLink: LOC_LINK,
    })

    expect(link).toBe(LOC_LINK)
  })

  it('UNASSIGNED lead falls through: tier 1 is skipped entirely, owner then location', async () => {
    h.enqueue('hub_users', { booking_link: OWNER_LINK })

    const link = await resolveOwnerBookingLink({
      assignedToUserId: null,
      locationOwnerUserId: OWNER_ID,
      locationCalendarLink: LOC_LINK,
    })

    expect(link).toBe(OWNER_LINK)
    // Exactly ONE hub_users read — the owner's. No query for a null assignee.
    expect(h.callsFor('hub_users')).toHaveLength(1)
  })

  it('unassigned AND no owner link → calendar_link', async () => {
    h.enqueue('hub_users', { booking_link: null })
    const link = await resolveOwnerBookingLink({
      assignedToUserId: null,
      locationOwnerUserId: OWNER_ID,
      locationCalendarLink: LOC_LINK,
    })
    expect(link).toBe(LOC_LINK)
  })

  it('nothing anywhere → null (this is what the guard holds on)', async () => {
    const link = await resolveOwnerBookingLink({
      assignedToUserId: null,
      locationOwnerUserId: null,
      locationCalendarLink: null,
    })
    expect(link).toBeNull()
  })

  it('assignee IS the location owner → only one read, no duplicate query', async () => {
    h.enqueue('hub_users', { booking_link: null })
    const link = await resolveOwnerBookingLink({
      assignedToUserId: OWNER_ID,
      locationOwnerUserId: OWNER_ID,
      locationCalendarLink: LOC_LINK,
    })
    expect(link).toBe(LOC_LINK)
    expect(h.callsFor('hub_users')).toHaveLength(1)
  })

  it('trims stored values', async () => {
    h.enqueue('hub_users', { booking_link: `  ${ASSIGNEE_LINK}  ` })
    await expect(
      resolveOwnerBookingLink({
        assignedToUserId: ASSIGNEE_ID, locationOwnerUserId: null, locationCalendarLink: null,
      }),
    ).resolves.toBe(ASSIGNEE_LINK)
  })
})

// ═══ 2. Pre-migration safety ═══════════════════════════════════════
// The code ships BEFORE migrations/hub_users_booking_link.sql runs. A
// missing column must degrade to today's behavior, not to an exception and
// not to a held send.
describe('pre-migration (hub_users.booking_link does not exist)', () => {
  it('fetchUserBookingLink swallows the column-missing error and returns null', async () => {
    h.enqueue('hub_users', null, { message: 'column hub_users.booking_link does not exist' })
    await expect(fetchUserBookingLink(ASSIGNEE_ID)).resolves.toBeNull()
  })

  it('the whole chain still yields calendar_link — byte-identical to today', async () => {
    h.enqueue('hub_users', null, { message: 'column hub_users.booking_link does not exist' })
    h.enqueue('hub_users', null, { message: 'column hub_users.booking_link does not exist' })

    const link = await resolveOwnerBookingLink({
      assignedToUserId: ASSIGNEE_ID,
      locationOwnerUserId: OWNER_ID,
      locationCalendarLink: LOC_LINK,
    })

    expect(link).toBe(LOC_LINK)
  })
})

// ═══ 3. The guard predicate ════════════════════════════════════════
describe('blockedOnMissingBookingLink', () => {
  const tpl = (subject: string | null, body: string | null) => ({ subject, body })
  const links = (owner: string | null, loc: string | null) => ({
    ownerBookingLink: owner, locationCalendarLink: loc,
  })

  it('new tag + nothing resolves → blocked', () => {
    expect(blockedOnMissingBookingLink(tpl(null, OWNER_BOOKING_BODY), links(null, null))).toBe(true)
    expect(blockedOnMissingBookingLink(tpl(null, OWNER_BOOKING_BODY), links('', null))).toBe(true)
    expect(blockedOnMissingBookingLink(tpl(null, OWNER_BOOKING_BODY), links('  ', null))).toBe(true)
  })

  it('new tag + a resolved link → not blocked', () => {
    expect(blockedOnMissingBookingLink(tpl(null, OWNER_BOOKING_BODY), links(ASSIGNEE_LINK, null))).toBe(false)
  })

  it('legacy aliases are guarded too — they render calendar_link and today ship a hole without it', () => {
    expect(blockedOnMissingBookingLink(tpl(null, BOOKING_BODY), links(null, null))).toBe(true)
    expect(blockedOnMissingBookingLink(tpl(null, 'Book here: {{booking_link}}'), links(null, null))).toBe(true)
    expect(blockedOnMissingBookingLink(tpl(null, BOOKING_BODY), links(null, LOC_LINK))).toBe(false)
  })

  it('PER-TAG: an alias is blocked on a blank calendar_link even when the assignee has a link', () => {
    // The alias renders calendar_link, NOT the chain — a personal link does
    // not save this sentence.
    expect(
      blockedOnMissingBookingLink(tpl(null, BOOKING_BODY), links(ASSIGNEE_LINK, null)),
    ).toBe(true)
    // ...and the new tag is fine in the same situation.
    expect(
      blockedOnMissingBookingLink(tpl(null, OWNER_BOOKING_BODY), links(ASSIGNEE_LINK, null)),
    ).toBe(false)
  })

  it('tag in the subject counts', () => {
    expect(
      blockedOnMissingBookingLink(tpl('Book at {{owner_booking_link}}', 'hi'), links(null, null)),
    ).toBe(true)
  })

  it('no booking tag → never blocked, whatever resolves', () => {
    expect(blockedOnMissingBookingLink(tpl('s', 'no scheduling here'), links(null, null))).toBe(false)
    expect(blockedOnMissingBookingLink(tpl(null, null), links(null, null))).toBe(false)
  })
})

// ═══ 4. Drip rail ══════════════════════════════════════════════════
const bookingStep = {
  id: 'st-1', step_order: 2, delay_days: 1, channel: 'email',
  subject: 's', body: BOOKING_BODY, master_template_id: null, templates: null,
}
const lead = {
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC_UUID, assigned_to: null, marketing_opt_out: false, project_type: null,
}
const progressRow = {
  id: 'prog-1', lead_id: LEAD_ID, drip_path_id: 'path-1', current_step: 2,
  next_send_at: '2026-01-01T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'organizing-d' },
}
const locBase = {
  id: LOC_UUID, name: 'Portland', sender_name: 'Bee Portland', phone: '555',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Portland', state: 'OR', timezone: 'America/Los_Angeles', lifecycle_status: 'active',
}

describe('booking guard — drip (sendDripStepForRow)', () => {
  it('booking template + NOTHING resolves → NO send, missing_booking_link, progress row UNTOUCHED, status write on lead', async () => {
    h.enqueue('drip_path_steps', bookingStep)
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, calendar_link: null })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'missing_booking_link' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // HELD: no stop, no advance — retried next tick, resumes once a link is set.
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
    // VISIBLE: the lead carries an owner-actionable send status.
    const leadWrites = h.updatePayloads('leads')
    expect(leadWrites).toHaveLength(1)
    expect(leadWrites[0].drip_last_send_status).toBe('failed')
    expect(leadWrites[0].drip_last_send_error).toMatch(/booking link/i)
  })

  it('same template + a location calendar_link → SENDS (guard is link-conditional, not template-conditional)', async () => {
    h.enqueue('drip_path_steps', bookingStep)
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, calendar_link: LOC_LINK })
    h.enqueue('drip_path_steps', null) // advance: no next step → complete

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('no link anywhere + template WITHOUT a booking tag → SENDS', async () => {
    h.enqueue('drip_path_steps', { ...bookingStep, body: 'Just checking in.' })
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, calendar_link: null })
    h.enqueue('drip_path_steps', null)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('THE POINT: an assigned lead renders the ASSIGNEE’s link into {{owner_booking_link}}', async () => {
    getPrimaryOwnerMock.mockResolvedValue({ id: OWNER_ID, email: null, full_name: 'Owner O', phone: null })
    h.enqueue('drip_path_steps', { ...bookingStep, body: OWNER_BOOKING_BODY })
    h.enqueue('leads', { ...lead, assigned_to: ASSIGNEE_ID })
    h.enqueue('locations', { ...locBase, calendar_link: LOC_LINK })
    h.enqueue('hub_users', { full_name: 'Assignee A' })          // {{owner_name}} lookup
    h.enqueue('hub_users', { booking_link: ASSIGNEE_LINK })      // tier 1
    h.enqueue('drip_path_steps', null)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    const ctx = renderTemplateMock.mock.calls[0][1] as any
    expect(ctx.owner_booking_link).toBe(ASSIGNEE_LINK)
    // The location link is untouched and still backs the legacy aliases.
    expect(ctx.book_assessment_link).toBe(LOC_LINK)
    expect(ctx.booking_link).toBe(LOC_LINK)
  })

  it('an UNASSIGNED lead on the new tag falls through to the location link', async () => {
    h.enqueue('drip_path_steps', { ...bookingStep, body: OWNER_BOOKING_BODY })
    h.enqueue('leads', lead)                                     // assigned_to: null
    h.enqueue('locations', { ...locBase, calendar_link: LOC_LINK })
    h.enqueue('drip_path_steps', null)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    const ctx = renderTemplateMock.mock.calls[0][1] as any
    expect(ctx.owner_booking_link).toBe(LOC_LINK)
  })
})

// ═══ 5. Welcome rail ═══════════════════════════════════════════════
const welcomeLead = {
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC_UUID, assigned_to: null, welcome_email_sent_at: null,
  is_junk: false, paused: false, marketing_opt_out: false,
}

describe('booking guard — welcome (sendWelcomeEmail)', () => {
  it('welcome template quoting a booking tag + no link → NO send, lead row UNTOUCHED', async () => {
    h.enqueue('leads', welcomeLead)
    h.enqueue('locations', { ...locBase, calendar_link: null })
    h.enqueue('templates', { subject: 'Welcome!', body: BOOKING_BODY })

    const res = await sendWelcomeEmail(LEAD_ID)

    expect(res).toEqual({ sent: false, error: 'missing_booking_link' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // scheduled_at intact (no welcome_email_sent_at stamp) → cron retries.
    expect(h.updatePayloads('leads')).toHaveLength(0)
  })

  it('link set → sends and stamps welcome_email_sent_at', async () => {
    h.enqueue('leads', welcomeLead)
    h.enqueue('locations', { ...locBase, calendar_link: LOC_LINK })
    h.enqueue('templates', { subject: 'Welcome!', body: BOOKING_BODY })
    h.enqueue('leads', null)        // mark-sent update
    h.enqueue('touchpoints', null)  // touchpoint insert

    const res = await sendWelcomeEmail(LEAD_ID)

    expect(res).toEqual({ sent: true })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })
})

// ═══ 6. Stage rail ═════════════════════════════════════════════════
describe('booking guard — stage (sendStageEmail)', () => {
  const scheduled = {
    id: 'sse-1', lead_id: LEAD_ID, stage_email_key: 'opp_organizing_estimate_3d',
    sent_at: null, cancelled_at: null,
  }

  it('stage template quoting a booking tag + no link → NO send, scheduled row UNTOUCHED', async () => {
    h.enqueue('scheduled_stage_emails', scheduled)
    h.enqueue('templates', { subject: 'Checking in', body: BOOKING_BODY, name: 'Estimate 3d' })
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, calendar_link: null })

    const res = await sendStageEmail('sse-1')

    expect(res).toEqual({ sent: false, error: 'missing_booking_link' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // send_at intact → cron retries; goes out once a link is set.
    expect(h.updatePayloads('scheduled_stage_emails')).toHaveLength(0)
  })

  it('link set → sends and stamps sent_at', async () => {
    h.enqueue('scheduled_stage_emails', scheduled)
    h.enqueue('templates', { subject: 'Checking in', body: BOOKING_BODY, name: 'Estimate 3d' })
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, calendar_link: LOC_LINK })
    h.enqueue('scheduled_stage_emails', null) // mark-sent update
    h.enqueue('touchpoints', null)

    const res = await sendStageEmail('sse-1')

    expect(res).toEqual({ sent: true })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })
})
