// lib/founding-fingerprint.test.harness.ts — TEST-ONLY (the .test. keeps it out of the source-scanning guards; vitest does not run it — it is not *.test.ts).
//
// Runs the REAL Jobber request webhook handlers (handleRequestCreate /
// handleRequestUpdate) over a spread of ordinary founding cases against the
// in-memory table set (lib/test-memdb.ts), and records EVERYTHING they write:
// every insert/update/upsert/delete (table, op, row), every sync_log row, and
// each handler's result. Ids and timestamps are normalised so two runs of the
// same code produce byte-identical JSON.
//
// lib/__fixtures__/founding-fingerprint.before.json was written by this
// harness against the code AS IT WAS before the second-request join
// (2026-11-12, base e5ded92). lib/beta-request-join.test.tsx re-runs it on the
// current code and requires byte equality: wherever the join rule does not
// apply, founding must be exactly what it was.
//
// The caller must vi.mock '@/lib/supabase-service', '@/lib/jobber' and
// '@/lib/sync-log' onto the shared `h` object it passes in.

import { createMemDb } from '@/lib/test-memdb'
import { encodeJobberId } from '@/lib/jobber-import'

export const LOC_UUID = 'loc-uuid-nc'
export const OTHER_LOC_UUID = 'loc-uuid-other'
export const SLUG = 'loc_northcolorado'
export const NOW = '2026-11-12T18:00:00.000Z'
export const T = (minsAgo: number) => new Date(Date.parse(NOW) - minsAgo * 60_000).toISOString()

export type Shared = { db: any; requests: Record<string, any>; syncLog: any[] }

export const location = {
  id: LOC_UUID, location_id: SLUG, name: 'North Colorado', timezone: 'Mountain Time (MT)',
  jobber_account_id: 'acct-nc', jobber_access_token: 'tok',
}

const clientGid = (n: string) => encodeJobberId('Client', n)
export function jobberRequest(id: string, opts: { client?: string; createdAt?: string; assessment?: any; status?: string } = {}) {
  return {
    id: encodeJobberId('Request', id),
    title: 'Home organizing', requestStatus: opts.status ?? 'new',
    createdAt: opts.createdAt ?? NOW,
    jobberWebUri: `https://secure.getjobber.com/work_requests/${id}`,
    client: {
      id: clientGid(opts.client ?? '5001'), firstName: 'Pat', lastName: 'Lee', companyName: null,
      emails: [{ address: 'pat@example.com', primary: true }], phones: [{ number: '5551112222', primary: true }],
    },
    property: null, assessment: opts.assessment ?? null, quotes: { nodes: [] }, jobs: { nodes: [] },
  }
}

export const baseLocations = () => [{
  ...location, lifecycle_status: 'active', subscription_status: 'active',
}]
export const lead = (over: any = {}) => ({
  id: 'lead-pat', name: 'Pat Lee', first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com',
  location_id: SLUG, location_uuid: LOC_UUID, jobber_client_id: '5001', stage: 'Request', ...over,
})
export const card = (id: string, over: any = {}) => ({
  id, client_id: 'lead-pat', location_uuid: LOC_UUID, stage: 'Request', founded_by: 'request',
  title: 'Engagement – Nov 2026', closed_at: null, total_invoiced: 0, created_at: T(10), ...over,
})
export const sr = (id: string, req: string, eng: string | null, over: any = {}) => ({
  id, lead_id: 'lead-pat', location_id: SLUG, jobber_request_id: req, engagement_id: eng,
  stage: 'New', status: 'active', source: 'jobber', requested_at: T(10), created_at: T(10), ...over,
})

type Scenario = {
  name: string
  seed: () => Record<string, any[]>
  requests: () => Record<string, any>
  run: (ctx: (topic: string, req: string) => any, handlers: any) => Promise<any>
}

