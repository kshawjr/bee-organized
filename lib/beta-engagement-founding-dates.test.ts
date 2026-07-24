// @vitest-environment node
//
// Engagement founding dates (2026-07-24).
//
// foundEngagement stamped created_at AND stage_entered_at with nowIso
// unconditionally. Every other table carries Jobber's createdAt across
// (leads, service_requests, quotes, jobs, invoices) — so the bulk import
// founded engagements for years-old requests that read "came in today" on
// the board while the Inbox (leads.created_at) aged correctly, and the
// 21-day pre-nurture cue was pushed out by the import offset. ~4,000 prod
// engagements affected; stage derivation was NOT affected (stale-close
// reads service_requests.requested_at — verified zero wrong stages).
//
// Fix under test: foundEngagement reads the founding child's own date in
// its child read (SR requested_at, else the child row's created_at) and
// uses it for created_at, stage_entered_at, and the fallback title month;
// now only when the child carries no date (live webhook founding) or for
// foundManualEngagement (now IS the truth there). params.openedAt is an
// explicit caller override. Dates only — stage values untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (intake-test pattern): chainable
//    builder, per-table FIFO response queues. ────────────────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any; count?: number }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
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

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))

import { foundEngagement, foundManualEngagement, ensureEngagementForServiceRequest } from '@/lib/engagements'

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const insertPayload = (table: string) => {
  const withInsert = callsFor(table).find(c => opsOf(c, 'insert').length > 0)
  expect(withInsert, `expected an insert on ${table}`).toBeTruthy()
  return opsOf(withInsert!, 'insert')[0][1][0]
}

const LEAD = {
  id: 'lead1', location_uuid: 'loc-uuid-1', location_id: 'loc_x',
  name: 'Pat Tester', request_details: 'help', project_type: null,
}

// Founding sequence responses, in read order: child read → lead read →
// engagement insert → founding-child link (update…select returns rows).
const enqueueFounding = (childTable: string, childRow: Record<string, any>) => {
  h.enqueue(childTable, { engagement_id: null, ...childRow })
  h.enqueue('leads', LEAD)
  h.enqueue('engagements', { id: 'eng1' })
  h.enqueue(childTable, [{ id: childRow.id }])
}

beforeEach(() => h.reset())

