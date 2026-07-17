// @vitest-environment node
// lib/beta-jobber-import-adoption.test.ts
// ─────────────────────────────────────────────────────────────
// upsertLead's ADOPTION PASS — the website-lead ↔ Jobber-client
// reconciliation.
//
// The bug it closes: intake rows carry jobber_client_id = NULL, so
// upsertLead's jobber_client_id SELECT could never match one and the
// import blind-inserted a SECOND row for the same human — web-form
// context on one row, Jobber money on the other, owner sees them twice.
// This fires on the NORMAL onboarding path (collect leads pre-launch,
// then import Jobber on day one), so both directions are pinned here:
//
//   ADOPT          — one row survives, request_details/source preserved.
//   NO FALSE MERGE — a different person is never fused into an existing
//                    lead. This is the direction that must NEVER break:
//                    a duplicate is recoverable, a bad merge is not.
//   IN QUESTION    — ambiguity creates + flags, never merges.
//   NO MATCH / hit — untouched, byte-for-byte the old behavior.
//
// The supabase mock is a recording query-builder (same shape as
// beta-intake-dedup.test.ts) so the REAL queryLeadMatches /
// classifyLeadMatches vocabulary runs against it — these tests exercise
// the actual matching code, not a restatement of it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  // FIFO per table: each builder for `table` shifts the next queued resp.
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
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'gte']) {
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

// A Jobber client node as the import's CLIENTS_QUERY returns it.
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

// The pre-existing website lead: jobber_client_id NULL, web-form context.
const websiteLead = (over: Record<string, any> = {}) => ({
  id: 'lead-web-1',
  name: 'Jane Smith',
  email: 'jane@x.com',
  phone: '336-555-0100',
  phone_normalized: '3365550100',
  address: null, city: null, state: null, zip: null,
  project_type: 'Organizing',
  request_details: 'I have a medically complex condition and need help.',
  preferred_contact: 'Text',
  stage: 'New',
  is_junk: false,
  location_uuid: LOC_UUID,
  created_at: '2026-07-02T00:00:00.000Z',
  jobber_client_id: null,
  ...over,
})

// Ops recorded against `leads`, in call order.
const leadCalls = () => h.state.calls.filter(c => c.table === 'leads')
const opArgs = (call: any, op: string) =>
  call.ops.filter(([m]: [string, any[]]) => m === op).map(([, a]: [string, any[]]) => a)
const findCall = (pred: (c: any) => boolean) => leadCalls().find(pred)
const isInsert = (c: any) => c.ops.some(([m]: [string, any[]]) => m === 'insert')
const isUpdate = (c: any) => c.ops.some(([m]: [string, any[]]) => m === 'update')
const insertPayload = (c: any) => opArgs(c, 'insert')[0]?.[0]
const updatePatch = (c: any) => opArgs(c, 'update')[0]?.[0]

beforeEach(() => {
  h.reset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('upsertLead — adoption pass', () => {
  it('ADOPTS a website lead: one row, jobber_client_id stamped, request_details preserved', async () => {
    // 1) jobber_client_id SELECT → miss
    h.enqueue('leads', null)
    // 2) queryLeadMatches → the website lead (unlinked, exact email+phone)
    h.enqueue('leads', [websiteLead()])
    // 3) adoptLead's targeted re-read → still unlinked
    h.enqueue('leads', websiteLead())
    // 4) the adopt UPDATE → ok
    h.enqueue('leads', null)

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID, {
      importSource: 'jobber_initial',
    })

    // Adopted the EXISTING row — not a new one.
    expect(out).toEqual({ id: 'lead-web-1', created: false, stage: 'New' })

    // The decisive assertion: NO insert happened. Two rows was the bug.
    expect(leadCalls().filter(isInsert)).toHaveLength(0)

    const patch = updatePatch(findCall(isUpdate))
    // The adoption itself.
    expect(patch.jobber_client_id).toBe('999')
    // Web-form context must survive untouched — these are the columns the
    // owner would otherwise have lost to the duplicate.
    expect(patch).not.toHaveProperty('request_details')
    expect(patch).not.toHaveProperty('source')
    // ...and the drip/provenance flags the import sets only on INSERT.
    expect(patch).not.toHaveProperty('paused')
    expect(patch).not.toHaveProperty('import_source')
    // phone_normalized is GENERATED — never in a write payload.
    expect(patch).not.toHaveProperty('phone_normalized')
  })

  it('ADOPT is fill-empty: never overwrites the intake row, fills only its blanks', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [websiteLead()])
    h.enqueue('leads', websiteLead()) // name/email/phone set; address/city/state/zip blank
    h.enqueue('leads', null)

    await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID, { importSource: 'jobber_initial' })

    const patch = updatePatch(findCall(isUpdate))
    // Blank on the lead → filled from Jobber.
    expect(patch.address).toBe('1 Main St, Greensboro, NC, 27401')
    expect(patch.city).toBe('Greensboro')
    expect(patch.state).toBe('NC')
    expect(patch.zip).toBe('27401')
    // Already present on the lead → Jobber must NOT clobber it.
    expect(patch).not.toHaveProperty('name')
    expect(patch).not.toHaveProperty('email')
    expect(patch).not.toHaveProperty('phone')
  })

  it('ADOPT fills assigned_to only when the row has no owner', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [websiteLead()])
    h.enqueue('leads', websiteLead({ assigned_to: null }))
    h.enqueue('leads', null)
    await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)
    expect(updatePatch(findCall(isUpdate)).assigned_to).toBe('owner-1')

    // ...and leaves an existing assignment alone.
    h.reset()
    h.enqueue('leads', null)
    h.enqueue('leads', [websiteLead()])
    h.enqueue('leads', websiteLead({ assigned_to: 'someone-else' }))
    h.enqueue('leads', null)
    await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)
    expect(updatePatch(findCall(isUpdate))).not.toHaveProperty('assigned_to')
  })

  it('NO FALSE MERGE: a different person is inserted, never fused into an existing lead', async () => {
    // jane@x.com exists as a website lead; the import brings in BOB.
    // queryLeadMatches is keyed on bob's email/phone, so it returns [].
    h.enqueue('leads', null)  // jobber_client_id SELECT → miss
    h.enqueue('leads', [])    // strong-key match → nothing
    h.enqueue('leads', [])    // name-only check → nothing (different name)
    h.enqueue('leads', { id: 'lead-bob-new', stage: 'New' }) // the insert

    const out = await upsertLead(
      jobberClient({
        id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC84ODg=', // → '888'
        firstName: 'Bob', lastName: 'Jones',
        emails: [{ address: 'bob@y.com', primary: true }],
        phones: [{ number: '336-555-0199', primary: true }],
      }),
      LOC_SLUG, LOC_UUID,
    )

    // A NEW row for Bob...
    expect(out.created).toBe(true)
    expect(out.id).toBe('lead-bob-new')
    // ...and jane's row was never updated. No adoption, no merge.
    expect(leadCalls().filter(isUpdate)).toHaveLength(0)

    const payload = insertPayload(findCall(isInsert))
    expect(payload.email).toBe('bob@y.com')
    expect(payload.jobber_client_id).toBe('888')
    // A clean insert carries no ambiguity flag.
    expect(payload).not.toHaveProperty('possible_duplicate_of')
  })

  it('NO FALSE MERGE holds even if the match query returns an over-broad row', async () => {
    // Defense in depth: the DB filter is not the only thing standing
    // between two different people. Hand the classifier jane's row in
    // response to BOB's query (what an over-broad .or() would do) and it
    // must still refuse — it re-verifies every key per row rather than
    // trusting that the query filtered correctly.
    h.enqueue('leads', null)
    h.enqueue('leads', [websiteLead()])  // jane — does NOT match bob's keys
    h.enqueue('leads', [])               // name-only check → nothing
    h.enqueue('leads', { id: 'lead-bob-new', stage: 'New' })

    const out = await upsertLead(
      jobberClient({
        id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC84ODg=',
        firstName: 'Bob', lastName: 'Jones',
        emails: [{ address: 'bob@y.com', primary: true }],
        phones: [{ number: '336-555-0199', primary: true }],
      }),
      LOC_SLUG, LOC_UUID,
    )

    // Bob got his own row; jane was never touched.
    expect(out.created).toBe(true)
    expect(leadCalls().filter(isUpdate)).toHaveLength(0)
    // Not even flagged — a non-matching row is not ambiguity, it is noise.
    expect(insertPayload(findCall(isInsert))).not.toHaveProperty('possible_duplicate_of')
  })

  it('IN QUESTION (strong key hits >1 unlinked lead): inserts + flags, never merges', async () => {
    h.enqueue('leads', null)
    // Two unlinked leads share jane's email → ambiguous, unmergeable.
    h.enqueue('leads', [
      websiteLead({ id: 'lead-a' }),
      websiteLead({ id: 'lead-b' }),
    ])
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    expect(out.created).toBe(true)
    // Nothing was merged.
    expect(leadCalls().filter(isUpdate)).toHaveLength(0)
    const payload = insertPayload(findCall(isInsert))
    expect(payload.possible_duplicate_of).toEqual(['lead-a', 'lead-b'])
  })

  it('IN QUESTION (name-only, different email): inserts + flags, never merges', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [])                       // no strong-key hit
    h.enqueue('leads', [{ id: 'lead-samename' }]) // name-only ilike hit
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    const out = await upsertLead(
      jobberClient({ emails: [{ address: 'different@z.com', primary: true }], phones: [] }),
      LOC_SLUG, LOC_UUID,
    )

    expect(out.created).toBe(true)
    expect(leadCalls().filter(isUpdate)).toHaveLength(0)
    expect(insertPayload(findCall(isInsert)).possible_duplicate_of).toEqual(['lead-samename'])

    // The name probe must be scoped: this location, unlinked rows only,
    // junk excluded via the NULL-safe form.
    const nameCall = leadCalls()[2]
    expect(opArgs(nameCall, 'ilike')[0]).toEqual(['name', 'Jane Smith'])
    expect(opArgs(nameCall, 'eq')).toContainEqual(['location_uuid', LOC_UUID])
    expect(opArgs(nameCall, 'is')).toContainEqual(['jobber_client_id', null])
    expect(opArgs(nameCall, 'not')).toContainEqual(['is_junk', 'is', true])
  })

  it('never adopts a lead already linked to a DIFFERENT Jobber client', async () => {
    h.enqueue('leads', null)
    // Same email, but this row belongs to Jobber client 111 — not ours.
    h.enqueue('leads', [websiteLead({ id: 'lead-linked', jobber_client_id: '111' })])
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    // Not adoptable → a new row, and the linked row is untouched.
    expect(out.created).toBe(true)
    expect(leadCalls().filter(isUpdate)).toHaveLength(0)
    // Solid-but-linked is still a real duplicate signal: the same person
    // reachable under two Jobber clients. Flag it, don't resolve it.
    expect(insertPayload(findCall(isInsert)).possible_duplicate_of).toEqual(['lead-linked'])
  })

  it('FALSE-MERGE REGRESSION: a linked row sharing a strong key still forces IN QUESTION', async () => {
    // The bug this pins: dropping linked rows BEFORE classification
    // strips the evidence classifyLeadMatches uses to detect ambiguity
    // (it counts how many leads each strong key reaches). Filter-first
    // saw "exactly one unlinked lead" and adopted — merging a third
    // person's Jobber money onto her row. Unrecoverable.
    //
    // Shared household landline:
    //   erin — website lead, landline L, ALREADY linked to her client 111
    //   fay  — website lead, same landline L, unlinked
    //   import Dave — same landline L, no email on his Jobber record
    // erin being linked is PROOF the landline is shared by ≥2 people.
    h.enqueue('leads', null)
    h.enqueue('leads', [
      websiteLead({ id: 'lead-erin', email: 'erin@x.com', jobber_client_id: '111' }),
      websiteLead({ id: 'lead-fay', email: 'fay@x.com', jobber_client_id: null }),
    ])
    h.enqueue('leads', { id: 'lead-dave-new', stage: 'New' })

    const out = await upsertLead(
      jobberClient({
        id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8yMjI=', // → '222'
        firstName: 'Dave', lastName: 'Nguyen',
        emails: [],                                        // no email — phone is the only key
        phones: [{ number: '336-555-0100', primary: true }],
      }),
      LOC_SLUG, LOC_UUID,
    )

    // Dave gets his OWN row. Fay's row is never touched.
    expect(out.created).toBe(true)
    expect(out.id).toBe('lead-dave-new')
    expect(leadCalls().filter(isUpdate)).toHaveLength(0)
    // Both landline residents are recorded as the ambiguity.
    expect(insertPayload(findCall(isInsert)).possible_duplicate_of)
      .toEqual(['lead-erin', 'lead-fay'])
  })

  it('adoption is not import-order dependent (same evidence → same verdict)', async () => {
    // The order-dependence corollary of the bug above: whether client 222
    // merged or flagged used to depend on whether client 111 happened to
    // be processed earlier in the same import loop (i.e. whether erin's
    // row was linked yet). Same two leads, erin NOT yet linked — the
    // verdict must be identical: in_question, never an adopt.
    h.enqueue('leads', null)
    h.enqueue('leads', [
      websiteLead({ id: 'lead-erin', email: 'erin@x.com', jobber_client_id: null }),
      websiteLead({ id: 'lead-fay', email: 'fay@x.com', jobber_client_id: null }),
    ])
    h.enqueue('leads', { id: 'lead-dave-new', stage: 'New' })

    const out = await upsertLead(
      jobberClient({
        id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8yMjI=',
        firstName: 'Dave', lastName: 'Nguyen',
        emails: [],
        phones: [{ number: '336-555-0100', primary: true }],
      }),
      LOC_SLUG, LOC_UUID,
    )

    expect(out.created).toBe(true)
    expect(leadCalls().filter(isUpdate)).toHaveLength(0)
    expect(insertPayload(findCall(isInsert)).possible_duplicate_of)
      .toEqual(['lead-erin', 'lead-fay'])
  })

  it('refuses to match at all when the location scope is missing (cross-tenant guard)', async () => {
    // queryLeadMatches drops its location filter on a falsy/'all' scope —
    // an unscoped match could adopt another territory's lead.
    h.enqueue('leads', null)
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    const out = await upsertLead(jobberClient(), LOC_SLUG, '' as any)

    expect(out.created).toBe(true)
    // No match query ran at all — not even the name probe.
    expect(leadCalls().some(c => c.ops.some(([m]: [string, any[]]) => m === 'or'))).toBe(false)
    expect(leadCalls().filter(isInsert)).toHaveLength(1)
  })

  it('does not name-match on the "Unknown" placeholder', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    // No names, no company → payload.name falls back to 'Unknown'.
    await upsertLead(
      jobberClient({ firstName: null, lastName: null, companyName: null }),
      LOC_SLUG, LOC_UUID,
    )

    // Only two leads calls: the id SELECT and the insert. No name probe —
    // 'Unknown' would otherwise flag every nameless client against itself.
    expect(leadCalls().filter(c => c.ops.some(([m]: [string, any[]]) => m === 'ilike'))).toHaveLength(0)
    expect(leadCalls().filter(isInsert)).toHaveLength(1)
  })

  it('degrades to a plain insert when the match query fails', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', null, { message: 'connection reset' }) // queryLeadMatches throws
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    // Losing a Jobber client is worse than a duplicate.
    expect(out.created).toBe(true)
    expect(insertPayload(findCall(isInsert))).not.toHaveProperty('possible_duplicate_of')
    expect(console.error).toHaveBeenCalled()
  })

  it('adopt UPDATE that trips the unique index recovers onto the winner', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [websiteLead()])
    h.enqueue('leads', websiteLead())
    // A racing writer claimed jobber_client_id 999 first.
    h.enqueue('leads', null, {
      code: '23505',
      message: 'duplicate key value violates unique constraint "leads_jobber_client_id_location_idx"',
    })
    h.enqueue('leads', { id: 'lead-winner', stage: 'Estimate Sent' }) // winner re-select
    h.enqueue('leads', null)                                          // winner update

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    expect(out).toEqual({ id: 'lead-winner', created: false, stage: 'Estimate Sent' })
    expect(leadCalls().filter(isInsert)).toHaveLength(0)
  })
})

