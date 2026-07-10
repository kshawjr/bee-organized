// @vitest-environment node
//
// Jobber phone/email write-back on send-to-jobber (feedback #2/#4).
//
// Matched-existing clients used to get NO contact updates: ClientEditInput
// requires phonesToEdit/emailsToEdit keyed by EncodedIds we never stored, so
// the route skipped the fields and Jobber kept stale phone/email (texting
// from Jobber lacked the number — feedback #4).
//
// Fix under test — fetch-at-push, no stored ids, never delete:
//   * FIND_CLIENT_QUERY returns emails/phones WITH ids
//   * buildContactEditFields diffs lead vs client (digits-only phones,
//     case-insensitive emails): differing → *ToEdit on the primary (else
//     first) entry's id; none → *ToAdd primary; equal → field omitted
//   * NEVER emits *ToDelete, never touches non-primary entries
//   * clientEdit userErrors stay non-fatal: the send still succeeds, the
//     response's contact_writeback reports the attempted fields 'failed'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  normalizePhoneDigits,
  buildContactEditFields,
  resolveContactWriteback,
} from '@/lib/jobber-contact-writeback'

// ── unit: phone normalization ───────────────────────────────────────────────

describe('normalizePhoneDigits', () => {
  it('strips formatting to bare digits', () => {
    expect(normalizePhoneDigits('(413) 297-8444')).toBe('4132978444')
  })
  it('treats a US +1 prefix as formatting, not identity', () => {
    expect(normalizePhoneDigits('+1 413-297-8444')).toBe('4132978444')
    expect(normalizePhoneDigits('14132978444')).toBe('4132978444')
  })
  it('leaves non-US-shaped numbers alone', () => {
    expect(normalizePhoneDigits('442071234567')).toBe('442071234567')
  })
  it('empty/garbage → empty string', () => {
    expect(normalizePhoneDigits(null)).toBe('')
    expect(normalizePhoneDigits('ext.')).toBe('')
  })
})

// ── unit: diff → ClientEditInput fields ─────────────────────────────────────

const clientWith = (over: any = {}) => ({
  phones: [{ id: 'ph-primary', number: '(555) 111-2222', primary: true }],
  emails: [{ id: 'em-primary', address: 'ankur@beeorganized.com', primary: true }],
  ...over,
})

describe('buildContactEditFields — phone', () => {
  it('differing phone → phonesToEdit targeting the fetched primary id', () => {
    const { fields, plan } = buildContactEditFields(
      { phone: '4132978444', email: '' },
      clientWith(),
    )
    expect(fields.phonesToEdit).toEqual([{ id: 'ph-primary', number: '4132978444' }])
    expect(fields.phonesToAdd).toBeUndefined()
    expect(plan.phone).toBe('edit')
  })

  it('targets the PRIMARY entry over an earlier non-primary one', () => {
    const { fields } = buildContactEditFields(
      { phone: '4132978444', email: '' },
      clientWith({
        phones: [
          { id: 'ph-old', number: '555-000-0000', primary: false },
          { id: 'ph-primary', number: '555-111-2222', primary: true },
        ],
      }),
    )
    expect(fields.phonesToEdit).toEqual([{ id: 'ph-primary', number: '4132978444' }])
  })

  it('no primary flagged → falls back to the first entry', () => {
    const { fields } = buildContactEditFields(
      { phone: '4132978444', email: '' },
      clientWith({ phones: [{ id: 'ph-first', number: '555-000-0000', primary: false }] }),
    )
    expect(fields.phonesToEdit).toEqual([{ id: 'ph-first', number: '4132978444' }])
  })

  it('client has no phones → phonesToAdd as primary', () => {
    const { fields, plan } = buildContactEditFields(
      { phone: '4132978444', email: '' },
      clientWith({ phones: [] }),
    )
    expect(fields.phonesToAdd).toEqual([{ number: '4132978444', primary: true }])
    expect(fields.phonesToEdit).toBeUndefined()
    expect(plan.phone).toBe('add')
  })

  it('formatting-only difference → field omitted entirely', () => {
    const { fields, plan } = buildContactEditFields(
      { phone: '+1 (555) 111-2222', email: '' },
      clientWith(),
    )
    expect(fields.phonesToEdit).toBeUndefined()
    expect(fields.phonesToAdd).toBeUndefined()
    expect(plan.phone).toBe('none')
  })

  it('lead phone already present as a NON-primary entry → omitted (never demote/duplicate)', () => {
    const { fields, plan } = buildContactEditFields(
      { phone: '413.297.8444', email: '' },
      clientWith({
        phones: [
          { id: 'ph-primary', number: '555-111-2222', primary: true },
          { id: 'ph-cell', number: '(413) 297-8444', primary: false },
        ],
      }),
    )
    expect(fields.phonesToEdit).toBeUndefined()
    expect(fields.phonesToAdd).toBeUndefined()
    expect(plan.phone).toBe('none')
  })

  it('empty lead phone → omitted (we never erase Jobber-side data)', () => {
    const { fields, plan } = buildContactEditFields({ phone: '', email: '' }, clientWith())
    expect(fields.phonesToEdit).toBeUndefined()
    expect(fields.phonesToAdd).toBeUndefined()
    expect(plan.phone).toBe('none')
  })
})

