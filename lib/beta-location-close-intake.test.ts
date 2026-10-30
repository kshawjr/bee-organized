// @vitest-environment node
// /api/leads/intake — a CLOSED location takes no new leads (lib/location-close).
// The zip path can't reach one (zip routing sends anything not active /
// onboarding to Other). The no-zip path goes where the website says, so it
// checks: a closed sent location → the lead lands at Other, flagged on the log.
// Same harness as beta-intake-zip-routing.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})
const syncLog = vi.hoisted(() => ({ writeSyncLog: vi.fn(async () => {}) }))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/sync-log', () => syncLog)
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
  isPastClient: vi.fn(async () => true),
}))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => ({ sent: true })) }))
vi.mock('@/lib/engagements', () => ({
  findOpenEngagementForClient: vi.fn(async () => null),
  foundManualEngagement: vi.fn(async () => ({ engagement: { id: 'eng-1' }, created: true })),
}))

import { POST } from '@/app/api/leads/intake/route'

const makeReq = (body: any) => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? 'test-key' : null) },
  json: async () => body,
}) as any

const CLOSED_KC = { id: 'uuid-kc', name: 'Kansas City', location_id: 'loc_kc', lifecycle_status: 'closed' }
const OPEN_KC = { ...CLOSED_KC, lifecycle_status: 'active' }
const OTHER = { id: 'uuid-other', name: 'Other', location_id: 'loc_other', lifecycle_status: 'onboarding' }

const lead = { full_name: 'Pat Doe', email: 'pat@example.com', phone: '8165550100', location_slug: 'loc_kc', form_source: 'Local' }
const locationLookups = () =>
  h.state.calls
    .filter(c => c.table === 'locations')
    .map(c => c.ops.find(o => o[0] === 'eq' && o[1][0] === 'location_id')?.[1][1])
    .filter((slug): slug is string => typeof slug === 'string')
const lastLog = () => {
  const calls = syncLog.writeSyncLog.mock.calls as any[]
  return calls[calls.length - 1][0] as any
}

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
})

describe('intake — a closed sent location, no zip', () => {
  it('lands at Other, never at the closed location, and says so on the log', async () => {
    h.enqueue('locations', CLOSED_KC)
    h.enqueue('locations', OTHER)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new' })
    const res = await POST(makeReq(lead))
    expect(res.status).toBe(200)
    expect(locationLookups()).toEqual(['loc_kc', 'loc_other'])
    expect((await res.json()).location.slug).toBe('loc_other')
    expect(lastLog()).toMatchObject({ location_id: 'loc_other' })
    expect(lastLog().message).toContain('sent_loc_closed=loc_kc')
  })

  it('an open sent location is unchanged — lands there (and Other is looked up for the duplicate check)', async () => {
    h.enqueue('locations', OPEN_KC)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new' })
    const res = await POST(makeReq(lead))
    expect(res.status).toBe(200)
    // The second lookup is the duplicate check's (29 Oct 2026): a client
    // waiting in Other is looked for too. It does not change where this lands.
    expect(locationLookups()).toEqual(['loc_kc', 'loc_other'])
    expect((await res.json()).location.slug).toBe('loc_kc')
    expect(lastLog().message).not.toContain('sent_loc_closed')
  })
})