// Ordinary cases — the join rule must NOT apply to any of these.
export const ORDINARY: Scenario[] = [
  {
    name: 'S01 brand-new client, single REQUEST_CREATE',
    seed: () => ({ locations: baseLocations() }),
    requests: () => ({ '7001': jobberRequest('7001', { client: '5999' }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7001')),
  },
  {
    name: 'S02 known client with no cards, single REQUEST_CREATE',
    seed: () => ({ locations: baseLocations(), leads: [lead({ stage: 'New' })] }),
    requests: () => ({ '7002': jobberRequest('7002') }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7002')),
  },
  {
    name: 'S03 second request minutes after a CLOSED card',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a', { stage: 'Closed Lost', closed_at: T(5), closed_reason: 'request_destroyed' })],
      service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(8) })],
    }),
    requests: () => ({ '7003': jobberRequest('7003', { createdAt: T(2) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7003')),
  },
  {
    name: 'S04 second request minutes after an open card that has a QUOTE',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a')],
      service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(8) })],
      quotes: [{ id: 'q-a', engagement_id: 'eng-a', lead_id: 'lead-pat', location_id: SLUG, jobber_quote_id: '9001', status: 'draft' }],
    }),
    requests: () => ({ '7004': jobberRequest('7004', { createdAt: T(3) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7004')),
  },
  {
    name: 'S05 new request three days after an open, untouched card',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a', { created_at: T(3 * 24 * 60) })],
      service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(3 * 24 * 60), created_at: T(3 * 24 * 60) })],
    }),
    requests: () => ({ '7005': jobberRequest('7005', { createdAt: T(1) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7005')),
  },
  {
    name: 'S06 REQUEST_UPDATE re-ingest of a request already on its card',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a')], service_requests: [sr('sr-a', '6001', 'eng-a')],
    }),
    requests: () => ({ '6001': jobberRequest('6001', { createdAt: T(10) }) }),
    run: (c, h) => h.handleRequestUpdate(c('REQUEST_UPDATE', '6001')),
  },
  {
    name: 'S07 REQUEST_CREATE for a request Send to Jobber pre-wrote onto a card',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-m', { founded_by: 'manual' })],
      service_requests: [sr('sr-m', '7007', 'eng-m', { requested_at: T(0) })],
    }),
    requests: () => ({ '7007': jobberRequest('7007', { createdAt: T(0) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7007')),
  },
  {
    name: 'S08 empty manual container adopts the first request (#67)',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-m', { founded_by: 'manual' })],
    }),
    requests: () => ({ '7008': jobberRequest('7008', { createdAt: T(1) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7008')),
  },
  {
    name: 'S09 new client whose request already carries an assessment',
    seed: () => ({ locations: baseLocations() }),
    requests: () => ({ '7009': jobberRequest('7009', { client: '5998', assessment: { id: encodeJobberId('Assessment', '8009'), startAt: '2026-11-20T16:00:00Z', isComplete: false, duration: 60 } }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7009')),
  },
  {
    name: 'S10 REQUEST_UPDATE for an archived request',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a')], service_requests: [sr('sr-a', '6001', 'eng-a')],
    }),
    requests: () => ({ '6001': jobberRequest('6001', { status: 'archived', createdAt: T(10) }) }),
    run: (c, h) => h.handleRequestUpdate(c('REQUEST_UPDATE', '6001')),
  },
  {
    name: 'S11 second request minutes after an open card already at Estimate',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a', { stage: 'Estimate' })],
      service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(8) })],
    }),
    requests: () => ({ '7011': jobberRequest('7011', { createdAt: T(3) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7011')),
  },
  {
    name: 'S12 open untouched card minutes old, but at ANOTHER location (transferred)',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-x', { location_uuid: OTHER_LOC_UUID })],
      service_requests: [sr('sr-x', '6012', 'eng-x', { requested_at: T(8) })],
    }),
    requests: () => ({ '7012': jobberRequest('7012', { createdAt: T(3) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7012')),
  },
  {
    name: 'S13 open card minutes old at Request stage with an ASSESSMENT booked',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a')],
      service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(8) })],
      assessments: [{ id: 'as-a', engagement_id: 'eng-a', service_request_id: 'sr-a', lead_id: 'lead-pat', location_id: SLUG, scheduled_at: '2026-11-20T16:00:00Z', status: 'scheduled' }],
    }),
    requests: () => ({ '7013': jobberRequest('7013', { createdAt: T(3) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7013')),
  },
  {
    name: 'S14 UPDATE arrives before CREATE for one new request (concurrent)',
    seed: () => ({ locations: baseLocations(), leads: [lead({ stage: 'New' })] }),
    requests: () => ({ '7014': jobberRequest('7014', { createdAt: T(0) }) }),
    run: async (c, h) => Promise.all([
      h.handleRequestUpdate(c('REQUEST_UPDATE', '7014')),
      h.handleRequestCreate(c('REQUEST_CREATE', '7014')),
    ]),
  },
  {
    name: 'S15 open untouched card with an invoice total but no rows (money on it)',
    seed: () => ({
      locations: baseLocations(), leads: [lead()],
      engagements: [card('eng-a', { total_invoiced: 120 })],
      service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(8) })],
    }),
    requests: () => ({ '7015': jobberRequest('7015', { createdAt: T(3) }) }),
    run: (c, h) => h.handleRequestCreate(c('REQUEST_CREATE', '7015')),
  },
]

// Normalise ids (mem-000123 → #n in first-seen order) and drop wall-clock
// timestamps the code stamps with new Date() (the fake clock pins them, but a
// normaliser keeps the fixture readable and robust).
export function normalise(value: any): any {
  const ids = new Map<string, string>()
  const json = JSON.stringify(value, (_k, v) => v)
  const out = json.replace(/mem-\d{6}/g, m => {
    if (!ids.has(m)) ids.set(m, `#${ids.size + 1}`)
    return ids.get(m)!
  })
  return JSON.parse(out)
}

export async function runScenario(s: Scenario, h: Shared, handlers: any) {
  h.db = createMemDb(s.seed())
  h.requests = s.requests()
  h.syncLog = []
  const ctx = (topic: string, req: string) => ({ topic, itemId: req, occurredAt: NOW, location })
  const result = await s.run(ctx, handlers)
  return normalise({
    result,
    writes: h.db.writes,
    syncLog: h.syncLog,
    engagements: h.db.rows('engagements'),
    service_requests: h.db.rows('service_requests'),
  })
}
