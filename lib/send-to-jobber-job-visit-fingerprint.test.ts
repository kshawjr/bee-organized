// @vitest-environment node
//
// A SEND WITH NO TIME DOES EXACTLY WHAT IT DID BEFORE THE VISIT TIME EXISTED —
// by fingerprint (2026-11-14).
//
// RECORDED on 09cb317 (the commit before the visit time), by running THIS file
// there with FP_RECORD=1 — it imports nothing the visit work added. The
// fingerprint is everything a send does that anyone could notice: every
// Jobber document and its variables in order, every database write, every
// sync_log row, and the HTTP status + reply. Four sends: a job with a date, a
// job with no date, a request, and a request with an assessment.
//
// Nothing is allowed to differ. The request paths are in here on purpose:
// the visit work must not touch them at all.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn(), jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-import', async (orig) => ({
  encodeJobberId: ((await orig()) as any).encodeJobberId,
  upsertServiceRequest: vi.fn(async () => ({ id: 'sr-db-1' })),
  upsertJob: vi.fn(async () => ({ id: 'job-db-1' })),
}))
vi.mock('@/lib/engagements', () => ({ attachToEngagement: vi.fn(async () => {}), isFallbackTitle: () => false }))
vi.mock('@/lib/lead-assignment', () => ({ resolveAndPersistLeadAssigneesIfEmpty: vi.fn(async () => {}) }))
vi.mock('@/lib/engagement-assignee-sync', () => ({
  getLeadAssignees: vi.fn(async () => []),
  getEngagementAssignees: vi.fn(async () => []),
  resolveJobberAssignment: () => ({ primaryJobberUserId: null, allJobberUserIds: [], mappedCount: 0, unmappedCount: 0 }),
}))
vi.mock('@/lib/assessment-type-record', () => ({ recordSentAssessmentType: vi.fn(async () => ({ ok: true })) }))

import { POST } from '@/app/api/leads/[id]/send-to-jobber/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'
import { writeSyncLog } from '@/lib/sync-log'

const SNAP = new URL('./send-to-jobber-job-visit-fingerprint.snapshot.json', import.meta.url)
const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')
const CLIENT_GID = gid('Client', '136289662')
const PROP_GID = gid('Property', '880011')

const lead = {
  id: 'lead-1', location_id: 'loc_palmbeach', location_uuid: 'loc-uuid-1',
  name: 'Michelle Durpetti', first_name: 'Michelle', last_name: 'Durpetti', email: '', phone: '3125550100',
  addresses: [{ street: '12 Elm St', city: 'West Palm Beach', state: 'FL', zip: '33401' }],
  address: '12 Elm St', city: 'West Palm Beach', state: 'FL', zip: '33401',
  jobber_client_id: '136289662', jobber_property_id: null, jobber_request_id: null,
  jobber_assessment_id: null, jobber_job_id: null, scheduled_at: null,
}

let dbWrites: any[] = []
function chainFor(table: string, row: any) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'is']) chain[m] = vi.fn(() => chain)
  for (const w of ['update', 'insert', 'upsert', 'delete']) chain[w] = vi.fn((p: any) => { dbWrites.push({ table, op: w, payload: p }); return chain })
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: any) => resolve({ data: row, error: null })
  return chain
}

