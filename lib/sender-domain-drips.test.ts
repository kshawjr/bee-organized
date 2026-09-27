// @vitest-environment node
//
// An unverified SENDER domain wrote the client off (Test Location, 2026-09-27)
// — the reply-to bug (lib/reply-to-drips.test.ts, Dallas) in a different field.
// Kevin sent a test drip to a valid Gmail address; "Home or Office Organizing"
// was set to send as kshawjr@gmail.com; Resend refused ("The gmail.com domain
// is not verified…"); the drip engine stopped the lead as 'invalid_recipient'
// and the card said "the client's email address looks invalid … contact
// support". Every part of that was wrong.
//
// Pinned here:
//   · the refusal is reported as the LOCATION's setting, with where to fix it
//   · the lead is HELD: not stopped, not counted, not moved to the next step
//   · it resumes by itself once the setting is corrected
//   · no message anywhere says "contact support" or blames the client for it
//   · a genuinely bad client address still stops the drip, as today
//   · the send-from field refuses two addresses and an unsendable domain —
//     on the location, on a job type's typed sender, and on a person-mode
//     handler whose sign-in is a Gmail address
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const payloads = (t: string, m: string) =>
    state.calls.filter(c => c.table === t).flatMap(c => c.ops.filter(o => o[0] === m).map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, payloads }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({})),
  getHubUser: vi.fn(async () => ({ role: 'owner', location_id: 'loc-test' })),
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 're-1' })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => null) }))
const sendable = vi.hoisted(() => ({ current: ['beeorganized.com'] as string[] | null }))
vi.mock('@/lib/sendable-domains', () => ({ getSendableDomains: vi.fn(async () => sendable.current) }))

// project-type sender route dependencies
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } } }) },
    from: () => {
      const b: any = {}
      b.select = () => b; b.eq = () => b
      b.single = async () => ({ data: { id: 'owner-1', role: 'owner', location_id: 'loc-test' } })
      return b
    },
  }),
}))
vi.mock('@/lib/notification-access', () => ({ notificationRecipientsManageableServer: () => true }))
const pts = vi.hoisted(() => ({
  handler: null as any,
  setHandlerForTypes: vi.fn(async () => {}),
  setSenderIdentityForType: vi.fn(async () => {}),
}))
vi.mock('@/lib/project-type-senders', () => ({
  getSenderConfig: vi.fn(async () => ({ ok: true })),
  getPickableHandler: vi.fn(async () => pts.handler),
  setHandlerForTypes: pts.setHandlerForTypes,
  setSenderIdentityForType: pts.setSenderIdentityForType,
  unassignTypes: vi.fn(async () => {}),
}))

import {
  senderAddressProblem,
  isLocationSendSettingProblem,
  projectTypeSenderDomainMessage,
  locationSenderDomainMessage,
  SENDER_DOMAIN_UNVERIFIED,
  SENDER_DOMAIN_PREFIX,
} from '@/lib/sender-domain'
import { LOCATION_REPLY_TO_BROKEN } from '@/lib/reply-to'
import { sendDripStepForRow, isTerminalSendFailure } from '@/lib/drip-send'
import { PATCH as LOCATION_PATCH } from '@/app/api/locations/[id]/route'
import { POST as SENDERS_POST, PUT as SENDERS_PUT } from '@/app/api/locations/[id]/project-type-senders/route'

const RESEND_GMAIL = 'The gmail.com domain is not verified. Please, add and verify your domain on https://resend.com/domains'
const TEST_MSG = projectTypeSenderDomainMessage('Home or Office Organizing', 'kshawjr@gmail.com')

beforeEach(() => { h.reset(); vi.clearAllMocks(); sendable.current = ['beeorganized.com']; pts.handler = null })

// ═══ the send: the location's setting, not the lead ══════════════════
const LEAD_ID = 'lead-test-1'
const LOC = 'loc-test'
const emailStep = { id: 'st-1', step_order: 1, delay_days: 1, channel: 'email', subject: 's', body: 'b', master_template_id: null, templates: null }
const lead = (over: any = {}) => ({
  id: LEAD_ID, name: 'Kevin Test', first_name: 'Kevin', email: 'kshawjr+client@gmail.com',
  location_uuid: LOC, assigned_to: null, marketing_opt_out: false, project_type: 'Home or Office Organizing',
  drip_last_send_status: null, drip_last_send_error: null, ...over,
})
const progressRow = {
  id: 'prog-1', lead_id: LEAD_ID, drip_path_id: 'path-1', current_step: 1,
  next_send_at: '2026-09-27T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'general-a' },
}
const loc = {
  id: LOC, name: 'Test Location', sender_name: 'Bee Test', phone: '555', calendar_link: null, reviews_link: null,
  rate_per_hour: null, city: 'Austin', state: 'TX', timezone: 'America/Chicago', lifecycle_status: 'active',
}
const preamble = (leadOver: any = {}) => {
  h.enqueue('drip_path_steps', emailStep)
  h.enqueue('leads', lead(leadOver))
  h.enqueue('locations', loc)
}
const touchpointLabels = () => h.payloads('touchpoints', 'insert').map((t: any) => t.label)
const everythingWritten = () => JSON.stringify(h.state.calls)

