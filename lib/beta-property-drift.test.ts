// The address drift, closed.
//
// A property event for a client we know, at an address that is not the lead's
// linked property, used to end in a note saying "left alone". That is why
// ~105 clients have properties in Jobber that Bee Hub has no record of, six
// of them with live work at an address that appears nowhere on the card.
//
// What these tests pin:
//   · the guard's RULE survives (primary columns and the property link are
//     never in the patch) while the branch gains an action
//   · "already known" is decided in ONE place — lib/property-drift — by id
//     first, then by normalized address text
//   · a retired address stays retired; an inbound Jobber event is not the
//     owner changing their mind about a retirement they made
//   · a destroyed property held as an OTHER address is retired, never deleted
//   · every path returns processed:true, and never claims a write it did not
//     make (a webhook that errors is a webhook Jobber retries forever)
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
vi.mock('@/lib/jobber-import', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/jobber-import')>()
  return { ...mod, upsertLead: vi.fn(async () => ({ id: 'lead-1', stage: 'Nurturing' })) }
})

import {
  handlePropertyCreate,
  handlePropertyUpdate,
  handlePropertyDestroy,
} from '@/lib/jobber-webhook-handlers'
import { planDriftAddress, planDestroyedProperty } from '@/lib/property-drift'

const ctx = (topic = 'PROPERTY_CREATE', itemId = '333') => ({
  topic,
  itemId,
  accountId: 'acct-1',
  occurredAt: '2026-09-08T00:00:00Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test' },
}) as any

// The Jobber property the event is about. `province` is Jobber's name for
// what we store as state.
const propertyReturns = (numericId: string, address: any, clientId = '555') =>
  wh.graphql.mockResolvedValue({
    data: {
      property: {
        id: Buffer.from(`gid://Jobber/Property/${numericId}`).toString('base64'),
        client: { id: Buffer.from(`gid://Jobber/Client/${clientId}`).toString('base64') },
        address,
      },
    },
    errors: undefined,
  } as any)

const ADDR = { street: '3448 Oakland Zion Road', city: 'Fayetteville', province: 'Arkansas', postalCode: '72703' }
const DISPLAY = '3448 Oakland Zion Road, Fayetteville, Arkansas, 72703'

const updatePatchOn = (table: string) => {
  const c = h.state.calls.filter(x => x.table === table).find(x => x.ops.some(([m]) => m === 'update'))
  return c?.ops.find(([m]) => m === 'update')?.[1][0]
}

// The lead as the client-link fallback sees it: linked to a DIFFERENT
// property, which is the branch under test.
const LINKED_ELSEWHERE = { id: 'lead-1', name: 'Tom Ballas', stage: 'Nurturing', jobber_property_id: '999' }

// The re-read row. The primary address stays 118 Elmhurst throughout —
// every assertion below is about what did NOT happen to it.
const REREAD = (former: any[] = []) => ({
  id: 'lead-1',
  stage: 'Nurturing',
  address: '118 Elmhurst Rd, Fayetteville, Arkansas, 72701',
  city: 'Fayetteville',
  state: 'Arkansas',
  zip: '72701',
  former_addresses: former,
})

// Queue the three lookups the handler makes before the guard branch fires:
// no property-id match, no former-address holder, then the client match.
const arriveAtGuard = (lead: any = LINKED_ELSEWHERE) => {
  h.enqueue('leads', null)
  h.enqueue('leads', null)
  h.enqueue('leads', lead)
}

beforeEach(() => { h.reset(); wh.graphql.mockReset() })

describe('an unknown property becomes one of the client’s other addresses', () => {
  it('records it, labelled other with the note the backfill uses', async () => {
    propertyReturns('333', ADDR)
    arriveAtGuard()
    h.enqueue('leads', REREAD())

    const res = await handlePropertyCreate(ctx())
    expect(res.processed).toBe(true)

    const p = updatePatchOn('leads')
    expect(p.former_addresses).toHaveLength(1)
    const entry = p.former_addresses[0]
    expect(entry.display).toBe(DISPLAY)
    expect(entry.street).toBe('3448 Oakland Zion Road')
    expect(entry.state).toBe('Arkansas') // province → state
    expect(entry.jobber_property_id).toBe('333')
    expect(entry.status).toBe('active')
    // 'other' REQUIRES a note; a bare 'other' degrades to the word "Other",
    // which is the label saying nothing.
    expect(entry.label).toBe('other')
    expect(entry.label_note).toBe('Found in Jobber')
    expect(String(res.note)).toContain(DISPLAY)
  })

  it('THE GUARD STILL HOLDS: the primary columns and the link are absent from the patch', async () => {
    propertyReturns('333', ADDR)
    arriveAtGuard()
    h.enqueue('leads', REREAD())

    await handlePropertyCreate(ctx())
    const p = updatePatchOn('leads')
    // This is the stomp d8aa5ef fixed. The branch gained an action; it did
    // not lose its rule.
    expect(p.address).toBeUndefined()
    expect(p.city).toBeUndefined()
    expect(p.state).toBeUndefined()
    expect(p.zip).toBeUndefined()
    expect(p.jobber_property_id).toBeUndefined()
    expect(Object.keys(p).sort()).toEqual(['former_addresses', 'updated_at'])
  })

  it('PROPERTY_UPDATE heals the same way — it shares the core', async () => {
    propertyReturns('333', ADDR)
    arriveAtGuard()
    h.enqueue('leads', REREAD())

    const res = await handlePropertyUpdate(ctx('PROPERTY_UPDATE'))
    expect(res.processed).toBe(true)
    const p = updatePatchOn('leads')
    expect(p.former_addresses[0].display).toBe(DISPLAY)
    expect(p.address).toBeUndefined()
    expect(p.jobber_property_id).toBeUndefined()
  })
})