describe('buildContactEditFields — email mirror', () => {
  it('differing email → emailsToEdit targeting the fetched primary id', () => {
    const { fields, plan } = buildContactEditFields(
      { phone: '', email: 'new@example.com' },
      clientWith(),
    )
    expect(fields.emailsToEdit).toEqual([{ id: 'em-primary', address: 'new@example.com' }])
    expect(plan.email).toBe('edit')
  })

  it('client has no emails → emailsToAdd as primary', () => {
    const { fields, plan } = buildContactEditFields(
      { phone: '', email: 'new@example.com' },
      clientWith({ emails: [] }),
    )
    expect(fields.emailsToAdd).toEqual([{ address: 'new@example.com', primary: true }])
    expect(plan.email).toBe('add')
  })

  it('case-only difference → field omitted', () => {
    const { fields, plan } = buildContactEditFields(
      { phone: '', email: 'Ankur@BeeOrganized.com' },
      clientWith(),
    )
    expect(fields.emailsToEdit).toBeUndefined()
    expect(fields.emailsToAdd).toBeUndefined()
    expect(plan.email).toBe('none')
  })
})

describe('buildContactEditFields — safety rails', () => {
  it('never emits a *ToDelete key, whatever the diff', () => {
    for (const lead of [
      { phone: '4132978444', email: 'new@example.com' },
      { phone: '', email: '' },
      { phone: '555-111-2222', email: 'ankur@beeorganized.com' },
    ]) {
      const { fields } = buildContactEditFields(lead, clientWith())
      expect(Object.keys(fields)).not.toContain('phonesToDelete')
      expect(Object.keys(fields)).not.toContain('emailsToDelete')
    }
  })
})

// ── unit: outcome mapping ───────────────────────────────────────────────────

describe('resolveContactWriteback', () => {
  it('maps plans to outcomes on success', () => {
    expect(resolveContactWriteback({ phone: 'edit', email: 'none' }, false))
      .toEqual({ phone: 'updated', email: 'unchanged' })
    expect(resolveContactWriteback({ phone: 'add', email: 'add' }, false))
      .toEqual({ phone: 'added', email: 'added' })
  })
  it('userErrors fail ONLY the attempted fields', () => {
    expect(resolveContactWriteback({ phone: 'edit', email: 'none' }, true))
      .toEqual({ phone: 'failed', email: 'unchanged' })
  })
})

// ── route: wiring + non-fatal userErrors ────────────────────────────────────
// Full POST /api/leads/[id]/send-to-jobber run with mocked collaborators.

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: vi.fn() },
}))
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: vi.fn(),
  jobberMutation: vi.fn(),
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))
vi.mock('@/lib/jobber-import', () => ({
  upsertServiceRequest: vi.fn(async () => ({ id: 'sr-db-1' })),
}))
vi.mock('@/lib/engagements', () => ({
  attachToEngagement: vi.fn(async () => {}),
}))

