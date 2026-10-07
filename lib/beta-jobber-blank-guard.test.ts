// @vitest-environment node
//
// A BLANK FROM JOBBER NEVER BEATS A REAL VALUE OF OURS — and only the sending
// location's own people go into its Jobber (Kevin, 6 Oct 2026).
//
// THE ZIP WIPE. Send to Jobber creates the client with no billing address.
// Seconds later REQUEST_CREATE arrives, upsertLead takes its `existing`
// branch, and it used to copy the client WHOLESALE: the empty billing address
// became address/city/state/zip = null. A website lead that gave a zip and no
// street lost the one field zip routing reads. Proven on 8 leads in zip
// routing's first six days (all zip-only, every one with a street survived,
// because PROPERTY_* wrote the address back), plus Kim Terry and Sarah Jane
// Paton before it. Kevin widened the rule to every person field: name,
// email, phone, company and the address — a blank from Jobber never wins.
//
// THE WRONG SALESPERSON. Travis Lawson (Central Austin) stayed assigned to two
// leads moved by hand to Southwest Austin. Their send pushed his Central
// Austin Jobber user as salesperson into Southwest Austin's account, and
// Jobber accepted it. resolveJobberAssignment now takes the location being
// pushed to and holds back anyone who works elsewhere.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const take = () => {
      const idx = state.queue.findIndex(q => q.table === table)
      return idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    }
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in', 'filter']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(take()) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(take()) }
    // A list read (the adoption match queries) — "nothing found", without
    // consuming the terminal-read queue.
    b.then = (res: any, rej: any) => {
      const isWrite = call.ops.some(([m]) => m === 'update' || m === 'insert' || m === 'delete')
      return Promise.resolve(isWrite ? { data: null, error: null } : { data: [], error: null }).then(res, rej)
    }
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})
const wh = vi.hoisted(() => ({ graphql: vi.fn() }))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: wh.graphql, jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'owner-1' })) }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => ({ enrolled: false })),
  stopActiveDripsForLead: vi.fn(async () => {}),
}))

import { upsertLead, withoutBlankPersonFields, JOBBER_PERSON_COLS } from '@/lib/jobber-import'
import { handlePropertyUpdate } from '@/lib/jobber-webhook-handlers'
import { resolveJobberAssignment } from '@/lib/engagement-assignee-sync'

const gid = (kind: string, n: string) => Buffer.from(`gid://Jobber/${kind}/${n}`).toString('base64')

const leadWrites = (kind: 'update' | 'insert') =>
  h.state.calls
    .filter(c => c.table === 'leads')
    .map(c => c.ops.find(([m]) => m === kind)?.[1][0])
    .filter(Boolean)

beforeEach(() => { h.reset(); wh.graphql.mockReset() })

// ── the rule itself ──────────────────────────────────────────────
describe('withoutBlankPersonFields', () => {
  it('drops every BLANK person field — null, undefined, empty, whitespace', () => {
    const out = withoutBlankPersonFields({
      name: '', first_name: null, last_name: undefined, company: '   ',
      email: null, phone: '', address: null, city: null, state: '', zip: null,
    })
    expect(out).toEqual({})
  })

  it("drops the 'Unknown' placeholder name — it is ours, not Jobber's", () => {
    expect(withoutBlankPersonFields({ name: 'Unknown' })).toEqual({})
  })

  it('KEEPS every real value — Jobber may still change a person', () => {
    const real = {
      name: 'Kim Terry', first_name: 'Kim', last_name: 'Terry', company: 'Terry LLC',
      email: 'kim@new.com', phone: '5125550199', address: '1 Main St, Austin, TX, 78746',
      city: 'Austin', state: 'TX', zip: '78746',
    }
    expect(withoutBlankPersonFields(real)).toEqual(real)
  })

  it('leaves NON-person columns alone, blank or not', () => {
    const out = withoutBlankPersonFields({
      jobber_client_id: '155042576', jobber_property_id: null, location_id: 'loc_swaustin',
      updated_at: '2026-10-06T00:00:00Z', zip: null,
    })
    expect(out).toEqual({
      jobber_client_id: '155042576', jobber_property_id: null, location_id: 'loc_swaustin',
      updated_at: '2026-10-06T00:00:00Z',
    })
  })

  it('covers exactly the ten person fields', () => {
    expect([...JOBBER_PERSON_COLS].sort()).toEqual(
      ['address', 'city', 'company', 'email', 'first_name', 'last_name', 'name', 'phone', 'state', 'zip'].sort(),
    )
  })
})

