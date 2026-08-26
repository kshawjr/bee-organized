// @vitest-environment node
// issue 316 — an email with no subject is HELD, not disguised.
//
// July 2026: three Kansas City email templates were saved with NULL subjects
// and for a month leads received emails whose subject line literally read
// "(no subject)" — because all three lead-facing senders substituted that
// fallback BEFORE lib/resend's empty-subject guard could fire. This suite
// pins the fix at both ends:
//
//   SEND — the fallback is gone from all three senders (drip, welcome,
//   stage). A blank resolved subject HOLDS the send exactly like the
//   missing-rate / missing-booking-link guards: row untouched, retried next
//   tick, resumes by itself the moment a subject exists. The drip hold also
//   records an owner-readable reason that NAMES the subject
//   (leads.drip_last_send_error).
//
//   SAVE — POST /api/templates rejects an email template with a blank
//   subject (subject_required, 400); PATCH /api/templates/[id] refuses a
//   patch that would leave an email template's subject blank. Text and call
//   templates have no subject by design and save exactly as before.
//
// Mocking style follows lib/email-send-integrity.test.ts (recording
// query-builder with per-table FIFO response queues). renderTemplate is the
// REAL one (importOriginal) so a NULL subject truly renders to '' the way it
// did in the incident.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── mock supabaseService: recording query-builder with per-table FIFO
//    response queues (same pattern as email-send-integrity.test.ts).
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
// KEEP the real renderTemplate: the whole incident was NULL → '' → truthy
// fallback, so a mocked renderer would test nothing.
vi.mock('@/lib/resend', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, sendEmail: sendEmailMock }
})
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own-1', full_name: 'Olive Owner', phone: '555' })),
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
}))

import { sendDripStepForRow } from '@/lib/drip-send'
import { sendWelcomeEmail } from '@/lib/welcome-email'
import { sendStageEmail } from '@/lib/stage-emails'
import { POST as templatesPOST } from '@/app/api/templates/route'
import { PATCH as templatePATCH } from '@/app/api/templates/[id]/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'

// ── helpers ────────────────────────────────────────────────
const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const updatePayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
const insertPayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))

const baseLead = (over: any = {}) => ({
  id: 'lead-1',
  name: 'Sarah Mitchell',
  first_name: 'Sarah',
  email: 'sarah@email.com',
  location_uuid: 'loc-uuid-1',
  assigned_to: null,
  is_junk: false,
  paused: false,
  marketing_opt_out: false,
  welcome_email_sent_at: null,
  project_type: null,
  drip_last_send_status: null,
  ...over,
})

const progressRow = (over: any = {}) => ({
  id: 'prog-1',
  lead_id: 'lead-1',
  drip_path_id: 'path-1',
  current_step: 1,
  next_send_at: '2026-01-01T14:00:00.000Z',
  drip_paths: { id: 'path-1', path_key: 'general-a' },
  ...over,
})

const LOC = {
  id: 'loc-uuid-1', name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Boulder', state: 'CO', timezone: 'America/Denver',
  lifecycle_status: 'active',
}

const emailStep = (over: any = {}) => ({
  id: 'st-1', step_order: 1, delay_days: 0, channel: 'email',
  subject: null, body: 'Hi {{first_name}}', master_template_id: null, templates: null,
  ...over,
})

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ═══ 1. SEND PATH — drip: blank subject HELD, not sent with a fallback ═══

