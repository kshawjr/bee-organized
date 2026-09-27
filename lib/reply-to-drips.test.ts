// @vitest-environment node
//
// A bad reply-to silently killed a location's drips and blamed the clients
// (Dawn Knapp, Dallas, 2026-09). Dallas's reply_to_email held TWO addresses;
// Resend refused every send as a 422 validation_error — the type a mistyped
// CLIENT address gets — so the drip engine stopped each lead's drip for good
// ('invalid_recipient') and wrote "Drip stopped — invalid email address" on the
// timeline. All ten client addresses were fine.
//
// Pinned here:
//   · the rule (lib/reply-to.ts): Dallas's exact value is refused with a reason
//     naming the problem; one good address is accepted
//   · PATCH /api/locations/[id] refuses it when it is SET (Settings and
//     onboarding both save through this route)
//   · a send failing on the reply-to reports the LOCATION's setting, never the
//     client's address — and the lead is NOT stopped, NOT counted, NOT marked
//   · the Settings row and onboarding both use the rule as the owner types
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
  getHubUser: vi.fn(async () => ({ role: 'owner', location_id: 'loc-dallas' })),
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 're-1' })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => null) }))

import { replyToProblem, onboardingReplyTo, LOCATION_REPLY_TO_BROKEN, REPLY_TO_INVALID } from '@/lib/reply-to'
import { PATCH } from '@/app/api/locations/[id]/route'
import { sendDripStepForRow, isTerminalSendFailure } from '@/lib/drip-send'

// Dallas's value, exactly as the brief recorded it — and the no-space form a
// paste produces. Both are the case.
const DALLAS = 'jackie@beeorganized.com, dknapp@beeorganized.com'
const DALLAS_NO_SPACE = 'jackie@beeorganized.com,dknapp@beeorganized.com'

beforeEach(() => { h.reset(); vi.clearAllMocks() })

// ═══ the rule ═══════════════════════════════════════════════════════
describe('replyToProblem — one usable address', () => {
  it('refuses Dallas’s two-address value, naming the problem', () => {
    for (const v of [DALLAS, DALLAS_NO_SPACE]) {
      const p = replyToProblem(v)
      expect(p).toContain('Only one reply-to address is allowed')
      expect(p).toContain('this has 2')
      expect(p).toContain('shared inbox')
    }
  })

  it('refuses other lists and malformed values', () => {
    expect(replyToProblem('a@x.com; b@x.com')).toContain('Only one')
    expect(replyToProblem('a@x.com b@x.com')).toContain('Only one')
    expect(replyToProblem('dknapp@beeorganized')).toContain('not valid')
    expect(replyToProblem('dknapp beeorganized.com')).toContain('not valid')
  })

  it('refuses blank — sendEmail cannot send without a reply-to', () => {
    expect(replyToProblem('')).toContain('required')
    expect(replyToProblem('   ')).toContain('required')
    expect(replyToProblem(null)).toContain('required')
  })

  it('accepts one valid address (and trims it)', () => {
    expect(replyToProblem('dknapp@beeorganized.com')).toBeNull()
    expect(replyToProblem('  dallas-hive@beeorganized.com ')).toBeNull()
  })

  it('onboarding saves the Send From address when the reply-to is left blank', () => {
    expect(onboardingReplyTo({ replyToEmail: '', sendFromEmail: 'dknapp@beeorganized.com' })).toBe('dknapp@beeorganized.com')
    expect(onboardingReplyTo({ replyToEmail: DALLAS, sendFromEmail: 'dknapp@beeorganized.com' })).toBe(DALLAS)
  })
})

