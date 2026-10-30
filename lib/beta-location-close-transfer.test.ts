// @vitest-environment node
// A CLOSED location (lib/location-close) is never a transfer destination:
//   • the picker (GET /api/locations/transfer-targets) leaves it out, and keeps
//     a location whose lifecycle_status is NULL
//   • transferLead refuses it before writing, whatever the picker showed
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[], writes: [] as string[] }
  const reset = () => { state.queue = []; state.writes = [] }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) b[m] = () => b
    for (const m of ['update', 'insert', 'delete']) b[m] = () => { state.writes.push(`${table}.${m}`); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
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
vi.mock('@/lib/lead-notification-email', () => ({ notifyNewLead: vi.fn(async () => ({ sent: true, recipientCount: 1 })) }))
vi.mock('@/lib/notification-recipients', () => ({ locationHasOperationalStaff: vi.fn(async () => false) }))
vi.mock('@/lib/drip-lifecycle', () => ({ stopActiveDripsForLead: vi.fn(async () => {}), startDripForLead: vi.fn(async () => {}) }))
vi.mock('@/lib/slack-bot', () => ({ notifyNewLeadSlack: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/notification-log', () => ({ logSlackNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/realtime-broadcast', () => ({ broadcastLeadMoved: vi.fn(async () => true) }))

import { GET } from '@/app/api/locations/transfer-targets/route'
import { transferLead } from '@/lib/lead-transfer'

beforeEach(() => h.reset())

describe('transfer picker', () => {
  it('leaves a closed location out and keeps a NULL-status one', async () => {
    h.enqueue('hub_users', { id: 'u1', role: 'admin' })
    h.enqueue('locations', [
      { id: 'l-a', name: 'Austin', location_id: 'loc_austin', lifecycle_status: 'active' },
      { id: 'l-kc', name: 'Kansas City', location_id: 'loc_kc', lifecycle_status: 'closed' },
      { id: 'l-n', name: 'Nowhere', location_id: 'loc_n', lifecycle_status: null },
    ])
    h.enqueue('hub_users', [])
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).targets.map((t: any) => t.slug)).toEqual(['loc_austin', 'loc_n'])
  })
})

describe('transferLead', () => {
  it('refuses a closed destination, nothing written', async () => {
    h.enqueue('leads', { id: 'lead-1', name: 'X', location_id: 'loc_other', location_uuid: 'other-uuid', jobber_client_id: null })
    h.enqueue('locations', { id: 'l-kc', name: 'Kansas City', location_id: 'loc_kc', lifecycle_status: 'closed' })
    const out = await transferLead({ leadId: 'lead-1', destinationLocationId: 'l-kc', reason: null, actor: { hubUserId: 'u1', role: 'admin' } })
    expect(out).toEqual({ status: 400, body: { error: 'destination_closed' } })
    expect(h.state.writes).toEqual([])
  })
})
