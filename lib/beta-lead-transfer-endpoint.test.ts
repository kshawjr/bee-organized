// @vitest-environment node
//
// POST /api/leads/:id/transfer — corp/admin routes a loc_other global-form
// lead to a real location. This pins the load-bearing behaviors:
//   • Gate: non-admin → rejected (the client section/button are cosmetic).
//   • ALWAYS: both location columns moved coherently, destination notified,
//     system touchpoint written.
//   • ACTIVE destination: drip re-enrolled stop-THEN-start, against the
//     DESTINATION uuid (never the pre-transfer one), verified to have
//     produced exactly one active progress row — no inline blast.
//   • NON-active destination: location moved + notified, but NO drip.
//   • project_type null → routing reported, not silently mis-enrolled.
//   • Jobber-linked slug collision on the move → 409, not 500.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabase mock: chainable builder + per-table FIFO queue,
//    plus captured update/insert payloads for coherence assertions. ──
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    updates: [] as { table: string; arg: any }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.updates = []; state.inserts = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) {
      b[m] = () => b
    }
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'u1' } as any }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/lead-notification-email', () => ({
  notifyNewLead: vi.fn(async () => ({ sent: true, recipientCount: 2 })),
}))
vi.mock('@/lib/drip-lifecycle', () => ({
  stopActiveDripsForLead: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
}))

import { POST } from '@/app/api/leads/[id]/transfer/route'
import { notifyNewLead } from '@/lib/lead-notification-email'
import { stopActiveDripsForLead, startDripForLead } from '@/lib/drip-lifecycle'

const LEAD = (over: any = {}) => ({
  id: 'lead-1',
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '5615550199',
  project_type: 'Garage',
  request_details: 'Need the garage organized',
  preferred_contact: 'Text',
  location_id: 'loc_other',
  location_uuid: 'loc-other-uuid',
  jobber_client_id: null,
  ...over,
})

const DEST = (over: any = {}) => ({
  id: 'dest-uuid',
  name: 'Boulder',
  location_id: 'boulder-01',
  lifecycle_status: 'active',
  ...over,
})

// Order the endpoint consumes: hub_users (server) → leads (existing) →
// locations (dest) → leads (update result) → touchpoints (insert) →
// lead_drip_progress (verify). Callers tune the pieces they assert on.
const arm = (opts: {
  role?: string
  lead?: any
  dest?: any
  moveError?: any
  activeRow?: any
} = {}) => {
  h.enqueue('hub_users', { id: 'u1', role: opts.role ?? 'admin', location_id: null })
  h.enqueue('leads', opts.lead ?? LEAD())
  h.enqueue('locations', opts.dest ?? DEST())
  h.enqueue('leads', {}, opts.moveError ?? null)      // update result
  h.enqueue('touchpoints', { id: 'tp-1' })            // touchpoint insert
  // verify query — only consumed on the active path
  h.enqueue('lead_drip_progress', 'activeRow' in opts ? opts.activeRow : { id: 'ldp-1' })
}

