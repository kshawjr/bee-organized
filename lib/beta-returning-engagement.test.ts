// @vitest-environment node
//
// #94 / #67 — the ONE "is there an open engagement?" policy.
//
// findOpenEngagementForClient is the single shared resolver; it excludes the
// two terminal stages (Closed Won/Lost) so a won client's genuine next job
// reads as "no open engagement" and founds fresh. ensureEngagementForService-
// Request calls it before rule-1 founding and ADOPTS an existing open engagement
// only when it is an EMPTY MANUAL CONTAINER (founded_by='manual', no SR) — the
// #67 duplicate fix (a bare Send-to-Jobber next to a "Start new engagement"
// card). The adoption is guarded tight so bulk import — where every engagement
// already owns its founding SR — never collapses two distinct jobs into one.
//
// originalEngagementIds (pure) backs the "Returning client" chip: it marks a
// client's DEBUT engagement so the chip lights only on returns, not on all of a
// three-engagement client's cards.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (founding-dates test pattern) ──
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in', 'delete']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import {
  findOpenEngagementForClient,
  ensureEngagementForServiceRequest,
} from '@/lib/engagements'
import { originalEngagementIds } from '@/components/hive/shared/engagementStatus'

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const insertedOn = (table: string) => callsFor(table).some(c => opsOf(c, 'insert').length > 0)

const LEAD = { id: 'lead1', location_uuid: 'loc-uuid-1', location_id: 'loc_x', name: 'Pat Tester', request_details: 'help', project_type: null }
// foundEngagement read → lead read → engagement insert → founding-child link.
const enqueueFounding = () => {
  h.enqueue('service_requests', { engagement_id: null, id: 'sr1', notes: '', requested_at: null, created_at: null })
  h.enqueue('leads', LEAD)
  h.enqueue('engagements', { id: 'eng-new' })
  h.enqueue('service_requests', [{ id: 'sr1' }])
  h.enqueue('lead_assignees', []) // seedEngagementAssigneesFromLead: engagement_assignees probe then lead_assignees
}

beforeEach(() => h.reset())

describe('findOpenEngagementForClient — the shared open-engagement resolver', () => {
  it('excludes the two terminals and takes the most-recent open row', async () => {
    h.enqueue('engagements', [{ id: 'e-open', stage: 'Estimate', created_at: '2026-07-01T00:00:00Z', founded_by: 'manual' }])
    const res = await findOpenEngagementForClient('lead1')
    expect(res).toMatchObject({ id: 'e-open', stage: 'Estimate', founded_by: 'manual' })

    const q = callsFor('engagements')[0]
    expect(opsOf(q, 'eq')[0][1]).toEqual(['client_id', 'lead1'])
    // The terminality predicate — the ONE definition of "open".
    expect(opsOf(q, 'not')[0][1]).toEqual(['stage', 'in', '("Closed Won","Closed Lost")'])
    expect(opsOf(q, 'order')[0][1]).toEqual(['created_at', { ascending: false }])
    expect(opsOf(q, 'limit')[0][1]).toEqual([1])
  })

  it('returns null when the client has no open engagement (all terminal / none)', async () => {
    h.enqueue('engagements', [])
    expect(await findOpenEngagementForClient('lead1')).toBeNull()
  })
})

describe('ensureEngagementForServiceRequest — #67 adoption guard', () => {
  it('ADOPTS an empty manual container (open, founded_by=manual, no SR) instead of founding a duplicate', async () => {
    h.enqueue('service_requests', { engagement_id: null })                    // readEngagementIdOf
    h.enqueue('engagements', [{ id: 'eng-manual', stage: 'Request', founded_by: 'manual', created_at: '2026-07-20T00:00:00Z' }]) // findOpen
    h.enqueue('service_requests', [])                                          // engagementHasServiceRequest → none
    h.enqueue('service_requests', { engagement_id: null })                     // attach read
    // attach update → default {error:null} → attached

    const res = await ensureEngagementForServiceRequest('sr1', 'lead1')
    expect(res).toEqual({ id: 'eng-manual', created: false })
    // No engagement was founded — the whole point of the fix.
    expect(insertedOn('engagements')).toBe(false)
  })

  it('does NOT adopt a manual engagement that already owns an SR (a second job founds anew)', async () => {
    h.enqueue('service_requests', { engagement_id: null })                    // readEngagementIdOf
    h.enqueue('engagements', [{ id: 'eng-manual', stage: 'Request', founded_by: 'manual', created_at: '2026-07-20T00:00:00Z' }]) // findOpen
    h.enqueue('service_requests', [{ id: 'sr-prior' }])                        // hasSR → HAS one → not adoptable
    enqueueFounding()

    const res = await ensureEngagementForServiceRequest('sr1', 'lead1')
    expect(res).toEqual({ id: 'eng-new', created: true })
    expect(insertedOn('engagements')).toBe(true)
  })

  it('does NOT adopt a non-manual open engagement (import safety: SR-founded jobs never collapse)', async () => {
    h.enqueue('service_requests', { engagement_id: null })                    // readEngagementIdOf
    h.enqueue('engagements', [{ id: 'eng-req', stage: 'Estimate', founded_by: 'request', created_at: '2026-07-20T00:00:00Z' }]) // findOpen → not manual
    enqueueFounding()

    const res = await ensureEngagementForServiceRequest('sr1', 'lead1')
    expect(res).toEqual({ id: 'eng-new', created: true })
    expect(insertedOn('engagements')).toBe(true)
  })

  it('founds as before when the client has no open engagement at all', async () => {
    h.enqueue('service_requests', { engagement_id: null })                    // readEngagementIdOf
    h.enqueue('engagements', [])                                               // findOpen → null
    enqueueFounding()

    const res = await ensureEngagementForServiceRequest('sr1', 'lead1')
    expect(res).toEqual({ id: 'eng-new', created: true })
    expect(insertedOn('engagements')).toBe(true)
  })
})

describe('originalEngagementIds — debut detection for the Returning client chip', () => {
  it('marks exactly one debut per client (the earliest) — later ones are returns', () => {
    const debut = originalEngagementIds([
      { id: 'a1', client_id: 'A', created_at: '2026-01-01T00:00:00Z' },
      { id: 'a2', client_id: 'A', created_at: '2026-03-01T00:00:00Z' },
      { id: 'a3', client_id: 'A', created_at: '2026-06-01T00:00:00Z' },
      { id: 'b1', client_id: 'B', created_at: '2026-02-01T00:00:00Z' },
    ])
    // A three-engagement client: only the debut is excluded, both returns marked.
    expect(debut.has('a1')).toBe(true)
    expect(debut.has('a2')).toBe(false)
    expect(debut.has('a3')).toBe(false)
    // A one-engagement client: their sole engagement is a debut, never "returning".
    expect(debut.has('b1')).toBe(true)
  })

  it('breaks a created_at tie deterministically by id (exactly one debut)', () => {
    const debut = originalEngagementIds([
      { id: 'z', client_id: 'A', created_at: '2026-01-01T00:00:00Z' },
      { id: 'a', client_id: 'A', created_at: '2026-01-01T00:00:00Z' },
    ])
    expect([...debut]).toEqual(['a']) // smaller id wins the tie
  })

  it('is null/shape safe (missing fields skipped, empty input → empty set)', () => {
    expect(originalEngagementIds(null as any).size).toBe(0)
    expect(originalEngagementIds([{ id: 'x' } as any]).size).toBe(0) // no client_id → skipped
  })
})
