// @vitest-environment node
//
// #122 client path — archiving a client in Jobber emits a bare CLIENT_UPDATE
// carrying Client.isArchived. The client STILL EXISTS and stays a lead:
//   • isArchived true  → stamp leads.archived_at (idempotent) + stop drip
//     ('client_archived'). NEVER null Jobber links, delete, or mark won.
//   • isArchived false → clear archived_at (reactivate) only if set; drips
//     stay stopped (no auto-restart — the #112 re-spam guard).
//   • a normal (non-archive) client update stays a plain field refresh.
//   • bookkeeping failure NEVER fails the webhook (fail-soft).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isLeadSuppressed } from '@/lib/lead-suppression'

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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
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
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn() }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  stopActiveDripsForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/jobber-import', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/jobber-import')>()
  return { ...mod, upsertLead: vi.fn(async () => ({ id: 'lead-1', stage: 'Nurturing' })) }
})

import { handleClientUpdate } from '@/lib/jobber-webhook-handlers'
import { jobberGraphQL } from '@/lib/jobber'
import { stopActiveDripsForLead } from '@/lib/drip-lifecycle'

const ctx = (over: any = {}) => ({
  topic: 'CLIENT_UPDATE',
  itemId: '136295673',
  accountId: 'acct-1',
  occurredAt: '2026-07-31T05:48:05Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test Location' },
  ...over,
}) as any

const clientReturns = (isArchived: boolean) =>
  vi.mocked(jobberGraphQL).mockResolvedValue({
    data: { client: { id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8xMzYyOTU2NzM=', firstName: 'John', lastName: 'Smith', isArchived } },
    errors: undefined,
  } as any)

const callsTo = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOn = (table: string) => callsTo(table).flatMap(c => c.ops.map(([m]) => m))
const updatePatch = (table: string) => {
  const c = callsTo(table).find(c => c.ops.some(([m]) => m === 'update'))
  return c?.ops.find(([m]) => m === 'update')?.[1][0]
}

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('#122 isLeadSuppressed predicate', () => {
  it('junk OR archived → suppressed; active → not', () => {
    expect(isLeadSuppressed({ is_junk: true, archived_at: null })).toBe(true)
    expect(isLeadSuppressed({ is_junk: false, archived_at: '2026-07-31T00:00:00Z' })).toBe(true)
    expect(isLeadSuppressed({ is_junk: false, archived_at: null })).toBe(false)
    expect(isLeadSuppressed({ is_junk: null, archived_at: null })).toBe(false)
    expect(isLeadSuppressed(null)).toBe(false)
  })
})

describe('#122 CLIENT_UPDATE archived', () => {
  it('isArchived true → stamps archived_at (guarded), stops drip client_archived, no link nulling / delete', async () => {
    clientReturns(true)
    h.enqueue('leads', null) // the archive stamp update

    const res = await handleClientUpdate(ctx())

    expect(res.processed).toBe(true)
    expect(res.note).toBe('CLIENT_UPDATE→archived')
    const patch = updatePatch('leads')
    expect(patch.archived_at).toBeTruthy()
    // Idempotent guard: only stamps when archived_at IS NULL.
    const isOps = callsTo('leads').flatMap(c => c.ops.filter(([m]) => m === 'is').map(([, a]) => a))
    expect(isOps).toContainEqual(['archived_at', null])
    // Drip stopped with the distinct reason.
    expect(stopActiveDripsForLead).toHaveBeenCalledWith('lead-1', 'client_archived')
    // Never a destroy: no jobber_* nulled, no delete, not marked won.
    expect(Object.keys(patch)).not.toContain('jobber_client_id')
    expect(patch.stage).toBeUndefined()
    expect(opsOn('leads')).not.toContain('delete')
  })

  it('bookkeeping error → webhook still processed, drip NOT stopped', async () => {
    clientReturns(true)
    h.enqueue('leads', null, { message: 'boom' }) // stamp update FAILS

    const res = await handleClientUpdate(ctx())

    expect(res.processed).toBe(true) // fail-soft
    expect(stopActiveDripsForLead).not.toHaveBeenCalled()
  })
})

describe('#122 CLIENT_UPDATE un-archive + normal refresh', () => {
  it('isArchived false + a row cleared → clears archived_at, note unarchived, drip NOT restarted', async () => {
    clientReturns(false)
    h.enqueue('leads', [{ id: 'lead-1' }]) // .select('id') after the clear → one row changed

    const res = await handleClientUpdate(ctx())

    expect(res.processed).toBe(true)
    expect(res.note).toBe('CLIENT_UPDATE→unarchived')
    expect(updatePatch('leads').archived_at).toBeNull()
    expect(stopActiveDripsForLead).not.toHaveBeenCalled() // no auto-restart of drips
  })

  it('isArchived false + nothing to clear (normal update) → plain refresh, no note', async () => {
    clientReturns(false)
    h.enqueue('leads', []) // .select('id') → zero rows changed (was not archived)

    const res = await handleClientUpdate(ctx())

    expect(res.processed).toBe(true)
    expect(res.note).toBeUndefined()
    expect(stopActiveDripsForLead).not.toHaveBeenCalled()
  })
})