// ── the client copy (REQUEST_*/CLIENT_UPDATE → upsertLead) ───────
describe('upsertLead on an EXISTING lead', () => {
  // What Send to Jobber leaves in Jobber for a zip-only website lead: a
  // client with a name and contact details, and NO billing address.
  const SENT_ZIP_ONLY = {
    id: gid('Client', '155042576'),
    firstName: 'Kim', lastName: 'Terry',
    emails: [{ address: 'kim@email.com', primary: true }],
    phones: [{ number: '5125550100', primary: true }],
    billingAddress: null,
    createdAt: '2026-10-01T19:02:26Z',
  }

  it("KIM TERRY'S CASE: an empty billing address no longer wipes the zip", async () => {
    h.enqueue('leads', { id: 'kim', stage: 'Request' })   // the jobber_client_id match
    const out = await upsertLead(SENT_ZIP_ONLY, 'loc_swaustin', 'sw-uuid')
    expect(out).toEqual({ id: 'kim', created: false, stage: 'Request' })
    const [patch] = leadWrites('update')
    for (const col of ['address', 'city', 'state', 'zip']) expect(patch, col).not.toHaveProperty(col)
    // Real values still flow.
    expect(patch).toMatchObject({ name: 'Kim Terry', first_name: 'Kim', last_name: 'Terry', email: 'kim@email.com', phone: '5125550100' })
    expect(patch.jobber_client_id).toBe('155042576')
  })

  it('a client Jobber holds with NO email, phone, name or company leaves ours standing', async () => {
    h.enqueue('leads', { id: 'kim', stage: 'Request' })
    await upsertLead({ id: gid('Client', '7'), emails: [], phones: [], billingAddress: null }, 'loc_swaustin', 'sw-uuid')
    const [patch] = leadWrites('update')
    for (const col of JOBBER_PERSON_COLS) expect(patch, col).not.toHaveProperty(col)
    expect(patch.jobber_client_id).toBe('7')
  })

  it('a REAL change in Jobber still reaches us — a corrected zip and email win', async () => {
    h.enqueue('leads', { id: 'kim', stage: 'Request' })
    await upsertLead({
      ...SENT_ZIP_ONLY,
      emails: [{ address: 'kim.terry@new.com', primary: true }],
      billingAddress: { street: '9 Oak Ln', city: 'Austin', province: 'TX', postalCode: '78735' },
    }, 'loc_swaustin', 'sw-uuid')
    const [patch] = leadWrites('update')
    expect(patch).toMatchObject({
      email: 'kim.terry@new.com', zip: '78735', city: 'Austin', state: 'TX',
      address: '9 Oak Ln, Austin, TX, 78735',
    })
  })

  it('the insert-race winner is protected the same way', async () => {
    h.enqueue('leads', null)                                   // existence miss
    h.enqueue('leads', null, { code: '23505', message: 'duplicate key value violates unique constraint "leads_jobber_client_id_location_idx"' })
    h.enqueue('leads', { id: 'winner', stage: 'New' })        // winner re-select
    await upsertLead(SENT_ZIP_ONLY, 'loc_swaustin', 'sw-uuid')
    const patch = leadWrites('update').at(-1)
    expect(patch).not.toHaveProperty('zip')
    expect(patch).not.toHaveProperty('address')
  })

  it('a brand-NEW lead still inserts whole — nothing of ours to protect', async () => {
    h.enqueue('leads', null)                                   // existence miss
    h.enqueue('leads', { id: 'new-lead', stage: 'New' })       // insert result
    await upsertLead({ id: gid('Client', '8'), emails: [], phones: [], billingAddress: null }, 'loc_swaustin', 'sw-uuid')
    const [ins] = leadWrites('insert')
    expect(ins).toMatchObject({ name: 'Unknown', zip: null, email: null })
  })
})