describe('an address we already have changes nothing', () => {
  it('matched by property id — even when the address text has since been edited', async () => {
    propertyReturns('333', { ...ADDR, street: '3448 Oakland Zion Road APT 2' })
    arriveAtGuard()
    h.enqueue('leads', REREAD([
      { display: DISPLAY, street: '3448 Oakland Zion Road', city: 'Fayetteville', state: 'Arkansas', zip: '72703', jobber_property_id: '333', moved_at: 'x', status: 'active' },
    ]))

    const res = await handlePropertyCreate(ctx())
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('already on the client')
    expect(String(res.note)).toContain('#1')
  })

  it('matched by address text — an entry recorded before the id was known', async () => {
    propertyReturns('333', ADDR)
    arriveAtGuard()
    h.enqueue('leads', REREAD([
      { display: DISPLAY, jobber_property_id: null, moved_at: 'x', status: 'active' },
    ]))

    const res = await handlePropertyCreate(ctx())
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('already on the client')
  })

  it('matched as the PRIMARY address — the card must not list it twice', async () => {
    propertyReturns('333', { street: '118 Elmhurst Rd', city: 'Fayetteville', province: 'Arkansas', postalCode: '72701' })
    arriveAtGuard()
    h.enqueue('leads', REREAD())

    const res = await handlePropertyCreate(ctx())
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('primary address')
  })

  it('no usable address in Jobber records nothing — a blank row is worse than the drift', async () => {
    propertyReturns('333', { street: '', city: '', province: '', postalCode: '' })
    arriveAtGuard()
    h.enqueue('leads', REREAD())

    const res = await handlePropertyCreate(ctx())
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('no usable address')
  })
})

describe('normalized matching — casing and punctuation cannot manufacture a duplicate', () => {
  const lead = { address: '118 Elmhurst Rd', city: 'Fayetteville', state: 'Arkansas', zip: '72701' }

  it('a differently-cased, differently-punctuated entry is the same address', () => {
    const plan = planDriftAddress({
      lead,
      formerAddresses: [{ display: '3448 OAKLAND ZION RD., Fayetteville, AR 72703' } as any],
      address: { street: '3448 oakland zion rd', city: 'fayetteville', province: 'ar', postalCode: '72703' },
      jobberPropertyId: null,
      nowIso: '2026-09-08T00:00:00Z',
    })
    expect(plan).toMatchObject({ action: 'skip', reason: 'matches_existing', index: 0 })
  })

  it('the primary matches regardless of case and punctuation', () => {
    const plan = planDriftAddress({
      lead,
      formerAddresses: [],
      address: { street: '118 ELMHURST RD.', city: 'FAYETTEVILLE', province: 'Arkansas', postalCode: '72701' },
      jobberPropertyId: '333',
      nowIso: '2026-09-08T00:00:00Z',
    })
    expect(plan).toEqual({ action: 'skip', reason: 'matches_primary' })
  })

  it('a genuinely different address is not swallowed by normalization', () => {
    const plan = planDriftAddress({
      lead,
      formerAddresses: [{ display: '118 Elmhurst Rd, Fayetteville, Arkansas, 72701' } as any],
      address: ADDR,
      jobberPropertyId: '333',
      nowIso: '2026-09-08T00:00:00Z',
    })
    expect(plan.action).toBe('create')
  })

  it('the id wins over the text — a matching id skips even when the address differs entirely', () => {
    const plan = planDriftAddress({
      lead,
      formerAddresses: [{ display: 'somewhere else entirely', jobber_property_id: '333' } as any],
      address: ADDR,
      jobberPropertyId: '333',
      nowIso: '2026-09-08T00:00:00Z',
    })
    expect(plan).toMatchObject({ action: 'skip', reason: 'matches_existing', index: 0 })
  })
})

