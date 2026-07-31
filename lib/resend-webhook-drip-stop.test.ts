// @vitest-environment node
//
// #104 — the Resend delivery webhook route (app/api/webhooks/resend/route.ts).
//
// THE POINT OF THIS SUITE is the correctness trap the scout named: a hard
// bounce stops a client's drip, but ONLY when the bounced row is the drip email
// itself (email_kind='drip'). A bounce on a 'lead_notification' row means an
// internal staffer's mailbox is dead and must NEVER silence the client's drip —
// it updates delivery_status and nothing else. This is the one way the build
// could do real damage, so it's pinned first.
//
// Also pinned: soft bounce records only; complaint stops with a distinct
// reason; delivered records only; verification failure 401s with no write; and
// a Svix redelivery is idempotent (no double stop, no second touchpoint).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'

// ── chainable supabaseService mock (per-table FIFO queue + call recording) ──
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
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
  const updatePayloads = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

// recordDripTouchpoint is the exact helper the send loop uses (exported for us
// in #104). Spy on it so we can assert the Timeline trace rides the STOP
// transition and nothing else.
const touchpointMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/drip-send', () => ({ recordDripTouchpoint: touchpointMock }))

import { POST } from '@/app/api/webhooks/resend/route'

const SECRET = 'whsec_' + Buffer.from('resend-test-secret-abc123').toString('base64')

function svixHeaders(body: string, opts: { id?: string; ts?: number; secret?: string } = {}) {
  const id = opts.id ?? 'msg_2Kx'
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const secret = opts.secret ?? SECRET
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }
}

function envelope(type: string, data: Record<string, any>) {
  return JSON.stringify({ type, created_at: '2026-07-30T00:00:00Z', data })
}
const bounce = (bounceType: string, email_id = 're_1') =>
  envelope('email.bounced', { email_id, to: ['x@example.com'], bounce: { type: bounceType, subType: 'General', message: 'm' } })
const complaint = (email_id = 're_1') =>
  envelope('email.complained', { email_id, to: ['x@example.com'] })
const delivered = (email_id = 're_1') =>
  envelope('email.delivered', { email_id, to: ['x@example.com'] })

async function post(body: string, headers: Record<string, string>) {
  const req = new Request('http://test/api/webhooks/resend', { method: 'POST', headers, body })
  return POST(req as any)
}
// sign + post with valid Svix headers
const send = (body: string) => post(body, svixHeaders(body))

beforeEach(() => {
  h.reset()
  touchpointMock.mockReset()
  touchpointMock.mockResolvedValue(undefined)
  process.env.RESEND_WEBHOOK_SECRET = SECRET
})