// ── the property copy (PROPERTY_CREATE/UPDATE) ──────────────────
describe('a property event on the linked property', () => {
  const propertyReturns = (address: any) =>
    wh.graphql.mockResolvedValue({
      data: {
        property: {
          id: Buffer.from('gid://Jobber/Property/333').toString('base64'),
          client: { id: Buffer.from('gid://Jobber/Client/555').toString('base64') },
          address,
        },
      },
      errors: undefined,
    } as any)
  const ctx = () => ({
    topic: 'PROPERTY_UPDATE', itemId: '333', accountId: 'acct-1',
    occurredAt: '2026-10-06T00:00:00Z',
    location: { id: 'sw-uuid', location_id: 'loc_swaustin', name: 'Southwest Austin' },
  }) as any

  it('a property saved WITHOUT a postal code leaves our zip alone; the link still moves', async () => {
    propertyReturns({ street: '1 Main St', city: 'Austin', province: 'TX', postalCode: '' })
    h.enqueue('leads', { id: 'lead-1', name: 'Kim Terry', stage: 'Request' })   // jobber_property_id match
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    const [patch] = leadWrites('update')
    expect(patch).not.toHaveProperty('zip')
    expect(patch).toMatchObject({ jobber_property_id: '333', city: 'Austin', state: 'TX' })
  })

  it('a property with NO address at all writes no address fields', async () => {
    propertyReturns({})
    h.enqueue('leads', { id: 'lead-1', name: 'Kim Terry', stage: 'Request' })
    await handlePropertyUpdate(ctx())
    const [patch] = leadWrites('update')
    for (const col of ['address', 'city', 'state', 'zip']) expect(patch, col).not.toHaveProperty(col)
    expect(patch.jobber_property_id).toBe('333')
  })

  it('a real Jobber address still wins', async () => {
    propertyReturns({ street: '9 Oak Ln', city: 'Austin', province: 'TX', postalCode: '78735' })
    h.enqueue('leads', { id: 'lead-1', name: 'Kim Terry', stage: 'Request' })
    await handlePropertyUpdate(ctx())
    const [patch] = leadWrites('update')
    expect(patch).toMatchObject({ zip: '78735', address: '9 Oak Ln, Austin, TX, 78735' })
  })
})

// ── only the sending location's own people reach its Jobber ──────
describe('resolveJobberAssignment holds back people from other locations', () => {
  const SW = 'sw-uuid'
  const travis = { hub_user_id: 'travis', name: 'Travis Lawson', email: null, jobber_user_id: 'J-CENTRAL', location_id: 'central-uuid' }
  const raluca = { hub_user_id: 'raluca', name: 'Raluca Sharma', email: null, jobber_user_id: 'J-SW', location_id: SW }
  const corporate = { hub_user_id: 'kevin', name: 'Kevin Shaw', email: null, jobber_user_id: 'J-ANY', location_id: null }
  const internal = { hub_user_id: 'helper', name: 'No Jobber', email: null, jobber_user_id: null, location_id: SW }

  it("TRAVIS'S CASE: a Central Austin assignee is NOT pushed into Southwest Austin's Jobber", () => {
    const r = resolveJobberAssignment([travis], { locationUuid: SW })
    expect(r.primaryJobberUserId).toBeNull()
    expect(r.allJobberUserIds).toEqual([])
    expect(r.offLocationCount).toBe(1)
    expect(r.mappedCount).toBe(0)
  })

  it('the location’s own person is pushed — and becomes salesperson even if listed second', () => {
    const r = resolveJobberAssignment([travis, raluca], { locationUuid: SW })
    expect(r.primaryJobberUserId).toBe('J-SW')
    expect(r.allJobberUserIds).toEqual(['J-SW'])
    expect(r.offLocationCount).toBe(1)
  })

  it('a person with no location (corporate) is held back too', () => {
    const r = resolveJobberAssignment([corporate], { locationUuid: SW })
    expect(r.allJobberUserIds).toEqual([])
    expect(r.offLocationCount).toBe(1)
  })

  it('an unlinked person is still counted as internal-only, not off-location', () => {
    const r = resolveJobberAssignment([internal, raluca], { locationUuid: SW })
    expect(r.unmappedCount).toBe(1)
    expect(r.offLocationCount).toBe(0)
    expect(r.allJobberUserIds).toEqual(['J-SW'])
  })
})

describe('every push into Jobber names its location', () => {
  const route = readFileSync('app/api/leads/[id]/send-to-jobber/route.ts', 'utf8')
  const sync = readFileSync('lib/engagement-assignee-sync.ts', 'utf8')

  it('Send to Jobber resolves BOTH assignee paths against the lead’s location', () => {
    expect(route).toContain('resolveJobberAssignment(engAssignees, { locationUuid: lead.location_uuid })')
    expect(route).toContain('resolveJobberAssignment(leadAssignees, { locationUuid: lead.location_uuid })')
    expect(route).not.toMatch(/resolveJobberAssignment\((engAssignees|leadAssignees)\)/)
  })

  it('a held-back person makes the send PARTIAL, in words', () => {
    expect(route).toContain("work at another location — not sent to this location's Jobber")
    expect(route).toMatch(/if \(assigneeOffLocationCount > 0\)/)
  })

  it('the crew/team sync resolves against the engagement’s location', () => {
    expect(sync).toContain("resolveJobberAssignment(assignees, { locationUuid: (engLoc as any)?.location_uuid ?? null })")
  })

  it('the assignee reads carry the person’s location', () => {
    expect(sync.match(/hub_users\(id, full_name, first_name, last_name, email, jobber_user_id, location_id\)/g)).toHaveLength(2)
  })
})
