// @vitest-environment node
//
// Requestless-import gap (2026-07-09).
//
// Jobber allows quotes/jobs created directly on a client with no service
// request ("quote-first" / "job-first" bookings). The bulk import's
// QUOTES_QUERY/JOBS_QUERY only fetched request{id}, so requestless work
// was fetched, staged, then silently dropped in the request-keyed join —
// the client imported with zero history and derived Nurturing. The live
// webhook handleQuoteCore hard-dropped the same shape
// (quote_missing_request).
//
// Fix under test:
//   * client{id} rides in QUOTES_QUERY / JOBS_QUERY / SINGLE_QUOTE_QUERY
//   * import route indexes requestless quotes/jobs by client.id and writes
//     them with service_request_id null, founding engagements via
//     resolveEngagementForChild (rule 5) — never the SR-founding path
//   * requestless work counts toward determineLeadStage
//   * handleQuoteCore gets the client{id} fallback handleJobCore has
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'

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
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
}))
vi.mock('@/lib/jobber-disconnect', () => ({
  disconnectJobberFromLocation: vi.fn(async () => ({ error: null })),
}))
const jobberGraphQL = vi.hoisted(() => vi.fn())
vi.mock('@/lib/jobber', () => ({ jobberGraphQL }))

import {
  QUOTES_QUERY,
  JOBS_QUERY,
  SINGLE_QUOTE_QUERY,
  upsertQuote,
  determineLeadStage,
} from '@/lib/jobber-import'
import { handleQuoteCreate } from '@/lib/jobber-webhook-handlers'

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
// quotes/jobs/invoices write via idempotent .upsert since the onConflict
// migration (beta-subrecord-upsert.test.ts pins that mechanism); this
// suite pins WHAT lands in the row, so collect both write shapes.
const insertPayloads = (table: string) =>
  callsFor(table).flatMap(c => [...opsOf(c, 'insert'), ...opsOf(c, 'upsert')].map(o => o[1][0]))

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
})

// ── 1. queries carry client{id} so requestless nodes are joinable ──
describe('bulk + single queries fetch client{id}', () => {
  it('QUOTES_QUERY fetches client { id } alongside request { id }', () => {
    expect(QUOTES_QUERY).toMatch(/request \{ id \}/)
    expect(QUOTES_QUERY).toMatch(/client \{ id \}/)
  })
  it('JOBS_QUERY fetches client { id } alongside request { id }', () => {
    expect(JOBS_QUERY).toMatch(/request \{ id \}/)
    expect(JOBS_QUERY).toMatch(/client \{ id \}/)
  })
  it('SINGLE_QUOTE_QUERY fetches a top-level client { id } (not only request.client)', () => {
    // strip the nested request { ... client { id } ... } line, then the
    // top-level client{id} must still be present
    const withoutNested = SINGLE_QUOTE_QUERY.replace(/request \{[^}]*client \{ id \}[^}]*\}/, '')
    expect(withoutNested).toMatch(/client \{ id \}/)
  })
})

