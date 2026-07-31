// @vitest-environment node
// lib/beta-jobber-lead-assignee-creation.test.ts
// ─────────────────────────────────────────────────────────────
// issue 153 — assign every Jobber-born lead AT CREATION.
//
// upsertLead has always written leads.assigned_to on insert but never a
// lead_assignees row, so a Jobber-born lead founded its engagement with an
// empty junction (the gap issues 149/150 compensate for downstream). This
// pins the fix AND its critical guard:
//
//   CREATE      — the location owner lands in lead_assignees, via
//                 'location_owner'.
//   NO RE-STAMP — a webhook UPDATE re-entering upsertLead on an EXISTING
//                 lead writes NOTHING to the junction. This is the
//                 regression that would hurt: an ungated write re-stamps
//                 over manual picks and issue 150's send-time resolution on
//                 every Jobber change — the blanket-stamp bug reborn.
//   NEVER CLOBBER — even on a create branch, a junction that already has
//                 rows is left untouched (belt-and-braces empty check).
//   ADOPT       — a freshly-adopted blank-owner lead is seeded; one that
//                 already has an owner is not.
//   FAIL-SOFT   — a junction write failure (e.g. migration not applied)
//                 never costs the caller the lead row.
//
// Same recording query-builder mock as beta-jobber-import-adoption.test.ts,
// extended to inspect lead_assignees ops.
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

import { upsertLead } from '@/lib/jobber-import'

const LOC_SLUG = 'loc_greensboro'
const LOC_UUID = 'uuid-greensboro'

const jobberClient = (over: Record<string, any> = {}) => ({
  id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC85OTk=', // encoded; extractJobberId → '999'
  firstName: 'Jane',
  lastName: 'Smith',
  companyName: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  emails: [{ address: 'jane@x.com', primary: true }],
  phones: [{ number: '336-555-0100', primary: true }],
  billingAddress: { street: '1 Main St', city: 'Greensboro', province: 'NC', postalCode: '27401' },
  ...over,
})

const websiteLead = (over: Record<string, any> = {}) => ({
  id: 'lead-web-1',
  name: 'Jane Smith',
  email: 'jane@x.com',
  phone: '336-555-0100',
  phone_normalized: '3365550100',
  address: null, city: null, state: null, zip: null,
  project_type: 'Organizing',
  request_details: 'help please',
  stage: 'New',
  is_junk: false,
  location_uuid: LOC_UUID,
  created_at: '2026-07-02T00:00:00.000Z',
  jobber_client_id: null,
  assigned_to: null,
  ...over,
})

// lead_assignees ops, in call order.
const junctionCalls = () => h.state.calls.filter(c => c.table === 'lead_assignees')
const junctionUpserts = () =>
  junctionCalls().filter(c => c.ops.some(([m]) => m === 'upsert'))
const upsertPayload = (c: any) =>
  c.ops.filter(([m]: [string, any[]]) => m === 'upsert').map(([, a]: [string, any[]]) => a)[0]?.[0]

beforeEach(() => {
  h.reset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('issue 153 — Jobber seam junction seed', () => {
  it('CREATE: the location owner lands in lead_assignees via location_owner', async () => {
    h.enqueue('leads', null)                              // jobber_client_id SELECT → miss
    h.enqueue('leads', [])                                // strong-key match → none
    h.enqueue('leads', [])                                // name probe → none
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })  // the insert
    h.enqueue('lead_assignees', [])                       // empty-check read → empty

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID, {
      importSource: 'jobber_initial',
    })

    expect(out).toEqual({ id: 'lead-new', created: true, stage: 'New' })

    const upserts = junctionUpserts()
    expect(upserts).toHaveLength(1)
    expect(upsertPayload(upserts[0])).toEqual({
      lead_id: 'lead-new',
      hub_user_id: 'owner-1',
      assigned_via: 'location_owner',
    })
  })

  it('NO RE-STAMP: a webhook UPDATE on an existing lead writes NOTHING to the junction', async () => {
    // The jobber_client_id SELECT hits → the `existing` UPDATE branch. This
    // is every CLIENT_UPDATE / REQUEST_UPDATE for a lead we already know.
    h.enqueue('leads', { id: 'lead-known', stage: 'Job in Progress' })
    h.enqueue('leads', null) // the update

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    expect(out).toEqual({ id: 'lead-known', created: false, stage: 'Job in Progress' })
    // The decisive assertion: the junction was never touched — not read, not
    // written. An ungated seed here is the blanket-stamp regression.
    expect(junctionCalls()).toHaveLength(0)
  })

  it('NEVER CLOBBER: a create branch leaves an already-populated junction alone', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })
    // Belt-and-braces: the empty check finds an existing pick (e.g. a racing
    // manual assignment) → the seed must NOT upsert over it.
    h.enqueue('lead_assignees', [{ hub_user_id: 'manual-pick', created_at: '2026-01-01T00:00:00Z' }])

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    expect(out.created).toBe(true)
    expect(junctionUpserts()).toHaveLength(0)
  })

  it('ADOPT: a blank-owner adopted lead is seeded with the owner', async () => {
    h.enqueue('leads', null)                                   // id SELECT → miss
    h.enqueue('leads', [websiteLead()])                        // strong-key match → the website lead
    h.enqueue('leads', websiteLead({ assigned_to: null }))     // adopt re-read → still unowned
    h.enqueue('leads', null)                                   // the adopt UPDATE
    h.enqueue('lead_assignees', [])                            // empty-check read

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    expect(out).toEqual({ id: 'lead-web-1', created: false, stage: 'New' })
    const upserts = junctionUpserts()
    expect(upserts).toHaveLength(1)
    expect(upsertPayload(upserts[0])).toEqual({
      lead_id: 'lead-web-1',
      hub_user_id: 'owner-1',
      assigned_via: 'location_owner',
    })
  })

  it('ADOPT: a lead that already has an owner is not seeded', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [websiteLead()])
    h.enqueue('leads', websiteLead({ assigned_to: 'someone-else' })) // already owned
    h.enqueue('leads', null)

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    expect(out.created).toBe(false)
    // ownerForJunction stayed null → the seed helper short-circuits before it
    // even reads the junction.
    expect(junctionCalls()).toHaveLength(0)
  })

  it('FAIL-SOFT: a junction write failure never costs the lead row', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })
    h.enqueue('lead_assignees', [])                       // empty-check read
    h.enqueue('lead_assignees', null, {                   // the upsert → migration missing
      message: 'relation "lead_assignees" does not exist',
    })

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    // The lead is still created — the seed failure is swallowed and logged.
    expect(out).toEqual({ id: 'lead-new', created: true, stage: 'New' })
    expect(console.error).toHaveBeenCalled()
  })
})
