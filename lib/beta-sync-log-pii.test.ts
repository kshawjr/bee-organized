// @vitest-environment node
//
// #110a — sync_log PII invariant at the source.
//
// Destroy/nullify webhook handlers build a `note` that the webhook route
// (app/api/webhooks/jobber/route.ts) appends verbatim into
// sync_log.message. That note used to interpolate the client's NAME
// (`lead "${lead.name}"`), writing customer PII into a table that has no
// retention and lives forever. The handle must be the lead UUID — which
// is also the better diagnostic (joinable; a name is not).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (shared beta pattern) ──────────
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
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
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn() }))

import { handleRequestDestroy, handleClientDestroy } from '@/lib/jobber-webhook-handlers'

const ctx = (over: any = {}) => ({
  topic: 'REQUEST_DESTROY',
  itemId: '555',
  accountId: 'acct-1',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test Location' },
  ...over,
}) as any

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('destroy webhook note → sync_log.message carries the lead UUID, never the name (#110a)', () => {
  it('REQUEST_DESTROY nullify note uses lead.id, not lead.name', async () => {
    h.enqueue('leads', { id: 'lead-xyz', name: 'Joe Green', stage: 'New' }) // match read
    h.enqueue('leads', null)                                                 // the update
    const res = await handleRequestDestroy(ctx())
    expect(res.processed).toBe(true)
    expect(res.note).toContain('lead-xyz')      // joinable UUID handle
    expect(res.note).not.toContain('Joe Green') // no customer name
  })

  it('CLIENT_DESTROY nullify note uses lead.id, not lead.name', async () => {
    h.enqueue('leads', { id: 'lead-abc', name: 'Sarah Mitchell', stage: 'New' })
    h.enqueue('leads', null)
    const res = await handleClientDestroy(ctx({ topic: 'CLIENT_DESTROY' }))
    expect(res.processed).toBe(true)
    expect(res.note).toContain('lead-abc')
    expect(res.note).not.toContain('Sarah Mitchell')
  })
})
