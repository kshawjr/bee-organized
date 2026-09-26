// @vitest-environment node
//
// The duplicate-Jobber-client hazard (found 2026-09-26, the second-job
// investigation). send-to-jobber used to find the Jobber client ONLY by
// searching the lead's email, ignoring the jobber_client_id we already hold.
// So a LINKED client with no email (1,262 of them) — or whose email in Jobber
// differs — fell through to clientCreate: a DUPLICATE client in Jobber, and
// the writeback then moved our link onto it.
//
// The fix under test: a linked lead reads its OWN client back by id and uses
// it. It never searches, never creates. If Jobber can't return the linked
// client the send stops before any write. Unlinked leads are unchanged.
//
// These route runs use mocked collaborators (the beta-contact-writeback
// pattern). The no-email case is pinned hardest: it is the one a mutation back
// to "search by email" must break.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn(), jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('@/lib/jobber-import', async (orig) => ({
  // encodeJobberId stays REAL — the id we ask Jobber for is part of the pin.
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

const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')

const LINKED_ID = '136289662'
const LINKED_GID = gid('Client', LINKED_ID)
const OTHER_GID = gid('Client', '999000') // what a search/create would land on

const baseLead = (over: any = {}) => ({
  id: 'lead-1',
  location_id: 'loc_chattanooga',
  location_uuid: 'loc-uuid-1',
  name: 'Martha Wassel',
  first_name: 'Martha',
  last_name: 'Wassel',
  email: '',
  phone: '4235550100',
  addresses: [],
  address: null,
  jobber_client_id: null,
  jobber_property_id: null,
  jobber_request_id: null,
  jobber_assessment_id: null,
  jobber_job_id: null,
  ...over,
})

let leadUpdates: any[] = []

function chainFor(row: any, table: string) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq']) chain[m] = vi.fn(() => chain)
  chain.update = vi.fn((payload: any) => { if (table === 'leads') leadUpdates.push(payload); return chain })
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: any) => resolve({ data: row, error: null })
  return chain
}

type JobberSetup = {
  linkedNode?: any              // what client(id:) returns (null = not found)
  linkedErrors?: any[]          // errors on client(id:)
  searchNodes?: any[]           // what the email search returns
}

