// @vitest-environment node
//
// Per-project-type drip SENDER routing — drip-send layer.
//
// The drip send path forwards the lead's project_type to sendEmail as
// senderProjectType; sendEmail resolves the location's assigned sender (or
// falls back to base). These tests pin the FORWARDING at the chokepoint (the
// correct project_type reaches sendEmail, the drip still sends); the actual
// base-vs-assigned resolution + never-drop fallback are pinned at the resend
// layer in resend-project-type-sender.test.ts.
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const tablesTouched = () => state.calls.map(c => c.table)
  return { state, reset, enqueue, makeBuilder, tablesTouched }
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
vi.mock('@/lib/welcome-email', () => ({
  scheduleWelcomeEmail: vi.fn(async () => {}),
}))

import { sendDripStepForRow } from '@/lib/drip-send'

const LOC_UUID = 'loc-uuid-1'
const emailStep = {
  id: 'st-2', step_order: 2, delay_days: 1, channel: 'email',
  subject: 's', body: 'b', master_template_id: null, templates: null,
}
const progressRow = {
  id: 'prog-1', lead_id: 'lead-1', drip_path_id: 'path-1', current_step: 2,
  next_send_at: '2026-01-01T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: 'general-a' },
}
const activeLoc = {
  id: LOC_UUID, name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Boulder', state: 'CO', timezone: 'America/Denver', lifecycle_status: 'active',
}
const leadWith = (project_type: string | null) => ({
  id: 'lead-1', name: 'Sarah', first_name: 'Sarah', email: 'sarah@email.com',
  location_uuid: LOC_UUID, assigned_to: null, marketing_opt_out: false, project_type,
})

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('drip-send — forwards project_type as senderProjectType', () => {
  it("lead with a project_type → sendEmail receives it verbatim as senderProjectType", async () => {
    h.enqueue('drip_path_steps', emailStep)
    h.enqueue('leads', leadWith('Local Move'))
    h.enqueue('locations', activeLoc)
    h.enqueue('drip_path_steps', null) // advance → complete

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ senderProjectType: 'Local Move' })
  })

  it('untagged lead (project_type null) → senderProjectType null, still sends', async () => {
    h.enqueue('drip_path_steps', emailStep)
    h.enqueue('leads', leadWith(null))
    h.enqueue('locations', activeLoc)
    h.enqueue('drip_path_steps', null)

    const res = await sendDripStepForRow(progressRow as any)

    expect(res.sent).toBe(true)
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ senderProjectType: null })
  })
})