describe('a send refused on the SENDER’s domain', () => {
  it('is reported as the location’s setting — the address, the job type, where to change it', async () => {
    preamble()
    sendEmailMock.mockResolvedValueOnce({ success: false, error: TEST_MSG, errorName: SENDER_DOMAIN_UNVERIFIED } as any)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'location_sender_domain_unverified' })
    const recorded = h.payloads('leads', 'update')[0].drip_last_send_error
    expect(recorded).toBe(TEST_MSG)
    expect(recorded).toContain('kshawjr@gmail.com')
    expect(recorded).toContain('Settings → New leads → Who handles what')
    const labels = touchpointLabels()
    expect(labels).toEqual([`Drip paused — ${TEST_MSG}`])
  })

  it('the lead is HELD — not stopped, not counted toward the cap, not moved on', async () => {
    preamble()
    sendEmailMock.mockResolvedValueOnce({ success: false, error: TEST_MSG, errorName: SENDER_DOMAIN_UNVERIFIED } as any)

    await sendDripStepForRow(progressRow as any)

    expect(h.payloads('lead_drip_progress', 'update'), 'progress row untouched: no stop, no counter, no advance').toHaveLength(0)
    expect(everythingWritten()).not.toContain('invalid_recipient')
    expect(everythingWritten()).not.toContain('stopped_at')
    expect(everythingWritten()).not.toContain('consecutive')
  })

  it('Resend’s raw words (label lost on the way) are held too, with a plain fallback message', async () => {
    preamble()
    sendEmailMock.mockResolvedValueOnce({ success: false, error: RESEND_GMAIL, errorName: 'validation_error', errorStatus: 403 } as any)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.error).toBe('location_sender_domain_unverified')
    expect(h.payloads('lead_drip_progress', 'update')).toHaveLength(0)
    const recorded = h.payloads('leads', 'update')[0].drip_last_send_error as string
    expect(recorded.startsWith(SENDER_DOMAIN_PREFIX)).toBe(true)
    expect(recorded).toContain('Settings → Emails')
  })

  it('writes the Timeline entry once, not every hour', async () => {
    preamble({ drip_last_send_status: 'failed', drip_last_send_error: TEST_MSG })
    sendEmailMock.mockResolvedValueOnce({ success: false, error: TEST_MSG, errorName: SENDER_DOMAIN_UNVERIFIED } as any)
    await sendDripStepForRow(progressRow as any)
    expect(touchpointLabels()).toHaveLength(0)
  })

  it('RESUMES once the setting is corrected: the same untouched row sends on the next tick and moves on', async () => {
    // tick 1 — refused, held
    preamble()
    sendEmailMock.mockResolvedValueOnce({ success: false, error: TEST_MSG, errorName: SENDER_DOMAIN_UNVERIFIED } as any)
    await sendDripStepForRow(progressRow as any)
    expect(h.payloads('lead_drip_progress', 'update')).toHaveLength(0)

    // Kevin fixes the sender. tick 2 — the SAME row (it was never stopped) sends.
    h.reset()
    preamble({ drip_last_send_status: 'failed', drip_last_send_error: TEST_MSG })
    h.enqueue('drip_path_steps', null) // no step 2 → the drip completes after this send
    sendEmailMock.mockResolvedValueOnce({ success: true, id: 'ok-1' } as any)
    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(h.payloads('leads', 'update')[0].drip_last_send_status).toBe('sent')
    expect(h.payloads('lead_drip_progress', 'update').length).toBeGreaterThan(0) // moved on
  })

  it('a genuinely bad CLIENT address still stops the drip, as today', async () => {
    preamble({ email: 'bad@' })
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'Invalid `to` field.', errorName: 'validation_error', errorStatus: 422 } as any)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.error).toBe('invalid_recipient')
    expect(h.payloads('lead_drip_progress', 'update')[0].stopped_reason).toBe('invalid_recipient')
  })

  it('classifier: sender-domain refusals are never terminal; a bad recipient still is', () => {
    expect(isTerminalSendFailure(SENDER_DOMAIN_UNVERIFIED)).toBe(false)
    expect(isTerminalSendFailure('validation_error', RESEND_GMAIL)).toBe(false)
    expect(isTerminalSendFailure('validation_error', 'Invalid `to` field.')).toBe(true)
  })
})

