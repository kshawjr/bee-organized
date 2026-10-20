// @vitest-environment node
//
// Send to Jobber puts the STREET ONLY in Jobber's street field (2026-10-20,
// Lynette Ewy / Wanda Wilkinson, KC). leads.address holds the full joined line
// ("street, city, state, zip" — the import's convention), and since May the
// send passed that whole line as street1 alongside city/province/postalCode.
// Jobber then showed city, state and zip twice, and the property webhook
// echoed the doubled line back into leads.address (~420 rows).
//
// Pins:
//   · pickPrimaryAddress strips the tail — repeats included — from the
//     address list entry and from the legacy columns
//   · the property Jobber is asked to create carries the clean street
//   · an EXISTING Jobber property is reused whether its street1 is the clean
//     street or the full line an earlier send stored (no duplicate property)
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn(), jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-import', async (orig) => ({
  encodeJobberId: ((await orig()) as any).encodeJobberId,
  upsertServiceRequest: vi.fn(async () => ({ id: 'sr-db-1' })),
  upsertJob: vi.fn(async () => ({ id: 'job-db-1' })),
}))
vi.mock('@/lib/engagements', () => ({ attachToEngagement: vi.fn(async () => {}) }))
vi.mock('@/lib/lead-assignment', () => ({ resolveAndPersistLeadAssigneesIfEmpty: vi.fn(async () => {}) }))
vi.mock('@/lib/engagement-assignee-sync', () => ({
  getLeadAssignees: vi.fn(async () => []),
  getEngagementAssignees: vi.fn(async () => []),
  resolveJobberAssignment: () => ({ primaryJobberUserId: null, allJobberUserIds: [], mappedCount: 0, unmappedCount: 0 }),
}))

import { POST } from '@/app/api/leads/[id]/send-to-jobber/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'
import { pickPrimaryAddress } from './visit-address'

const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')
const LINKED_ID = '156813799'
const LINKED_GID = gid('Client', LINKED_ID)
const NEW_GID = gid('Client', '999000')
const NEW_PROP = gid('Property', '555')

const WANDA_LIST = {
  type: 'Service',
  value: '15353 Carter Road, Overland Park, KS, Overland Park, KS, 66221',
  street: '15353 Carter Road, Overland Park, KS, Overland Park, KS, 66221',
  city: 'Overland Park', state: 'KS', zip: '66221',
}
const LEGACY = {
  address: '15353 Carter Street, Overland Park, Kansas, 66221',
  city: 'Overland Park', state: 'Kansas', zip: '66221',
}

describe('pickPrimaryAddress — the street only', () => {
  it('legacy columns: the full joined line loses its city/state/zip tail', () => {
    expect(pickPrimaryAddress({ addresses: [], ...LEGACY })).toEqual({
      street: '15353 Carter Street', city: 'Overland Park', state: 'Kansas', zip: '66221',
      storedStreet: '15353 Carter Street, Overland Park, Kansas, 66221',
    })
  })

  it('address list: a doubled tail is stripped in full', () => {
    const a = pickPrimaryAddress({ addresses: [WANDA_LIST], ...LEGACY })!
    expect(a.street).toBe('15353 Carter Road')
    expect(a.state).toBe('KS')
    expect(a.storedStreet).toBe(WANDA_LIST.street)
  })

  it('a street-only line passes through untouched (unit kept)', () => {
    expect(pickPrimaryAddress({ address: '500 Oak Ave Apt 4', city: 'Austin', state: 'TX', zip: '78701' })!.street)
      .toBe('500 Oak Ave Apt 4')
  })

  it('a stub list entry with no street falls through to the columns', () => {
    expect(pickPrimaryAddress({ addresses: [{ type: 'Service' }], ...LEGACY })!.street).toBe('15353 Carter Street')
  })

  it('nothing on file → null', () => {
    expect(pickPrimaryAddress({ addresses: [], address: null })).toBeNull()
  })
})

// ── Route runs (the send-to-jobber-stored-link harness) ───────────────────

const baseLead = (over: any = {}) => ({
  id: 'lead-1', location_id: 'loc_kc', location_uuid: 'loc-uuid-1',
  name: 'Wanda Wilkinson', first_name: 'Wanda', last_name: 'Wilkinson',
  email: '', phone: '9135550100', addresses: [], address: null,
  jobber_client_id: null, jobber_property_id: null, jobber_request_id: null,
  jobber_assessment_id: null, jobber_job_id: null,
  ...over,
})