const call = (body: any, id = 'lead-1') =>
  POST(
    new Request(`http://test/api/leads/${id}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as any,
    { params: Promise.resolve({ id }) },
  )

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'u1' }
  vi.mocked(notifyNewLead).mockClear()
  vi.mocked(stopActiveDripsForLead).mockClear()
  vi.mocked(startDripForLead).mockClear()
})

describe('transfer endpoint — gate', () => {
  it('401 when unauthenticated', async () => {
    authUser.current = null
    const res = await call({ destination_location_id: 'dest-uuid' })
    expect(res.status).toBe(401)
  })

  it('non-admin (owner) → 403 forbidden_admin_only, no move', async () => {
    arm({ role: 'owner' })
    const res = await call({ destination_location_id: 'dest-uuid' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_admin_only')
    expect(h.state.updates.length).toBe(0)
    expect(notifyNewLead).not.toHaveBeenCalled()
  })

  it('400 when destination_location_id missing', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'admin', location_id: null })
    const res = await call({})
    expect(res.status).toBe(400)
  })

  it('400 cannot_transfer_to_loc_other', async () => {
    arm({ dest: DEST({ id: 'loc-other-uuid', location_id: 'loc_other', name: 'Unassigned' }) })
    const res = await call({ destination_location_id: 'loc-other-uuid' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('cannot_transfer_to_loc_other')
  })
})

describe('transfer endpoint — active destination', () => {
  it('moves BOTH location columns coherently, notifies, writes touchpoint, drips once', async () => {
    arm({})
    const res = await call({ destination_location_id: 'dest-uuid' })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)

    // both columns moved together to the destination
    const move = h.state.updates.find(u => u.table === 'leads')
    expect(move?.arg).toMatchObject({ location_id: 'boulder-01', location_uuid: 'dest-uuid' })

    // destination notified (by UUID)
    expect(notifyNewLead).toHaveBeenCalledWith(
      expect.objectContaining({ location: { id: 'dest-uuid', name: 'Boulder' } }),
    )
    expect(j.notified).toBe(2)

    // system touchpoint on the destination
    const tp = h.state.inserts.find(i => i.table === 'touchpoints')
    expect(tp?.arg).toMatchObject({ kind: 'system', label: 'Transferred in', location_uuid: 'dest-uuid' })

    // stop-THEN-start, against the DESTINATION uuid (not the pre-transfer one)
    expect(stopActiveDripsForLead).toHaveBeenCalledTimes(1)
    expect(startDripForLead).toHaveBeenCalledWith('lead-1', 'dest-uuid')
    expect(startDripForLead).not.toHaveBeenCalledWith('lead-1', 'loc-other-uuid')
    expect(vi.mocked(stopActiveDripsForLead).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(startDripForLead).mock.invocationCallOrder[0])

    // exactly one active drip row verified → enrolled, no warnings
    expect(j.drip_enrolled).toBe(true)
    expect(j.drip_skipped_reason).toBeUndefined()
    expect(j.warnings).toBeUndefined()
  })

  it('reports drip_not_enrolled_after_start when the verify finds no active row', async () => {
    arm({ activeRow: null })
    const res = await call({ destination_location_id: 'dest-uuid' })
    const j = await res.json()
    expect(j.drip_enrolled).toBe(false)
    expect(j.warnings).toContain('drip_not_enrolled_after_start')
  })

  it('project_type null → routing reported, still enrolled', async () => {
    arm({ lead: LEAD({ project_type: null }) })
    const res = await call({ destination_location_id: 'dest-uuid' })
    const j = await res.json()
    expect(j.warnings).toContain('project_type_null_drip_routed_to_default')
    expect(startDripForLead).toHaveBeenCalledWith('lead-1', 'dest-uuid')
    expect(j.drip_enrolled).toBe(true)
  })
})

describe('transfer endpoint — non-active destination', () => {
  it('moves + notifies but skips the drip entirely', async () => {
    arm({ dest: DEST({ lifecycle_status: 'onboarding' }) })
    const res = await call({ destination_location_id: 'dest-uuid' })
    expect(res.status).toBe(200)
    const j = await res.json()

    // still moved coherently + notified
    const move = h.state.updates.find(u => u.table === 'leads')
    expect(move?.arg).toMatchObject({ location_id: 'boulder-01', location_uuid: 'dest-uuid' })
    expect(notifyNewLead).toHaveBeenCalledTimes(1)

    // NO drip touched
    expect(stopActiveDripsForLead).not.toHaveBeenCalled()
    expect(startDripForLead).not.toHaveBeenCalled()
    expect(j.drip_enrolled).toBe(false)
    expect(j.drip_skipped_reason).toBe('destination_not_active')
  })
})

describe('transfer endpoint — collision', () => {
  it('Jobber-linked slug collision on the move → 409, not 500', async () => {
    arm({ moveError: { code: '23505', message: 'duplicate key' } })
    const res = await call({ destination_location_id: 'dest-uuid' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('destination_has_linked_duplicate')
    // move failed → no notify / drip
    expect(notifyNewLead).not.toHaveBeenCalled()
    expect(startDripForLead).not.toHaveBeenCalled()
  })
})