// ═══ the wording, everywhere ═════════════════════════════════════════
describe('no message says "contact support" or blames the client for this cause', () => {
  const cardSrc = readFileSync(join(process.cwd(), 'components/hive/shared/PreferencesBlock.jsx'), 'utf8')
  const profileSrc = readFileSync(join(process.cwd(), 'app/api/clients/[id]/profile/route.ts'), 'utf8')
  const beehive = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('the owner messages themselves', () => {
    for (const m of [TEST_MSG, locationSenderDomainMessage('owner@gmail.com')]) {
      expect(m).not.toMatch(/contact support/i)
      expect(m).not.toMatch(/client/i)
      expect(m).toMatch(/resume on their own/)
    }
  })

  it('the client card shows a HELD state from the recorded message — its own branch, no stop copy, no support', () => {
    expect(profileSrc).toContain('drip_held_message')
    expect(profileSrc).toContain('isLocationSendSettingProblem')
    expect(profileSrc).toMatch(/PROFILE_COLS =[\s\S]*drip_last_send_error/)
    const branch = cardSrc.slice(cardSrc.indexOf(') : dripHeldMessage ? ('), cardSrc.indexOf(') : dripCompleted ? ('))
    expect(branch).toContain('{dripHeldMessage}')
    expect(branch).not.toMatch(/contact support/i)
    expect(branch).not.toMatch(/client/i)
    // held outranks everything but a real stop
    expect(cardSrc).toContain('const dripCompleted = !dripStopCopy && !dripHeldMessage')
  })

  it('the classic panel says "on hold" with the message, instead of "failed: <raw error>"', () => {
    expect(beehive).toContain('dsStatus === "failed" && isLocationSendSettingProblem(person.dripLastSendError)')
    expect(beehive).toContain('" on hold — " + person.dripLastSendError')
  })

  it('the card/panel recogniser covers all three location holds and nothing client-side', () => {
    expect(isLocationSendSettingProblem(TEST_MSG)).toBe(true)
    expect(isLocationSendSettingProblem(LOCATION_REPLY_TO_BROKEN)).toBe(true)
    expect(isLocationSendSettingProblem('Your location’s sender email isn’t set up — check Settings (send-from address, sender name and reply-to).')).toBe(true)
    expect(isLocationSendSettingProblem('Invalid `to` field.')).toBe(false)
    expect(isLocationSendSettingProblem(null)).toBe(false)
  })
})

// ═══ the field refuses it ════════════════════════════════════════════
describe('senderAddressProblem — the rule', () => {
  it('refuses two addresses', () => {
    expect(senderAddressProblem('a@beeorganized.com, b@beeorganized.com', ['beeorganized.com'])).toContain('Only one')
    expect(senderAddressProblem('a@beeorganized.com;b@beeorganized.com', null)).toContain('Only one')
  })
  it('refuses an unsendable domain, naming the domains that ARE sendable (from the list, not hard-coded)', () => {
    expect(senderAddressProblem('kshawjr@gmail.com', ['beeorganized.com'])).toBe('Bee Organized can’t send email from gmail.com addresses. Use an address on beeorganized.com.')
    expect(senderAddressProblem('x@beeorganized.com', ['example.org', 'other.io'])).toContain('example.org or other.io')
  })
  it('accepts one address on a sendable domain (case-insensitive, exact domain)', () => {
    expect(senderAddressProblem(' Test@BeeOrganized.com ', ['beeorganized.com'])).toBeNull()
    expect(senderAddressProblem('x@mail.beeorganized.com', ['beeorganized.com'])).toContain('can’t send')
  })
  it('UNKNOWN domain list → shape only; never a guessed rule', () => {
    expect(senderAddressProblem('kshawjr@gmail.com', null)).toBeNull()
    expect(senderAddressProblem('not-an-address', null)).toContain('not valid')
  })
})

