// @vitest-environment node
// Email-send integrity — pins the 2026-07 fixes from the drip-pause
// verification report:
//   1. marketing_opt_out is enforced in ALL THREE send queues (path
//      drips, welcome, stage emails) at send time, plus the cheap
//      scheduling-time gates (startDripForLead, scheduleStageEmails)
//      and the immediate opt-out lifecycle hook.
//   2. Junk CANCELS a pending welcome; pause HOLDS it (released after
//      resume); stage-exit past New/Attempting cancels it.
//   3. drip-pause / drip-resume endpoints sync leads.paused so the flag
//      (chip, welcome-hold) and the progress rows (cron) can't diverge.
//   4. The dead unpaused door (dual-write createLead) stays deleted.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock supabaseService: recording query-builder with per-table FIFO
//    response queues (same pattern as beta-intake-dedup.test.ts).
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
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
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own-1', full_name: 'Olive Owner', phone: '555' })),
}))
// dual-write drags in zoho + sync-log (import-time clients) — mock both
// so the dead-door assertion can import the REAL dual-write module.
vi.mock('@/lib/zoho', () => ({
  zohoUpdate: vi.fn(async () => ({})),
  getZohoToken: vi.fn(async () => 'tok'),
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
}))

import { sendDripStepForRow } from '@/lib/drip-send'
import { sendWelcomeEmail, cancelPendingWelcomeEmail } from '@/lib/welcome-email'
import { sendStageEmail, scheduleStageEmails } from '@/lib/stage-emails'
import { applyDripSideEffects, startDripForLead } from '@/lib/drip-lifecycle'
import { POST as dripPausePOST } from '@/app/api/leads/[id]/drip-pause/route'
import { POST as dripResumePOST } from '@/app/api/leads/[id]/drip-resume/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'

// ── helpers ────────────────────────────────────────────────
const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const updatePayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
const insertPayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))
const upsertPayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'upsert').map(o => o[1][0]))

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
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ═══ 1. marketing_opt_out × three queues ═══════════════════

describe('opt-out enforcement — path drips', () => {
  it('send time: opted-out lead → row stopped with stopped_reason=opted_out, NO email', async () => {
    h.enqueue('drip_path_steps', { id: 'st-1', step_order: 1, delay_days: 0, channel: 'email', subject: 's', body: 'b', master_template_id: null, templates: null })
    h.enqueue('leads', baseLead({ marketing_opt_out: true }))
    const res = await sendDripStepForRow(progressRow() as any)
    expect(res).toEqual({ sent: false, error: 'opted_out' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    const stops = updatePayloads('lead_drip_progress')
    expect(stops).toHaveLength(1)
    expect(stops[0].stopped_reason).toBe('opted_out')
    expect(stops[0].stopped_at).toBeTruthy()
  })

  it('schedule time: startDripForLead refuses to enroll an opted-out lead', async () => {
    h.enqueue('leads', { paused: false, marketing_opt_out: true })
    await startDripForLead('lead-1', 'loc-uuid-1')
    expect(callsFor('locations')).toHaveLength(0)          // bailed before path lookup
    expect(insertPayloads('lead_drip_progress')).toHaveLength(0)
  })
})

describe('opt-out enforcement — welcome email', () => {
  it('send time: opted-out → pending welcome CANCELLED (scheduled_at cleared), NO email', async () => {
    h.enqueue('leads', baseLead({ marketing_opt_out: true }))
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'opted_out' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    const upd = updatePayloads('leads')
    expect(upd).toEqual([{ welcome_email_scheduled_at: null }])
  })
})

describe('opt-out enforcement — stage emails', () => {
  it('send time: opted-out → row cancelled with cancelled_reason=opted_out, NO email', async () => {
    h.enqueue('scheduled_stage_emails', { id: 'sse-1', lead_id: 'lead-1', stage_email_key: 'opp_closed_job_3mo', sent_at: null, cancelled_at: null })
    h.enqueue('templates', { subject: 's', body: 'b', name: '3mo' })
    h.enqueue('leads', baseLead({ marketing_opt_out: true }))
    const res = await sendStageEmail('sse-1')
    expect(res).toEqual({ sent: false, error: 'opted_out' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    const upd = updatePayloads('scheduled_stage_emails')
    expect(upd).toHaveLength(1)
    expect(upd[0].cancelled_reason).toBe('opted_out')
    expect(upd[0].cancelled_at).toBeTruthy()
  })

  it('schedule time: scheduleStageEmails refuses to queue for an opted-out lead', async () => {
    h.enqueue('leads', { marketing_opt_out: true })
    await scheduleStageEmails({ leadId: 'lead-1', newStage: 'Closed Won', projectType: null })
    expect(upsertPayloads('scheduled_stage_emails')).toHaveLength(0)
  })
})

describe('opt-out lifecycle hook — flag flips true via PATCH', () => {
  it('stops drips (opted_out), cancels stage emails (opted_out), cancels pending welcome', async () => {
    await applyDripSideEffects({
      leadId: 'lead-1', locationUuid: 'loc-uuid-1', prevStage: 'New',
      patch: { marketing_opt_out: true },
    })
    const dripStops = updatePayloads('lead_drip_progress')
    expect(dripStops).toHaveLength(1)
    expect(dripStops[0].stopped_reason).toBe('opted_out')
    const stageCancels = updatePayloads('scheduled_stage_emails')
    expect(stageCancels).toHaveLength(1)
    expect(stageCancels[0].cancelled_reason).toBe('opted_out')
    expect(updatePayloads('leads')).toEqual([{ welcome_email_scheduled_at: null }])
  })
})

// ═══ 2. pause/junk/stage-exit × pending welcome ═════════════

describe('welcome email — junk cancels, pause holds, resume releases', () => {
  it('junk (send-time backstop): pending welcome cancelled, error=junk', async () => {
    h.enqueue('leads', baseLead({ is_junk: true }))
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'junk' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('leads')).toEqual([{ welcome_email_scheduled_at: null }])
  })

  it('junk (lifecycle hook): PATCH is_junk=true cancels the pending welcome', async () => {
    await applyDripSideEffects({
      leadId: 'lead-1', locationUuid: 'loc-uuid-1', prevStage: 'New',
      patch: { is_junk: true },
    })
    const leadUpdates = updatePayloads('leads')
    expect(leadUpdates).toContainEqual({ welcome_email_scheduled_at: null })
  })

  it('pause HOLDS: paused lead → no send, and crucially NO state change (row stays pending)', async () => {
    h.enqueue('leads', baseLead({ paused: true }))
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'paused' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('leads')).toHaveLength(0)   // held, not cancelled/tombstoned
  })

  it('resume RELEASES: same lead unpaused → welcome sends and marks sent', async () => {
    h.enqueue('leads', baseLead({ paused: false }))
    h.enqueue('locations', LOC)
    h.enqueue('templates', { subject: 'Welcome!', body: 'Hi {{first_name}}' })
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: true })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const upd = updatePayloads('leads')
    expect(upd).toHaveLength(1)
    expect(upd[0].welcome_email_sent_at).toBeTruthy()
  })

  it('stage-exit past New/Attempting cancels the pending welcome alongside the drip stop', async () => {
    await applyDripSideEffects({
      leadId: 'lead-1', locationUuid: 'loc-uuid-1', prevStage: 'Attempting',
      patch: { stage: 'Nurturing' },
    })
    // drip stopped (stage_changed) + welcome cleared
    const dripStops = updatePayloads('lead_drip_progress')
    expect(dripStops).toHaveLength(1)
    expect(dripStops[0].stopped_reason).toBe('stage_changed')
    expect(updatePayloads('leads')).toContainEqual({ welcome_email_scheduled_at: null })
  })

  it('cancelPendingWelcomeEmail scopes to pending rows only (sent_at IS NULL, scheduled_at NOT NULL)', async () => {
    await cancelPendingWelcomeEmail('lead-1', 'junk')
    const call = callsFor('leads')[0]
    expect(opsOf(call, 'is')).toContainEqual(['is', ['welcome_email_sent_at', null]])
    expect(opsOf(call, 'not')).toContainEqual(['not', ['welcome_email_scheduled_at', 'is', null]])
  })
})

