// @vitest-environment node
//
// PATCH /api/engagements/:id — the OWNER OVERRIDE close (issue 119).
//
// Kevin's ruling: if the owner says a deal is paid in Jobber and Bee Hub
// disagrees, they can close it — but THE REASON IS MANDATORY AND
// VISIBLE. This file is the floor under that rule, and it is the test
// that matters most: a silent override is worse than no override.
// Everything here forges the request directly at the route, bypassing
// the wizard entirely, because a disabled button is not a guarantee.
//
//   1) the override reason with NO note is refused, 400, ZERO writes
//   2) whitespace is not a reason
//   3) with a reason it commits — and stamps a reason DISTINGUISHABLE
//      from an ordinary Closed Won
//   4) balance_owing is never written by the close
//   5) nothing reaches Jobber
//   6) the ordinary Won close is untouched by all of the above
//
// (The UI half — which cases explain themselves, and that the reason
// renders on the engagement afterwards — is beta-final-processing-explains.)
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabaseService mock — the beta-stage-terminal-only pattern:
// chainable builder, per-table FIFO response queues.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number | null }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null, count: number | null = null) =>
    state.queue.push({ table, resp: { data, error, count } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null, count: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { PATCH } from '@/app/api/engagements/[id]/route'
import { WON_OVER_BALANCE } from '@/lib/engagements'

const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', location_uuid: 'loc-uuid-1',
  stage: 'Final Processing', title: 'Garage organization', description: null,
  project_type: null, closed_reason: null, balance_owing: 340,
  ...over,
})

const arm = (engagement: any = ENG()) => {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('engagements', engagement)
}

// The tail of writes a successful close consumes after the update.
const armCommitTail = () => {
  h.enqueue('engagements', null)                            // the update
  h.enqueue('touchpoints', null)                            // stage_change trail
  h.enqueue('leads', { location_id: 'loc1', name: 'Pat' })  // close trail lookup
  h.enqueue('engagements', null, null, 0)                   // other-open count
}

