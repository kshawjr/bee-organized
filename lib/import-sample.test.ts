// @vitest-environment node
//
// Sample selection (lib/import-sample) + the idempotency pin for the
// sample-then-bulk handoff.
//
// What is pinned:
//   • TWO LANES — newest by client.createdAt + most-recently-active WITH
//     child history (quote/job/invoice), deduped, newest-first output.
//   • HISTORY REQUIRED — the active lane never picks a client with zero
//     children; a bare service request is not history.
//   • SMALL LOCATION — fewer clients than the sample target → everyone is
//     selected, so the segment finds no remainder and completes instead of
//     parking.
//   • IDEMPOTENCY — the bulk resume is the EXISTING resume path: marking
//     the sample as written and re-running selectUnwrittenClients yields
//     exactly the complement — no overlap, no gaps, no duplicates. (Proven
//     in prod by the segmented import; pinned here for the sample split.)
import { describe, it, expect, vi } from 'vitest'
import {
  buildLastChildActivity,
  selectSampleClients,
  SAMPLE_NEWEST_COUNT,
  SAMPLE_ACTIVE_COUNT,
} from '@/lib/import-sample'

// selectUnwrittenClients lives in jobber-import, which instantiates
// supabaseService at module load — stub it, same as beta-import-write-guard.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('unused in this suite') } } }))
import { selectUnwrittenClients, extractJobberId } from '@/lib/jobber-import'

// Jobber-style base64 global id for client N (extractJobberId round-trips it).
const gid = (n: number) => Buffer.from(`gid://Jobber/Client/${n}`, 'utf8').toString('base64')

const iso = (daysAgo: number) => new Date(Date.parse('2026-07-23T12:00:00Z') - daysAgo * 86400_000).toISOString()

// A staged client node; id is the Jobber global id like the real staging rows.
const client = (n: number, createdDaysAgo: number) => ({
  id: gid(n),
  createdAt: iso(createdDaysAgo),
  firstName: `C${n}`,
})

const emptyMaps = () => ({
  reqByClient: {} as Record<string, any[]>,
  quotesByReq: {} as Record<string, any[]>,
  jobsByReq: {} as Record<string, any[]>,
  reqlessQuotesByClient: {} as Record<string, any[]>,
  reqlessJobsByClient: {} as Record<string, any[]>,
})

describe('buildLastChildActivity', () => {
  it('takes the max across quotes, jobs, nested invoices, and requestless children', () => {
    const c = client(1, 400)
    const maps = emptyMaps()
    maps.reqByClient[c.id] = [{ id: 'r1' }]
    maps.quotesByReq['r1'] = [{ createdAt: iso(300) }]
    maps.jobsByReq['r1'] = [{ createdAt: iso(200), invoices: { nodes: [{ createdAt: iso(50) }] } }]
    maps.reqlessQuotesByClient[c.id] = [{ createdAt: iso(150) }]
    const out = buildLastChildActivity([c], maps)
    expect(out.get(c.id)).toBe(Date.parse(iso(50)))   // the invoice wins
  })

  it('a client with requests but NO quote/job/invoice has no entry — a bare SR is not history', () => {
    const c = client(1, 10)
    const maps = emptyMaps()
    maps.reqByClient[c.id] = [{ id: 'r1' }]           // request only, no children
    expect(buildLastChildActivity([c], maps).size).toBe(0)
  })

  it('tolerates missing/unparseable timestamps', () => {
    const c = client(1, 10)
    const maps = emptyMaps()
    maps.reqlessJobsByClient[c.id] = [{ createdAt: 'garbage', invoices: { nodes: [{}] } }]
    expect(buildLastChildActivity([c], maps).size).toBe(0)
  })
})

