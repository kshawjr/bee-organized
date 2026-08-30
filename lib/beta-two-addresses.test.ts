// @vitest-environment node
//
// TWO ADDRESSES PER CLIENT — the server half.
//
// A move ADDS (a former_addresses entry here, a new property in Jobber) and
// never edits anything historical; a correction is exactly yesterday's
// behavior. Pinned, per the brief:
//   · a one-address client behaves exactly as today (default = correction;
//     same writes, same single push, nothing new sent)
//   · a move creates a property and leaves the old one untouched (the old
//     address lands in former_addresses with its old property link; the
//     mocked Jobber layer proves propertyEdit is never called on a move)
//   · a correction edits in place and creates nothing
//   · a formatting-only edit pushes nothing (and a 'move' without a real
//     new address is refused outright)
//   · the inbound webhook updates the RIGHT address once a client has two,
//     and a lead linked to a DIFFERENT property is left alone (the stomp
//     this build fixes)
//   · several Jobber properties + one Bee Hub address keeps the legacy
//     managed-blast-radius behavior (nothing breaks, nothing new pushes)
//   · nothing that was silent before now pushes (unlinked clients push
//     nothing on either path)
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in', 'filter']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'hub-1' } as any }))
const jm = vi.hoisted(() => ({
  sync: vi.fn(async () => ({ billing: 'updated', property: 'updated', upcoming_visits: false })),
  move: vi.fn(async () => ({ created: true, propertyId: '999', billing: 'updated', error: null })),
}))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/dual-write', () => ({ updateLead: vi.fn(async () => {}) }))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(() => null) }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => ({ enrolled: false })),
  stopActiveDripsForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => ({})) }))
vi.mock('@/lib/people-mapper', () => ({ mapLeadToPerson: vi.fn((r: any) => r) }))
vi.mock('@/lib/engagement-rollup', () => ({ rollUpEngagements: vi.fn(async () => ({})) }))
vi.mock('@/lib/jobber-contact-sync', () => ({ syncLeadContactToJobber: vi.fn(async () => null) }))
vi.mock('@/lib/jobber-address-sync', () => ({
  syncLeadAddressToJobber: jm.sync,
  createPropertyForMove: jm.move,
}))

import { PATCH } from '@/app/api/leads/[id]/route'
import { updateLead } from '@/lib/dual-write'

const LEAD = {
  id: 'lead-1',
  location_uuid: 'loc-uuid-1',
  location_id: 'loc_test',
  stage: 'Nurturing',
  jobber_client_id: '555',
  jobber_property_id: '111',
  phone: '',
  email: '',
  address: '10 Old Rd, Fairway, KS, 66205',
  city: 'Fairway',
  state: 'KS',
  zip: '66205',
  addresses: [],
}

const NEW_COLS = { address: '99 New Ave', city: 'Olathe', state: 'KS', zip: '66062' }

const patchLead = async (body: any) => {
  const req = { json: async () => body } as any
  const res = await PATCH(req, { params: Promise.resolve({ id: 'lead-1' }) } as any)
  return { status: res.status, body: await res.json() }
}

const seed = (lead: any = LEAD, opts: { former?: any } = {}) => {
  h.enqueue('hub_users', { id: 'hub-1', role: 'owner', location_id: 'loc-uuid-1' })
  h.enqueue('leads', lead)                 // the existing-lead load
  if (opts.former !== undefined) h.enqueue('leads', opts.former) // move's former read
  h.enqueue('touchpoints', { id: 'tp-1' }) // audit insert
  h.enqueue('leads', { ...lead, ...NEW_COLS }) // the refetch
}

const leadUpdatePatch = () => (vi.mocked(updateLead).mock.calls[0] || [])[1] as any

beforeEach(() => { h.reset(); vi.clearAllMocks(); authUser.current = { id: 'hub-1' } })

describe('one address, no flag — exactly today', () => {
  it('a real correction pushes through the existing sync (with the property link) and creates nothing', async () => {
    seed()
    const { status, body } = await patchLead(NEW_COLS)
    expect(status).toBe(200)
    expect(jm.sync).toHaveBeenCalledTimes(1)
    expect(jm.sync.mock.calls[0][0]).toMatchObject({ jobberClientId: '555', linkedPropertyId: '111' })
    expect(jm.move).not.toHaveBeenCalled()
    const p = leadUpdatePatch()
    expect(p.former_addresses).toBeUndefined()
    expect(p.jobber_property_id).toBeUndefined()
    expect(body.address_move).toBeUndefined()
  })

  it('an explicit correction is the same path', async () => {
    seed()
    await patchLead({ ...NEW_COLS, address_change: 'correction' })
    expect(jm.sync).toHaveBeenCalledTimes(1)
    expect(jm.move).not.toHaveBeenCalled()
  })

  it('a formatting-only edit pushes nothing at all', async () => {
    seed()
    const { status } = await patchLead({ address: '10 OLD RD, Fairway, KS, 66205' })
    expect(status).toBe(200)
    expect(jm.sync).not.toHaveBeenCalled()
    expect(jm.move).not.toHaveBeenCalled()
  })
})

