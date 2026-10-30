// @vitest-environment node
// lib/beta-profile-duplicate-of.test.ts
// ─────────────────────────────────────────────────────────────
// GET /api/clients/:id/profile resolves leads.possible_duplicate_of (a JSONB
// ARRAY of ids) to { id, name, state } for the card's duplicate notice
// (29 Oct 2026). Pins: every id is looked up in one .in(), junk rows are
// fetched on purpose, another location's row is not named to an owner, and a
// failed lookup never takes the profile down.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number }
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
    for (const m of ['select', 'eq', 'neq', 'not', 'is', 'in', 'order', 'limit', 'range']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
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

import { GET } from '@/app/api/clients/[id]/profile/route'

const get = (id = 'copy-2de9') =>
  GET(new Request(`http://test/api/clients/${id}/profile`), { params: Promise.resolve({ id }) })

const COPY = {
  id: 'copy-2de9', name: 'Shirley Ann Morgan', location_uuid: 'loc-1', is_junk: false,
  assigned_to: null, referred_by_kind: null, referred_by_id: null,
}
// leads queue order: the record → the duplicate lookup → (referred-us etc. default to null)
const setup = (role: string, lead: any, dupRows?: any, dupErr: any = null) => {
  h.enqueue('hub_users', { id: 'u1', role, location_id: 'loc-1' })
  h.enqueue('leads', lead)
  if (dupRows !== undefined || dupErr) h.enqueue('leads', dupRows ?? null, dupErr)
}
const dupLookup = () => h.state.calls.find(c => c.table === 'leads' && c.ops.some(([m]) => m === 'in'))

beforeEach(() => h.reset())

describe('profile route — possible_duplicate_of', () => {
  it('resolves an ARRAY of several ids in one lookup, junk included, missing ones marked gone', async () => {
    setup('owner', { ...COPY, possible_duplicate_of: ['real-072e', 'binned', 'deleted'] }, [
      { id: 'real-072e', name: 'Shirley Ann Morgan', is_junk: false, location_uuid: 'loc-1' },
      { id: 'binned', name: 'Old Copy', is_junk: true, location_uuid: 'loc-1' },
    ])
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(dupLookup()!.ops).toContainEqual(['in', ['id', ['real-072e', 'binned', 'deleted']]])
    // junk is NOT filtered out of this lookup — the card says "in the bin"
    expect(dupLookup()!.ops.some(([m, a]) => m === 'not' && a[0] === 'is_junk')).toBe(false)
    expect(body.client.duplicate_of).toEqual([
      { id: 'real-072e', name: 'Shirley Ann Morgan', state: 'ok' },
      { id: 'binned', name: 'Old Copy', state: 'junk' },
      { id: 'deleted', name: null, state: 'gone' },
    ])
  })

  it("does not name another location's record to an owner", async () => {
    setup('owner', { ...COPY, possible_duplicate_of: ['elsewhere'] }, [
      { id: 'elsewhere', name: 'Someone Else', is_junk: false, location_uuid: 'loc-2' },
    ])
    const body = await (await get()).json()
    expect(body.client.duplicate_of).toEqual([{ id: 'elsewhere', name: null, state: 'gone' }])
  })

  it('a failed lookup leaves the profile up', async () => {
    setup('owner', { ...COPY, possible_duplicate_of: ['real-072e'] }, null, { message: 'boom' })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.client.duplicate_of).toEqual([{ id: 'real-072e', name: null, state: 'gone' }])
  })

  it('no flag: no lookup, empty list', async () => {
    setup('owner', { ...COPY, possible_duplicate_of: null })
    const body = await (await get()).json()
    expect(dupLookup()).toBeUndefined()
    expect(body.client.duplicate_of).toEqual([])
  })
})