describe('upsertLead — unchanged paths (regression)', () => {
  it('an existing jobber_client_id hit still short-circuits before any matching', async () => {
    h.enqueue('leads', { id: 'lead-known', stage: 'Job in Progress' })
    h.enqueue('leads', null) // the update

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID)

    expect(out).toEqual({ id: 'lead-known', created: false, stage: 'Job in Progress' })
    // Exactly two calls: SELECT + UPDATE. The adoption pass never ran.
    expect(leadCalls()).toHaveLength(2)
    expect(leadCalls().filter(isInsert)).toHaveLength(0)
  })

  it('NO MATCH inserts exactly as before (owner, source, paused, created_at)', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    const out = await upsertLead(jobberClient(), LOC_SLUG, LOC_UUID, {
      importSource: 'jobber_initial',
    })

    expect(out).toEqual({ id: 'lead-new', created: true, stage: 'New' })
    const payload = insertPayload(findCall(isInsert))
    expect(payload.assigned_to).toBe('owner-1')
    expect(payload.import_source).toBe('jobber_initial')
    expect(payload.paused).toBe(true)
    expect(payload.created_at).toBe('2026-07-01T00:00:00.000Z')
    expect(payload.jobber_client_id).toBe('999')
    expect(payload.location_id).toBe(LOC_SLUG)
    expect(payload.location_uuid).toBe(LOC_UUID)
    expect(payload).not.toHaveProperty('possible_duplicate_of')
  })

  it('a client with neither email nor phone skips the strong-key query entirely', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', [])  // name-only check (name is present)
    h.enqueue('leads', { id: 'lead-new', stage: 'New' })

    const out = await upsertLead(
      jobberClient({ emails: [], phones: [] }),
      LOC_SLUG, LOC_UUID,
    )

    expect(out.created).toBe(true)
    // queryLeadMatches returns [] without querying when there is no key —
    // so no .or() was ever built (never email.eq.null).
    expect(leadCalls().some(c => c.ops.some(([m]: [string, any[]]) => m === 'or'))).toBe(false)
  })
})
