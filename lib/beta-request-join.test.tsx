// @vitest-environment node
//
// Fix 2 of 2 (2026-11) — a second Jobber request for a client who already has
// an open, unworked card from the last hour JOINS that card instead of
// founding a second one. See lib/engagements.ts findJoinableCardForRequest.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const h = vi.hoisted(() => ({ db: null as any, requests: {} as Record<string, any>, syncLog: [] as any[] }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.db.from(t), rpc: (...a: any[]) => h.db.rpc(...a) },
}))
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: async (_loc: string, _q: string, vars: any) => {
    const hit = Object.values(h.requests).find((r: any) => r.id === vars?.id)
    return hit ? { data: { request: hit } } : { data: {} }
  },
  jobberMutation: async () => ({ data: {}, userErrors: undefined }),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: async (row: any) => { h.syncLog.push(row) } }))

import * as handlers from '@/lib/jobber-webhook-handlers'
import { ORDINARY, runScenario, NOW, T, location, jobberRequest, baseLocations, lead, card, sr, LOC_UUID, OTHER_LOC_UUID, SLUG } from '@/lib/founding-fingerprint.test.harness'
import { createMemDb } from '@/lib/test-memdb'
import { ensureEngagementForServiceRequest, JOIN_REQUEST_WINDOW_MS } from '@/lib/engagements'
import { describeJoinedRequests } from '@/components/hive/shared/joinedRequests'

const FIXTURE = 'lib/__fixtures__/founding-fingerprint.before.json'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  ;(globalThis as any).fetch = async () => { throw new Error('network disabled in test') }
})
afterAll(() => { vi.useRealTimers() })

async function fingerprintAll() {
  const out: Record<string, any> = {}
  for (const s of ORDINARY) out[s.name] = await runScenario(s, h as any, handlers)
  return out
}

describe('fingerprint — ordinary founding is byte-identical to before the join', () => {
  it('every ordinary case matches the pre-change fixture', async () => {
    const now = await fingerprintAll()
    const json = JSON.stringify(now, null, 1)
    if (process.env.FP_WRITE === '1') {
      if (!existsSync('lib/__fixtures__')) mkdirSync('lib/__fixtures__')
      writeFileSync(FIXTURE, json + '\n')
    }
    const before = readFileSync(FIXTURE, 'utf8')
    expect(json + '\n').toBe(before)
  })
})

// ── join scenarios ──────────────────────────────────────────────────────────
const ctx = (topic: string, req: string) => ({ topic, itemId: req, occurredAt: NOW, location })
function setup(seed: Record<string, any[]>, requests: Record<string, any>) {
  h.db = createMemDb({ locations: baseLocations(), leads: [lead()], ...seed })
  h.requests = requests
  h.syncLog = []
}
// Donna Hawk's shape: our request 6001 three minutes ago on an untouched card.
const donna = (over: any = {}) => ({
  engagements: [card('eng-a', { created_at: T(3) })],
  service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(3), created_at: T(3) })],
  ...over,
})
const cards = () => h.db.rows('engagements')
const reqsOn = (eng: string) => h.db.rows('service_requests').filter((r: any) => r.engagement_id === eng).map((r: any) => r.jobber_request_id).sort()
// Every request Jobber told us about has exactly one row, on exactly one card.
function everyRequestKept(jobberIds: string[]) {
  const rows = h.db.rows('service_requests')
  for (const id of jobberIds) {
    const mine = rows.filter((r: any) => r.jobber_request_id === id)
    expect(mine, `request ${id} has one row`).toHaveLength(1)
    expect(mine[0].engagement_id, `request ${id} is on a card`).toBeTruthy()
    expect(cards().some((e: any) => e.id === mine[0].engagement_id), `request ${id}'s card exists`).toBe(true)
  }
}