import { POST } from '@/app/api/leads/[id]/send-to-jobber/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'

// The route stores the numeric portion of Jobber's base64 global ids —
// mock nodes must carry realistic encodings for extractJobberId to work.
const gid = (type: string, n: string) =>
  Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')

const LEAD = {
  id: 'lead-1',
  location_id: 'loc_palmbeach',
  location_uuid: 'loc-uuid-1',
  name: 'Richard Baker',
  first_name: 'Richard',
  last_name: 'Baker',
  email: 'rbaker53@aol.com',
  phone: '4132978444',
  addresses: [],
  address: null,
  assigned_to: null,
  jobber_request_id: null,
  jobber_assessment_id: null,
}

// Minimal chainable stub: .select().eq().eq()...maybeSingle()/.single()
// resolve to the row configured per table; .update().eq() resolves
// { error: null }. Enough surface for this route's queries.
function chainFor(row: any) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'update']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: any) => resolve({ data: row, error: null })
  return chain
}

function wireMocks({ clientEditResult }: { clientEditResult: any }) {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor({ id: 'u1', role: 'super_admin', location_id: null })),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(LEAD)
    if (table === 'locations') {
      return chainFor({
        id: 'loc-uuid-1', location_id: 'loc_palmbeach', name: 'Palm Beach',
        timezone: 'America/New_York', jobber_access_token: 'tok',
      })
    }
    return chainFor(null)
  })
  // Search finds a matched client: same email, DIFFERENT phone, ids present.
  ;(jobberGraphQL as any).mockResolvedValue({
    data: {
      clients: {
        nodes: [{
          id: gid('Client', '101'),
          firstName: 'Richard', lastName: 'Baker', companyName: null,
          emails: [{ id: 'em-1', address: 'rbaker53@aol.com', primary: true }],
          phones: [{ id: 'ph-1', number: '555-000-9999', primary: true }],
        }],
      },
    },
  })
  ;(jobberMutation as any).mockImplementation(async (_loc: string, mutation: string) => {
    if (mutation.includes('clientEdit')) return clientEditResult
    if (mutation.includes('requestCreate')) {
      return { data: { requestCreate: { request: { id: gid('Request', '9') } } } }
    }
    throw new Error(`unexpected mutation: ${mutation.slice(0, 60)}`)
  })
}

function postSend() {
  const req: any = new Request('http://test/api/leads/lead-1/send-to-jobber', {
    method: 'POST',
    body: JSON.stringify({ creation_type: 'request_only' }),
    headers: { 'Content-Type': 'application/json' },
  })
  ;(req as any).nextUrl = new URL('http://test/api/leads/lead-1/send-to-jobber')
  return POST(req, { params: Promise.resolve({ id: 'lead-1' }) } as any)
}

describe('send-to-jobber route — contact write-back wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('matched client with differing phone → clientEdit carries phonesToEdit with the fetched id; response reports updated', async () => {
    wireMocks({ clientEditResult: { data: { clientEdit: { client: { id: gid('Client', '101') } } } } })
    const res = await postSend()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.contact_writeback).toEqual({ phone: 'updated', email: 'unchanged' })

    const editCall = (jobberMutation as any).mock.calls.find(
      (c: any[]) => c[1].includes('clientEdit'),
    )
    expect(editCall).toBeDefined()
    expect(editCall[2].input.phonesToEdit).toEqual([{ id: 'ph-1', number: '4132978444' }])
    // matched by this exact email → no email churn
    expect(editCall[2].input.emailsToEdit).toBeUndefined()
    expect(editCall[2].input.emailsToAdd).toBeUndefined()
    expect(Object.keys(editCall[2].input)).not.toContain('phonesToDelete')
  })

  it('clientEdit userErrors → the send still succeeds and writeback reports failed', async () => {
    wireMocks({ clientEditResult: { userErrors: [{ message: 'phone rejected' }] } })
    const res = await postSend()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.jobber_request_id).toBe('9')  // request still created
    expect(body.contact_writeback).toEqual({ phone: 'failed', email: 'unchanged' })
  })
})