describe('PATCH /api/locations/[id] — send_from_email', () => {
  const req = (body: any) => new Request('http://test/api/locations/loc-test', { method: 'PATCH', body: JSON.stringify(body) }) as any

  it('refuses two addresses, writes nothing', async () => {
    const res = await LOCATION_PATCH(req({ send_from_email: 'a@beeorganized.com, b@beeorganized.com' }), { params: { id: 'loc-test' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Only one Send From address')
    expect(h.payloads('locations', 'update')).toHaveLength(0)
  })

  it('refuses a Gmail address, writes nothing', async () => {
    const res = await LOCATION_PATCH(req({ send_from_email: 'owner@gmail.com' }), { params: { id: 'loc-test' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('can’t send email from gmail.com')
    expect(h.payloads('locations', 'update')).toHaveLength(0)
  })

  it('accepts one address on a sendable domain', async () => {
    h.enqueue('locations', { id: 'loc-test' })
    const res = await LOCATION_PATCH(req({ send_from_email: 'test@beeorganized.com' }), { params: { id: 'loc-test' } })
    expect(res.status).toBe(200)
    expect(h.payloads('locations', 'update')[0].send_from_email).toBe('test@beeorganized.com')
  })

  it('when the list can’t be known, only the shape is checked (saved, and the send path still explains)', async () => {
    sendable.current = null
    h.enqueue('locations', { id: 'loc-test' })
    const res = await LOCATION_PATCH(req({ send_from_email: 'owner@gmail.com' }), { params: { id: 'loc-test' } })
    expect(res.status).toBe(200)
  })
})

describe('job-type senders — typed address and person-mode handler', () => {
  const put = (body: any) => SENDERS_PUT(new Request('http://t', { method: 'PUT', body: JSON.stringify(body) }) as any, { params: { id: 'loc-test' } })
  const post = (body: any) => SENDERS_POST(new Request('http://t', { method: 'POST', body: JSON.stringify(body) }) as any, { params: { id: 'loc-test' } })

  it('a typed shared sender on Gmail is refused', async () => {
    const res = await put({ project_type: 'Home or Office Organizing', sender_is_custom: true, sender_name: 'Kevin', sender_email: 'kshawjr@gmail.com' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('can’t send email from gmail.com')
    expect(pts.setSenderIdentityForType).not.toHaveBeenCalled()
  })

  it('a typed shared sender with two addresses is refused', async () => {
    const res = await put({ project_type: 'Home or Office Organizing', sender_is_custom: true, sender_name: 'Team', sender_email: 'a@beeorganized.com,b@beeorganized.com' })
    expect(res.status).toBe(400)
    expect(pts.setSenderIdentityForType).not.toHaveBeenCalled()
  })

  it('Test Location’s exact setup: a handler who signs in with Gmail, sending as themselves, is refused with the reason', async () => {
    pts.handler = { id: 'u-kevin', name: 'Kevin Shaw', email: 'kshawjr@gmail.com' }
    h.enqueue('location_project_type_senders', []) // no typed identity for the type
    const res = await post({ source_user_id: 'u-kevin', project_types: ['Home or Office Organizing'] })
    expect(res.status).toBe(400)
    const err = (await res.json()).error
    expect(err).toContain('Kevin Shaw signs in with kshawjr@gmail.com')
    expect(err).toContain('shared address')
    expect(pts.setHandlerForTypes).not.toHaveBeenCalled()
  })

  it('…but the same handler is fine for a type that already sends as a typed shared mailbox', async () => {
    pts.handler = { id: 'u-kevin', name: 'Kevin Shaw', email: 'kshawjr@gmail.com' }
    h.enqueue('location_project_type_senders', [{ project_type: 'Home or Office Organizing', sender_is_custom: true }])
    const res = await post({ source_user_id: 'u-kevin', project_types: ['Home or Office Organizing'] })
    expect(res.status).toBe(200)
    expect(pts.setHandlerForTypes).toHaveBeenCalled()
  })

  it('a handler on a sendable domain is assigned as before', async () => {
    pts.handler = { id: 'u-carol', name: 'Carol', email: 'carol@beeorganized.com' }
    const res = await post({ source_user_id: 'u-carol', project_types: ['Moving/Relocation'] })
    expect(res.status).toBe(200)
  })
})

// ═══ where the field is edited ═══════════════════════════════════════
describe('the screens check it as the owner types', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  it('Settings › Send From Email validates with the shared rule', () => {
    const row = src.split('\n').find(l => l.includes('label="Send From Email"'))!
    expect(row).toContain('validate={v=>senderAddressProblem(v, null)}')
    expect(row).toContain('not a personal Gmail')
  })
  it('onboarding refuses a bad Send From before saving and says why', () => {
    expect(src).toContain('const sendFromErr = senderAddressProblem(locationForm.sendFromEmail, null)')
    expect(src).toContain('!replyToError && !sendFromError')
  })
})
