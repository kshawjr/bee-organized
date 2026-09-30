// @vitest-environment node
//
// Owners choosing what goes out after the first email (lib/drip-followups.ts).
//
// KEVIN'S RULE, the one these tests exist for: DRIP STEP 1 and the WELCOME
// always send, whatever the owner chooses. Everything after step 1 is theirs:
// remove single emails, or switch off everything after step 1.
//
// Decisions pinned here:
//   · switching OFF stops everyone partway (past step 1) where they are —
//     stopped_reason 'followups_off'; new leads get step 1 and are stopped
//     straight after it.
//   · switching back ON revives nobody. It touches no drip record at all.
//   · a removed email is skipped and the lead moves on to the next one.
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
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 're-1' })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => null) }))
const scheduleWelcomeMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/welcome-email', () => ({ scheduleWelcomeEmail: scheduleWelcomeMock }))

import { sendDripStepForRow } from '@/lib/drip-send'
import { dripStepDecision, firstStepRemovalError, stopAfterSend, FOLLOWUPS_OFF_REASON } from '@/lib/drip-followups'
import { PATCH as patchSteps } from '@/app/api/drip-paths/[id]/steps/route'
import { PATCH as patchSwitch } from '@/app/api/locations/[id]/drip-followups/route'

const LEAD_ID = 'lead-1'
const LOC = 'loc-uuid-1'
const lead = {
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC, assigned_to: null, marketing_opt_out: false,
  import_source: null, paid_amount: null,
}
const loc = {
  id: LOC, name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
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

// Queue one sendDripStepForRow run. `after` = the drip_path_steps reads that
// advanceOrComplete makes (next step, then current step).
function queueRun(o: { step: any; followupsOff: boolean | 'error'; next?: any; current?: any }) {
  h.enqueue('drip_path_steps', o.step)
  h.enqueue('leads', lead)
  h.enqueue('locations', loc)
  if (o.followupsOff === 'error') h.enqueue('locations', null, { message: 'column locations.drip_followups_off does not exist' })
  else h.enqueue('locations', { drip_followups_off: o.followupsOff })
  if ('next' in o) h.enqueue('drip_path_steps', o.next)
  if ('current' in o) h.enqueue('drip_path_steps', o.current)
}

const stops = () => h.updatePayloads('lead_drip_progress').filter(u => u.stopped_at)

beforeEach(() => { h.reset(); vi.clearAllMocks() })

// ═══ The rule itself ═══════════════════════════════════════════════════
describe('dripStepDecision — step 1 always sends', () => {
  it('step 1 sends with the switch off AND the step flagged removed', () => {
    expect(dripStepDecision({ stepOrder: 1, stepActive: false, followupsOff: true })).toBe('send')
  })
  it('after step 1: switch off → stop; removed → skip; otherwise send', () => {
    expect(dripStepDecision({ stepOrder: 2, stepActive: true, followupsOff: true })).toBe('stop_followups_off')
    expect(dripStepDecision({ stepOrder: 2, stepActive: false, followupsOff: false })).toBe('skip_removed')
    expect(dripStepDecision({ stepOrder: 3, stepActive: true, followupsOff: false })).toBe('send')
  })
  it('only an explicit false removes — a row with no flag still sends', () => {
    expect(dripStepDecision({ stepOrder: 2, stepActive: null, followupsOff: false })).toBe('send')
    expect(dripStepDecision({ stepOrder: 2, stepActive: undefined, followupsOff: false })).toBe('send')
  })
  it('stopAfterSend only stops when off and there is something left to stop', () => {
    expect(stopAfterSend({ followupsOff: true, hasNextStep: true })).toBe(true)
    expect(stopAfterSend({ followupsOff: false, hasNextStep: true })).toBe(false)
    expect(stopAfterSend({ followupsOff: true, hasNextStep: false })).toBe(false)
  })
})

// ═══ Step 1 and the welcome, through the real sender ══════════════════
describe('step 1 and the welcome always send, whatever the setting', () => {
  for (const off of [false, true]) {
    it(`switch ${off ? 'OFF' : 'on'}: step 1 is sent and the welcome is scheduled`, async () => {
      queueRun({ step: step(1), followupsOff: off, next: step(2), current: step(1) })
      const res = await sendDripStepForRow(row(1) as any)
      expect(res.sent).toBe(true)
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
      expect(scheduleWelcomeMock).toHaveBeenCalledTimes(1)
      expect(scheduleWelcomeMock).toHaveBeenCalledWith(LEAD_ID, expect.anything())
    })
  }

  it('step 1 still sends even if its row were somehow flagged removed', async () => {
    queueRun({ step: step(1, { is_active: false }), followupsOff: true, next: step(2), current: step(1) })
    const res = await sendDripStepForRow(row(1) as any)
    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(scheduleWelcomeMock).toHaveBeenCalledTimes(1)
  })

  it('switch OFF: after step 1 the lead is stopped straight away — nothing left waiting', async () => {
    queueRun({ step: step(1), followupsOff: true, next: step(2), current: step(1) })
    await sendDripStepForRow(row(1) as any)
    expect(stops()).toEqual([expect.objectContaining({ stopped_reason: FOLLOWUPS_OFF_REASON })])
  })

  it('switch on: after step 1 the lead moves to step 2 and is NOT stopped', async () => {
    queueRun({ step: step(1), followupsOff: false, next: step(2), current: step(1) })
    await sendDripStepForRow(row(1) as any)
    expect(stops()).toHaveLength(0)
    expect(h.updatePayloads('lead_drip_progress')).toEqual([expect.objectContaining({ current_step: 2 })])
  })

  it('the welcome sender never reads the switch — there is no way for it to hold the welcome', () => {
    const src = readFileSync(join(__dirname, 'welcome-email.ts'), 'utf8')
    expect(src).not.toMatch(/drip_followups_off|drip-followups|followupsOff/)
  })
})

// ═══ Removing one email ═══════════════════════════════════════════════
describe('a removed email is skipped and the sequence carries on', () => {
  it('step 2 removed → nothing sent, lead moves on to step 3, not stopped', async () => {
    queueRun({ step: step(2, { is_active: false }), followupsOff: false, next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res).toEqual({ sent: false, error: 'step_removed', advanced_to_step: 3 })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(stops()).toHaveLength(0)
    expect(h.updatePayloads('lead_drip_progress')).toEqual([expect.objectContaining({ current_step: 3 })])
    // No "sent" / "failed" status on the lead for an email that was removed.
    expect(h.updatePayloads('leads')).toHaveLength(0)
  })

  it('the last email removed → the sequence completes, no send', async () => {
    queueRun({ step: step(4, { is_active: false }), followupsOff: false, next: null })
    const res = await sendDripStepForRow(row(4) as any)
    expect(res.sent).toBe(false)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatePayloads('lead_drip_progress')).toEqual([expect.objectContaining({ completed_at: expect.any(String) })])
  })

  it('an email that is not removed still sends (control)', async () => {
    queueRun({ step: step(2), followupsOff: false, next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })
})

// ═══ Switching off ════════════════════════════════════════════════════
describe('switching off stops step 2 onwards', () => {
  it('a lead due step 2 with the switch off → nothing sent, stopped for good', async () => {
    queueRun({ step: step(2), followupsOff: true })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res).toEqual({ sent: false, error: 'followups_off' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(stops()).toEqual([expect.objectContaining({ stopped_reason: FOLLOWUPS_OFF_REASON })])
  })

  it('before the migration runs (column missing) the sender behaves exactly as today', async () => {
    queueRun({ step: step(2), followupsOff: 'error', next: step(3), current: step(2) })
    const res = await sendDripStepForRow(row(2) as any)
    expect(res.sent).toBe(true)
    expect(stops()).toHaveLength(0)
  })
})

// ═══ The switch route — people mid-sequence, and switching back on ═══════
const req = (body: any) => ({ json: async () => body }) as any
const locParams = { params: { id: LOC } }
const owner = { id: 'u1', role: 'owner', location_id: LOC }

describe('PATCH /api/locations/:id/drip-followups', () => {
  it('OFF: saves the setting, then stops everyone past step 1 at this location', async () => {
    h.enqueue('hub_users', owner)
    h.enqueue('locations', null)                                            // update ok
    h.enqueue('lead_drip_progress', [{ id: 'p-a' }, { id: 'p-b' }])          // in flight
    h.enqueue('lead_drip_progress', null)                                   // stop ok
    const res = await patchSwitch(req({ off: true }), locParams)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, off: true, stopped: 2 })

    expect(h.updatePayloads('locations')).toEqual([{ drip_followups_off: true }])
    // Found by this location, past step 1, unfinished.
    const find = h.callsFor('lead_drip_progress')[0]
    expect(find.ops).toEqual(expect.arrayContaining([
      ['eq', ['leads.location_uuid', LOC]],
      ['gt', ['current_step', 1]],
      ['is', ['stopped_at', null]],
      ['is', ['completed_at', null]],
    ]))
    // Stopped where they are, with the reason the client record explains.
    const stop = h.callsFor('lead_drip_progress')[1]
    expect(stop.ops).toEqual(expect.arrayContaining([['in', ['id', ['p-a', 'p-b']]]]))
    expect(h.updatePayloads('lead_drip_progress')).toEqual([
      expect.objectContaining({ stopped_at: expect.any(String), stopped_reason: FOLLOWUPS_OFF_REASON }),
    ])
  })

  it('back ON: saves the setting and touches NO drip record — nobody resumes', async () => {
    h.enqueue('hub_users', owner)
    h.enqueue('locations', null)
    const res = await patchSwitch(req({ off: false }), locParams)
    expect(await res.json()).toEqual({ ok: true, off: false, stopped: 0 })
    expect(h.updatePayloads('locations')).toEqual([{ drip_followups_off: false }])
    expect(h.callsFor('lead_drip_progress')).toHaveLength(0)
  })

  it('a lead stopped by the switch stays stopped: the cron only picks up unstopped rows', () => {
    const cron = readFileSync(join(__dirname, '..', 'app/api/cron/send-drips/route.ts'), 'utf8')
    expect(cron).toMatch(/\.is\('stopped_at', null\)/)
  })

  it('refuses a manager, and an owner of another location', async () => {
    h.enqueue('hub_users', { ...owner, role: 'manager' })
    expect((await patchSwitch(req({ off: true }), locParams)).status).toBe(403)
    h.reset()
    h.enqueue('hub_users', { ...owner, location_id: 'other' })
    expect((await patchSwitch(req({ off: true }), locParams)).status).toBe(403)
    expect(h.updatePayloads('locations')).toHaveLength(0)
  })

  it('before the migration runs it says so and changes nothing', async () => {
    h.enqueue('hub_users', owner)
    h.enqueue('locations', null, { message: 'column "drip_followups_off" of relation "locations" does not exist' })
    const res = await patchSwitch(req({ off: true }), locParams)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('not_set_up_yet')
    expect(h.callsFor('lead_drip_progress')).toHaveLength(0)
  })
})

// ═══ Step 1 cannot be removed — the save route ═════════════════════════
describe('step 1 cannot be removed', () => {
  const OWN_PATH = { id: 'p2', location_uuid: LOC, is_master: false }
  const deleted = () => h.state.calls.some(c => c.table === 'drip_path_steps' && c.ops.some(([m]) => m === 'delete'))
  const s = (n: number, is_active?: boolean) => ({ step_order: n, delay_days: n, channel: 'email', subject: `S${n}`, body: 'b', ...(is_active === undefined ? {} : { is_active }) })

  it('firstStepRemovalError refuses step 1 and allows the rest', () => {
    expect(firstStepRemovalError([{ step_order: 1, is_active: false }])).toBe('first_email_always_sends')
    expect(firstStepRemovalError([{ step_order: 1, is_active: true }, { step_order: 2, is_active: false }])).toBeNull()
  })

  it('the save refuses step 1 removed, before anything is deleted', async () => {
    h.enqueue('hub_users', owner)
    h.enqueue('drip_paths', OWN_PATH)
    const res = await patchSteps(req({ steps: [s(1, false), s(2)] }), { params: { id: 'p2' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('first_email_always_sends')
    expect(deleted()).toBe(false)
  })

  it('whichever email ends up FIRST after renumbering is the protected one', async () => {
    h.enqueue('hub_users', owner)
    h.enqueue('drip_paths', OWN_PATH)
    const res = await patchSteps(req({ steps: [s(2, false), s(3)] }), { params: { id: 'p2' } })
    expect(res.status).toBe(400)
    expect(deleted()).toBe(false)
  })

  it('removing step 2 saves, carrying the flag through to the row', async () => {
    h.enqueue('hub_users', owner)
    h.enqueue('drip_paths', OWN_PATH)
    const res = await patchSteps(req({ steps: [s(1), s(2, false), s(3)] }), { params: { id: 'p2' } })
    expect(res.status).toBe(200)
    const ins = h.callsFor('drip_path_steps').flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))[0]
    expect(ins.map((r: any) => [r.step_order, r.is_active])).toEqual([[1, true], [2, false], [3, true]])
  })

  it('a save that says nothing about removal keeps every email sending (older callers)', async () => {
    h.enqueue('hub_users', owner)
    h.enqueue('drip_paths', OWN_PATH)
    await patchSteps(req({ steps: [s(1), s(2)] }), { params: { id: 'p2' } })
    const ins = h.callsFor('drip_path_steps').flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))[0]
    expect(ins.every((r: any) => r.is_active === true)).toBe(true)
  })
})
