// @vitest-environment node
//
// checkLanded for PROPERTY events, judged against what the handler REALLY
// did. Every case below runs the real handler first, then hands checkLanded
// the lead exactly as that handler left it — so a note or a patch that
// drifts from what the check expects fails here, not in Kevin's Slack.
//
// Why this file exists. The drift fix (e0d0451) records a property it did
// not know as one of the client's OTHER addresses, and by design never
// touches leads.jobber_property_id — that is the stomp guard from d8aa5ef.
// checkLanded only asked "does the link now equal this property?", so every
// correct drift write alarmed "processed but didn't land": Donna Lagatta ×4,
// Kim Noonan, Jodi Yuspeh. All three verified intact in production.
//
// What these tests pin:
//   · both success shapes land: the primary link, OR an other-address entry
//   · a genuine failure (nothing written) is still not_landed
//   · a documented no-op is 'na' — not 'landed', and with no DB read
//   · PROPERTY_DESTROY's retire path lands when the entry is retired, and
//     does NOT land when the retire write failed (the old check passed that
//     whenever the holder's primary link happened to be empty)
//   · the three real alert shapes, by their production property ids
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

import { readFileSync } from 'node:fs'
import {
  handlePropertyCreate,
  handlePropertyUpdate,
  handlePropertyDestroy,
  PROPERTY_NOOP_NOTES,
} from '@/lib/jobber-webhook-handlers'
import { checkLanded } from '@/lib/webhook-landed'