const patch = (body: any, id = 'e1') =>
  PATCH(
    new Request(`http://test/api/engagements/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  )

const engagementWrites = () =>
  h.state.calls.filter(c => c.table === 'engagements' && c.ops.some(([m]) => m === 'update' || m === 'insert'))

const updatePayload = () => {
  const call = engagementWrites().find(c => c.ops.some(([m]) => m === 'update'))
  return call ? call.ops.find(([m]) => m === 'update')![1][0] : null
}

beforeEach(() => { h.reset(); vi.clearAllMocks() })

// ── THE ONE THAT MATTERS ──────────────────────────────────────
describe('the reason is mandatory AT THE ROUTE, not just in the wizard', () => {
  it('a forged override close with NO note is refused — 400, and nothing is written', async () => {
    arm()
    const res = await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('close_reason_required')
    expect(engagementWrites()).toEqual([])
  })

  it('an empty-string note is not a reason', async () => {
    arm()
    const res = await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, closed_note: '' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('close_reason_required')
    expect(engagementWrites()).toEqual([])
  })

  it('whitespace is not a reason either', async () => {
    arm()
    const res = await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, closed_note: '   \n\t  ' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('close_reason_required')
    expect(engagementWrites()).toEqual([])
  })

  it('a non-string note is not a reason either', async () => {
    arm()
    const res = await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, closed_note: 42 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('close_reason_required')
    expect(engagementWrites()).toEqual([])
  })

  it('the refusal explains itself in plain words', async () => {
    arm()
    const j = await (await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE })).json()
    expect(j.message).toMatch(/balance/i)
    expect(j.message).toMatch(/why/i)
  })
})

// ── the close itself ──────────────────────────────────────────
describe('with a reason, the override commits and stays distinguishable', () => {
  it('stamps the override reason and stores the owner’s words', async () => {
    arm(); armCommitTail()
    const res = await patch({
      stage: 'Closed Won',
      closed_reason: WON_OVER_BALANCE,
      closed_note: 'Paid cash on the day, Jobber never updated',
    })
    expect(res.status).toBe(200)
    const p = updatePayload()!
    expect(p.stage).toBe('Closed Won')
    expect(p.closed_reason).toBe(WON_OVER_BALANCE)
    expect(p.closed_reason).not.toBe('won')  // NOT an ordinary Closed Won
    expect(p.closed_note).toBe('Paid cash on the day, Jobber never updated')
    expect(p.closed_at).toBeTruthy()
  })

  it('the balance is NOT zeroed to make the row tidy — the number stays true', async () => {
    arm(ENG({ balance_owing: 340 })); armCommitTail()
    await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, closed_note: 'Settled in Jobber' })
    const p = updatePayload()!
    expect(p).not.toHaveProperty('balance_owing')
    expect(p).not.toHaveProperty('total_paid')
    expect(p).not.toHaveProperty('total_invoiced')
  })

  it('an attempt to smuggle a balance write in alongside is ignored', async () => {
    arm(ENG({ balance_owing: 340 })); armCommitTail()
    await patch({
      stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, closed_note: 'Settled',
      balance_owing: 0, total_paid: 500,
    })
    const p = updatePayload()!
    expect(p).not.toHaveProperty('balance_owing')
    expect(p).not.toHaveProperty('total_paid')
  })

  it('it does not touch Jobber — no invoice or job row is written', async () => {
    arm(); armCommitTail()
    await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, closed_note: 'Settled in Jobber' })
    const touched = h.state.calls.filter(c =>
      ['invoices', 'jobs', 'quotes'].includes(c.table) && c.ops.some(([m]) => m === 'update' || m === 'insert'))
    expect(touched).toEqual([])
    // And the route holds no Jobber client at all.
    expect((globalThis as any).__jobberCalls ?? []).toEqual([])
  })

  it('a very long reason is capped, not rejected — the owner is never silently truncated into nothing', async () => {
    arm(); armCommitTail()
    await patch({ stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, closed_note: 'x'.repeat(900) })
    expect(updatePayload()!.closed_note).toHaveLength(500)
  })
})

// ── the ordinary path is untouched ────────────────────────────
describe('the ordinary Won close is untouched', () => {
  it('a plain Won still stamps reason "won" and needs no note', async () => {
    arm(); armCommitTail()
    const res = await patch({ stage: 'Closed Won' })
    expect(res.status).toBe(200)
    const p = updatePayload()!
    expect(p.closed_reason).toBe('won')
    expect(p).not.toHaveProperty('closed_note')
  })

  it('a plain Won with an optional completion note still works', async () => {
    arm(); armCommitTail()
    await patch({ stage: 'Closed Won', closed_note: 'Wrapped up nicely' })
    expect(updatePayload()!.closed_reason).toBe('won')
    expect(updatePayload()!.closed_note).toBe('Wrapped up nicely')
  })

  it('a Closed LOST with no note is still fine — the mandatory reason is the override’s rule alone', async () => {
    arm(ENG({ stage: 'Estimate' })); armCommitTail()
    const res = await patch({ stage: 'Closed Lost', closed_reason: 'No response' })
    expect(res.status).toBe(200)
    expect(updatePayload()!.closed_reason).toBe('No response')
  })

  it('the override reason on a LOST close is stored as an ordinary label, not gated', async () => {
    // closed_reason is free text on Lost (the admin picklist is the
    // source of truth). The mandatory-note rule is scoped to Won — it
    // must not leak across and start refusing Lost closes.
    arm(ENG({ stage: 'Estimate' })); armCommitTail()
    const res = await patch({ stage: 'Closed Lost', closed_reason: WON_OVER_BALANCE })
    expect(res.status).toBe(200)
    expect(updatePayload()!.closed_reason).toBe(WON_OVER_BALANCE)
  })
})