describe('1. a second request within the window joins the open, unworked card', () => {
  it('Donna Hawk shape: 3 minutes later → one card holding both, no second card', async () => {
    setup(donna(), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    const res = await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(res.processed).toBe(true)
    expect(cards()).toHaveLength(1)
    expect(reqsOn('eng-a')).toEqual(['6001', '6002'])
    expect(h.db.writes.filter((w: any) => w.table === 'engagements' && w.op === 'insert')).toEqual([])
    const line = h.syncLog.find(l => String(l.message).includes('REQUEST_JOINED'))
    expect(line?.message).toContain('request 6002')
    expect(line?.message).toContain('after request 6001')
    everyRequestKept(['6001', '6002'])
  })
  it('right at the edge: 60 minutes joins', async () => {
    setup(donna({ service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(60) })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(1)
  })
  it('North Colorado shape: four requests in 17 minutes all land on ONE card (window runs from the newest)', async () => {
    setup({ engagements: [card('eng-a', { created_at: T(17) })], service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(17) })] }, {})
    for (const [id, ago] of [['6002', 5], ['6003', 2], ['6004', 0]] as const) {
      h.requests[id] = jobberRequest(id, { createdAt: T(ago + 0) })
      await handlers.handleRequestCreate(ctx('REQUEST_CREATE', id))
    }
    expect(cards()).toHaveLength(1)
    expect(reqsOn('eng-a')).toEqual(['6001', '6002', '6003', '6004'])
    everyRequestKept(['6001', '6002', '6003', '6004'])
  })
  it('a run longer than the window still chains, because the window runs from the NEWEST request', async () => {
    setup({ engagements: [card('eng-a', { created_at: T(100) })], service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(100) })] }, {})
    for (const [id, ago] of [['6002', 55], ['6003', 10]] as const) {
      h.requests[id] = jobberRequest(id, { createdAt: T(ago) })
      await handlers.handleRequestCreate(ctx('REQUEST_CREATE', id))
    }
    expect(cards()).toHaveLength(1)
    expect(reqsOn('eng-a')).toEqual(['6001', '6002', '6003'])
  })
  it('joins whatever founded the card — a manual card that a Send already filled', async () => {
    setup(donna({ engagements: [card('eng-a', { founded_by: 'manual', created_at: T(3) })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(1)
    expect(reqsOn('eng-a')).toEqual(['6001', '6002'])
  })
})

describe('2. outside the window founds a new card, as today', () => {
  it('the window is 60 minutes (chosen from the data — see engagements.ts)', () => {
    expect(JOIN_REQUEST_WINDOW_MS).toBe(60 * 60 * 1000)
  })
  it('61 minutes → a second card', async () => {
    setup(donna({ service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(61) })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
    expect(reqsOn('eng-a')).toEqual(['6001'])
    expect(h.syncLog.some(l => String(l.message).includes('REQUEST_JOINED'))).toBe(false)
  })
  it('Philadelphia shape: 1.1 hours later → a second card (that pair had real work on both)', async () => {
    setup(donna({ service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(66) })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
  it('a 47-day-old untouched card and a new enquiry today are not merged', async () => {
    setup(donna({ service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(47 * 24 * 60) })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
})

describe('3. any work on the existing card → a new card', () => {
  const work: [string, Record<string, any[]>][] = [
    ['a quote', { quotes: [{ id: 'q', engagement_id: 'eng-a', jobber_quote_id: '9' }] }],
    ['a job', { jobs: [{ id: 'j', engagement_id: 'eng-a', jobber_job_id: '9' }] }],
    ['an invoice', { invoices: [{ id: 'i', engagement_id: 'eng-a', jobber_invoice_id: '9' }] }],
    ['an assessment', { assessments: [{ id: 'a', engagement_id: 'eng-a', service_request_id: 'sr-a' }] }],
  ]
  for (const [label, extra] of work) {
    it(`the card has ${label}`, async () => {
      setup(donna(extra), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
      await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
      expect(cards()).toHaveLength(2)
      expect(reqsOn('eng-a')).toEqual(['6001'])
    })
  }
  it('money on the card (total_invoiced) with no rows', async () => {
    setup(donna({ engagements: [card('eng-a', { created_at: T(3), total_invoiced: 50 })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
  it('the card has moved past Request', async () => {
    setup(donna({ engagements: [card('eng-a', { created_at: T(3), stage: 'Estimate' })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
})

describe('4. a closed card → a new card', () => {
  it('closed (closed_at set) even though the stage still reads Request', async () => {
    setup(donna({ engagements: [card('eng-a', { created_at: T(3), closed_at: T(1) })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
  it('Closed Lost', async () => {
    setup(donna({ engagements: [card('eng-a', { created_at: T(3), stage: 'Closed Lost', closed_at: T(1) })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
  it('another client’s open card is never joined', async () => {
    setup(donna({ engagements: [card('eng-a', { created_at: T(3), client_id: 'lead-other' })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
  it('a card at a location the client moved away from is not joined', async () => {
    setup(donna({ engagements: [card('eng-a', { created_at: T(3), location_uuid: OTHER_LOC_UUID })] }), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    expect(cards()).toHaveLength(2)
  })
})

describe('6. the owner sees an attached request on the card', () => {
  it('describes every request after the first, with its number, gap and a link to it', () => {
    const lines = describeJoinedRequests([
      { jobber_request_id: '35753192', requested_at: '2026-11-02T21:51:37Z', request_url: 'https://secure.getjobber.com/work_requests/35753192' },
      { jobber_request_id: '35753033', requested_at: '2026-11-02T21:48:54Z' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('A second request came in from Jobber and was added to this card: REQ-35753192, 3 minutes after REQ-35753033. If it is a separate job, open it in Jobber.')
    expect(lines[0].href).toBe('https://secure.getjobber.com/work_requests/35753192')
  })
  it('a one-request card says nothing', () => {
    expect(describeJoinedRequests([{ jobber_request_id: '1', requested_at: NOW }])).toEqual([])
    expect(describeJoinedRequests([])).toEqual([])
  })
  it('four requests → three lines, each naming the first', () => {
    const lines = describeJoinedRequests(['1', '2', '3', '4'].map((id, i) => ({ jobber_request_id: id, requested_at: T(20 - i * 5) })))
    expect(lines.map(l => l.jobberRequestId)).toEqual(['2', '3', '4'])
    expect(lines.every(l => l.text.includes('after REQ-1'))).toBe(true)
  })
  it('the card renders it at the top of its Records column, from the card’s own request rows', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(panel).toContain('const joinedRequests = describeJoinedRequests(children.service_requests)')
    expect(panel).toMatch(/const leftCol = \(\s*<div[^>]*>\s*\{joinedRequests\.map\(/)
    expect(panel).toContain('data-joined-request={j.jobberRequestId}')
  })
  it('end to end: after a join, the card’s rows produce the line', async () => {
    setup(donna(), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    const lines = describeJoinedRequests(h.db.rows('service_requests').filter((r: any) => r.engagement_id === 'eng-a'))
    expect(lines.map(l => l.jobberRequestId)).toEqual(['6002'])
  })
})

describe('7. no request is ever ignored or discarded', () => {
  it('in every ordinary case, every request Jobber sent is on a card', async () => {
    for (const s of ORDINARY) {
      if (s.name.startsWith('S10')) continue // archived: the cleanup removes it, as before (fingerprinted)
      await runScenario(s, h as any, handlers)
      everyRequestKept(Object.keys(h.requests))
    }
  })
  it('archiving the FIRST request of a joined card keeps the card open with the second', async () => {
    setup(donna(), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))
    h.requests['6001'] = jobberRequest('6001', { createdAt: T(3), status: 'archived' })
    await handlers.handleRequestUpdate(ctx('REQUEST_UPDATE', '6001'))
    const e = cards()
    expect(e).toHaveLength(1)
    expect(e[0].closed_at).toBeNull()
    expect(reqsOn('eng-a')).toEqual(['6002'])
  })
  it('the join path writes the row onto the card — it never skips the request', () => {
    const src = readFileSync('lib/engagements.ts', 'utf8')
    const fn = src.slice(src.indexOf('if (opts.joinRecentRequest) {'), src.indexOf('const founded = await foundEngagement({\n    clientId: leadId,\n    foundedBy: \'request\''))
    expect(fn).toContain("attachToEngagement('service_requests', serviceRequestId, target.id)")
    // every exit either returns a card id or falls through to founding
    expect(fn).not.toMatch(/return null/)
  })
})

describe('8. UPDATE before CREATE still ends with exactly one card', () => {
  it('a brand-new request (no card yet): one card — the 2 Nov race (also fingerprinted, S14)', async () => {
    setup({}, { '7001': jobberRequest('7001', { createdAt: T(0) }) })
    await Promise.all([handlers.handleRequestUpdate(ctx('REQUEST_UPDATE', '7001')), handlers.handleRequestCreate(ctx('REQUEST_CREATE', '7001'))])
    expect(cards()).toHaveLength(1)
    everyRequestKept(['7001'])
  })
  it('a SECOND request whose UPDATE and CREATE race: joins once, no second card', async () => {
    setup(donna(), { '6002': jobberRequest('6002', { createdAt: T(0) }) })
    await Promise.all([handlers.handleRequestUpdate(ctx('REQUEST_UPDATE', '6002')), handlers.handleRequestCreate(ctx('REQUEST_CREATE', '6002'))])
    expect(cards()).toHaveLength(1)
    expect(reqsOn('eng-a')).toEqual(['6001', '6002'])
    expect(h.db.writes.filter((w: any) => w.table === 'engagements' && w.op === 'insert')).toEqual([])
  })
})

describe('scope — only the live webhook joins', () => {
  it('the import route never asks to join (history keeps its own cards)', () => {
    const imp = readFileSync('app/api/import/jobber-clients/route.ts', 'utf8')
    expect(imp).toContain('ensureEngagementForServiceRequest(reqDbId, leadId, { title: engJobTitle })')
    expect(imp).not.toContain('joinRecentRequest')
  })
  it('without the flag, a twin-shaped request founds a new card exactly as before', async () => {
    setup(donna({ service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(3) }), sr('sr-b', '6002', null, { requested_at: T(0) })] }), {})
    const r = await ensureEngagementForServiceRequest('sr-b', 'lead-pat')
    expect(r?.created).toBe(true)
    expect(cards()).toHaveLength(2)
  })
  it('the webhook is the one caller that passes it', () => {
    const wh = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    expect(wh).toContain('ensureEngagementForServiceRequest(sr.id, lead.id, { joinRecentRequest: true })')
  })
})