const ctx = (topic: string, itemId = '333') => ({
  topic,
  itemId,
  accountId: 'acct-1',
  occurredAt: '2026-09-15T00:00:00Z',
  location: { id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test' },
}) as any

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

// Placeholder addresses throughout — the tests carry no customer address.
const ADDR = { street: '3448 Oakland Zion Road', city: 'Fayetteville', province: 'Arkansas', postalCode: '72703' }
const DISPLAY = '3448 Oakland Zion Road, Fayetteville, Arkansas, 72703'

const updatePatchOn = (table: string) => {
  const c = h.state.calls.filter(x => x.table === table).find(x => x.ops.some(([m]) => m === 'update'))
  return c?.ops.find(([m]) => m === 'update')?.[1][0]
}

const rereadRow = (id: string, former: any[] = []) => ({
  id,
  stage: 'Nurturing',
  address: '118 Elmhurst Rd, Fayetteville, Arkansas, 72701',
  city: 'Fayetteville',
  state: 'Arkansas',
  zip: '72701',
  former_addresses: former,
})

// The handler's lookups before the drift branch fires: no property-id match,
// no former-address holder, then a client match linked ELSEWHERE.
const arriveAtDriftBranch = (lead: any) => {
  h.enqueue('leads', null)
  h.enqueue('leads', null)
  h.enqueue('leads', lead)
}

// The lead as it stands AFTER the handler ran. Anything the handler left
// unconsumed is dropped, so the check reads exactly this row.
const leadNowIs = (row: any) => {
  h.state.queue = []
  h.enqueue('leads', row)
}

const entry = (pid: string, over: any = {}) => ({
  street: '1 Placeholder St', city: 'Town', state: 'ST', zip: '00000',
  display: `1 Placeholder St #${pid}, Town, ST, 00000`,
  jobber_property_id: pid, moved_at: 'x', added_at: 'x',
  label: 'other', label_note: 'Found in Jobber', status: 'active',
  ...over,
})

const noNoopMarkerIn = (note: unknown) => {
  for (const m of Object.values(PROPERTY_NOOP_NOTES)) expect(String(note)).not.toContain(m)
}

beforeEach(() => { h.reset(); wh.graphql.mockReset() })

describe('PROPERTY_CREATE / PROPERTY_UPDATE — both success shapes land', () => {
  it('a drifted address recorded in former_addresses → landed (the link never moved)', async () => {
    propertyReturns('333', ADDR)
    arriveAtDriftBranch({ id: 'lead-1', name: 'x', stage: 'Nurturing', jobber_property_id: '999' })
    h.enqueue('leads', rereadRow('lead-1'))

    const res = await handlePropertyCreate(ctx('PROPERTY_CREATE'))
    expect(String(res.note)).toContain('recorded as another of the client')
    const p = updatePatchOn('leads')
    expect(p.jobber_property_id).toBeUndefined() // the stomp guard

    leadNowIs({ jobber_property_id: '999', former_addresses: p.former_addresses })
    expect(await checkLanded(ctx('PROPERTY_CREATE'), res)).toBe('landed')
  })

  it('an existing other address updated in place → landed', async () => {
    propertyReturns('333', ADDR)
    h.enqueue('leads', null) // not anyone's primary
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing', former_addresses: [entry('333')] })

    const res = await handlePropertyUpdate(ctx('PROPERTY_UPDATE'))
    expect(String(res.note)).toContain('synced FORMER address entry')
    const p = updatePatchOn('leads')
    expect(p.former_addresses[0].display).toBe(DISPLAY)

    leadNowIs({ jobber_property_id: '999', former_addresses: p.former_addresses })
    expect(await checkLanded(ctx('PROPERTY_UPDATE'), res)).toBe('landed')
  })

  it('the primary address → landed (unchanged)', async () => {
    propertyReturns('333', ADDR)
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing' })

    const res = await handlePropertyUpdate(ctx('PROPERTY_UPDATE'))
    expect(String(res.note)).toContain('synced property address to lead')
    expect(updatePatchOn('leads').jobber_property_id).toBe('333')

    leadNowIs({ jobber_property_id: '333', former_addresses: [] })
    expect(await checkLanded(ctx('PROPERTY_UPDATE'), res)).toBe('landed')
  })

  it('an unlinked client adopting this property as its primary → landed', async () => {
    propertyReturns('333', ADDR)
    arriveAtDriftBranch({ id: 'lead-1', name: 'x', stage: 'Nurturing', jobber_property_id: null })

    const res = await handlePropertyCreate(ctx('PROPERTY_CREATE'))
    leadNowIs({ jobber_property_id: '333', former_addresses: null })
    expect(await checkLanded(ctx('PROPERTY_CREATE'), res)).toBe('landed')
  })
})

describe('PROPERTY_CREATE / PROPERTY_UPDATE — a genuine failure is still not_landed', () => {
  it('the drift write failed — nothing recorded anywhere → not_landed', async () => {
    propertyReturns('333', ADDR)
    arriveAtDriftBranch({ id: 'lead-1', name: 'x', stage: 'Nurturing', jobber_property_id: '999' })
    h.enqueue('leads', rereadRow('lead-1'))
    h.enqueue('leads', null, { message: 'permission denied for table leads' })

    const res = await handlePropertyCreate(ctx('PROPERTY_CREATE'))
    expect(res.processed).toBe(true) // no error thrown — the check must not trust that
    expect(res.error).toBeUndefined()
    expect(String(res.note)).toContain('could not record it')
    noNoopMarkerIn(res.note)

    leadNowIs({ jobber_property_id: '999', former_addresses: [] })
    expect(await checkLanded(ctx('PROPERTY_CREATE'), res)).toBe('not_landed')
  })

  it('the drift re-read failed — nothing recorded → not_landed', async () => {
    propertyReturns('333', ADDR)
    arriveAtDriftBranch({ id: 'lead-1', name: 'x', stage: 'Nurturing', jobber_property_id: '999' })
    h.enqueue('leads', null, { message: 'connection reset by peer' })

    const res = await handlePropertyUpdate(ctx('PROPERTY_UPDATE'))
    expect(String(res.note)).toContain('could not re-read')
    noNoopMarkerIn(res.note)

    leadNowIs({ jobber_property_id: '999', former_addresses: [entry('444')] })
    expect(await checkLanded(ctx('PROPERTY_UPDATE'), res)).toBe('not_landed')
  })

  it('another property on the card does not count — only THIS id does', async () => {
    leadNowIs({ jobber_property_id: '999', former_addresses: [entry('444'), entry('3333'), entry('33')] })
    expect(await checkLanded(ctx('PROPERTY_UPDATE'), { processed: true, lead_id: 'lead-1', note: 'PROPERTY_UPDATE: synced property address to lead lead-1' })).toBe('not_landed')
  })

  it('the lead row is gone on re-read → not_landed', async () => {
    leadNowIs(null)
    expect(await checkLanded(ctx('PROPERTY_CREATE'), { processed: true, lead_id: 'lead-1', note: 'PROPERTY_CREATE: synced property address to lead lead-1' })).toBe('not_landed')
  })
})

describe('PROPERTY_CREATE / PROPERTY_UPDATE — a documented no-op is na, with no read', () => {
  const noop = async (address: any, former: any[] = []) => {
    propertyReturns('333', address)
    arriveAtDriftBranch({ id: 'lead-1', name: 'x', stage: 'Nurturing', jobber_property_id: '999' })
    h.enqueue('leads', rereadRow('lead-1', former))
    const res = await handlePropertyCreate(ctx('PROPERTY_CREATE'))
    expect(updatePatchOn('leads')).toBeUndefined() // really wrote nothing
    h.state.queue = []
    const before = h.state.calls.length
    const landed = await checkLanded(ctx('PROPERTY_CREATE'), res)
    return { res, landed, reads: h.state.calls.length - before }
  }

  it('no usable address in Jobber → na', async () => {
    const { res, landed, reads } = await noop({ street: '', city: '', province: '', postalCode: '' })
    expect(String(res.note)).toContain(PROPERTY_NOOP_NOTES.noAddress)
    expect(landed).toBe('na')
    expect(reads).toBe(0)
  })

  it('already the primary address → na', async () => {
    const { res, landed, reads } = await noop({ street: '118 Elmhurst Rd', city: 'Fayetteville', province: 'Arkansas', postalCode: '72701' })
    expect(String(res.note)).toContain(PROPERTY_NOOP_NOTES.matchesPrimary)
    expect(landed).toBe('na')
    expect(reads).toBe(0)
  })

  it('already one of their addresses (matched by text, recorded before the id was known) → na', async () => {
    const { res, landed, reads } = await noop(ADDR, [{ display: DISPLAY, jobber_property_id: null, moved_at: 'x', status: 'active' }])
    expect(String(res.note)).toContain(PROPERTY_NOOP_NOTES.matchesExisting)
    expect(landed).toBe('na')
    expect(reads).toBe(0)
  })

  it('no matching lead at all → na', async () => {
    propertyReturns('333', ADDR, '777')
    h.enqueue('leads', null); h.enqueue('leads', null); h.enqueue('leads', null)
    const res = await handlePropertyCreate(ctx('PROPERTY_CREATE'))
    expect(await checkLanded(ctx('PROPERTY_CREATE'), res)).toBe('na')
  })
})

describe('PROPERTY_DESTROY — the retire path', () => {
  it('an other address retired → landed (the link is a different property, and must stay so)', async () => {
    h.enqueue('leads', null) // not anyone's primary
    h.enqueue('leads', { id: 'lead-1', stage: 'Nurturing', former_addresses: [entry('111'), entry('333')] })

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(String(res.note)).toContain('retired that address')
    const p = updatePatchOn('leads')

    leadNowIs({ jobber_property_id: '999', former_addresses: p.former_addresses })
    expect(await checkLanded(ctx('PROPERTY_DESTROY', '333'), res)).toBe('landed')
  })

  it('the retire write failed on a holder with NO primary link → not_landed (the old check passed this)', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', { id: 'lead-1', stage: 'Nurturing', former_addresses: [entry('333')] })
    h.enqueue('leads', null, { message: 'permission denied for table leads' })

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(String(res.note)).toContain('could not retire it')
    noNoopMarkerIn(res.note)

    leadNowIs({ jobber_property_id: null, former_addresses: [entry('333')] })
    expect(await checkLanded(ctx('PROPERTY_DESTROY', '333'), res)).toBe('not_landed')
  })

  it('already retired → na, with no read', async () => {
    h.enqueue('leads', null)
    h.enqueue('leads', { id: 'lead-1', stage: 'Nurturing', former_addresses: [entry('333', { status: 'retired' })] })

    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(String(res.note)).toContain(PROPERTY_NOOP_NOTES.alreadyRetired)
    h.state.queue = []
    const before = h.state.calls.length
    expect(await checkLanded(ctx('PROPERTY_DESTROY', '333'), res)).toBe('na')
    expect(h.state.calls.length - before).toBe(0)
  })

  it('the primary link nulled → landed; still set → not_landed (unchanged)', async () => {
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing' })
    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(String(res.note)).toContain('nulled jobber_property_id')

    leadNowIs({ jobber_property_id: null, former_addresses: [] })
    expect(await checkLanded(ctx('PROPERTY_DESTROY', '333'), res)).toBe('landed')

    leadNowIs({ jobber_property_id: '333', former_addresses: [] })
    expect(await checkLanded(ctx('PROPERTY_DESTROY', '333'), res)).toBe('not_landed')
  })

  it('primary link nulled while an active other address carries the same id → landed, as before (no new alarm here)', async () => {
    // 33 production leads have this shape. The handler nulls the link and
    // stops; the entry stays live. That is a handler gap, reported
    // separately — this fix does not turn it into a new alert.
    h.enqueue('leads', { id: 'lead-1', name: 'x', stage: 'Nurturing' })
    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))

    leadNowIs({ jobber_property_id: null, former_addresses: [entry('333')] })
    expect(await checkLanded(ctx('PROPERTY_DESTROY', '333'), res)).toBe('landed')
  })

  it('a property nobody holds → na', async () => {
    h.enqueue('leads', null); h.enqueue('leads', null)
    const res = await handlePropertyDestroy(ctx('PROPERTY_DESTROY', '333'))
    expect(await checkLanded(ctx('PROPERTY_DESTROY', '333'), res)).toBe('na')
  })
})