function wire(lead: any, jb: JobberSetup = {}) {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor({ id: 'u1', role: 'super_admin', location_id: null }, 'hub_users')),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(lead, 'leads')
    if (table === 'locations') {
      return chainFor({
        id: 'loc-uuid-1', location_id: 'loc_chattanooga', name: 'Chattanooga',
        timezone: 'America/New_York', jobber_access_token: 'tok',
        lifecycle_status: 'active', subscription_status: 'active',
      }, 'locations')
    }
    return chainFor(null, table)
  })
  ;(jobberGraphQL as any).mockImplementation(async (_loc: string, query: string) => {
    if (query.includes('GetClientById')) {
      if (jb.linkedErrors) return { errors: jb.linkedErrors }
      return { data: { client: jb.linkedNode === undefined ? null : jb.linkedNode } }
    }
    if (query.includes('FindClient')) return { data: { clients: { nodes: jb.searchNodes || [] } } }
    if (query.includes('GetClientProperties')) return { data: { client: { clientProperties: { nodes: [] } } } }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`)
  })
  ;(jobberMutation as any).mockImplementation(async (_loc: string, mutation: string, vars: any) => {
    if (mutation.includes('clientEdit')) return { data: { clientEdit: { client: { id: vars.clientId } } } }
    if (mutation.includes('clientCreate')) return { data: { clientCreate: { client: { id: OTHER_GID } } } }
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

const queriesRun = () => (jobberGraphQL as any).mock.calls.map((c: any[]) => c[1] as string)
const mutationCalls = (name: string) => (jobberMutation as any).mock.calls.filter((c: any[]) => (c[1] as string).includes(name))
const linkedNode = (over: any = {}) => ({
  id: LINKED_GID, firstName: 'Martha', lastName: 'Wassel', companyName: null,
  emails: [], phones: [{ id: 'ph-1', number: '423-555-0100', primary: true }],
  ...over,
})

beforeEach(() => { vi.clearAllMocks(); leadUpdates = [] })

describe('send-to-jobber — a LINKED client with NO email never gets a duplicate Jobber client', () => {
  it('reads the linked client back by id, creates the request ON it, and keeps our link', async () => {
    wire(baseLead({ jobber_client_id: LINKED_ID, email: '' }), { linkedNode: linkedNode() })
    const res = await postSend()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)

    // 1. It asked Jobber for THE linked client, by its encoded id.
    const byId = (jobberGraphQL as any).mock.calls.find((c: any[]) => c[1].includes('GetClientById'))
    expect(byId, 'the stored link must be read back').toBeDefined()
    expect(byId[2]).toEqual({ clientId: LINKED_GID })

    // 2. No client was created — the duplicate is impossible.
    expect(mutationCalls('clientCreate'), 'a linked client must NEVER be re-created').toHaveLength(0)

    // 3. The new request is on the EXISTING client.
    const reqCreate = mutationCalls('requestCreate')
    expect(reqCreate).toHaveLength(1)
    expect(reqCreate[0][2].input.clientId).toBe(LINKED_GID)

    // 4. Our link did not move.
    expect(body.jobber_client_id).toBe(LINKED_ID)
    expect(body.match_status).toBe('matched_existing')
    expect(leadUpdates).toHaveLength(1)
    expect(leadUpdates[0].jobber_client_id).toBe(LINKED_ID)
  })

  it('does not search by email at all when the link is held', async () => {
    wire(baseLead({ jobber_client_id: LINKED_ID, email: '' }), { linkedNode: linkedNode() })
    await postSend()
    expect(queriesRun().some((q: string) => q.includes('FindClient'))).toBe(false)
  })
})

describe('send-to-jobber — a LINKED client whose Jobber email differs gets no duplicate', () => {
  it('uses the linked client even though an email search would find a different one', async () => {
    // Bee Hub has a new address; Jobber still holds the old one. A search on
    // the new address would find nothing (or someone else) and create.
    wire(
      baseLead({ jobber_client_id: LINKED_ID, email: 'martha.new@example.com' }),
      {
        linkedNode: linkedNode({ emails: [{ id: 'em-1', address: 'martha.old@example.com', primary: true }] }),
        searchNodes: [{ id: OTHER_GID, emails: [{ id: 'em-x', address: 'martha.new@example.com', primary: true }], phones: [] }],
      },
    )
    const res = await postSend()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mutationCalls('clientCreate')).toHaveLength(0)
    expect(queriesRun().some((q: string) => q.includes('FindClient'))).toBe(false)
    expect(mutationCalls('requestCreate')[0][2].input.clientId).toBe(LINKED_GID)
    expect(body.jobber_client_id).toBe(LINKED_ID)
    expect(leadUpdates[0].jobber_client_id).toBe(LINKED_ID)
  })
})

describe('send-to-jobber — the link can\'t be read back: stop, never fall back', () => {
  it('Jobber returns no client for the stored id → 409, and NOTHING is written anywhere', async () => {
    wire(baseLead({ jobber_client_id: LINKED_ID, email: 'martha@example.com' }), { linkedNode: null })
    const res = await postSend()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.success).toBe(false)
    expect(body.error).toContain(`JC-${LINKED_ID}`)
    expect(body.error).toContain('no duplicate was created')
    expect((jobberMutation as any).mock.calls, 'no Jobber write of any kind').toHaveLength(0)
    expect(queriesRun().some((q: string) => q.includes('FindClient')), 'no email fallback').toBe(false)
    expect(leadUpdates).toHaveLength(0)
  })

  it('the id lookup errors → 409 with the reason, no writes', async () => {
    wire(baseLead({ jobber_client_id: LINKED_ID }), { linkedErrors: [{ message: 'Throttled' }] })
    const res = await postSend()
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error).toContain('Throttled')
    expect((jobberMutation as any).mock.calls).toHaveLength(0)
    expect(leadUpdates).toHaveLength(0)
  })
})

describe('send-to-jobber — an UNLINKED client works exactly as before', () => {
  it('email matches an existing Jobber client → reused, no create', async () => {
    wire(
      baseLead({ jobber_client_id: null, email: 'amy@example.com' }),
      { searchNodes: [{ id: OTHER_GID, emails: [{ id: 'em-1', address: 'amy@example.com', primary: true }], phones: [] }] },
    )
    const res = await postSend()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(queriesRun().some((q: string) => q.includes('GetClientById'))).toBe(false)
    expect(queriesRun().some((q: string) => q.includes('FindClient'))).toBe(true)
    expect(mutationCalls('clientCreate')).toHaveLength(0)
    expect(mutationCalls('requestCreate')[0][2].input.clientId).toBe(OTHER_GID)
    expect(body.match_status).toBe('matched_existing')
  })

  it('no match → a new Jobber client is created and linked (the first-send path)', async () => {
    wire(baseLead({ jobber_client_id: null, email: 'new@example.com' }), { searchNodes: [] })
    const res = await postSend()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mutationCalls('clientCreate')).toHaveLength(1)
    expect(mutationCalls('requestCreate')[0][2].input.clientId).toBe(OTHER_GID)
    expect(body.match_status).toBe('new_client')
    expect(body.jobber_client_id).toBe('999000')
    expect(leadUpdates[0].jobber_client_id).toBe('999000')
  })

  it('no email and no link → creates (unchanged; there is nothing to match on)', async () => {
    wire(baseLead({ jobber_client_id: null, email: '' }))
    const res = await postSend()
    expect(res.status).toBe(200)
    expect(queriesRun().some((q: string) => q.includes('FindClient'))).toBe(false)
    expect(mutationCalls('clientCreate')).toHaveLength(1)
  })
})
