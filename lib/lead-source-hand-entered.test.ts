// @vitest-environment node
//
// Tidying the messy source values (30 Sept 2026).
//
// Nine "google" and two "ig" in 90 days sat beside "Google" and "Instagram"
// as separate sources. The website door already ran its source through
// normalizeLeadSource; a lead ENTERED BY HAND (the New sheet) and a source
// CHANGED BY HAND (the picker / client record) skipped it. Pinned here:
//   · google → Google, ig → Instagram, whatever the capitals
//   · anything unrecognised stays exactly as the owner typed it — this is a
//     tidy-up, not a fixed list
//   · hand-entered and hand-edited leads go through it too
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const payloads = (t: string, m: string) =>
    state.calls.filter(c => c.table === t).flatMap(c => c.ops.filter(o => o[0] === m).map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, payloads }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: vi.fn(async () => null) }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'owner-1' })) }))
vi.mock('@/lib/lead-assignment', () => ({
  writeLeadAssignment: vi.fn(async () => ({ hubUserIds: [], basis: 'location_owner', junctionWritten: true, warnings: [] })),
}))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => ({ enrol: { enrolled: true } })) }))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/lead-notification-email', () => ({ notifyNewLead: vi.fn(async () => ({})) }))
vi.mock('@/lib/slack-bot', () => ({ notifyNewLeadSlack: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/notification-log', () => ({ logSlackNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/dual-write', () => ({ updateLead: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-contact-sync', () => ({ syncLeadContactToJobber: vi.fn(async () => null) }))
vi.mock('@/lib/jobber-address-sync', () => ({ syncLeadAddressToJobber: vi.fn(async () => null) }))

import { POST } from '@/app/api/leads/route'
import { PATCH } from '@/app/api/leads/[id]/route'
import { updateLead } from '@/lib/dual-write'
import { normalizeLeadSource } from '@/lib/lead-source'

beforeEach(() => { h.reset(); vi.mocked(updateLead).mockClear() })

describe('normalizeLeadSource — capitals do not matter for the ones we recognise', () => {
  it.each([
    ['google', 'Google'],
    ['GOOGLE', 'Google'],
    ['Google', 'Google'],
    [' google ', 'Google'],
    ['ig', 'Instagram'],
    ['IG', 'Instagram'],
    ['instagram', 'Instagram'],
    ['facebook', 'Facebook'],
    ['referral', 'Referral'],
    ['word of mouth', 'Word of Mouth'],
    ['nextdoor', 'NextDoor'],
    ['tiktok', 'TikTok'],
    ['website', 'Website'],
  ])('%j → %j', (typed, stored) => {
    expect(normalizeLeadSource(typed)).toBe(stored)
  })

  it.each([
    'Hershey Mills Ads',
    'chatgpt.com',
    'Quarry Days',
    'Googled us after the home show', // contains "google" — still not ours to rewrite
    'smoke_test',
  ])('unrecognised %j stays exactly as typed', (typed) => {
    expect(normalizeLeadSource(typed)).toBe(typed)
  })

  it('blank stays blank — never a default', () => {
    expect(normalizeLeadSource('')).toBeNull()
    expect(normalizeLeadSource('   ')).toBeNull()
    expect(normalizeLeadSource(null)).toBeNull()
    expect(normalizeLeadSource(undefined)).toBeNull()
  })
})

describe('a lead ENTERED by hand goes through the tidy-up', () => {
  const create = async (source: any) => {
    h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
    h.enqueue('locations', { id: 'loc-test', location_id: 'loc_test', name: 'Test Location' })
    h.enqueue('leads', { id: 'lead-new', name: 'Jane', assigned_to: 'owner-1' })
    const res = await POST(new Request('http://test/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_uuid: 'loc-test', name: 'Jane', stage: 'Closed Won', source }),
    }) as any)
    expect(res.status).toBe(201)
    const inserts = h.payloads('leads', 'insert')
    expect(inserts).toHaveLength(1)
    return inserts[0].source
  }

  it('google → Google', async () => { expect(await create('google')).toBe('Google') })
  it('ig → Instagram', async () => { expect(await create('ig')).toBe('Instagram') })
  it('an unrecognised source is stored as typed', async () => {
    expect(await create('Hershey Mills Ads')).toBe('Hershey Mills Ads')
  })
  it('no source is stored blank', async () => { expect(await create(undefined)).toBeNull() })
})

describe('a source CHANGED by hand goes through the tidy-up', () => {
  const LEAD = {
    id: 'lead-1', location_uuid: 'loc-uuid-1', location_id: 'kc',
    stage: 'New', jobber_client_id: null, source: 'Website',
    phone: null, email: null, address: null, city: null, state: null, zip: null, addresses: [],
  }
  const change = async (source: any) => {
    h.enqueue('hub_users', { id: 'u1', role: 'super_admin', location_id: null })
    h.enqueue('leads', LEAD)
    h.enqueue('leads', { ...LEAD })
    const res = await PATCH(
      new Request('http://test/api/leads/lead-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      }),
      { params: Promise.resolve({ id: 'lead-1' }) },
    )
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalledTimes(1)
    return (vi.mocked(updateLead).mock.calls[0][1] as any).source
  }

  it('google → Google', async () => { expect(await change('google')).toBe('Google') })
  it('ig → Instagram', async () => { expect(await change('ig')).toBe('Instagram') })
  it('an unrecognised source is stored as typed', async () => {
    expect(await change('Quarry Days')).toBe('Quarry Days')
  })
  it('clearing the source stays cleared', async () => { expect(await change(null)).toBeNull() })
})
