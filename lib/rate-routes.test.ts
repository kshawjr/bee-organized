// @vitest-environment node
//
// rate_per_hour write paths — the two API routes that persist the rate.
//
//   PATCH /api/locations/[id]        — Settings row. Standard sparse-patch:
//     string writes trim, empty string CLEARS to null (the guard then holds
//     rate-quoting sends — an explicit clear is a deliberate act).
//   POST  /api/locations/[id]/paths  — onboarding wizard save. Write-ONLY-
//     when-non-empty: the wizard sends '' when C/D was picked, and that must
//     never wipe a rate an owner already entered.
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'is', 'limit', 'order']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const updatePayloads = (t: string) =>
    state.calls.filter(c => c.table === t).flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({})),
  getHubUser: vi.fn(async () => ({ role: 'owner', location_id: 'loc-uuid-1' })),
}))

import { PATCH } from '@/app/api/locations/[id]/route'
import { POST as pathsPOST } from '@/app/api/locations/[id]/paths/route'

const LOC = 'loc-uuid-1'

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('PATCH /api/locations/[id] — rate_per_hour', () => {
  const req = (body: any) =>
    new Request(`http://test/api/locations/${LOC}`, { method: 'PATCH', body: JSON.stringify(body) }) as any

  it('accepts rate_per_hour and writes the trimmed free-form text', async () => {
    h.enqueue('locations', { id: LOC, rate_per_hour: '$95' })
    const res = await PATCH(req({ rate_per_hour: '  $95 ' }), { params: { id: LOC } })
    expect(res.status).toBe(200)
    const upd = h.updatePayloads('locations')
    expect(upd).toHaveLength(1)
    expect(upd[0].rate_per_hour).toBe('$95')
  })

  it('free-form values pass through untouched — no numeric coercion', async () => {
    h.enqueue('locations', { id: LOC })
    await PATCH(req({ rate_per_hour: '$85/hr (3-hour minimum)' }), { params: { id: LOC } })
    expect(h.updatePayloads('locations')[0].rate_per_hour).toBe('$85/hr (3-hour minimum)')
  })

  it('empty string clears to null (deliberate clear from Settings)', async () => {
    h.enqueue('locations', { id: LOC })
    await PATCH(req({ rate_per_hour: '' }), { params: { id: LOC } })
    expect(h.updatePayloads('locations')[0].rate_per_hour).toBeNull()
  })
})

describe('POST /api/locations/[id]/paths — rate_per_hour from the wizard', () => {
  const req = (body: any) =>
    new Request(`http://test/api/locations/${LOC}/paths`, { method: 'POST', body: JSON.stringify(body) }) as any

  it('writes the rate when the wizard provides one (A/B picked)', async () => {
    h.enqueue('locations', { id: LOC })
    const res = await pathsPOST(
      req({ default_drip_path: 'organizing-a', default_move_drip_path: 'moving-c', calendar_link: '', rate_per_hour: '$95' }),
      { params: { id: LOC } },
    )
    expect(res.status).toBe(200)
    const upd = h.updatePayloads('locations')[0]
    expect(upd.rate_per_hour).toBe('$95')
    expect(upd.default_drip_path).toBe('organizing-a')
  })

  it("empty rate ('' — C/D picked) NEVER wipes a saved rate: key absent from the patch", async () => {
    h.enqueue('locations', { id: LOC })
    await pathsPOST(
      req({ default_drip_path: 'organizing-c', default_move_drip_path: 'moving-c', calendar_link: '', rate_per_hour: '' }),
      { params: { id: LOC } },
    )
    const upd = h.updatePayloads('locations')[0]
    expect('rate_per_hour' in upd).toBe(false)
  })
})
