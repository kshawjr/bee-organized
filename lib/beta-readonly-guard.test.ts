// @vitest-environment node
//
// 868kawwmh — server-side read-only enforcement (defense in depth). The
// UI hides edit affordances for read-only users; these tests pin the
// floor: the write routes reject BEFORE any mutation, mirroring the
// forbidden_read_only_role / *_rejected precedents. Covered here on two
// representative routes (leads PATCH — already had the lite guard;
// engagements PATCH — the former gap):
//
//   • lite_user (own location)      → 403 forbidden_read_only_role
//   • paused / inactive location    → 403 forbidden_read_only_location
//   • past_due location (grace)     → WRITE PROCEEDS (full access)
//   • active-location owner         → writes normally (no regression)
//   • super_admin (elevated)        → writes normally, no locations query
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabase mock (same harness as beta-junk-linked-guard):
//    chainable builder, per-table FIFO response queues. ──────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[] }
  const reset = () => { state.queue = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) {
      b[m] = () => b
    }
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
// leads route deps
vi.mock('@/lib/dual-write', () => ({ updateLead: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-contact-sync', () => ({ syncLeadContactToJobber: vi.fn(async () => null) }))
vi.mock('@/lib/jobber-address-sync', () => ({ syncLeadAddressToJobber: vi.fn(async () => null) }))
// engagements route deps (only imported; PATCH close path is never reached here)
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/engagement-assignee-sync', () => ({ getEngagementAssignees: vi.fn(async () => []) }))
vi.mock('@/lib/engagements', () => ({
  ENGAGEMENT_STAGE_RANK: { Request: 0, Estimate: 1, 'Closed Won': 9, 'Closed Lost': 9 },
  recoverEngagementStageDrift: vi.fn(async () => {}),
  CLOSE_REASONS: ['won', 'lost_other'],
}))

import { PATCH as leadsPatch } from '@/app/api/leads/[id]/route'
import { PATCH as engPatch } from '@/app/api/engagements/[id]/route'
import { updateLead } from '@/lib/dual-write'

const LEAD = (over: any = {}) => ({
  id: 'lead-1', location_uuid: 'loc-uuid-1', location_id: 'kc',
  stage: 'New', jobber_client_id: null,
  phone: null, email: null, address: null, city: null, state: null, zip: null, addresses: [],
  ...over,
})

const leadPatchReq = (body: any) =>
  leadsPatch(
    new Request('http://test/api/leads/lead-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'lead-1' }) }
  )

const engPatchReq = (body: any) =>
  engPatch(
    new Request('http://test/api/engagements/eng-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'eng-1' }) }
  )

beforeEach(() => {
  h.reset()
  vi.mocked(updateLead).mockClear()
})

describe('PATCH /api/leads/:id — read-only enforcement', () => {
  it('lite_user (own location) → 403 forbidden_read_only_role, no write', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'lite_user', location_id: 'loc-uuid-1' })
    h.enqueue('leads', LEAD())
    const res = await leadPatchReq({ source: 'Referral' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only_role')
    expect(updateLead).not.toHaveBeenCalled()
  })

  it('owner at a PAUSED location → 403 forbidden_read_only_location, no write', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })
    h.enqueue('leads', LEAD())
    h.enqueue('locations', { lifecycle_status: 'paused', subscription_status: 'active' })
    const res = await leadPatchReq({ source: 'Referral' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only_location')
    expect(updateLead).not.toHaveBeenCalled()
  })

  it('owner at a PAST_DUE location → write PROCEEDS (grace keeps full access)', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })
    h.enqueue('leads', LEAD())
    h.enqueue('locations', { lifecycle_status: 'active', subscription_status: 'past_due' })
    h.enqueue('leads', LEAD({ source: 'Referral' })) // refetch
    const res = await leadPatchReq({ source: 'Referral' })
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalledWith('lead-1', expect.objectContaining({ source: 'Referral' }))
  })

  it('owner at an ACTIVE location → writes normally (no regression)', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })
    h.enqueue('leads', LEAD())
    h.enqueue('locations', { lifecycle_status: 'active', subscription_status: 'active' })
    h.enqueue('leads', LEAD({ source: 'Referral' }))
    const res = await leadPatchReq({ source: 'Referral' })
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalled()
  })

  it('super_admin → writes normally, no locations lookup needed', async () => {
    // No 'locations' row enqueued — elevated bypasses the query entirely.
    h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
    h.enqueue('leads', LEAD())
    h.enqueue('leads', LEAD({ source: 'Referral' }))
    const res = await leadPatchReq({ source: 'Referral' })
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalled()
  })
})

describe('PATCH /api/engagements/:id — read-only enforcement (former gap)', () => {
  const ENG = (over: any = {}) => ({ id: 'eng-1', location_uuid: 'loc-uuid-1', stage: 'Estimate', ...over })

  it('lite_user → 403 forbidden_read_only_role before any stage write', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'lite_user', location_id: 'loc-uuid-1' })
    h.enqueue('engagements', ENG())
    const res = await engPatchReq({ stage: 'Closed Won' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only_role')
  })

  it('owner at a PAUSED location → 403 forbidden_read_only_location', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })
    h.enqueue('engagements', ENG())
    h.enqueue('locations', { lifecycle_status: 'paused', subscription_status: 'active' })
    const res = await engPatchReq({ stage: 'Closed Won' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_read_only_location')
  })

  it('owner at an ACTIVE location passes the read-only guard (reaches normal validation)', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })
    h.enqueue('engagements', ENG())
    h.enqueue('locations', { lifecycle_status: 'active', subscription_status: 'active' })
    const res = await engPatchReq({}) // empty body → past the guard, then nothing_to_update
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('nothing_to_update')
  })

  it('super_admin passes the guard with no locations lookup', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
    h.enqueue('engagements', ENG())
    const res = await engPatchReq({})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('nothing_to_update')
  })
})
