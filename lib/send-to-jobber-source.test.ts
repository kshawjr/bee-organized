// @vitest-environment node
//
// SENDING the lead's source to Jobber (30 Sept 2026) — reverses the earlier
// "Source stays in Bee Hub" call.
//
// What Jobber lets us write (live schema, 2026-09-30):
//   · the REQUEST's own source field — never. It is read-only and Jobber
//     stamps "Bee Organized Interface" on it.
//   · a JOB — has no lead source at all.
//   · the request's DETAILS FORM — always. So every send carries a "Source"
//     line there, for a brand-new client and for one already in Jobber.
//
// Settled rules pinned here:
//   · the value is whatever is on the lead when Send to Jobber is pressed
//   · no source sends BLANK — no line, never a default
//   · the value is tidied on the way out (ig → Instagram, old form slugs →
//     Website), so a raw slug never lands in a franchisee's Jobber
//
// Route runs use mocked collaborators (the send-to-jobber-stored-link
// pattern).
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
vi.mock('@/lib/engagements', async (orig) => ({
  // isFallbackTitle stays REAL — it decides whether a card's words are sent.
  isFallbackTitle: ((await orig()) as any).isFallbackTitle,
  attachToEngagement: vi.fn(async () => {}),
}))
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
const NEW_GID = gid('Client', '999000')

const baseLead = (over: any = {}) => ({
  id: 'lead-1',
  location_id: 'loc_test',
  location_uuid: 'loc-uuid-1',
  name: 'Martha Wassel',
  first_name: 'Martha',
  last_name: 'Wassel',
  email: 'martha@x.com',
  phone: '4235550100',
  addresses: [],
  address: null,
  project_type: 'Pantry',
  request_details: 'Wants shelving.',
  source: null,
  jobber_client_id: null,
  jobber_property_id: null,
  jobber_request_id: null,
  jobber_assessment_id: null,
  jobber_job_id: null,
  ...over,
})

function chainFor(row: any) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'update']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: any) => resolve({ data: row, error: null })
  return chain
}

