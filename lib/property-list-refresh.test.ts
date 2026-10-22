// A Jobber address change reaches the address list (2026-10-21).
//
// PROPERTY_CREATE/UPDATE on the lead's own property rewrote the primary
// address columns and left leads.addresses — the list Send to Jobber reads
// FIRST — holding whatever Bee Hub last sent. The next send pushed the old
// street back; nine rows were repaired by hand on 20 Oct.
//
// What these tests pin:
//   · the columns AND the list's Service entry move together
//   · the entry is built from Jobber's separate fields, the street stripped
//     of any city/state/zip tail (visitStreet) — never from leads.address,
//     ~200 of which still carry a doubled tail
//   · the entry is updated in place, never appended; its other keys
//     (apt, label, note) survive
//   · no Service entry, several Service entries, or an empty list: the list
//     is left alone and the note says so; nothing errors
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

const wh = vi.hoisted(() => ({ graphql: vi.fn() }))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: wh.graphql, jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-disconnect', () => ({ disconnectJobberFromLocation: vi.fn(async () => ({ error: null })) }))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => ({ enrolled: false })),
  stopActiveDripsForLead: vi.fn(async () => {}),
}))

import { handlePropertyUpdate, handlePropertyCreate } from '@/lib/jobber-webhook-handlers'
import { planListEntryRefresh } from '@/lib/property-drift'
import { visitStreet } from '@/lib/visit-address'

const ctx = (topic = 'PROPERTY_UPDATE') => ({
  topic, itemId: '333', accountId: 'acct-1', occurredAt: '2026-10-21T00:00:00Z',
  location: { id: 'pb-uuid', location_id: 'loc_palmbeach', name: 'Palm Beach' },
}) as any

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

// A real row's entry shape (Samantha Fields, Palm Beach, before the 20 Oct repair).
const ENTRY = {
  zip: '33414', city: 'Wellington', type: 'Service', state: 'FL',
  value: '12626 Mallet Circle, Wellington, FL, 33414', street: '12626 Mallet Circle',
}
const JOBBER = { street: '12624 Mallet Circle', city: 'Wellington', province: 'Florida', postalCode: '33414' }

// The lead the jobber_property_id lookup returns (branch 1, the linked property).
const linkedLead = (over: any = {}) => ({ id: 'lead-1', name: 'Samantha Fields', stage: 'Nurturing', addresses: [ENTRY], ...over })

const leadPatch = () => {
  const c = h.state.calls.filter(x => x.table === 'leads').find(x => x.ops.some(([m]) => m === 'update'))
  return c?.ops.find(([m]) => m === 'update')?.[1][0]
}

beforeEach(() => { h.reset(); wh.graphql.mockReset() })

describe('a Jobber address change updates the columns AND the list entry', () => {
  it('linked property: both move, the entry from Jobber\'s own fields', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead())
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    const patch = leadPatch()
    expect(patch).toMatchObject({
      address: '12624 Mallet Circle, Wellington, Florida, 33414',
      city: 'Wellington', state: 'Florida', zip: '33414', jobber_property_id: '333',
    })
    expect(patch.addresses).toEqual([{
      type: 'Service', street: '12624 Mallet Circle', city: 'Wellington', state: 'Florida', zip: '33414',
      value: '12624 Mallet Circle, Wellington, Florida, 33414',
    }])
    expect(String(res.note)).toContain('address list entry updated')
  })

  it('unlinked fallback (first PROPERTY_CREATE after a send): the list moves too', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', null)                                    // no property-id match
    h.enqueue('leads', null)                                    // no former-address holder
    h.enqueue('leads', { ...linkedLead(), jobber_property_id: null }) // client match, unlinked
    await handlePropertyCreate(ctx('PROPERTY_CREATE'))
    expect(leadPatch().addresses[0].street).toBe('12624 Mallet Circle')
  })

  it('the entry is updated in place — never a second entry', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead())
    await handlePropertyUpdate(ctx())
    expect(leadPatch().addresses).toHaveLength(1)
  })

  it('already matching: no list write, says so', async () => {
    propertyReturns({ street: '12626 Mallet Circle', city: 'Wellington', province: 'FL', postalCode: '33414' })
    h.enqueue('leads', linkedLead())
    const res = await handlePropertyUpdate(ctx())
    expect(leadPatch()).not.toHaveProperty('addresses')
    expect(String(res.note)).toContain('address list already matches')
  })
})