describe('hard bounce on a drip row → drip stopped', () => {
  it('stops the drip, records hard_bounce, writes a touchpoint, marks bounced', async () => {
    h.enqueue('notification_log', [{ id: 'n1', lead_id: 'L1', location_id: 'loc1', email_kind: 'drip' }])
    h.enqueue('notification_log', null)            // delivery_status update
    h.enqueue('lead_drip_progress', [{ id: 'p1' }]) // one active drip flipped

    const res = await send(bounce('Permanent'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.terminal).toBe(true)
    expect(json.reason).toBe('hard_bounce')
    expect(json.drips_stopped).toBe(1)

    // delivery_status='bounced' written to the notebook
    expect(h.updatePayloads('notification_log')[0]).toMatchObject({ delivery_status: 'bounced' })
    // drip stopped with the DISTINCT reason (never #73's 'invalid_recipient')
    expect(h.updatePayloads('lead_drip_progress')[0]).toMatchObject({ stopped_reason: 'hard_bounce' })
    // Timeline trace on the stop transition
    expect(touchpointMock).toHaveBeenCalledTimes(1)
    expect(touchpointMock).toHaveBeenCalledWith('L1', 'loc1', { status: 'failed', label: 'Drip stopped — email bounced' })
  })
})

describe('THE TRAP — hard bounce on a lead_notification row → NO drip stop', () => {
  it('updates delivery_status but never touches lead_drip_progress', async () => {
    h.enqueue('notification_log', [{ id: 'n1', lead_id: 'L1', location_id: 'loc1', email_kind: 'lead_notification' }])
    h.enqueue('notification_log', null) // delivery_status update

    const res = await send(bounce('Permanent'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.drips_stopped).toBe(0)
    // delivery_status still recorded — the internal mailbox IS dead
    expect(h.updatePayloads('notification_log')[0]).toMatchObject({ delivery_status: 'bounced' })
    // …but the client's drip was never opened
    expect(h.callsFor('lead_drip_progress')).toHaveLength(0)
    expect(touchpointMock).not.toHaveBeenCalled()
  })
})

describe('soft bounce → record only', () => {
  it('Transient bounce updates delivery_status and stops nothing', async () => {
    h.enqueue('notification_log', [{ id: 'n1', lead_id: 'L1', location_id: 'loc1', email_kind: 'drip' }])
    h.enqueue('notification_log', null)

    const res = await send(bounce('Transient'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.terminal).toBeUndefined()
    expect(h.updatePayloads('notification_log')[0]).toMatchObject({ delivery_status: 'bounced' })
    expect(h.callsFor('lead_drip_progress')).toHaveLength(0)
    expect(touchpointMock).not.toHaveBeenCalled()
  })
})

describe('complaint → stopped with spam_complaint', () => {
  it('stops the drip with the distinct complaint reason', async () => {
    h.enqueue('notification_log', [{ id: 'n1', lead_id: 'L1', location_id: 'loc1', email_kind: 'drip' }])
    h.enqueue('notification_log', null)
    h.enqueue('lead_drip_progress', [{ id: 'p1' }])

    const res = await send(complaint())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.reason).toBe('spam_complaint')
    expect(h.updatePayloads('notification_log')[0]).toMatchObject({ delivery_status: 'complained' })
    expect(h.updatePayloads('lead_drip_progress')[0]).toMatchObject({ stopped_reason: 'spam_complaint' })
    expect(touchpointMock).toHaveBeenCalledWith('L1', 'loc1', { status: 'failed', label: 'Drip stopped — spam complaint' })
  })
})

describe('delivered → delivery_status only', () => {
  it('records delivered, no read of drips, no stop', async () => {
    h.enqueue('notification_log', [{ id: 'n1', lead_id: 'L1', location_id: 'loc1', email_kind: 'drip' }])
    h.enqueue('notification_log', null)

    const res = await send(delivered())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.processed).toBe(true)
    expect(h.updatePayloads('notification_log')[0]).toMatchObject({ delivery_status: 'delivered' })
    expect(h.callsFor('lead_drip_progress')).toHaveLength(0)
    expect(touchpointMock).not.toHaveBeenCalled()
  })
})

describe('verification failure → 401, no write', () => {
  it('bad signature never touches the DB', async () => {
    const body = bounce('Permanent')
    const res = await post(body, { 'svix-id': 'x', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,wrongsig' })
    expect(res.status).toBe(401)
    expect(h.state.calls).toHaveLength(0)
    expect(touchpointMock).not.toHaveBeenCalled()
  })

  it('missing secret rejects everything', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    const body = bounce('Permanent')
    const res = await post(body, svixHeaders(body)) // headers computed with default secret, but env is unset
    expect(res.status).toBe(401)
    expect(h.state.calls).toHaveLength(0)
  })
})

describe('redelivery → idempotent', () => {
  it('a second delivery of an already-stopped drip stops nothing and writes no touchpoint', async () => {
    // Drip already stopped: the active-only update flips ZERO rows.
    h.enqueue('notification_log', [{ id: 'n1', lead_id: 'L1', location_id: 'loc1', email_kind: 'drip' }])
    h.enqueue('notification_log', null)
    h.enqueue('lead_drip_progress', []) // nothing active → nothing flipped

    const res = await send(bounce('Permanent'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.drips_stopped).toBe(0)
    // delivery_status is re-set (harmless, idempotent) but no touchpoint fires
    expect(h.updatePayloads('notification_log')[0]).toMatchObject({ delivery_status: 'bounced' })
    expect(touchpointMock).not.toHaveBeenCalled()
  })
})
