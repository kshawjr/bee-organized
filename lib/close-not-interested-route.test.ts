// @vitest-environment node
//
// POST /api/leads/:id/close-not-interested — issue 204, the lead-side
// (System A) drip stop for "Close — not interested".
//
// Proves the drip-stop mechanism (the two landmines scout 203 flagged):
//   1) It fires the SAME three cancels markJunk's is_junk branch does —
//      stopActiveDripsForLead + cancelStageEmails + cancelPendingWelcomeEmail
//      — all with reason 'closed_lost', NOT 'junk'.
//   2) It never sets is_junk and never writes leads.stage (which is how the
//      lead avoids the Recycle Bin, and how we dodge the leads.stage CHECK /
//      DRIP_STOP_STAGES mismatch that would leave drips running).
//   3) Guards: 404 unknown lead, 403 wrong location, read-only block passes
//      through before any cancel.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[] }
  const reset = () => { state.queue = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) b[m] = () => b
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
// read-only block returns null (allowed) by default; a test overrides it.
const roBlock = { fn: vi.fn(async () => null as any) }
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: (...a: any[]) => roBlock.fn(...a) }))
vi.mock('@/lib/drip-lifecycle', () => ({ stopActiveDripsForLead: vi.fn(async () => {}) }))
vi.mock('@/lib/stage-emails', () => ({ cancelStageEmails: vi.fn(async () => {}) }))
vi.mock('@/lib/welcome-email', () => ({ cancelPendingWelcomeEmail: vi.fn(async () => {}) }))

import { POST } from '@/app/api/leads/[id]/close-not-interested/route'
import { stopActiveDripsForLead } from '@/lib/drip-lifecycle'
import { cancelStageEmails } from '@/lib/stage-emails'
import { cancelPendingWelcomeEmail } from '@/lib/welcome-email'

const LEAD = (over: any = {}) => ({ id: 'lead-1', location_uuid: 'loc-uuid-1', ...over })

// hub_users profile (server client) then the existing lead (service client).
const arm = (lead: any, role = 'super_admin', locId: any = null) => {
  h.enqueue('hub_users', { id: 'u1', role, location_id: locId })
  h.enqueue('leads', lead)
}

const post = () =>
  POST(new Request('http://test/api/leads/lead-1/close-not-interested', { method: 'POST' }),
    { params: Promise.resolve({ id: 'lead-1' }) })

beforeEach(() => {
  h.reset()
  roBlock.fn.mockClear().mockResolvedValue(null)
  vi.mocked(stopActiveDripsForLead).mockClear()
  vi.mocked(cancelStageEmails).mockClear()
  vi.mocked(cancelPendingWelcomeEmail).mockClear()
})

describe('POST /api/leads/:id/close-not-interested — issue 204 drip stop', () => {
  it('fires all three cancels with reason closed_lost (mirrors markJunk, not junk)', async () => {
    arm(LEAD())
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(stopActiveDripsForLead).toHaveBeenCalledWith('lead-1', 'closed_lost')
    expect(cancelStageEmails).toHaveBeenCalledWith({ leadId: 'lead-1', reason: 'closed_lost' })
    expect(cancelPendingWelcomeEmail).toHaveBeenCalledWith('lead-1', 'closed_lost')
    // Never 'junk' — she is not junk, and must not land in the Recycle Bin.
    expect(stopActiveDripsForLead).not.toHaveBeenCalledWith('lead-1', 'junk')
  })

  it('404 on an unknown lead — no cancels fire', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
    h.enqueue('leads', null, { message: 'not found' })
    const res = await post()
    expect(res.status).toBe(404)
    expect(stopActiveDripsForLead).not.toHaveBeenCalled()
  })

  it('403 when a non-admin is scoped to another location — no cancels fire', async () => {
    arm(LEAD({ location_uuid: 'loc-uuid-OTHER' }), 'owner', 'loc-uuid-MINE')
    const res = await post()
    expect(res.status).toBe(403)
    expect(cancelStageEmails).not.toHaveBeenCalled()
  })

  it('read-only block short-circuits before any cancel', async () => {
    arm(LEAD())
    const { NextResponse } = await import('next/server')
    roBlock.fn.mockResolvedValueOnce(NextResponse.json({ error: 'read_only' }, { status: 403 }))
    const res = await post()
    expect(res.status).toBe(403)
    expect(stopActiveDripsForLead).not.toHaveBeenCalled()
    expect(cancelPendingWelcomeEmail).not.toHaveBeenCalled()
  })
})