// The three alerts Kevin got, by their real production shapes (property ids
// and address counts read from production 2026-09-15; addresses are
// placeholders). Each one alarmed "processed but didn't land". Each is landed.
describe('the three real false alarms', () => {
  it('Donna Lagatta (Rhode Island) — no primary link, 4 other addresses, PROPERTY_UPDATE on one of them → landed', async () => {
    const others = ['83865436', '95361766', '121227696', '154606047'].map(pid => entry(pid))
    propertyReturns('154606047', ADDR)
    h.enqueue('leads', null) // no lead has 154606047 as its primary
    h.enqueue('leads', { id: 'lead-donna', name: 'Donna Lagatta', stage: 'Nurturing', former_addresses: others })

    const res = await handlePropertyUpdate(ctx('PROPERTY_UPDATE', '154606047'))
    expect(String(res.note)).toContain('synced FORMER address entry (property=154606047)')
    const p = updatePatchOn('leads')
    expect(p.former_addresses).toHaveLength(4)

    const now = { jobber_property_id: null, former_addresses: p.former_addresses }
    expect(now.jobber_property_id).not.toBe('154606047') // why the old check alarmed
    leadNowIs(now)
    expect(await checkLanded(ctx('PROPERTY_UPDATE', '154606047'), res)).toBe('landed')
  })

  it('Kim Noonan (South Charlotte) — primary 156756679, PROPERTY_UPDATE records 156756678 as her 1 other address → landed', async () => {
    propertyReturns('156756678', ADDR)
    arriveAtDriftBranch({ id: 'lead-kim', name: 'Kim Noonan', stage: 'Nurturing', jobber_property_id: '156756679' })
    h.enqueue('leads', rereadRow('lead-kim'))

    const res = await handlePropertyUpdate(ctx('PROPERTY_UPDATE', '156756678'))
    expect(String(res.note)).toContain('recorded as another of the client')
    const p = updatePatchOn('leads')
    expect(p.former_addresses).toHaveLength(1)
    expect(p.former_addresses[0].jobber_property_id).toBe('156756678')

    leadNowIs({ jobber_property_id: '156756679', former_addresses: p.former_addresses })
    expect(await checkLanded(ctx('PROPERTY_UPDATE', '156756678'), res)).toBe('landed')
  })

  it('Jodi Yuspeh (New Orleans) — primary 158820349; Property added then Property updated on 159263272, her 1 other address → both landed', async () => {
    propertyReturns('159263272', ADDR)
    arriveAtDriftBranch({ id: 'lead-jodi', name: 'Jodi Yuspeh', stage: 'Nurturing', jobber_property_id: '158820349' })
    h.enqueue('leads', rereadRow('lead-jodi'))

    const created = await handlePropertyCreate(ctx('PROPERTY_CREATE', '159263272'))
    expect(String(created.note)).toContain('recorded as another of the client')
    const list = updatePatchOn('leads').former_addresses
    expect(list).toHaveLength(1)

    leadNowIs({ jobber_property_id: '158820349', former_addresses: list })
    expect(await checkLanded(ctx('PROPERTY_CREATE', '159263272'), created)).toBe('landed')

    // …then Jobber's PROPERTY_UPDATE for the same property refreshes it in place.
    h.reset()
    propertyReturns('159263272', ADDR)
    h.enqueue('leads', null)
    h.enqueue('leads', { id: 'lead-jodi', name: 'Jodi Yuspeh', stage: 'Nurturing', former_addresses: list })
    const updated = await handlePropertyUpdate(ctx('PROPERTY_UPDATE', '159263272'))
    expect(String(updated.note)).toContain('synced FORMER address entry (property=159263272)')

    leadNowIs({ jobber_property_id: '158820349', former_addresses: updatePatchOn('leads').former_addresses })
    expect(await checkLanded(ctx('PROPERTY_UPDATE', '159263272'), updated)).toBe('landed')
  })
})

describe('the no-op words are the handler’s own, never a copy', () => {
  it('webhook-landed imports PROPERTY_NOOP_NOTES and re-types none of its phrases', () => {
    const src = readFileSync(new URL('./webhook-landed.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/import\s*\{[^}]*PROPERTY_NOOP_NOTES[^}]*\}\s*from\s*'\.\/jobber-webhook-handlers'/)
    for (const phrase of Object.values(PROPERTY_NOOP_NOTES)) expect(src).not.toContain(phrase)
  })
})