function wire() {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor('hub_users', { id: 'u1', role: 'owner', location_id: 'loc-uuid-1' })),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(table, lead)
    if (table === 'locations') return chainFor(table, { id: 'loc-uuid-1', location_id: 'loc_palmbeach', name: 'Palm Beach', timezone: 'Eastern Time (ET)', jobber_access_token: 'tok', lifecycle_status: 'active', subscription_status: 'active' })
    return chainFor(table, null)
  })
  ;(jobberGraphQL as any).mockImplementation(async (_l: string, query: string) => {
    if (query.includes('GetClientById')) return { data: { client: { id: CLIENT_GID, firstName: 'Michelle', lastName: 'Durpetti', companyName: null, emails: [], phones: [{ id: 'ph', number: '312-555-0100', primary: true }] } } }
    if (query.includes('GetClientProperties')) return { data: { client: { clientProperties: { nodes: [{ id: PROP_GID, address: { street1: '12 Elm St', street2: '', city: 'West Palm Beach', province: 'FL', postalCode: '33401' } }] } } } }
    return { data: {} }
  })
  ;(jobberMutation as any).mockImplementation(async (_l: string, m: string) => {
    if (m.includes('jobCreate')) return { data: { jobCreate: { job: { id: gid('Job', '160366153'), createdAt: 'x', jobberWebUri: 'x', title: 't', jobStatus: 'upcoming', startAt: null, completedAt: null, total: 450, client: { id: CLIENT_GID }, property: { id: PROP_GID } } } } }
    if (m.includes('requestCreate')) return { data: { requestCreate: { request: { id: gid('Request', '77') } } } }
    if (m.includes('assessmentCreate')) return { data: { assessmentCreate: { assessment: { id: gid('Assessment', '88'), assignedUsers: { nodes: [] } } } } }
    if (m.includes('clientEdit')) return { data: { clientEdit: { client: { id: CLIENT_GID } } } }
    return { data: {} }
  })
}

const SENDS: Record<string, any> = {
  job_with_date: { creation_type: 'job_direct', line_items: [{ name: 'Garage', unitPrice: 450, quantity: 1 }], scheduled_at: '2026-10-23' },
  job_no_date:   { creation_type: 'job_direct', line_items: [{ name: 'Garage', unitPrice: 450, quantity: 1 }] },
  request_only:  { creation_type: 'request_only' },
  request_with_assessment: { creation_type: 'request_with_assessment', scheduled_assessment_at: '2026-10-23T14:00:00.000Z', assessment_type: 'in-person' },
}

// Times the route stamps from the clock are blanked; everything else is kept.
const blank = (v: any) => JSON.parse(JSON.stringify(v, (_k, x) =>
  typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(x) && !x.startsWith('2026-10-23') ? '<now>' : x,
).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?=")/g, (s) => (s.startsWith('2026-10-23') ? s : '<now>')))

async function fingerprint(body: any) {
  vi.clearAllMocks(); dbWrites = []
  wire()
  const req: any = new Request('http://test/api/leads/lead-1/send-to-jobber', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  req.nextUrl = new URL('http://test/api/leads/lead-1/send-to-jobber')
  const res = await POST(req, { params: Promise.resolve({ id: 'lead-1' }) } as any)
  return blank({
    status: res.status,
    reply: await res.json(),
    jobber: [
      ...(jobberGraphQL as any).mock.calls.map((c: any[]) => ({ kind: 'query', loc: c[0], doc: c[1], vars: c[2] })),
      ...(jobberMutation as any).mock.calls.map((c: any[]) => ({ kind: 'mutation', loc: c[0], doc: c[1], vars: c[2] })),
    ],
    jobberOrder: (jobberMutation as any).mock.invocationCallOrder.concat((jobberGraphQL as any).mock.invocationCallOrder).length,
    dbWrites,
    syncLog: (writeSyncLog as any).mock.calls.map((c: any[]) => c[0]),
  })
}

const hash = (v: any) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

beforeEach(() => { vi.clearAllMocks() })

describe('no time picked — byte-for-byte the send before visit times existed', () => {
  it('every send matches the fingerprint recorded on 09cb317', async () => {
    const now: Record<string, any> = {}
    for (const [name, body] of Object.entries(SENDS)) now[name] = await fingerprint(body)
    if (process.env.FP_RECORD) {
      writeFileSync(SNAP, JSON.stringify({ recordedOn: process.env.FP_RECORD, hashes: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, hash(v)])), detail: now }, null, 1))
      return
    }
    const snap = JSON.parse(readFileSync(SNAP, 'utf8'))
    expect(snap.recordedOn).toBe('09cb317')
    for (const name of Object.keys(SENDS)) {
      expect(now[name], `${name} differs from 09cb317`).toEqual(snap.detail[name])
      expect(hash(now[name])).toBe(snap.hashes[name])
    }
  })
})
