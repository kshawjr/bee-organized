// @vitest-environment node
//
// findJustClosedManualEngagement — the lost-lead close's second-press guard.
//
// POST /api/engagements { reuse_open } (the Close wizard on a lead with no
// engagement) used to reuse only an OPEN card. Closing the same lead again
// found none — the first card was already closed — and founded a second
// closed card: 8 leads, 25 s to 21 min apart (Aug–Sep 2026). The lookup
// under test is what the route now falls back to. The mock returns whatever
// is queued, so these tests pin the FILTERS the query sends: only this
// client, only cards this route makes (manual), only Lost, only closed in
// the last 30 minutes, newest close first.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Call = { table: string; ops: [string, any[]][] }
  const state = { rows: [] as any[], calls: [] as Call[] }
  const makeBuilder = (table: string) => {
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'gt', 'lt', 'not', 'in', 'is', 'order', 'limit']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.then = (res: any, rej: any) => Promise.resolve({ data: state.rows, error: null }).then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { findJustClosedManualEngagement, JUST_CLOSED_WINDOW_MS } from '@/lib/engagements'

const NOW = new Date('2026-10-19T18:00:00.000Z')
const ops = () => h.state.calls[0].ops
const has = (m: string, ...args: any[]) =>
  ops().some(([om, oa]) => om === m && JSON.stringify(oa) === JSON.stringify(args))

beforeEach(() => { h.state.rows = []; h.state.calls = [] })

describe('findJustClosedManualEngagement', () => {
  it('the window is 30 minutes', () => {
    expect(JUST_CLOSED_WINDOW_MS).toBe(30 * 60 * 1000)
  })

  it('asks only for this client\'s manual cards closed Lost in the last 30 minutes, newest close first', async () => {
    await findJustClosedManualEngagement('c1', NOW)
    expect(h.state.calls).toHaveLength(1)
    expect(h.state.calls[0].table).toBe('engagements')
    expect(has('eq', 'client_id', 'c1')).toBe(true)
    expect(has('eq', 'founded_by', 'manual')).toBe(true)
    expect(has('eq', 'stage', 'Closed Lost')).toBe(true)
    expect(has('gte', 'closed_at', '2026-10-19T17:30:00.000Z')).toBe(true)
    expect(has('order', 'closed_at', { ascending: false })).toBe(true)
    expect(has('limit', 1)).toBe(true)
  })

  it('returns the card it finds', async () => {
    h.state.rows = [{ id: 'eng-1', stage: 'Closed Lost', created_at: '2026-10-19T17:59:00Z', founded_by: 'manual' }]
    const got = await findJustClosedManualEngagement('c1', NOW)
    expect(got?.id).toBe('eng-1')
  })

  it('returns null when there is none', async () => {
    expect(await findJustClosedManualEngagement('c1', NOW)).toBeNull()
  })
})
