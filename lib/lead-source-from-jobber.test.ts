// @vitest-environment node
//
// READING Jobber's lead source (30 Sept 2026).
//
// Jobber holds "how did this client hear about us" on the client
// (Client.leadSource — "Google", "Referral", an owner's own label like
// "Hershey Mills Ads"). Bee Hub never asked for it, so ~260 clients a month
// arrived from Jobber with a blank source. Pinned here:
//   · a Jobber client with a source arrives with it set
//   · "google" and "Google" land as one thing
//   · an unrecognised Jobber source comes through exactly as typed
//   · Jobber's stamp of OUR app name ("Bee Organized Interface") is not a
//     source and lands blank
//   · all four client queries (webhook + initial import) ask for the field
//   · INSERT ONLY — an existing lead is not touched (no silent backfill)
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'gte']) {
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
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'owner-1' })),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import {
  upsertLead,
  CLIENTS_QUERY,
  INCREMENTAL_CLIENTS_QUERY,
  SINGLE_CLIENT_QUERY,
  SINGLE_REQUEST_QUERY,
} from '@/lib/jobber-import'
import { leadSourceFromJobber, JOBBER_APP_SOURCE_STAMP } from '@/lib/lead-source'

const LOC_SLUG = 'loc_dallas'
const LOC_UUID = 'uuid-dallas'

const jobberClient = (over: Record<string, any> = {}) => ({
  id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC85OTk=', // extractJobberId → '999'
  firstName: 'Jane',
  lastName: 'Smith',
  companyName: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  emails: [{ address: 'jane@x.com', primary: true }],
  phones: [{ number: '214-555-0100', primary: true }],
  billingAddress: { street: '1 Main St', city: 'Dallas', province: 'TX', postalCode: '75201' },
  ...over,
})

const leadCalls = () => h.state.calls.filter(c => c.table === 'leads')
const payloadsOf = (op: string) =>
  leadCalls().flatMap(c => c.ops.filter(([m]) => m === op).map(([, a]) => a[0]))

// A brand-new client: the id SELECT misses, the match probes find nobody,
// then the insert returns the new row.
async function importNewClient(over: Record<string, any>, importSource: 'jobber_webhook' | 'jobber_initial') {
  h.enqueue('leads', null)  // jobber_client_id SELECT → miss
  h.enqueue('leads', [])    // strong-key match → nothing
  h.enqueue('leads', [])    // name-only check → nothing
  h.enqueue('leads', { id: 'lead-new', stage: 'New' }) // the insert
  const out = await upsertLead(jobberClient(over), LOC_SLUG, LOC_UUID, { importSource })
  const inserts = payloadsOf('insert')
  expect(inserts).toHaveLength(1)
  expect(out).toBeTruthy()
  return inserts[0]
}

beforeEach(() => {
  h.reset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('a client arriving from Jobber brings its source', () => {
  it('WEBHOOK: a Jobber client with a source arrives with it set', async () => {
    const row = await importNewClient({ leadSource: 'Referral' }, 'jobber_webhook')
    expect(row.source).toBe('Referral')
    expect(row.import_source).toBe('jobber_webhook')
  })

  it('INITIAL IMPORT: same', async () => {
    const row = await importNewClient({ leadSource: 'Google' }, 'jobber_initial')
    expect(row.source).toBe('Google')
    expect(row.import_source).toBe('jobber_initial')
  })

  it('"google" and "Google" land as one thing', async () => {
    const row = await importNewClient({ leadSource: 'google' }, 'jobber_webhook')
    expect(row.source).toBe('Google')
  })

  it("an unrecognised Jobber source comes through as typed (an owner's own label)", async () => {
    const row = await importNewClient({ leadSource: 'Hershey Mills Ads' }, 'jobber_webhook')
    expect(row.source).toBe('Hershey Mills Ads')
  })

  it('a Jobber client with NO source arrives blank — not defaulted to Website', async () => {
    const row = await importNewClient({ leadSource: null }, 'jobber_webhook')
    expect(row.source).toBeNull()
  })

  it("Jobber's stamp of our own app name is not a source — it lands blank", async () => {
    const row = await importNewClient({ leadSource: JOBBER_APP_SOURCE_STAMP }, 'jobber_webhook')
    expect(row.source).toBeNull()
    expect(leadSourceFromJobber('bee organized interface')).toBeNull()
  })

  it('INSERT ONLY: an existing lead is refreshed without touching its source (no silent backfill)', async () => {
    h.enqueue('leads', { id: 'lead-existing', stage: 'New' }) // the jobber_client_id SELECT hits
    await upsertLead(jobberClient({ leadSource: 'Google' }), LOC_SLUG, LOC_UUID, { importSource: 'jobber_webhook' })
    expect(payloadsOf('insert')).toHaveLength(0)
    const updates = payloadsOf('update')
    expect(updates.length).toBeGreaterThan(0)
    for (const u of updates) expect(u).not.toHaveProperty('source')
  })
})

describe('every client query asks Jobber for the source', () => {
  // Without the field in the query, client.leadSource is undefined and every
  // import quietly lands blank again — exactly the bug being fixed.
  it.each([
    ['initial import — full scan', CLIENTS_QUERY],
    ['initial import — incremental pass', INCREMENTAL_CLIENTS_QUERY],
    ['webhook — client', SINGLE_CLIENT_QUERY],
    ['webhook — request (its client)', SINGLE_REQUEST_QUERY],
  ])('%s', (_name, query) => {
    expect(query).toMatch(/\bleadSource\b/)
  })
})
