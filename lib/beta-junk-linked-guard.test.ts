// @vitest-environment node
//
// PATCH /api/leads/:id — the Jobber-owns-deletion rule, API floor
// (Kevin 7/10): junking (is_junk=true) is Bee Hub's deletion door and
// it is PRE-JOBBER territory only. A Jobber-linked lead's lifecycle
// belongs to Jobber — its *_DESTROY webhooks (service-client writes,
// never this route) are the sole deletion path. Browser surfaces hide
// the affordance; this 409 is the enforcement, mirroring the
// manual_stage_move_rejected precedent (beta-stage-terminal-only).
//
//   1) is_junk=true on a linked lead → 409 jobber_linked_junk_rejected,
//      BEFORE any write (updateLead never called).
//   2) is_junk=true on an unlinked lead still commits (the Inbox bulk
//      Remove path).
//   3) is_junk=false stays allowed on linked leads — restore/undo and
//      Bin resurrection must keep working.
//   4) Non-junk fields on a linked lead are untouched by the hardening.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabase mock (stage-terminal-only pattern):
//    chainable builder, per-table FIFO response queues. ──────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
  }
  const reset = () => { state.queue = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) {
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
vi.mock('@/lib/dual-write', () => ({ updateLead: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-contact-sync', () => ({ syncLeadContactToJobber: vi.fn(async () => null) }))
vi.mock('@/lib/jobber-address-sync', () => ({ syncLeadAddressToJobber: vi.fn(async () => null) }))

import { PATCH } from '@/app/api/leads/[id]/route'
import { updateLead } from '@/lib/dual-write'

const LEAD = (over: any = {}) => ({
  id: 'lead-1', location_uuid: 'loc-uuid-1', location_id: 'kc',
  stage: 'New', jobber_client_id: null,
  phone: null, email: null, address: null, city: null, state: null, zip: null, addresses: [],
  ...over,
})

// Queue the pair every PATCH consumes first: hub_users profile (server
// client) then the existing lead (service client). Success paths also
// refetch the lead — queue a fresh row for those.
const arm = (lead: any, { refetch = true } = {}) => {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('leads', lead)
  if (refetch) h.enqueue('leads', { ...lead })
}

const patchReq = (body: any) =>
  PATCH(
    new Request('http://test/api/leads/lead-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'lead-1' }) }
  )

beforeEach(() => {
  h.reset()
  vi.mocked(updateLead).mockClear()
})

describe('jobber-linked junk hardening', () => {
  it('409 jobber_linked_junk_rejected on is_junk=true for a linked lead — before any write', async () => {
    arm(LEAD({ jobber_client_id: 'jc-42' }), { refetch: false })
    const res = await patchReq({ is_junk: true })
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.error).toBe('jobber_linked_junk_rejected')
    expect(updateLead).not.toHaveBeenCalled()
  })

  it('is_junk=true on an UNLINKED lead still commits (Inbox Remove path)', async () => {
    arm(LEAD())
    const res = await patchReq({ is_junk: true })
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalledWith('lead-1', expect.objectContaining({ is_junk: true }))
  })

  it('is_junk=false stays allowed on a linked lead (restore/undo, Bin resurrection)', async () => {
    arm(LEAD({ jobber_client_id: 'jc-42' }))
    const res = await patchReq({ is_junk: false })
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalledWith('lead-1', expect.objectContaining({ is_junk: false }))
  })

  it('non-junk fields on a linked lead are untouched by the hardening', async () => {
    arm(LEAD({ jobber_client_id: 'jc-42' }))
    const res = await patchReq({ snoozed_until: '2026-08-01' })
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalledWith('lead-1', expect.objectContaining({ snoozed_until: '2026-08-01' }))
  })
})
