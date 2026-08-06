// @vitest-environment node
//
// POST /api/engagements { reuse_open: true } — issue 204 find-or-create.
//
// The "Close — not interested" flow founds a Closed Lost engagement for a
// lead with none. But a lead may already carry an OPEN engagement the caller
// can't see; reuse_open makes the server hand that one back instead of
// founding a second — so a lead that already HAS an engagement closes it
// rather than creating a duplicate open card. Default (unset) keeps the
// always-found "Start new engagement" behavior.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number }
  const state = { queue: [] as { table: string; resp: Resp }[] }
  const reset = () => { state.queue = [] }
  const enqueue = (table: string, data: any, error: any = null, count?: number) =>
    state.queue.push({ table, resp: { data, error, count } })
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
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(async () => null) }))
vi.mock('@/lib/lead-suppression', () => ({ fetchSuppressedLeadIds: vi.fn(async () => new Set()) }))
vi.mock('@/lib/engagements', () => ({
  foundManualEngagement: vi.fn(async () => ({ engagement: { id: 'eng-NEW', stage: 'Request' }, created: true })),
  findOpenEngagementForClient: vi.fn(async () => null),
}))

import { POST } from '@/app/api/engagements/route'
import { foundManualEngagement, findOpenEngagementForClient } from '@/lib/engagements'

const arm = () => {
  h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
  h.enqueue('leads', { id: 'c1', name: 'Sarah Watts', phone: null, email: null, location_uuid: 'loc-1' })
}

const post = (body: any) =>
  POST(new Request('http://test/api/engagements', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))

beforeEach(() => {
  h.reset()
  vi.mocked(foundManualEngagement).mockClear()
  vi.mocked(findOpenEngagementForClient).mockClear().mockResolvedValue(null as any)
})

describe('POST /api/engagements reuse_open — issue 204', () => {
  it('reuses the existing OPEN engagement (never founds a second)', async () => {
    arm()
    vi.mocked(findOpenEngagementForClient).mockResolvedValueOnce({ id: 'eng-OPEN', stage: 'Estimate', created_at: null, founded_by: 'manual' } as any)
    h.enqueue('engagements', { id: 'eng-OPEN', stage: 'Estimate', client_id: 'c1' }) // select('*').single
    h.enqueue('engagements', null, null, 2)                                          // repeat count head

    const res = await post({ client_id: 'c1', reuse_open: true })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.reused).toBe(true)
    expect(j.engagement.id).toBe('eng-OPEN')
    expect(foundManualEngagement).not.toHaveBeenCalled()
  })

  it('founds a new engagement when the lead has none', async () => {
    arm()
    // findOpenEngagementForClient → null (default); foundManualEngagement runs.
    h.enqueue('engagements', null, null, 1) // repeat count head after founding
    const res = await post({ client_id: 'c1', reuse_open: true })
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.engagement.id).toBe('eng-NEW')
    expect(foundManualEngagement).toHaveBeenCalledTimes(1)
  })

  it('without reuse_open, always founds (Start new engagement is unchanged)', async () => {
    arm()
    h.enqueue('engagements', null, null, 1)
    const res = await post({ client_id: 'c1' })
    expect(res.status).toBe(201)
    expect(findOpenEngagementForClient).not.toHaveBeenCalled()
    expect(foundManualEngagement).toHaveBeenCalledTimes(1)
  })
})