// ═══ refused when SET ═══════════════════════════════════════════════
describe('PATCH /api/locations/[id] — reply_to_email', () => {
  const req = (body: any) =>
    new Request('http://test/api/locations/loc-dallas', { method: 'PATCH', body: JSON.stringify(body) }) as any

  it('refuses Dallas’s value with a 400 naming the problem, and writes nothing', async () => {
    const res = await PATCH(req({ reply_to_email: DALLAS }), { params: { id: 'loc-dallas' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Only one reply-to address is allowed')
    expect(h.payloads('locations', 'update')).toHaveLength(0)
  })

  it('refuses a cleared reply-to (it would hold every send)', async () => {
    const res = await PATCH(req({ reply_to_email: '' }), { params: { id: 'loc-dallas' } })
    expect(res.status).toBe(400)
    expect(h.payloads('locations', 'update')).toHaveLength(0)
  })

  it('accepts one valid address and writes it', async () => {
    h.enqueue('locations', { id: 'loc-dallas', reply_to_email: 'dknapp@beeorganized.com' })
    const res = await PATCH(req({ reply_to_email: ' dknapp@beeorganized.com ' }), { params: { id: 'loc-dallas' } })
    expect(res.status).toBe(200)
    expect(h.payloads('locations', 'update')[0].reply_to_email).toBe('dknapp@beeorganized.com')
  })

  it('a save that does not touch reply-to is unaffected (Katy can still save other fields)', async () => {
    h.enqueue('locations', { id: 'loc-dallas' })
    const res = await PATCH(req({ phone: '555' }), { params: { id: 'loc-dallas' } })
    expect(res.status).toBe(200)
  })
})

// ═══ the send: the location's fault, not the lead's ═════════════════
const LEAD_ID = 'lead-dallas-1'
const LOC = 'loc-dallas'
const emailStep = { id: 'st-2', step_order: 2, delay_days: 1, channel: 'email', subject: 's', body: 'b', master_template_id: null, templates: null }
const lead = (over: any = {}) => ({
  id: LEAD_ID, name: 'Dallas Client', first_name: 'Dallas', email: 'client@example.com',
  location_uuid: LOC, assigned_to: null, marketing_opt_out: false, project_type: null,
  drip_last_send_status: null, drip_last_send_error: null, ...over,
})
const progressRow = {
  id: 'prog-1', lead_id: LEAD_ID, drip_path_id: 'path-1', current_step: 2,
  next_send_at: '2026-09-10T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'general-a' },
}
const loc = {
  id: LOC, name: 'Dallas', sender_name: 'Bee Dallas', phone: '555', calendar_link: null, reviews_link: null,
  rate_per_hour: null, city: 'Dallas', state: 'TX', timezone: 'America/Chicago', lifecycle_status: 'active',
}
const preamble = (leadOver: any = {}) => {
  h.enqueue('drip_path_steps', emailStep)
  h.enqueue('leads', lead(leadOver))
  h.enqueue('locations', loc)
}
const touchpointLabels = () => h.payloads('touchpoints', 'insert').map((t: any) => t.label)

describe('a send refused on the reply-to', () => {
  it('reports the location’s setting — never the client’s address', async () => {
    preamble()
    sendEmailMock.mockResolvedValueOnce({ success: false, error: `${LOCATION_REPLY_TO_BROKEN} (Only one…)`, errorName: REPLY_TO_INVALID } as any)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'location_reply_to_invalid' })
    const leadUpd = h.payloads('leads', 'update')
    expect(leadUpd[0].drip_last_send_error).toBe(LOCATION_REPLY_TO_BROKEN)
    expect(LOCATION_REPLY_TO_BROKEN).toBe('Your location’s reply-to address is not valid — check Settings.')
    const labels = touchpointLabels()
    expect(labels).toHaveLength(1)
    expect(labels[0]).toContain('reply-to address is not valid — check Settings')
    expect(labels.join(' ')).not.toContain('invalid email address')
  })

  it('does NOT stop the lead’s drip, count it toward the cap, or advance it — it is held', async () => {
    preamble()
    sendEmailMock.mockResolvedValueOnce({ success: false, error: LOCATION_REPLY_TO_BROKEN, errorName: REPLY_TO_INVALID } as any)

    await sendDripStepForRow(progressRow as any)

    const prog = h.payloads('lead_drip_progress', 'update')
    expect(prog, 'the lead’s drip row is untouched — no stop, no counter, no advance').toHaveLength(0)
    expect(JSON.stringify(h.state.calls)).not.toContain('invalid_recipient')
  })

  it('Resend’s own reply-to rejection (a 422 validation_error) is held too — never read as a bad recipient', async () => {
    // The label was lost on the way (e.g. an older sender): only Resend's words remain.
    preamble()
    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: 'Invalid `reply_to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.',
      errorName: 'validation_error', errorStatus: 422,
    } as any)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.error).toBe('location_reply_to_invalid')
    expect(h.payloads('lead_drip_progress', 'update')).toHaveLength(0)
    expect(h.payloads('leads', 'update')[0].drip_last_send_error).toBe(LOCATION_REPLY_TO_BROKEN)
  })

  it('writes the Timeline entry once, not every hour', async () => {
    preamble({ drip_last_send_status: 'failed', drip_last_send_error: LOCATION_REPLY_TO_BROKEN })
    sendEmailMock.mockResolvedValueOnce({ success: false, error: LOCATION_REPLY_TO_BROKEN, errorName: REPLY_TO_INVALID } as any)

    await sendDripStepForRow(progressRow as any)

    expect(touchpointLabels()).toHaveLength(0)
  })

  it('a genuinely bad CLIENT address still stops as before (the fix is narrow)', async () => {
    preamble({ email: 'bad@' })
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'Invalid `to` field.', errorName: 'validation_error', errorStatus: 422 } as any)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.error).toBe('invalid_recipient')
    expect(h.payloads('lead_drip_progress', 'update')[0].stopped_reason).toBe('invalid_recipient')
  })

  it('classifier: reply-to rejections are never terminal', () => {
    expect(isTerminalSendFailure(REPLY_TO_INVALID)).toBe(false)
    expect(isTerminalSendFailure('validation_error', 'Invalid `reply_to` field.')).toBe(false)
    expect(isTerminalSendFailure('validation_error', 'Invalid `to` field.')).toBe(true)
  })
})

// ═══ the screens refuse it as the owner types ═══════════════════════
describe('where the field is edited', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('Settings › Reply-To Email validates with the shared rule (which also refuses blank)', () => {
    const row = src.split('\n').find(l => l.includes('label="Reply-To Email"'))!
    expect(row).toContain('validate={replyToProblem}')
    expect(row).not.toContain('defaults to Send From')
    // SettingsEditRow disables Save while validate() returns a reason, so a
    // blank or two-address value can't be saved from the row at all.
  })

  it('onboarding refuses a bad reply-to before saving, shows why, and saves the fallback', () => {
    expect(src).toContain('const replyToErr = replyToProblem(replyToToSave)')
    expect(src).toContain('reply_to_email:  replyToToSave,')
    expect(src).toContain('!reviewsLinkError && !replyToError')
  })
})
