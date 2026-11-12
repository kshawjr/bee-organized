// @vitest-environment node
//
// The digest reads its WHOLE day (2026-11).
//
// fetchWebhookLogEvents used to stop at the newest 1,000 inbound sync_log rows
// whoever asked. On 2026-11-12 the last 24 hours held 1,732, so the daily
// digest never looked at the oldest ~40% of the day — and that morning two
// changes that never landed (Greensboro, Central Austin) sat in the unread
// part while the digest reported none. Pins:
//   · with maxRows the read pages through every row of a >1,000-row day
//   · a failure in the OLDEST part of the day reaches findNeverLanded
//   · without maxRows the read is the same single newest-1,000 query as before
//     (dashboard + instant-alert rail untouched)
//   · if even the ceiling is hit, truncated + the real total come back, so the
//     digest can say "N of M" instead of reporting on part of a day
//   · name lookups are batched, so a big day cannot outgrow one request
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = {
  id: string; location_id: string; entity_id: string; entity_type: string
  jobber_record_id: string; status: string; message: string; created_at: string
  landed_status: string; direction: string
}
const db: { rows: Row[]; calls: any[] } = { rows: [], calls: [] }

// Minimal PostgREST stand-in for the four tables the read touches. sync_log
// honours order(created_at desc), gte/lte, limit, range and head-count — and,
// like the real API, never returns more than 1,000 rows in one reply.
function builder(table: string) {
  const q: any = { table, filters: [] as any[], orders: [] as string[], limit: null, range: null, head: false, in: null }
  const api: any = {
    select: (_c: string, o?: any) => { if (o?.head) q.head = true; return api },
    eq: (c: string, v: any) => { q.filters.push(['eq', c, v]); return api },
    gte: (c: string, v: any) => { q.filters.push(['gte', c, v]); return api },
    lte: (c: string, v: any) => { q.filters.push(['lte', c, v]); return api },
    order: (c: string) => { q.orders.push(c); return api },
    limit: (n: number) => { q.limit = n; return api },
    range: (a: number, b: number) => { q.range = [a, b]; return api },
    in: (c: string, v: any[]) => { q.in = [c, v]; return api },
    then: (res: any, rej: any) => Promise.resolve(run(q)).then(res, rej),
  }
  return api
}
function run(q: any) {
  db.calls.push(q)
  if (q.table !== 'sync_log') return { data: [], error: null }
  let rows = db.rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  for (const [op, c, v] of q.filters) {
    rows = rows.filter((r: any) => (op === 'eq' ? r[c] === v : op === 'gte' ? r[c] >= v : r[c] <= v))
  }
  if (q.head) return { data: null, count: rows.length, error: null }
  if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1)
  if (q.limit != null) rows = rows.slice(0, q.limit)
  return { data: rows.slice(0, 1000), error: null }
}
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => builder(t) } }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: async () => {} }))

import { fetchWebhookLogEvents, DIGEST_MAX_ROWS } from '@/lib/webhook-observability'
import { findNeverLanded, buildWebhookDigest } from '@/lib/webhook-digest'