describe('a move adds and never edits', () => {
  it('creates the new property, keeps the old address with its old link, re-points the lead', async () => {
    seed(LEAD, { former: { former_addresses: [] } })
    const { status, body } = await patchLead({ ...NEW_COLS, address_change: 'move' })
    expect(status).toBe(200)
    expect(jm.move).toHaveBeenCalledTimes(1)
    // The in-place editor is NEVER invoked on a move — nothing historical is touched.
    expect(jm.sync).not.toHaveBeenCalled()
    const p = leadUpdatePatch()
    expect(p.address).toBe('99 New Ave')
    expect(p.jobber_property_id).toBe('999') // the NEW property
    expect(p.former_addresses).toHaveLength(1)
    expect(p.former_addresses[0]).toMatchObject({
      display: '10 Old Rd, Fairway, KS, 66205',
      jobber_property_id: '111', // the old address still knows its property
    })
    expect(body.address_move).toMatchObject({ created: true, propertyId: '999', kept: true })
  })

  it('an unlinked client moves locally — zero Jobber calls, history still kept', async () => {
    seed({ ...LEAD, jobber_client_id: null, jobber_property_id: null }, { former: { former_addresses: [] } })
    const { status } = await patchLead({ ...NEW_COLS, address_change: 'move' })
    expect(status).toBe(200)
    expect(jm.move).not.toHaveBeenCalled()
    expect(jm.sync).not.toHaveBeenCalled()
    const p = leadUpdatePatch()
    expect(p.former_addresses).toHaveLength(1)
    expect(p.jobber_property_id).toBeNull()
  })

  it('a move without a real new address is refused, and nothing is written', async () => {
    seed()
    const { status, body } = await patchLead({ address: '10 OLD RD, Fairway, KS, 66205', address_change: 'move' })
    expect(status).toBe(400)
    expect(body.error).toBe('move_requires_a_new_address')
    expect(updateLead).not.toHaveBeenCalled()
  })

  it('pre-migration the move fails calm — 503, no write, the old address never silently dropped', async () => {
    h.enqueue('hub_users', { id: 'hub-1', role: 'owner', location_id: 'loc-uuid-1' })
    h.enqueue('leads', LEAD)
    h.enqueue('leads', null, { code: '42703', message: 'column leads.former_addresses does not exist' })
    const { status, body } = await patchLead({ ...NEW_COLS, address_change: 'move' })
    expect(status).toBe(503)
    expect(body.error).toBe('moves_not_available_yet')
    expect(updateLead).not.toHaveBeenCalled()
    expect(jm.move).not.toHaveBeenCalled()
  })

  it('several Jobber properties + one Bee Hub address: correction keeps the legacy path (no link → the managed blast radius decides)', async () => {
    seed({ ...LEAD, jobber_property_id: null })
    await patchLead(NEW_COLS)
    expect(jm.sync).toHaveBeenCalledTimes(1)
    expect(jm.sync.mock.calls[0][0].linkedPropertyId).toBeNull()
  })
})

// ─── the inbound webhook with two addresses ───────────────────────────

const wh = vi.hoisted(() => ({ graphql: vi.fn() }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: wh.graphql, jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/jobber-import', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/jobber-import')>()
  return { ...mod, upsertLead: vi.fn(async () => ({ id: 'lead-1', stage: 'Nurturing' })) }
})

import { handlePropertyUpdate } from '@/lib/jobber-webhook-handlers'

const ctx = () => ({
  topic: 'PROPERTY_UPDATE',
  itemId: '111',
  accountId: 'acct-1',
  occurredAt: '2026-08-30T00:00:00Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test' },
}) as any

const propertyReturns = (numericId: string, street: string) =>
  wh.graphql.mockResolvedValue({
    data: {
      property: {
        id: Buffer.from(`gid://Jobber/Property/${numericId}`).toString('base64'),
        client: { id: Buffer.from('gid://Jobber/Client/555').toString('base64') },
        address: { street, city: 'Fairway', province: 'KS', postalCode: '66205' },
      },
    },
    errors: undefined,
  } as any)

const updatePatchOn = (table: string) => {
  const c = h.state.calls.filter(x => x.table === table).find(x => x.ops.some(([m]) => m === 'update'))
  return c?.ops.find(([m]) => m === 'update')?.[1][0]
}

describe('inbound property events route to the right address', () => {
  it('the CURRENT property updates the current columns (unchanged behavior)', async () => {
    propertyReturns('111', '10 Old Rd')
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing' }) // property-id match
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toMatchObject({ address: '10 Old Rd, Fairway, KS, 66205', jobber_property_id: '111' })
  })

  it('a FORMER property updates its stored entry and leaves the current address alone', async () => {
    propertyReturns('111', '10 Old Rd UNIT B')
    h.enqueue('leads', null) // no current-link match
    h.enqueue('leads', {     // the former-holder match
      id: 'lead-1', name: 'x', stage: 'Nurturing',
      former_addresses: [{ street: '10 Old Rd', city: 'Fairway', state: 'KS', zip: '66205', display: '10 Old Rd, Fairway, KS, 66205', jobber_property_id: '111', moved_at: 'x' }],
    })
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    expect(String(res.note)).toContain('FORMER')
    const p = updatePatchOn('leads')
    expect(p.former_addresses[0].street).toBe('10 Old Rd UNIT B')
    // The current columns and link are NOT in the patch — nothing stomped.
    expect(p.address).toBeUndefined()
    expect(p.jobber_property_id).toBeUndefined()
  })

  it('a lead linked to a DIFFERENT property is left alone — the stomp is fixed', async () => {
    propertyReturns('333', 'Some Other Property St')
    h.enqueue('leads', null) // no current-link match
    h.enqueue('leads', null) // no former match
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing', jobber_property_id: '999' }) // client match, linked elsewhere
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    expect(String(res.note)).toContain('left alone')
    expect(updatePatchOn('leads')).toBeUndefined()
  })

  it('the original backfill case survives: an UNLINKED lead still syncs by client', async () => {
    propertyReturns('111', '10 Old Rd')
    h.enqueue('leads', null) // no current-link match
    h.enqueue('leads', null) // no former match
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing', jobber_property_id: null })
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toMatchObject({ jobber_property_id: '111' })
  })
})