function wire(lead: any, linkedNode: any = null, engagement: any = null) {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor({ id: 'u1', role: 'super_admin', location_id: null })),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(lead)
    if (table === 'engagements') return chainFor(engagement)
    if (table === 'locations') {
      return chainFor({
        id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test Location',
        timezone: 'America/New_York', jobber_access_token: 'tok',
        lifecycle_status: 'active', subscription_status: 'active',
      })
    }
    return chainFor(null)
  })
  ;(jobberGraphQL as any).mockImplementation(async (_loc: string, query: string) => {
    if (query.includes('GetClientById')) return { data: { client: linkedNode } }
    if (query.includes('FindClient')) return { data: { clients: { nodes: [] } } }
    if (query.includes('GetClientProperties')) return { data: { client: { clientProperties: { nodes: [] } } } }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`)
  })
  ;(jobberMutation as any).mockImplementation(async (_loc: string, mutation: string, vars: any) => {
    if (mutation.includes('clientEdit')) return { data: { clientEdit: { client: { id: vars.clientId } } } }
    if (mutation.includes('clientCreate')) return { data: { clientCreate: { client: { id: NEW_GID } } } }
    if (mutation.includes('requestCreate')) return { data: { requestCreate: { request: { id: gid('Request', '77') } } } }
    throw new Error(`unexpected mutation: ${mutation.slice(0, 60)}`)
  })
}

async function send(extra: Record<string, any> = {}) {
  const req: any = new Request('http://test/api/leads/lead-1/send-to-jobber', {
    method: 'POST',
    body: JSON.stringify({ creation_type: 'request_only', ...extra }),
    headers: { 'Content-Type': 'application/json' },
  })
  req.nextUrl = new URL('http://test/api/leads/lead-1/send-to-jobber')
  const res = await POST(req, { params: Promise.resolve({ id: 'lead-1' }) } as any)
  expect(res.status).toBe(200)
}

const mutationInputs = (name: string) =>
  (jobberMutation as any).mock.calls.filter((c: any[]) => (c[1] as string).includes(name)).map((c: any[]) => c[2])

// The request Jobber actually received, and the items of its details form.
const requestInput = () => {
  const calls = mutationInputs('requestCreate')
  expect(calls).toHaveLength(1)
  return calls[0].input
}
const formItems = () => requestInput().requestDetails?.form?.sections?.[0]?.items ?? []
const sourceLine = () => formItems().find((i: any) => i.label === 'Source')

const linkedNode = () => ({
  id: LINKED_GID, firstName: 'Martha', lastName: 'Wassel', companyName: null,
  emails: [{ id: 'em-1', address: 'martha@x.com', primary: true }],
  phones: [{ id: 'ph-1', number: '423-555-0100', primary: true }],
})

beforeEach(() => { vi.clearAllMocks() })

describe("send-to-jobber — the lead's source reaches Jobber", () => {
  it('NEW client: the request carries a Source line with the lead\'s source', async () => {
    wire(baseLead({ source: 'Google' }))
    await send()
    expect(mutationInputs('clientCreate')).toHaveLength(1)
    expect(sourceLine()).toEqual({ label: 'Source', answerText: 'Google' })
  })

  it('EXISTING Jobber client: still gets the Source line in the request details', async () => {
    // Their own source field in Jobber can't be edited (ClientEditInput has
    // none) — the line on the request is the only place it can go.
    wire(baseLead({ source: 'Referral', jobber_client_id: LINKED_ID }), linkedNode())
    await send()
    expect(mutationInputs('clientCreate')).toHaveLength(0)
    expect(requestInput().clientId).toBe(LINKED_GID)
    expect(sourceLine()).toEqual({ label: 'Source', answerText: 'Referral' })
  })

  it("a send riding a CARD carries the card's words AND the lead's source", async () => {
    // The card supplies what the job is; the source is how the client found
    // us, so it comes from the lead whichever card is sent.
    wire(
      baseLead({ source: 'Google', jobber_client_id: LINKED_ID }),
      linkedNode(),
      { id: 'eng-1', client_id: 'lead-1', stage: 'New', title: 'Bedroom closet', description: 'Second job.', project_type: 'Closet' },
    )
    await send({ engagement_id: 'eng-1' })
    expect(formItems()).toEqual([
      { label: 'Type of Project', answerText: 'Closet' },
      { label: 'Additional Comments/Questions', answerText: 'Bedroom closet\n\nSecond job.' },
      { label: 'Source', answerText: 'Google' },
    ])
  })

  it('a lead with NO source sends blank — no Source line, no default', async () => {
    wire(baseLead({ source: null }))
    await send()
    expect(sourceLine()).toBeUndefined()
    // the rest of the form is still there
    expect(formItems().map((i: any) => i.label)).toEqual(['Type of Project', 'Additional Comments/Questions'])
    expect(JSON.stringify(mutationInputs('requestCreate'))).not.toContain('Website')
  })

  it('whitespace-only source is blank too', async () => {
    wire(baseLead({ source: '   ' }))
    await send()
    expect(sourceLine()).toBeUndefined()
  })

  it('no source and nothing else to say → no details form at all', async () => {
    wire(baseLead({ source: null, project_type: null, request_details: null }))
    await send()
    expect(requestInput()).not.toHaveProperty('requestDetails')
  })

  it('a source alone is enough to send the form', async () => {
    wire(baseLead({ source: 'Yelp', project_type: null, request_details: null }))
    await send()
    expect(formItems()).toEqual([{ label: 'Source', answerText: 'Yelp' }])
  })

  it('the value is tidied on the way out: ig → Instagram, an old form slug → Website', async () => {
    wire(baseLead({ source: 'ig' }))
    await send()
    expect(sourceLine()).toEqual({ label: 'Source', answerText: 'Instagram' })

    vi.clearAllMocks()
    wire(baseLead({ source: 'seattle_assessment' }))
    await send()
    expect(sourceLine()).toEqual({ label: 'Source', answerText: 'Website' })
    expect(JSON.stringify(mutationInputs('requestCreate'))).not.toContain('seattle_assessment')
  })

  it("an owner's own label goes over exactly as typed", async () => {
    wire(baseLead({ source: 'Hershey Mills Ads' }))
    await send()
    expect(sourceLine()).toEqual({ label: 'Source', answerText: 'Hershey Mills Ads' })
  })

  it('never tries to write the request\'s own source field (Jobber has no such input)', async () => {
    wire(baseLead({ source: 'Google' }))
    await send()
    expect(requestInput()).not.toHaveProperty('source')
  })
})
