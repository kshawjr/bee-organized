// @vitest-environment node
//
// POST /api/leads (the New sheet) says whether nurture emails started.
// Seven hand-entered leads in 30 days went in with Drip left off and nobody
// knew; Test Fornat went in WITH Drip ticked and silently didn't enrol. Both
// now come back in the response (the sheet shows "Client saved — nurture
// emails didn't start: <reason>") and drip_not_ticked is stored on the lead.
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const payloads = (t: string, m: string) =>
    state.calls.filter(c => c.table === t).flatMap(c => c.ops.filter(o => o[0] === m).map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, payloads }
})

const applyFx = vi.hoisted(() => vi.fn(async () => ({ enrol: { enrolled: true } as any })))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(async () => null) }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'owner-1' })) }))
vi.mock('@/lib/lead-assignment', () => ({
  writeLeadAssignment: vi.fn(async () => ({ hubUserIds: [], basis: 'location_owner', junctionWritten: true, warnings: [] })),
}))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: applyFx }))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/lead-notification-email', () => ({ notifyNewLead: vi.fn(async () => ({})) }))
vi.mock('@/lib/slack-bot', () => ({ notifyNewLeadSlack: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/notification-log', () => ({ logSlackNotification: vi.fn(async () => {}) }))

import { POST } from '@/app/api/leads/route'

const post = (body: any) =>
  POST(new Request('http://test/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any)

const primeCreate = () => {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('locations', { id: 'loc-test', location_id: 'loc_test', name: 'Test Location' })
  h.enqueue('leads', { id: 'lead-new', name: 'Test Fornat', assigned_to: 'owner-1' })
}

beforeEach(() => { h.reset(); applyFx.mockClear() })

describe('POST /api/leads — did nurture emails start?', () => {
  it('Drip left unticked → says so, and stores drip_not_ticked on the lead', async () => {
    primeCreate()
    const res = await post({ location_uuid: 'loc-test', name: 'Test Fornat', stage: 'New', startDrip: false })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.drip).toEqual({ enrolled: false, reason: 'drip_not_ticked', message: 'Drip wasn’t ticked when this client was added' })
    expect(applyFx).not.toHaveBeenCalled()
    const stored = h.payloads('leads', 'update').find((p: any) => 'drip_enrol_reason' in p)
    expect(stored).toMatchObject({ drip_enrol_reason: 'drip_not_ticked' })
  })

  it('Drip ticked but enrolment fails (Test Fornat) → the reason comes back in owner words', async () => {
    applyFx.mockResolvedValueOnce({ enrol: { enrolled: false, reason: 'path_has_no_first_email', sequence: 'Moving' } })
    primeCreate()
    const res = await post({ location_uuid: 'loc-test', name: 'Test Fornat', stage: 'New', startDrip: true })
    const body = await res.json()
    expect(body.drip.enrolled).toBe(false)
    expect(body.drip.reason).toBe('path_has_no_first_email')
    expect(body.drip.message).toBe('the Moving sequence has no emails in it — add one in Settings → Emails')
  })

  it('Drip ticked and enrolled → says enrolled (no warning to show)', async () => {
    primeCreate()
    const res = await post({ location_uuid: 'loc-test', name: 'Jane', stage: 'New', startDrip: true })
    expect((await res.json()).drip).toEqual({ enrolled: true })
  })

  it('a lead created at a stage with no drip gets no drip field (nothing to warn about)', async () => {
    primeCreate()
    const res = await post({ location_uuid: 'loc-test', name: 'Jane', stage: 'Closed Won', startDrip: false })
    expect((await res.json()).drip).toBeUndefined()
  })
})