const HOUR = 60 * 60 * 1000
// `n` inbound rows spread evenly over the last 23 hours, newest first by index.
function day(n: number, over: (i: number) => Partial<Row> = () => ({})): Row[] {
  const now = Date.now()
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`,
    location_id: 'loc_test',
    direction: 'inbound',
    entity_id: `item-${i}`,
    entity_type: 'job',
    jobber_record_id: `${100000 + i}`,
    status: 'success',
    message: `topic=JOB_UPDATE item=${100000 + i}`,
    created_at: new Date(now - 60_000 - Math.floor((i / n) * 23 * HOUR)).toISOString(),
    landed_status: 'landed',
    ...over(i),
  }))
}
const syncLogReads = () => db.calls.filter(c => c.table === 'sync_log' && !c.head)

beforeEach(() => { db.rows = []; db.calls = [] })

describe('a 1,732-row day', () => {
  // The oldest row of the day is a REQUEST_CREATE whose fetch failed and that
  // nothing ever followed — the exact shape of the two lost requests.
  const LOST = 1731
  const busyDay = () =>
    day(1732, i => i === LOST
      ? { status: 'error', landed_status: 'not_landed', entity_type: 'request',
          message: `topic=REQUEST_CREATE item=${100000 + i} error=request_fetch: no_valid_jobber_token` }
      : {})

  it('the digest read sees every row, and the failure in the oldest part of the day', async () => {
    db.rows = busyDay()

    const { events, truncated } = await fetchWebhookLogEvents({ window: '24h', maxRows: DIGEST_MAX_ROWS })

    expect(events).toHaveLength(1732)
    expect(truncated).toBe(false)
    expect(new Set(events.map(e => e.id)).size).toBe(1732) // no row twice
    expect(syncLogReads().map(c => c.range)).toEqual([[0, 999], [1000, 1999]])

    const { neverLanded } = findNeverLanded(events, Date.now())
    expect(neverLanded).toHaveLength(1)
    expect(neverLanded[0].who).toBe(`Jobber #${100000 + LOST}`)
    expect(neverLanded[0].reason).toBe('the Jobber connection blipped and no later update came through')
  })

  it('the old capped read would have missed it — which is what happened', async () => {
    db.rows = busyDay()

    const { events, truncated } = await fetchWebhookLogEvents({ window: '24h' })

    expect(events).toHaveLength(1000)
    expect(truncated).toBe(true)
    expect(findNeverLanded(events, Date.now()).neverLanded).toHaveLength(0)
  })

  it('end to end: the digest for that day names the lost request', async () => {
    db.rows = busyDay()
    const { events, truncated, totalInWindow } = await fetchWebhookLogEvents({ window: '24h', maxRows: DIGEST_MAX_ROWS })
    const d = buildWebhookDigest({
      events, appUrl: 'https://app.test',
      coverage: truncated ? { checked: DIGEST_MAX_ROWS, total: totalInWindow ?? null } : undefined,
    })
    expect(d.suppressed).toBe(false)
    expect(d.neverLanded).toBe(1)
    expect(d.partlyChecked).toBe(false)
    expect(d.text).toContain(`Jobber #${100000 + LOST} — Request created`)
  })
})

describe('the default read is the one it always was', () => {
  it('no maxRows → ONE sync_log query: newest first, limit 1000, no range, no upper bound', async () => {
    db.rows = day(1200)

    const res = await fetchWebhookLogEvents({ window: '24h' })

    const reads = syncLogReads()
    expect(reads).toHaveLength(1)
    expect(reads[0].limit).toBe(1000)
    expect(reads[0].range).toBeNull()
    expect(reads[0].orders).toEqual(['created_at'])
    expect(reads[0].filters.map((f: any) => `${f[0]}:${f[1]}`)).toEqual(['eq:direction', 'gte:created_at'])
    expect(Object.keys(res).sort()).toEqual(['events', 'truncated']) // same shape the dashboard route spreads
    expect(db.calls.some(c => c.head)).toBe(false)
  })

  it('a maxRows at or under one page changes nothing either', async () => {
    db.rows = day(50)
    await fetchWebhookLogEvents({ window: '24h', maxRows: 1000 })
    expect(syncLogReads()).toHaveLength(1)
    expect(syncLogReads()[0].range).toBeNull()
  })
})

describe('a day past even the ceiling', () => {
  it('stops at the ceiling, and reports truncated with the REAL total', async () => {
    db.rows = day(2500)

    const res = await fetchWebhookLogEvents({ window: '24h', maxRows: 2000 })

    expect(res.events).toHaveLength(2000)
    expect(res.truncated).toBe(true)
    expect(res.totalInWindow).toBe(2500)
    expect(syncLogReads()).toHaveLength(2) // never reads past the ceiling
  })

  it('a day of EXACTLY the ceiling is a full read, not a short one', async () => {
    db.rows = day(2000)

    const res = await fetchWebhookLogEvents({ window: '24h', maxRows: 2000 })

    expect(res.events).toHaveLength(2000)
    expect(res.truncated).toBe(false)
  })

  it('the ceiling is a guard far above a real day (busiest on record: 1,866)', () => {
    expect(DIGEST_MAX_ROWS).toBeGreaterThanOrEqual(5 * 1866)
  })
})

describe('name lookups on a big day', () => {
  it('are sent in batches of at most 200 ids', async () => {
    // 450 distinct jobs → 450 ids to resolve through the jobs table.
    db.rows = day(450)
    await fetchWebhookLogEvents({ window: '24h', maxRows: DIGEST_MAX_ROWS })

    const lookups = db.calls.filter(c => c.table === 'jobs')
    expect(lookups.map(c => c.in[1].length).sort((a, b) => b - a)).toEqual([200, 200, 50])
    expect(new Set(lookups.flatMap(c => c.in[1])).size).toBe(450)
  })

  it('a small list is still one request', async () => {
    db.rows = day(30)
    await fetchWebhookLogEvents({ window: '24h' })
    expect(db.calls.filter(c => c.table === 'jobs')).toHaveLength(1)
  })
})