describe('the street written to the list has no city/state/zip tail', () => {
  it('a payload street carrying its own tail is stripped', async () => {
    propertyReturns({ ...JOBBER, street: '12624 Mallet Circle, Wellington, Florida, 33414' })
    h.enqueue('leads', linkedLead())
    await handlePropertyUpdate(ctx())
    const e = leadPatch().addresses[0]
    expect(e.street).toBe('12624 Mallet Circle')
    expect(e.value).toBe('12624 Mallet Circle, Wellington, Florida, 33414')
  })

  it('a tail written the OLD way ("FL") comes off when Jobber now says "Florida"', async () => {
    propertyReturns({ ...JOBBER, street: '12624 Mallet Circle, Wellington, FL, 33414' })
    h.enqueue('leads', linkedLead())
    await handlePropertyUpdate(ctx())
    expect(leadPatch().addresses[0].street).toBe('12624 Mallet Circle')
  })

  it('REGRESSION: a doubled main address column never reaches the list', async () => {
    // Nanci Oechsle's shape: leads.address doubled, the list entry doubled too.
    const doubled = '700 Eucalyptus Avenue, Vista, CA, 92084, Vista, CA, 92084'
    propertyReturns({ street: '700 Eucalyptus Avenue', city: 'Vista', province: 'CA', postalCode: '92084' })
    h.enqueue('leads', linkedLead({
      address: doubled, city: 'Vista', state: 'CA', zip: '92084',
      addresses: [{ type: 'Service', street: doubled, value: doubled, city: 'Vista', state: 'CA', zip: '92084' }],
    }))
    await handlePropertyUpdate(ctx())
    const e = leadPatch().addresses[0]
    expect(e.street).toBe('700 Eucalyptus Avenue')
    expect(e.value).toBe('700 Eucalyptus Avenue, Vista, CA, 92084')
    expect(JSON.stringify(leadPatch().addresses)).not.toContain('92084, Vista')
  })

  it('REGRESSION: the main column\'s stale, doubled line is never the source', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead({ address: '12626 Mallet Circle, Wellington, FL, 33414, Wellington, FL, 33414' }))
    await handlePropertyUpdate(ctx())
    expect(leadPatch().addresses[0].street).toBe('12624 Mallet Circle')
  })

  it('REGRESSION: a doubled payload street is stripped in full', async () => {
    propertyReturns({ street: '700 Eucalyptus Avenue, Vista, CA, 92084, Vista, CA, 92084', city: 'Vista', province: 'CA', postalCode: '92084' })
    h.enqueue('leads', linkedLead())
    await handlePropertyUpdate(ctx())
    expect(leadPatch().addresses[0].street).toBe('700 Eucalyptus Avenue')
  })
})

describe('the entry keeps everything else it carries', () => {
  it('label, note and apt survive the update', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead({ addresses: [{ ...ENTRY, apt: '', label: 'other', label_note: 'Gate code 4411' }] }))
    await handlePropertyUpdate(ctx())
    expect(leadPatch().addresses[0]).toMatchObject({
      label: 'other', label_note: 'Gate code 4411', apt: '', street: '12624 Mallet Circle',
    })
  })

  it('other entries are untouched', async () => {
    const billing = { type: 'Billing', street: '1 Bill St', city: 'Jupiter', state: 'FL', zip: '33458', value: '1 Bill St, Jupiter, FL, 33458' }
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead({ addresses: [billing, ENTRY] }))
    await handlePropertyUpdate(ctx())
    const list = leadPatch().addresses
    expect(list[0]).toBe(billing)
    expect(list[1].street).toBe('12624 Mallet Circle')
  })

  it('a blank from Jobber never erases ours', async () => {
    propertyReturns({ street: '12624 Mallet Circle', city: 'Wellington', province: 'Florida', postalCode: '' })
    h.enqueue('leads', linkedLead())
    await handlePropertyUpdate(ctx())
    expect(leadPatch().addresses[0].zip).toBe('33414')
  })
})

describe('nothing to match: the list is left alone, and nothing errors', () => {
  it('no Service entry → list untouched, columns still move, note says why', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead({ addresses: [{ ...ENTRY, type: 'Billing' }] }))
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    expect(leadPatch()).not.toHaveProperty('addresses')
    expect(leadPatch().address).toBe('12624 Mallet Circle, Wellington, Florida, 33414')
    expect(String(res.note)).toContain('no Service entry to match')
  })

  it('two Service entries → ambiguous, list untouched', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead({ addresses: [ENTRY, { ...ENTRY, street: '9 Other Rd' }] }))
    const res = await handlePropertyUpdate(ctx())
    expect(leadPatch()).not.toHaveProperty('addresses')
    expect(String(res.note)).toContain('more than one Service entry')
  })

  it('an empty list → untouched, no error', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead({ addresses: [] }))
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    expect(leadPatch()).not.toHaveProperty('addresses')
    expect(String(res.note)).toContain('no address list')
  })

  it('no list column at all (null) → untouched, no error', async () => {
    propertyReturns(JOBBER)
    h.enqueue('leads', linkedLead({ addresses: null }))
    const res = await handlePropertyUpdate(ctx())
    expect(res.processed).toBe(true)
    expect(leadPatch()).not.toHaveProperty('addresses')
  })

  it('no address in Jobber → list untouched', async () => {
    propertyReturns({})
    h.enqueue('leads', linkedLead())
    await handlePropertyUpdate(ctx())
    expect(leadPatch()).not.toHaveProperty('addresses')
  })
})

describe('planListEntryRefresh / visitStreet (pure)', () => {
  it('visitStreet strips with every parts set until nothing more comes off', () => {
    expect(visitStreet('1 A St, Topeka, KS, 66603', { city: 'Topeka', state: 'Kansas', zip: '66603' }, { state: 'KS' })).toBe('1 A St')
    expect(visitStreet('1 A St Apt 2', { city: 'Topeka', state: 'KS', zip: '' })).toBe('1 A St Apt 2')
  })

  it('never builds from anything but the payload and the entry', () => {
    const plan = planListEntryRefresh([ENTRY], JOBBER)
    expect(plan.action).toBe('update')
    if (plan.action === 'update') expect(plan.index).toBe(0)
  })
})
