// @vitest-environment node
// lib/beta-manual-lead-assignee-fallback.test.ts
// ─────────────────────────────────────────────────────────────
// issue 153 — POST /api/leads (manual create) must never mint an
// unassigned lead.
//
// The New Lead modal defaults assigned_to to the creating user, but the
// client can't always resolve currentUserId — it then posts assigned_to:
// null. Historically that inserted a lead with assigned_to=null AND no
// lead_assignees row (the mirror block is gated on a truthy assignedTo), so
// the lead founded its engagement unassigned. Now a null assigned_to falls
// back to the location owner; a human pick still wins when present.
//
//   PICK     — an explicit assigned_to is used verbatim, via 'manual', and
//              the owner resolver is never consulted.
//   FALLBACK — a null assigned_to resolves to the location owner, via
//              'location_owner'.
//   NO OWNER — if even the owner can't resolve, the lead is still created
//              (unassigned), the junction is left empty — issues 149/150 are
//              the net.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabase mock: chainable builder, per-table FIFO. ──
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
  return { state, reset, enqueue, makeBuilder }
})

const ownerMock = vi.hoisted(() => vi.fn(async () => ({ id: 'owner-1' }) as any))
const writeMock = vi.hoisted(() =>
  vi.fn(async () => ({ hubUserIds: [], basis: 'location_owner', junctionWritten: true, warnings: [] })),
)

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(async () => null) }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: ownerMock }))
vi.mock('@/lib/lead-assignment', () => ({ writeLeadAssignment: writeMock }))
// Notification / drip side-effects — all silenced; the tests post startDrip:false
// and omit notifyEmail/notifySlack so none of these should fire anyway.
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
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

const leadInsertPayload = () => {
  const call = h.state.calls.find(c => c.table === 'leads' && c.ops.some(([m]) => m === 'insert'))
  return call?.ops.find(([m]) => m === 'insert')?.[1][0]
}

beforeEach(() => {
  h.reset()
  ownerMock.mockClear()
  writeMock.mockClear()
})

describe('issue 153 — manual create assignee fallback', () => {
  it('FALLBACK: a null assigned_to resolves to the location owner (via location_owner)', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' }) // auth
    h.enqueue('locations', { id: 'loc-uuid-1', location_id: 'kc', name: 'KC' })
    h.enqueue('leads', { id: 'lead-1', name: 'Jane', assigned_to: 'owner-1' })       // insert

    const res = await post({
      location_uuid: 'loc-uuid-1', name: 'Jane', assigned_to: null, startDrip: false,
    })

    expect(res.status).toBe(201)
    expect(ownerMock).toHaveBeenCalledWith('loc-uuid-1')
    // The inserted row carries the owner, not null.
    expect(leadInsertPayload().assigned_to).toBe('owner-1')
    // ...and the junction mirror runs with the fallback basis.
    expect(writeMock).toHaveBeenCalledTimes(1)
    const arg = writeMock.mock.calls[0][0] as any
    expect(arg.assignedVia).toBe('location_owner')
    expect(arg.resolved.hubUserIds).toEqual(['owner-1'])
  })

  it('PICK: an explicit assigned_to wins and the owner resolver is never consulted', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' }) // auth
    h.enqueue('locations', { id: 'loc-uuid-1', location_id: 'kc', name: 'KC' })
    h.enqueue('hub_users', { id: 'picked-user', location_id: 'loc-uuid-1' })         // assignee validation
    h.enqueue('leads', { id: 'lead-1', name: 'Jane', assigned_to: 'picked-user' })   // insert

    const res = await post({
      location_uuid: 'loc-uuid-1', name: 'Jane', assigned_to: 'picked-user', startDrip: false,
    })

    expect(res.status).toBe(201)
    // A human pick short-circuits the fallback entirely.
    expect(ownerMock).not.toHaveBeenCalled()
    expect(leadInsertPayload().assigned_to).toBe('picked-user')
    const arg = writeMock.mock.calls[0][0] as any
    expect(arg.assignedVia).toBe('manual')
    expect(arg.resolved.hubUserIds).toEqual(['picked-user'])
  })

  it('NO OWNER: an unresolvable owner still creates the lead, leaving the junction empty', async () => {
    ownerMock.mockResolvedValueOnce(null as any)
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' }) // auth
    h.enqueue('locations', { id: 'loc-uuid-1', location_id: 'kc', name: 'KC' })
    h.enqueue('leads', { id: 'lead-1', name: 'Jane', assigned_to: null })            // insert

    const res = await post({
      location_uuid: 'loc-uuid-1', name: 'Jane', assigned_to: null, startDrip: false,
    })

    expect(res.status).toBe(201)
    expect(ownerMock).toHaveBeenCalledWith('loc-uuid-1')
    // No assignee anywhere — the historical nets (issues 149/150) cover it.
    expect(leadInsertPayload().assigned_to).toBeNull()
    expect(writeMock).not.toHaveBeenCalled()
  })
})