describe('drip send — blank subject is held', () => {
  it('a step resolving to an empty subject is HELD (missing_subject) and NO send happens', async () => {
    h.enqueue('drip_path_steps', emailStep({ subject: null }))
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)

    const res = await sendDripStepForRow(progressRow() as any)
    expect(res).toEqual({ sent: false, error: 'missing_subject' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // Row untouched — the hold retries next tick (no stop, no advance).
    expect(updatePayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('a subject that renders to nothing (tag-only, value null) is held the same way', async () => {
    // {{owner_booking_link}} resolves null here (no links anywhere), so the
    // rendered subject is '' even though the SOURCE subject is non-empty.
    h.enqueue('drip_path_steps', emailStep({ subject: '{{reviews_link}}' }))
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)

    const res = await sendDripStepForRow(progressRow() as any)
    expect(res).toEqual({ sent: false, error: 'missing_subject' })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('the recorded hold reason NAMES the subject (leads.drip_last_send_error)', async () => {
    h.enqueue('drip_path_steps', emailStep({ subject: null }))
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)

    await sendDripStepForRow(progressRow() as any)
    const upd = updatePayloads('leads')
    expect(upd).toHaveLength(1)
    expect(upd[0].drip_last_send_status).toBe('failed')
    expect(upd[0].drip_last_send_error).toMatch(/subject/i)
    expect(upd[0].drip_last_send_error).toBe(
      'Email subject is blank — send held until a subject is entered on the template or drip step',
    )
  })

  it('a held send RESUMES (sends) once a subject exists — same row, subject filled in', async () => {
    h.enqueue('drip_path_steps', emailStep({ subject: 'Hello {{first_name}}' }))
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)

    const res = await sendDripStepForRow(progressRow() as any)
    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect((sendEmailMock.mock.calls[0] as any)[0].subject).toBe('Hello Sarah')
  })

  it('regression: a missing body still blocks (no_body_source) before any subject logic', async () => {
    h.enqueue('drip_path_steps', emailStep({ subject: 'Hi', body: null }))
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)

    const res = await sendDripStepForRow(progressRow() as any)
    expect(res).toEqual({ sent: false, error: 'no_body_source' })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('regression: a missing rate still holds (missing_rate) with its own reason', async () => {
    h.enqueue('drip_path_steps', emailStep({ subject: 'Hi', body: 'Our rate is {{rate_per_hour}}' }))
    h.enqueue('leads', baseLead())
    h.enqueue('locations', { ...LOC, rate_per_hour: null })

    const res = await sendDripStepForRow(progressRow() as any)
    expect(res).toEqual({ sent: false, error: 'missing_rate' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    const upd = updatePayloads('leads')
    expect(upd[0].drip_last_send_error).toMatch(/rate/i)
  })
})

// ═══ 2. SEND PATH — welcome + stage: same hold, native shape ═══

describe('welcome email — blank subject is held (row untouched, retried next tick)', () => {
  it('NULL template subject → missing_subject, NO send, NO lead write (held, not tombstoned)', async () => {
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)
    h.enqueue('templates', { id: 'tpl-w', subject: null, body: 'Hi {{first_name}}' })
    // fork lookup drains an empty templates queue → falls back to master

    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'missing_subject' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // HELD: scheduled_at intact — nothing written to the lead at all.
    expect(updatePayloads('leads')).toHaveLength(0)
  })
})

describe('stage email — blank subject is held (send_at intact, retried next tick)', () => {
  it('NULL template subject → missing_subject, NO send, row neither sent nor cancelled', async () => {
    h.enqueue('scheduled_stage_emails', { id: 'sse-1', lead_id: 'lead-1', stage_email_key: 'opp_organizing_estimate_3d', sent_at: null, cancelled_at: null })
    h.enqueue('templates', { id: 'tpl-s', subject: null, body: 'Hi {{first_name}}', name: '3d follow-up' })
    h.enqueue('leads', baseLead())
    // fork lookup drains an empty templates queue → falls back to master
    h.enqueue('locations', LOC)

    const res = await sendStageEmail('sse-1')
    expect(res).toEqual({ sent: false, error: 'missing_subject' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('scheduled_stage_emails')).toHaveLength(0)
  })
})

// ═══ 3. the '(no subject)' fallback is GONE from every sender ═══

describe("the string '(no subject)' appears nowhere in any sender", () => {
  const senders = ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts']
  it.each(senders)('%s contains no "(no subject)" fallback', (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
    expect(src).not.toContain('(no subject)')
  })
})

// ═══ 4. SAVE PATH — POST / PATCH /api/templates ═══

const authAs = (role: string, locationId: string | null = 'loc-uuid-1') => {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: 'u1', role, location_id: locationId }, error: null }),
        }),
      }),
    }),
  })
}
const jsonReq = (body: any) => ({ json: async () => body }) as any