describe('selectSampleClients — two lanes, deduped', () => {
  it('newest lane + active-with-history lane, deduped, ~75 total', () => {
    // 200 clients: ids 1..200, id N created N days ago (1 = newest).
    const clients = Array.from({ length: 200 }, (_, i) => client(i + 1, i + 1))
    // History on the OLD half only (ids 101..200): activity recency inverse
    // of age so id 200 has the freshest child.
    const activity = new Map<string, number>()
    for (let n = 101; n <= 200; n++) activity.set(gid(n), Date.parse(iso(200 - n + 1)))

    const picked = selectSampleClients(clients, activity)
    expect(picked.length).toBe(SAMPLE_NEWEST_COUNT + SAMPLE_ACTIVE_COUNT)

    const ids = new Set(picked.map((c: any) => c.id))
    // Newest lane: ids 1..25.
    for (let n = 1; n <= SAMPLE_NEWEST_COUNT; n++) expect(ids.has(gid(n))).toBe(true)
    // Active lane: the 50 most-recently-active with history = ids 200 down to 151.
    for (let n = 151; n <= 200; n++) expect(ids.has(gid(n))).toBe(true)
    // Old clients with NO history never make it.
    expect(ids.has(gid(60))).toBe(false)
    // No duplicates.
    expect(ids.size).toBe(picked.length)
  })

  it('dedupes overlap: a newest client that also has history is picked once, freeing an active slot', () => {
    const clients = Array.from({ length: 100 }, (_, i) => client(i + 1, i + 1))
    // EVERY client has history, recency matching creation order.
    const activity = new Map<string, number>()
    for (let n = 1; n <= 100; n++) activity.set(gid(n), Date.parse(iso(n)))
    const picked = selectSampleClients(clients, activity)
    // Newest 25 also top the activity ranking; the active lane skips them and
    // fills with the next 50 → 75 unique.
    expect(picked.length).toBe(75)
    const ids = new Set(picked.map((c: any) => c.id))
    for (let n = 1; n <= 75; n++) expect(ids.has(gid(n))).toBe(true)
  })

  it('active lane requires history: without it, only the newest lane fills', () => {
    const clients = Array.from({ length: 100 }, (_, i) => client(i + 1, i + 1))
    const picked = selectSampleClients(clients, new Map())
    expect(picked.length).toBe(SAMPLE_NEWEST_COUNT)
  })

  it('SMALL LOCATION: fewer clients than the target → everyone selected (no remainder → completes, never parks)', () => {
    const clients = Array.from({ length: 40 }, (_, i) => client(i + 1, i + 1))
    const activity = new Map<string, number>([[gid(3), Date.parse(iso(1))]])
    const picked = selectSampleClients(clients, activity)
    expect(picked.length).toBe(40)
  })

  it('output is newest-client-first, matching the write loop standing order', () => {
    const clients = [client(3, 30), client(1, 1), client(2, 10)]
    const activity = new Map<string, number>([[gid(3), Date.parse(iso(2))]])
    const picked = selectSampleClients(clients, activity, { newestCount: 1, activeCount: 1 })
    expect(picked.map((c: any) => c.firstName)).toEqual(['C1', 'C3'])
  })
})

describe('IDEMPOTENCY PIN — sample then bulk is the existing resume path', () => {
  it('bulk resume writes exactly the complement of the sample: no overlap, no gaps', () => {
    const clients = Array.from({ length: 300 }, (_, i) => client(i + 1, i + 1))
    const activity = new Map<string, number>()
    for (let n = 150; n <= 300; n++) activity.set(gid(n), Date.parse(iso(300 - n + 1)))

    // Segment 1 (sample): select + "write" — the DB now holds their numeric ids.
    const sample = selectSampleClients(clients, activity)
    const written = new Set<string>(sample.map((c: any) => extractJobberId(c.id)!))

    // Segment 2 (overnight bulk): the route reloads ALL staged clients and
    // filters by what's written — the SAME gate every resumed import uses.
    const remainder = selectUnwrittenClients(clients, written)

    // Complement exactly: nothing double-written, nothing dropped.
    expect(remainder.length).toBe(clients.length - sample.length)
    const remainderIds = new Set(remainder.map((c: any) => c.id))
    for (const s of sample) expect(remainderIds.has((s as any).id)).toBe(false)
    expect(remainder.length + sample.length).toBe(clients.length)
  })
})