// ── 2. upsertQuote writes service_request_id null for requestless quotes ──
describe('upsertQuote with null service_request_id', () => {
  it('inserts a new requestless quote with service_request_id: null', async () => {
    h.enqueue('quotes', null)              // existing lookup → none
    h.enqueue('quotes', { id: 'q-db-1' })  // insert returning
    const res = await upsertQuote(
      { id: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzEyMw==', createdAt: '2026-07-01T00:00:00Z', amounts: { total: '500' } },
      null,
      'lead-1',
      'loc-slug',
    )
    expect(res).toMatchObject({ id: 'q-db-1', created: true })
    const inserts = insertPayloads('quotes')
    expect(inserts.length).toBe(1)
    expect(inserts[0].service_request_id).toBeNull()
    expect(inserts[0].lead_id).toBe('lead-1')
    expect(inserts[0].jobber_quote_id).toBe('123')
  })
})

// ── 3. requestless work drives lead stage (not Nurturing-by-default) ──
describe('determineLeadStage sees requestless work', () => {
  const base = { email: 'a@b.c', phone: null, clientCreatedAt: '2024-01-01T00:00:00Z', requests: [], quotes: [], jobs: [], invoices: [] }
  const now = new Date('2026-07-09T00:00:00Z').getTime()

  it('requestless-only client with a fresh quote → Estimate Sent (was Nurturing when quotes were dropped)', () => {
    const r = determineLeadStage({ ...base, quotes: [{ createdAt: '2026-07-01T00:00:00Z' }] }, now)
    expect(r).toEqual({ stage: 'Estimate Sent', isJunk: false })
  })
  it('requestless-only client with completed job + paid invoice → Closed Won', () => {
    const r = determineLeadStage({
      ...base,
      jobs: [{ jobStatus: 'COMPLETED', completedAt: '2026-05-01T00:00:00Z', createdAt: '2026-04-01T00:00:00Z' }],
      invoices: [{ invoiceStatus: 'PAID', createdAt: '2026-05-02T00:00:00Z' }],
    }, now)
    expect(r).toEqual({ stage: 'Closed Won', isJunk: false })
  })
  it('control: same client with NO work still derives Nurturing (genuinely stale leads stay put)', () => {
    const r = determineLeadStage(base, now)
    expect(r).toEqual({ stage: 'Nurturing', isJunk: false })
  })
})

// ── 4. import route wiring: requestless index + null-SR writes +
//       resolveEngagementForChild (pinned at source level — the loop is
//       inline in the route handler) ─────────────────────────────
describe('import route joins requestless quotes/jobs by client.id', () => {
  const src = readFileSync('app/api/import/jobber-clients/route.ts', 'utf8')

  it('indexes requestless quotes/jobs by client.id alongside the request-keyed maps', () => {
    expect(src).toContain('reqlessQuotesByClient')
    expect(src).toContain('reqlessJobsByClient')
    // request-joined path unchanged: still keyed through reqIds
    expect(src).toContain('if (reqIds.has(rid)) (quotesByReq[rid] ||= []).push(q)')
    expect(src).toContain('if (reqIds.has(rid)) (jobsByReq[rid] ||= []).push(j)')
  })
  it('writes requestless quotes/jobs with service_request_id null (positional null arg)', () => {
    expect(src).toMatch(/upsertQuote\(quote, null, leadId, locSlug\)/)
    expect(src).toMatch(/upsertJob\(job, null, leadId, locSlug\)/)
  })
  it('founds requestless engagements via resolveEngagementForChild, never the SR-founding path', () => {
    expect(src).toContain('resolveEngagementForChild')
    // ensureEngagementForServiceRequest appears only for the request-joined path
    const requestlessBlock = src.slice(src.indexOf('reqlessQuotesByClient[client.id]'), src.indexOf('lead-level stage classification'))
    expect(requestlessBlock).toContain('resolveEngagementForChild')
    expect(requestlessBlock).not.toContain('ensureEngagementForServiceRequest')
  })
  it('requestless quotes/jobs are included in the determineLeadStage bundle', () => {
    const bundleBlock = src.slice(src.indexOf('const clientQuotes'), src.indexOf('determineLeadStage({'))
    expect(bundleBlock).toContain('reqlessQuotesByClient[client.id]')
    expect(bundleBlock).toContain('reqlessJobsByClient[client.id]')
  })
})

// ── 5. webhook: handleQuoteCore client{id} fallback ────────────────
describe('handleQuoteCore falls back to client{id} when request is absent', () => {
  const ctx = {
    topic: 'QUOTE_CREATE',
    itemId: '456',
    occurredAt: '2026-07-09T12:00:00Z',
    location: { id: 'loc-uuid-1', location_id: 'loc-slug', name: 'Test Loc' } as any,
  }
  const requestlessQuote = {
    id: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzQ1Ng==',
    createdAt: '2026-07-09T11:00:00Z',
    jobberWebUri: 'https://jobber/quotes/456',
    quoteStatus: 'SENT',
    request: null,
    client: { id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC83ODk=' },
    amounts: { total: '750' },
  }

  it('requestless quote + existing lead → quote written (SR null), engagement founded, stage promoted', async () => {
    jobberGraphQL.mockResolvedValueOnce({ data: { quote: requestlessQuote } })
    h.enqueue('leads', { id: 'lead-1', stage: 'New' })          // findLeadByJobberClientId
    h.enqueue('quotes', null)                                    // upsertQuote existing lookup
    h.enqueue('quotes', { id: 'q-db-1' })                        // upsertQuote insert
    h.enqueue('quotes', { engagement_id: null })                 // resolve: own engagement_id
    h.enqueue('engagements', [])                                 // resolve: open engagements
    h.enqueue('engagements', null)                               // resolve: prior count (head)
    h.enqueue('quotes', { id: 'q-db-1', engagement_id: null })   // foundEngagement child read
    h.enqueue('leads', { id: 'lead-1', location_uuid: 'loc-uuid-1', location_id: 'loc-slug', name: 'Rita', request_details: null, project_type: null })
    h.enqueue('engagements', { id: 'eng-1' })                    // engagement insert
    h.enqueue('quotes', [{ id: 'q-db-1' }])                      // founding child link update
    h.enqueue('quotes', { engagement_id: 'eng-1' })              // attachToEngagement read
    h.enqueue('engagements', { id: 'eng-1', stage: 'Estimate' }) // maybeAdvance read
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('leads', { stage: 'New' })                         // promoteLeadStage read

    const res = await handleQuoteCreate(ctx)
    expect(res.processed).toBe(true)
    expect(res.error).toBeUndefined()
    expect(res.lead_id).toBe('lead-1')
    expect(res.lead_stage).toBe('Estimate Sent')

    const quoteInserts = insertPayloads('quotes')
    expect(quoteInserts.length).toBe(1)
    expect(quoteInserts[0].service_request_id).toBeNull()
    const engInserts = insertPayloads('engagements')
    expect(engInserts.length).toBe(1)
    expect(engInserts[0].founded_by).toBe('quote')
  })

  it('requestless quote with no matching lead → clean error, not a throw', async () => {
    jobberGraphQL.mockResolvedValueOnce({ data: { quote: requestlessQuote } })
    h.enqueue('leads', null)  // findLeadByJobberClientId → no lead
    const res = await handleQuoteCreate(ctx)
    expect(res).toEqual({ processed: false, error: 'quote_no_matching_lead' })
  })

  it('request-joined quote path unchanged: resolves via the SR', async () => {
    jobberGraphQL.mockResolvedValueOnce({
      data: { quote: { ...requestlessQuote, request: { id: 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMTEx' } } },
    })
    h.enqueue('service_requests', { id: 'sr-1', lead_id: 'lead-1' })  // findServiceRequestByJobberId
    h.enqueue('quotes', null)                                          // upsertQuote existing lookup
    h.enqueue('quotes', { id: 'q-db-2' })                              // upsertQuote insert
    h.enqueue('quotes', { engagement_id: 'eng-9' })                    // resolve: already attached
    h.enqueue('quotes', { engagement_id: 'eng-9' })                    // attach read (no-op)
    h.enqueue('engagements', { id: 'eng-9', stage: 'Estimate' })       // maybeAdvance read
    h.enqueue('service_requests', [])
    h.enqueue('quotes', [])
    h.enqueue('jobs', [])
    h.enqueue('invoices', [])
    h.enqueue('leads', { stage: 'Estimate Sent' })                     // promoteLeadStage read

    const res = await handleQuoteCreate(ctx)
    expect(res.processed).toBe(true)
    const quoteInserts = insertPayloads('quotes')
    expect(quoteInserts.length).toBe(1)
    expect(quoteInserts[0].service_request_id).toBe('sr-1')
  })
})
