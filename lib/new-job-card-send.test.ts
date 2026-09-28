// @vitest-environment node
//
// Sending a card started in Bee Hub (NewJobWizard, 2026-09-28) — the REAL
// send-to-jobber route, with the card attached (engagement_id). Both endings
// arrive here: "Send to Jobber now" straight after founding, and the unsent
// card's own "Send to Jobber" later. What must hold:
//
//   · the request is created on the client's EXISTING Jobber record — the
//     stored link is read back by id; no search, no clientCreate. That part
//     of the route is fa9dfc1's and is untouched; this proves the card path
//     rides it rather than a second road to Jobber.
//   · the request lands ON the card (attachToEngagement), so the webhook
//     finds it already founded and no second engagement appears.
//   · the request carries what the owner captured — the card's work and
//     what they said — not the lead's request_details, which describe the
//     client's first enquiry.
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
vi.mock('@/lib/engagements', () => ({
  attachToEngagement: vi.fn(async () => ({ attached: true })),
  // the real rule, restated: only fallbackTitle's own shape is "no words"
  isFallbackTitle: (t: unknown) => typeof t === 'string' && /^Engagement – [A-Z][a-z]{2} \d{4}$/.test(t.trim()),
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
import { attachToEngagement } from '@/lib/engagements'

const gid = (type: string, n: string) => Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')
const LINKED_ID = '136289662'
const LINKED_GID = gid('Client', LINKED_ID)

const lead = {
  id: 'lead-1', location_id: 'loc_chattanooga', location_uuid: 'loc-uuid-1',
  name: 'Martha Wassel', first_name: 'Martha', last_name: 'Wassel',
  email: '', phone: '4235550100', addresses: [], address: null,
  jobber_client_id: LINKED_ID, jobber_property_id: null, jobber_request_id: null,
  jobber_assessment_id: null, jobber_job_id: null,
  // The FIRST job's words — must not ride the second job's request.
  request_details: 'Kitchen pantry, wants it before Thanksgiving', project_type: 'Kitchen',
}
const wizardCard = {
  id: 'eng-card', client_id: 'lead-1', stage: 'Request',
  title: 'Primary bedroom closet',
  description: 'Wants it before December. Told her we can assess next week.',
  project_type: null,
}

function chainFor(row: any) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'update']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: any) => resolve({ data: row, error: null })
  return chain
}

function wire(card: any) {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor({ id: 'u1', role: 'super_admin', location_id: null })),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(lead)
    if (table === 'engagements') return chainFor(card)
    if (table === 'locations') return chainFor({
      id: 'loc-uuid-1', location_id: 'loc_chattanooga', name: 'Chattanooga',
      timezone: 'America/New_York', jobber_access_token: 'tok',
      lifecycle_status: 'active', subscription_status: 'active',
    })
    return chainFor(null)
  })
  ;(jobberGraphQL as any).mockImplementation(async (_l: string, q: string) => {
    if (q.includes('GetClientById')) return { data: { client: { id: LINKED_GID, firstName: 'Martha', lastName: 'Wassel', companyName: null, emails: [], phones: [] } } }
    if (q.includes('FindClient')) return { data: { clients: { nodes: [] } } }
    if (q.includes('GetClientProperties')) return { data: { client: { clientProperties: { nodes: [] } } } }
    throw new Error(`unexpected query: ${q.slice(0, 60)}`)
  })
  ;(jobberMutation as any).mockImplementation(async (_l: string, m: string, vars: any) => {
    if (m.includes('clientEdit')) return { data: { clientEdit: { client: { id: vars.clientId } } } }
    if (m.includes('clientCreate')) return { data: { clientCreate: { client: { id: gid('Client', '999000') } } } }
    if (m.includes('requestCreate')) return { data: { requestCreate: { request: { id: gid('Request', '77'), createdAt: new Date().toISOString(), title: 'x', jobberWebUri: 'u' } } } }
    throw new Error(`unexpected mutation: ${m.slice(0, 60)}`)
  })
}

const send = (body: any) => {
  const req: any = new Request('http://test/api/leads/lead-1/send-to-jobber', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  })
  req.nextUrl = new URL('http://test/api/leads/lead-1/send-to-jobber')
  return POST(req, { params: Promise.resolve({ id: 'lead-1' }) } as any)
}
const mutations = (name: string) => (jobberMutation as any).mock.calls.filter((c: any[]) => (c[1] as string).includes(name))
const comments = (input: any) => input.requestDetails?.form.sections[0].items.find((i: any) => /Comments/.test(i.label))?.answerText

beforeEach(() => vi.clearAllMocks())

describe('a card started in Bee Hub goes to Jobber as a proper request', () => {
  it('creates the request on the EXISTING Jobber client — no duplicate client, no search', async () => {
    wire(wizardCard)
    const res = await send({ creation_type: 'request_only', engagement_id: 'eng-card' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(mutations('clientCreate'), 'a linked client must never be re-created').toHaveLength(0)
    expect((jobberGraphQL as any).mock.calls.some((c: any[]) => c[1].includes('FindClient'))).toBe(false)
    const req = mutations('requestCreate')
    expect(req).toHaveLength(1)
    expect(req[0][2].input.clientId).toBe(LINKED_GID)
    expect(body.jobber_client_id).toBe(LINKED_ID)
  })

  it('the request lands ON the card, so no second engagement is founded for it', async () => {
    wire(wizardCard)
    await send({ creation_type: 'request_only', engagement_id: 'eng-card' })
    expect(attachToEngagement).toHaveBeenCalledWith('service_requests', 'sr-db-1', 'eng-card')
  })

  it('the request carries what was captured — the work and what they said — not the first job’s notes', async () => {
    wire(wizardCard)
    await send({ creation_type: 'request_only', engagement_id: 'eng-card' })
    const input = mutations('requestCreate')[0][2].input
    expect(comments(input)).toBe('Primary bedroom closet\n\nWants it before December. Told her we can assess next week.')
    expect(JSON.stringify(input)).not.toContain('Kitchen pantry')
  })

  it('an old hand-made card with only an auto title keeps today’s lead-level form exactly', async () => {
    wire({ ...wizardCard, title: 'Engagement – Sep 2026', description: null })
    await send({ creation_type: 'request_only', engagement_id: 'eng-card' })
    const input = mutations('requestCreate')[0][2].input
    expect(comments(input)).toBe('Kitchen pantry, wants it before Thanksgiving')
  })

  it('a send with no card attached is unchanged (the lead’s own words)', async () => {
    wire(null)
    await send({ creation_type: 'request_only' })
    expect(comments(mutations('requestCreate')[0][2].input)).toBe('Kitchen pantry, wants it before Thanksgiving')
    expect(attachToEngagement).not.toHaveBeenCalled()
  })

  it('the mock’s fallback-title rule is the real one', async () => {
    const { isFallbackTitle: realIsFallbackTitle } = await vi.importActual<any>('@/lib/engagements')
    for (const t of ['Engagement – Sep 2026', '  Engagement – Jan 2025 ']) expect(realIsFallbackTitle(t)).toBe(true)
    for (const t of ['Primary bedroom closet', 'Enquiry — No response', 'Website enquiry']) expect(realIsFallbackTitle(t)).toBe(false)
  })
})
