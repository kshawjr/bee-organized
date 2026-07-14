// @vitest-environment node
//
// SAFETY GATE — interface-active drip suppression (Beehive/Resend cutover).
//
// After the cutover, client-facing drip emails originate from Beehive
// (Resend). The load-bearing safety rule: drips enroll & send ONLY for
// locations ACTIVE on the interface (lifecycle_status === 'active'),
// because the interface is the only place a drip can be stopped — a
// non-active location must NEVER send an uncontrollable client drip.
//
// The gate is the SAME lifecycle_status === 'active' condition the intake
// caller has always used (9d5811f), enforced at the two shared
// chokepoints so every caller (intake, POST/PATCH /api/leads, the Jobber
// webhook stage-promotion path, drip-restart, imported-lead resume)
// inherits it:
//
//   1. startDripForLead      — ENROLLMENT gate: a non-active location
//                              enrolls NOTHING (bails right after the
//                              location lookup; no path/step/progress writes).
//   2. sendDripStepForRow    — SEND backstop: a non-active location SENDS
//                              nothing (no Resend call), error
//                              'location_not_active', and the progress row
//                              is left UNTOUCHED (held, not stopped — so it
//                              resumes if the location reactivates).
//
// Category routing (Move vs Organizing) still works under the active gate
// — pinned in beta-drip-project-type-selection.test.ts, whose fixtures now
// carry lifecycle_status:'active'.
//
// The internal lead notification (B2/B3) is a separate path and is not
// touched by any of this.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── chainable supabaseService mock (per-table FIFO queue + call recording),
//    same shape as beta-drip-project-type-selection.test.ts. ───────────────
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
  const tablesTouched = () => state.calls.map(c => c.table)
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const opsOf = (call: { ops: [string, any[]][] }, m: string) =>
    call.ops.filter(o => o[0] === m)
  const insertPayloads = (t: string) =>
    callsFor(t).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))
  const updatePayloads = (t: string) =>
    callsFor(t).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, tablesTouched, callsFor, insertPayloads, updatePayloads }
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

import { startDripForLead } from '@/lib/drip-lifecycle'
import { sendDripStepForRow } from '@/lib/drip-send'

const LEAD_ID = 'lead-1'
const LOC_UUID = 'loc-uuid-1'

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ═══ 1. ENROLLMENT gate — startDripForLead ═════════════════════════
describe('interface-active gate — enrollment (startDripForLead)', () => {
  it('ACTIVE location → enrolls (progress row inserted)', async () => {
    h.enqueue('leads', { paused: false, marketing_opt_out: false, project_type: null })
    h.enqueue('locations', { id: LOC_UUID, timezone: 'UTC', lifecycle_status: 'active', default_drip_path: 'organizing-a', default_move_drip_path: null })
    h.enqueue('drip_paths', null)                     // location-copy → miss
    h.enqueue('drip_paths', { id: 'path-db-1' })      // master → hit
    h.enqueue('drip_path_steps', { delay_days: 0 })   // step 1
    h.enqueue('lead_drip_progress', null)             // insert ok

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.insertPayloads('lead_drip_progress')).toEqual([
      expect.objectContaining({ lead_id: LEAD_ID, drip_path_id: 'path-db-1', current_step: 1 }),
    ])
  })

  it('NON-active location (onboarding) → enrolls NOTHING (bails after location lookup)', async () => {
    h.enqueue('leads', { paused: false, marketing_opt_out: false, project_type: null })
    h.enqueue('locations', { id: LOC_UUID, timezone: 'UTC', lifecycle_status: 'onboarding', default_drip_path: 'organizing-a', default_move_drip_path: null })

    await startDripForLead(LEAD_ID, LOC_UUID)

    // Stops right after the location lookup — no path resolution, no step
    // lookup, no progress insert.
    expect(h.tablesTouched()).toEqual(['leads', 'locations'])
    expect(h.tablesTouched()).not.toContain('drip_paths')
    expect(h.insertPayloads('lead_drip_progress')).toHaveLength(0)
  })

  it('NULL lifecycle_status → fail-closed, enrolls NOTHING', async () => {
    h.enqueue('leads', { paused: false, marketing_opt_out: false, project_type: null })
    h.enqueue('locations', { id: LOC_UUID, timezone: 'UTC', lifecycle_status: null, default_drip_path: 'organizing-a', default_move_drip_path: null })

    await startDripForLead(LEAD_ID, LOC_UUID)

    expect(h.tablesTouched()).toEqual(['leads', 'locations'])
    expect(h.insertPayloads('lead_drip_progress')).toHaveLength(0)
  })
})

// ═══ 2. SEND backstop — sendDripStepForRow ═════════════════════════
const emailStep = {
  id: 'st-2', step_order: 2, delay_days: 1, channel: 'email',
  subject: 's', body: 'b', master_template_id: null, templates: null,
}
const lead = {
  id: LEAD_ID, name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC_UUID, assigned_to: null, marketing_opt_out: false,
}
// current_step 2 keeps us off the step-1 welcome-scheduling branch.
const progressRow = {
  id: 'prog-1', lead_id: LEAD_ID, drip_path_id: 'path-1', current_step: 2,
  next_send_at: '2026-01-01T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'general-a' },
}
const locBase = {
  id: LOC_UUID, name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Boulder', state: 'CO', timezone: 'America/Denver',
}

describe('interface-active gate — send backstop (sendDripStepForRow)', () => {
  it('ACTIVE location → SENDS via Resend and advances the row', async () => {
    h.enqueue('drip_path_steps', emailStep)                       // step lookup
    h.enqueue('leads', lead)                                      // lead lookup
    h.enqueue('locations', { ...locBase, lifecycle_status: 'active' })
    h.enqueue('drip_path_steps', null)                            // advance: no next step → complete

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    // Completed (no next step) — row advanced, not held.
    const upd = h.updatePayloads('lead_drip_progress')
    expect(upd).toHaveLength(1)
    expect(upd[0].completed_at).toBeTruthy()
  })

  it('NON-active location → NO send, error=location_not_active, row UNTOUCHED', async () => {
    h.enqueue('drip_path_steps', emailStep)
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, lifecycle_status: 'paused' })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'location_not_active' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // HELD, not stopped: no write to the progress row (no stop, no advance),
    // and no drip send-status write to the lead. Resumes on the next tick
    // if the location reactivates.
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
    expect(h.updatePayloads('leads')).toHaveLength(0)
  })

  it('NULL lifecycle_status → fail-closed, NO send', async () => {
    h.enqueue('drip_path_steps', emailStep)
    h.enqueue('leads', lead)
    h.enqueue('locations', { ...locBase, lifecycle_status: null })

    const res = await sendDripStepForRow(progressRow as any)

    expect(res).toEqual({ sent: false, error: 'location_not_active' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatePayloads('lead_drip_progress')).toHaveLength(0)
  })
})