// ═══ 3. pause endpoints sync leads.paused (chip honesty) ═══

const authAs = (role: string) => {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: 'u1', role, location_id: 'loc-uuid-1' }, error: null }),
        }),
      }),
    }),
  })
}
const routeParams = { params: Promise.resolve({ id: 'lead-1' }) }

describe('drip-pause / drip-resume — flag stays in lockstep with row state', () => {
  it('drip-pause stamps paused_at on rows AND sets leads.paused=true', async () => {
    authAs('owner')
    h.enqueue('leads', { id: 'lead-1', location_uuid: 'loc-uuid-1' }) // scoping lookup
    const res = await dripPausePOST({} as any, routeParams)
    expect(res.status).toBe(200)
    const rowUpd = updatePayloads('lead_drip_progress')
    expect(rowUpd).toHaveLength(1)
    expect(rowUpd[0].paused_at).toBeTruthy()
    const flagUpd = updatePayloads('leads')
    expect(flagUpd).toHaveLength(1)
    expect(flagUpd[0].paused).toBe(true)
  })

  it('drip-resume clears leads.paused FIRST (so the imported-lead seed path can fire), then resumes rows', async () => {
    authAs('owner')
    h.enqueue('leads', { id: 'lead-1', location_uuid: 'loc-uuid-1' }) // scoping lookup
    // resumePausedDripsForLead: paused rows load → none (queue empty →
    // null), then lead lookup for the seed path → stage not drip-eligible
    // here, so it returns without seeding. That's fine — this test pins
    // the FLAG write and its ordering, not the seed itself.
    const res = await dripResumePOST({} as any, routeParams)
    expect(res.status).toBe(200)
    const flagUpd = updatePayloads('leads')
    expect(flagUpd).toHaveLength(1)
    expect(flagUpd[0].paused).toBe(false)
    // ordering: the leads.paused update happens before any
    // lead_drip_progress access
    const order = h.state.calls
      .filter(c => (c.table === 'leads' && opsOf(c, 'update').length) || c.table === 'lead_drip_progress')
      .map(c => c.table)
    expect(order[0]).toBe('leads')
  })
})

// ═══ 4. dead unpaused door stays deleted ════════════════════

describe('dual-write — createLead stays deleted', () => {
  it('module exports updateLead but NOT createLead (unguarded paused=false / stage=New door)', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    const mod: any = await import('@/lib/dual-write')
    expect(typeof mod.updateLead).toBe('function')
    expect(mod.createLead).toBeUndefined()
  })
})