const TPL_ROW = (over: any = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  legacy_id: null, name: 'My Template', type: 'email', tag: null,
  subject: 'Existing subject', body: 'Existing body', is_active: true,
  location_uuid: 'loc-uuid-1', cloned_from_id: null, created_by: 'u1',
  created_at: 'x', updated_at: 'x',
  ...over,
})

describe('POST /api/templates — email templates require a subject', () => {
  it('email + body + blank subject → 400 subject_required, nothing inserted', async () => {
    authAs('owner')
    const res = await templatesPOST(jsonReq({ name: 'T', type: 'email', subject: '   ', body: 'B' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
    expect(insertPayloads('templates')).toHaveLength(0)
  })

  it('email + missing subject entirely → 400 subject_required', async () => {
    authAs('owner')
    const res = await templatesPOST(jsonReq({ name: 'T', type: 'email', body: 'B' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
  })

  it('email + real subject → 201, created', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW())
    const res = await templatesPOST(jsonReq({ name: 'T', type: 'email', subject: 'Hello', body: 'B' }))
    expect(res.status).toBe(201)
    expect(insertPayloads('templates')).toHaveLength(1)
    expect(insertPayloads('templates')[0].subject).toBe('Hello')
  })

  it('sms template saves fine with no subject (blank by design)', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'sms', subject: null }))
    const res = await templatesPOST(jsonReq({ name: 'T', type: 'sms', body: 'B' }))
    expect(res.status).toBe(201)
    expect(insertPayloads('templates')[0].subject).toBeNull()
  })

  it('call template saves fine with no subject (blank by design)', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'call', subject: null }))
    const res = await templatesPOST(jsonReq({ name: 'T', type: 'call', body: 'B' }))
    expect(res.status).toBe(201)
    expect(insertPayloads('templates')[0].subject).toBeNull()
  })
})

describe('PATCH /api/templates/[id] — a patch cannot wipe an email subject', () => {
  const params = { params: { id: '11111111-2222-3333-4444-555555555555' } }

  it('explicit blank subject on an email template → 400 subject_required, no update', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'email' }))
    const res = await templatePATCH(jsonReq({ subject: '' }), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
    expect(updatePayloads('templates')).toHaveLength(0)
  })

  it('explicit null subject on an email template → 400 subject_required', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'email' }))
    const res = await templatePATCH(jsonReq({ subject: null }), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
  })

  it('retyping to email while the row has no subject → 400 subject_required', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'sms', subject: null }))
    const res = await templatePATCH(jsonReq({ type: 'email' }), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
  })

  it('an unrelated edit (name only) on an email template still goes through', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'email' }))          // loadCallerAndTemplate
    h.enqueue('templates', TPL_ROW({ type: 'email', name: 'Renamed' })) // update result
    const res = await templatePATCH(jsonReq({ name: 'Renamed' }), params)
    expect(res.status).toBe(200)
    expect(updatePayloads('templates')).toEqual([{ name: 'Renamed' }])
  })

  it('a real subject edit on an email template still goes through', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'email' }))
    h.enqueue('templates', TPL_ROW({ type: 'email', subject: 'New subject' }))
    const res = await templatePATCH(jsonReq({ subject: 'New subject' }), params)
    expect(res.status).toBe(200)
    expect(updatePayloads('templates')).toEqual([{ subject: 'New subject' }])
  })

  it('blanking the subject on an SMS template stays allowed (no subject by design)', async () => {
    authAs('owner')
    h.enqueue('templates', TPL_ROW({ type: 'sms', subject: 'stale' }))
    h.enqueue('templates', TPL_ROW({ type: 'sms', subject: null }))
    const res = await templatePATCH(jsonReq({ subject: '' }), params)
    expect(res.status).toBe(200)
    expect(updatePayloads('templates')).toEqual([{ subject: '' }])
  })
})