describe('foundEngagement carries the founding child date', () => {
  it('service_request founding uses the SR requested_at for created_at + stage_entered_at', async () => {
    enqueueFounding('service_requests', {
      id: 'sr1', notes: '', requested_at: '2024-05-10T12:00:00Z', created_at: '2026-07-23T02:00:00Z',
    })
    const res = await foundEngagement({
      clientId: 'lead1', foundedBy: 'request',
      foundingChildTable: 'service_requests', foundingChildId: 'sr1',
    })
    expect(res).toEqual({ id: 'eng1', created: true })
    const row = insertPayload('engagements')
    expect(row.created_at).toBe('2024-05-10T12:00:00.000Z')
    expect(row.stage_entered_at).toBe('2024-05-10T12:00:00.000Z')
    expect(row.stage).toBe('Request') // dates only — opening stage untouched
  })

  it('SR child read selects requested_at + created_at (field-omission guard)', async () => {
    enqueueFounding('service_requests', {
      id: 'sr1', notes: '', requested_at: '2024-05-10T12:00:00Z', created_at: '2024-05-10T12:00:00Z',
    })
    await foundEngagement({
      clientId: 'lead1', foundedBy: 'request',
      foundingChildTable: 'service_requests', foundingChildId: 'sr1',
    })
    const childRead = callsFor('service_requests')[0]
    const sel = String(opsOf(childRead, 'select')[0][1][0])
    expect(sel).toContain('requested_at')
    expect(sel).toContain('created_at')
  })

  it('quote founding uses the quote row created_at', async () => {
    enqueueFounding('quotes', { id: 'q1', created_at: '2023-11-02T09:30:00Z' })
    const res = await foundEngagement({
      clientId: 'lead1', foundedBy: 'quote',
      foundingChildTable: 'quotes', foundingChildId: 'q1',
    })
    expect(res).toEqual({ id: 'eng1', created: true })
    const row = insertPayload('engagements')
    expect(row.created_at).toBe('2023-11-02T09:30:00.000Z')
    expect(row.stage_entered_at).toBe('2023-11-02T09:30:00.000Z')
    expect(row.stage).toBe('Estimate')
  })

  it('job founding uses the job row created_at', async () => {
    enqueueFounding('jobs', { id: 'j1', created_at: '2025-01-15T00:00:00Z' })
    await foundEngagement({
      clientId: 'lead1', foundedBy: 'job',
      foundingChildTable: 'jobs', foundingChildId: 'j1',
    })
    const row = insertPayload('engagements')
    expect(row.created_at).toBe('2025-01-15T00:00:00.000Z')
  })

  it('dateless child falls back to now (live webhook path unchanged)', async () => {
    const before = Date.now()
    enqueueFounding('service_requests', {
      id: 'sr1', notes: '', requested_at: null, created_at: null,
    })
    await foundEngagement({
      clientId: 'lead1', foundedBy: 'request',
      foundingChildTable: 'service_requests', foundingChildId: 'sr1',
    })
    const row = insertPayload('engagements')
    const t = new Date(row.created_at).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
    expect(row.stage_entered_at).toBe(row.created_at)
  })

  it('explicit openedAt overrides the child dates', async () => {
    enqueueFounding('service_requests', {
      id: 'sr1', notes: '', requested_at: '2024-05-10T12:00:00Z', created_at: '2024-05-10T12:00:00Z',
    })
    await foundEngagement({
      clientId: 'lead1', foundedBy: 'request',
      foundingChildTable: 'service_requests', foundingChildId: 'sr1',
      openedAt: '2022-02-02T02:00:00Z',
    })
    const row = insertPayload('engagements')
    expect(row.created_at).toBe('2022-02-02T02:00:00.000Z')
  })

  it('fallback title month matches the founding date, not today', async () => {
    enqueueFounding('service_requests', {
      id: 'sr1', notes: '', requested_at: '2024-05-10T12:00:00Z', created_at: '2024-05-10T12:00:00Z',
    })
    await foundEngagement({
      clientId: 'lead1', foundedBy: 'request',
      foundingChildTable: 'service_requests', foundingChildId: 'sr1',
    })
    expect(insertPayload('engagements').title).toBe('Engagement – May 2024')
  })

  it('updated_at stays now even when created_at is historical', async () => {
    const before = Date.now()
    enqueueFounding('service_requests', {
      id: 'sr1', notes: '', requested_at: '2024-05-10T12:00:00Z', created_at: '2024-05-10T12:00:00Z',
    })
    await foundEngagement({
      clientId: 'lead1', foundedBy: 'request',
      foundingChildTable: 'service_requests', foundingChildId: 'sr1',
    })
    const row = insertPayload('engagements')
    const t = new Date(row.updated_at).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })

  it('ensureEngagementForServiceRequest (the import + webhook door) carries the date through', async () => {
    // readEngagementIdOf: SR has no engagement yet.
    h.enqueue('service_requests', { engagement_id: null })
    enqueueFounding('service_requests', {
      id: 'sr1', notes: '', requested_at: '2021-09-01T08:00:00Z', created_at: '2026-07-23T02:00:00Z',
    })
    const res = await ensureEngagementForServiceRequest('sr1', 'lead1')
    expect(res).toEqual({ id: 'eng1', created: true })
    const row = insertPayload('engagements')
    expect(row.created_at).toBe('2021-09-01T08:00:00.000Z')
    expect(row.stage_entered_at).toBe('2021-09-01T08:00:00.000Z')
  })
})

describe('foundManualEngagement stays now-stamped', () => {
  it('created_at and stage_entered_at are now — a manual founding has no history', async () => {
    const before = Date.now()
    h.enqueue('leads', { id: 'lead1', location_uuid: 'loc-uuid-1', location_id: 'loc_x', name: 'Pat', is_junk: false })
    h.enqueue('engagements', { id: 'eng9', stage: 'Request' })
    const res = await foundManualEngagement({ clientId: 'lead1' })
    expect('engagement' in res && res.engagement.id).toBe('eng9')
    const row = insertPayload('engagements')
    for (const k of ['created_at', 'stage_entered_at'] as const) {
      const t = new Date(row[k]).getTime()
      expect(t).toBeGreaterThanOrEqual(before)
      expect(t).toBeLessThanOrEqual(Date.now())
    }
  })
})