function chainFor(row: any) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq']) chain[m] = vi.fn(() => chain)
  chain.update = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: any) => resolve({ data: row, error: null })
  return chain
}

function wire(lead: any, existingProps: any[] = []) {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor({ id: 'u1', role: 'super_admin', location_id: null })),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(lead)
    if (table === 'locations') {
      return chainFor({
        id: 'loc-uuid-1', location_id: 'loc_kc', name: 'Kansas City',
        timezone: 'America/Chicago', jobber_access_token: 'tok',
        lifecycle_status: 'active', subscription_status: 'active',
      })
    }
    return chainFor(null)
  })
  ;(jobberGraphQL as any).mockImplementation(async (_loc: string, query: string) => {
    if (query.includes('GetClientById')) {
      return { data: { client: { id: LINKED_GID, firstName: 'Wanda', lastName: 'Wilkinson', companyName: null, emails: [], phones: [] } } }
    }
    if (query.includes('FindClient')) return { data: { clients: { nodes: [] } } }
    if (query.includes('GetClientProperties')) return { data: { client: { clientProperties: { nodes: existingProps } } } }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`)
  })
  ;(jobberMutation as any).mockImplementation(async (_loc: string, mutation: string, vars: any) => {
    if (mutation.includes('clientEdit')) return { data: { clientEdit: { client: { id: vars.clientId } } } }
    if (mutation.includes('clientCreate')) return { data: { clientCreate: { client: { id: NEW_GID } } } }
    if (mutation.includes('propertyCreate')) return { data: { propertyCreate: { properties: [{ id: NEW_PROP }] } } }
    if (mutation.includes('requestCreate')) return { data: { requestCreate: { request: { id: gid('Request', '77') } } } }
    throw new Error(`unexpected mutation: ${mutation.slice(0, 60)}`)
  })
}

function postSend() {
  const req: any = new Request('http://test/api/leads/lead-1/send-to-jobber', {
    method: 'POST',
    body: JSON.stringify({ creation_type: 'request_only' }),
    headers: { 'Content-Type': 'application/json' },
  })
  req.nextUrl = new URL('http://test/api/leads/lead-1/send-to-jobber')
  return POST(req, { params: Promise.resolve({ id: 'lead-1' }) } as any)
}

const mutationCalls = (name: string) => (jobberMutation as any).mock.calls.filter((c: any[]) => (c[1] as string).includes(name))
const requestProperty = () => mutationCalls('requestCreate')[0]?.[2]?.input?.propertyId

beforeEach(() => { vi.clearAllMocks() })

describe('send-to-jobber — the property Jobber creates has the street only', () => {
  it('legacy full line: street1 is the street, the parts ride in their own fields', async () => {
    wire(baseLead({ ...LEGACY }))
    const res = await postSend()
    expect(res.status).toBe(200)
    const create = mutationCalls('propertyCreate')
    expect(create).toHaveLength(1)
    expect(create[0][2].input.properties[0].address).toEqual({
      street1: '15353 Carter Street', city: 'Overland Park', province: 'Kansas', postalCode: '66221', country: 'US',
    })
  })

  it('a doubled address-list street (Wanda) still sends the street only', async () => {
    wire(baseLead({ ...LEGACY, addresses: [WANDA_LIST] }))
    expect((await postSend()).status).toBe(200)
    expect(mutationCalls('propertyCreate')[0][2].input.properties[0].address.street1).toBe('15353 Carter Road')
  })
})

describe('send-to-jobber — an existing Jobber property is reused, never duplicated', () => {
  const linked = { ...LEGACY, jobber_client_id: LINKED_ID }

  it('matches a property whose street1 is the clean street', async () => {
    const prop = { id: gid('Property', '1'), address: { street1: '15353 Carter Street', city: 'Overland Park', province: 'Kansas', postalCode: '66221' } }
    wire(baseLead(linked), [prop])
    expect((await postSend()).status).toBe(200)
    expect(mutationCalls('propertyCreate')).toHaveLength(0)
    expect(requestProperty()).toBe(prop.id)
  })

  it('matches a property an earlier send created with the FULL line as street1', async () => {
    const prop = { id: gid('Property', '2'), address: { street1: '15353 Carter Street, Overland Park, Kansas, 66221', city: 'Overland Park', province: 'Kansas', postalCode: '66221' } }
    wire(baseLead(linked), [prop])
    expect((await postSend()).status).toBe(200)
    expect(mutationCalls('propertyCreate')).toHaveLength(0)
    expect(requestProperty()).toBe(prop.id)
  })
})