describe('a retired address stays retired', () => {
  it('an inbound event does not un-retire what the owner retired', async () => {
    propertyReturns('333', ADDR)
    arriveAtGuard()
    h.enqueue('leads', REREAD([
      { display: DISPLAY, jobber_property_id: '333', moved_at: 'x', status: 'retired' },
    ]))

    const res = await handlePropertyCreate(ctx())
    expect(res.processed).toBe(true)
    // Nothing written at all — not a re-activation, not a re-stamp.
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('retired, left retired')
  })

  it('the planner reports the retired state so the note can say so', () => {
    const plan = planDriftAddress({
      lead: { address: '118 Elmhurst Rd' },
      formerAddresses: [{ display: DISPLAY, jobber_property_id: '333', status: 'retired' } as any],
      address: ADDR,
      jobberPropertyId: '333',
      nowIso: '2026-09-08T00:00:00Z',
    })
    expect(plan).toEqual({ action: 'skip', reason: 'matches_existing', index: 0, retired: true })
  })
})

describe('a property for a client we do not have', () => {
  it('is a quiet no-op — we never invent a lead with no owner, source or consent', async () => {
    propertyReturns('333', ADDR, '777')
    h.enqueue('leads', null) // no property-id match
    h.enqueue('leads', null) // no former holder
    h.enqueue('leads', null) // no client match either

    const res = await handlePropertyCreate(ctx())
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('no matching lead')
  })
})

describe('it never claims a write it did not make', () => {
  it('a failed re-read records nothing and says nothing was recorded', async () => {
    propertyReturns('333', ADDR)
    arriveAtGuard()
    h.enqueue('leads', null, { message: 'connection reset by peer' })

    const res = await handlePropertyCreate(ctx())
    expect(res.processed).toBe(true) // Jobber must not retry forever
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('could not re-read')
    expect(String(res.note)).toContain('nothing recorded')
    expect(String(res.note)).not.toContain('recorded as another')
  })

  it('a failed write says so rather than reporting the address as added', async () => {
    propertyReturns('333', ADDR)
    arriveAtGuard()
    h.enqueue('leads', REREAD())
    h.enqueue('leads', null, { message: 'former_addresses column missing' })

    const res = await handlePropertyCreate(ctx())
    expect(res.processed).toBe(true)
    expect(String(res.note)).toContain('could not record it')
    expect(String(res.note)).not.toContain('recorded as another')
  })
})

describe('PROPERTY_DESTROY retires an other-address, and never deletes it', () => {
  const HELD = [
    { display: '1 First St', jobber_property_id: '111', moved_at: 'x', status: 'active', label: 'other', label_note: 'Found in Jobber' },
    { display: DISPLAY, jobber_property_id: '333', moved_at: 'x', status: 'active', label: 'second_home', label_note: null },
  ]

  it('retires the entry, keeping the address, label and history', async () => {
    h.enqueue('leads', null)           // not anyone's PRIMARY property
    h.enqueue('leads', { id: 'lead-1', stage: 'Nurturing', former_addresses: HELD })

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(res.processed).toBe(true)

    const p = updatePatchOn('leads')
    expect(p.former_addresses).toHaveLength(2) // NOT deleted
    expect(p.former_addresses[1].status).toBe('retired')
    expect(p.former_addresses[1].display).toBe(DISPLAY)
    expect(p.former_addresses[1].label).toBe('second_home')
    expect(p.former_addresses[1].jobber_property_id).toBe('333')
    // the untouched sibling is untouched
    expect(p.former_addresses[0]).toEqual(HELD[0])
    expect(String(res.note)).toContain('retired that address')
  })

  it('does not re-retire one that is already retired', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', {
      id: 'lead-1', stage: 'Nurturing',
      former_addresses: [{ display: DISPLAY, jobber_property_id: '333', status: 'retired' }],
    })

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('already retired')
  })

  it('the PRIMARY case is unchanged — the link is still nulled', async () => {
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing' })

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(res.processed).toBe(true)
    const p = updatePatchOn('leads')
    expect(p.jobber_property_id).toBeNull()
    expect(p.former_addresses).toBeUndefined()
  })

  it('a property nobody holds stays the quiet no-op it was', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', null)

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toBeUndefined()
    expect(String(res.note)).toContain('no matching lead')
  })

  it('a containment-filter error pre-migration fails soft, not loudly', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', null, { message: 'column leads.former_addresses does not exist' })

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(res.processed).toBe(true)
    expect(updatePatchOn('leads')).toBeUndefined()
  })

  it('the destroy planner keeps every other entry byte-identical', () => {
    const plan = planDestroyedProperty(HELD as any, '333')
    expect(plan.action).toBe('retire')
    if (plan.action !== 'retire') throw new Error('unreachable')
    expect(plan.index).toBe(1)
    expect(plan.next[0]).toEqual(HELD[0])
    expect(plan.next[1].status).toBe('retired')
    expect(HELD[1].status).toBe('active') // the input is not mutated
  })

  it('the destroy planner skips what is not held, and what has no id', () => {
    expect(planDestroyedProperty(HELD as any, '999')).toEqual({ action: 'skip', reason: 'not_held' })
    expect(planDestroyedProperty(HELD as any, null)).toEqual({ action: 'skip', reason: 'no_property_id' })
  })
})
