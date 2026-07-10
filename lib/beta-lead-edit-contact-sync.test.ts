// @vitest-environment node
//
// Auto-sync phone/email to Jobber on lead edit (feedback #2/#4 — Ankur's
// case: an already-jobber-linked client edited in Bee Hub).
//
// d51b764 wired the contact write-back only into send-to-jobber's
// matched-existing path — which a linked lead never passes through again,
// so editing their phone/email in Bee Hub left Jobber stale. Under test:
//
//   * PATCH /api/leads/:id triggers the write-back ONLY when the patch
//     really changes phone/email (digits-only / case-insensitive diff
//     against the stored value — formatting edits don't fire)
//   * the client is fetched BY CLIENT ID (never an email search — the
//     email may be exactly the field being edited)
//   * same rails as the send path: edit primary-else-first, add when
//     none, omit when already present anywhere, never delete
//   * non-fatal: the lead save always succeeds; outcome rides the PATCH
//     response (contact_writeback) + a sync_log breadcrumb
//   * ECHO GUARD: one edit → at most one Jobber mutation. The
//     CLIENT_UPDATE echo writes the lead row directly (upsertLead), never
//     through PATCH; and re-applying the same value is a no-op at both
//     the patch-vs-stored diff and the fetch-at-push diff.
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { diffContactPatch } from '@/lib/jobber-contact-writeback'

// ── unit: patch-vs-stored trigger decision ──────────────────────────────────

describe('diffContactPatch', () => {
  const stored = { phone: '(555) 000-9999', email: 'ankur@beeorganized.com' }

  it('real phone change → returns the new value to push', () => {
    const d = diffContactPatch({ phone: '413-297-8444' }, stored)
    expect(d.phone).toBe('413-297-8444')
    expect(d.email).toBeNull()
    expect(d.changed).toBe(true)
  })

  it('formatting-only phone edit → no trigger', () => {
    expect(diffContactPatch({ phone: '+1 (555) 000-9999' }, stored).changed).toBe(false)
    expect(diffContactPatch({ phone: '555.000.9999' }, stored).changed).toBe(false)
  })

  it('clearing a field never triggers (we never delete Jobber-side data)', () => {
    expect(diffContactPatch({ phone: '' }, stored).changed).toBe(false)
    expect(diffContactPatch({ phone: null }, stored).changed).toBe(false)
    expect(diffContactPatch({ email: '' }, stored).changed).toBe(false)
  })

  it('case-only email edit → no trigger; real change → trigger', () => {
    expect(diffContactPatch({ email: 'Ankur@BeeOrganized.com' }, stored).changed).toBe(false)
    const d = diffContactPatch({ email: 'new@example.com' }, stored)
    expect(d.email).toBe('new@example.com')
    expect(d.changed).toBe(true)
  })

  it('non-contact patches never trigger', () => {
    expect(diffContactPatch({ stage: 'Nurturing', notes: 'x' }, stored).changed).toBe(false)
    expect(diffContactPatch({}, stored).changed).toBe(false)
  })
})

// ── route: PATCH /api/leads/[id] wiring ─────────────────────────────────────

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: vi.fn() },
}))
vi.mock('@/lib/dual-write', () => ({
  updateLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-send', () => ({
  sendDripStep: vi.fn(async () => {}),
}))
vi.mock('@/lib/people-mapper', () => ({
  mapLeadToPerson: vi.fn(() => ({})),
}))
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: vi.fn(),
  jobberMutation: vi.fn(),
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: vi.fn(async () => {}),
}))

import { PATCH } from '@/app/api/leads/[id]/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { updateLead } from '@/lib/dual-write'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'
import { writeSyncLog } from '@/lib/sync-log'

const gid = (type: string, n: string) =>
  Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')

// Mutable "DB row" shared across a test. single() hands out COPIES so the
// route's `existing` snapshot isn't retroactively mutated when updateLead
// applies the patch.
let leadRow: any

const baseLead = () => ({
  id: 'lead-1',
  location_id: 'loc_palmbeach',
  location_uuid: 'loc-uuid-1',
  stage: 'Nurturing',
  name: 'Ankur Patel',
  first_name: 'Ankur',
  last_name: 'Patel',
  email: 'ankur@beeorganized.com',
  phone: '555-000-9999',
  jobber_client_id: '101',
})

function chainFor(rowRef: () => any) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'update', 'insert']) chain[m] = vi.fn(() => chain)
  chain.single = vi.fn(async () => {
    const row = rowRef()
    return { data: row ? { ...row } : null, error: row ? null : { message: 'not found' } }
  })
  chain.maybeSingle = chain.single
  chain.then = (resolve: any) => resolve({ data: null, error: null })
  return chain
}

function wireDb() {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => chainFor(() => ({ id: 'u1', role: 'super_admin', location_id: null }))),
  })
  ;(supabaseService.from as any).mockImplementation((table: string) => {
    if (table === 'leads') return chainFor(() => leadRow)
    return chainFor(() => null)
  })
  // Simulate persistence so multi-PATCH sequences see prior saves.
  ;(updateLead as any).mockImplementation(async (_id: string, patch: any) => {
    Object.assign(leadRow, patch)
  })
}

function wireJobber({
  clientPhones = [{ id: 'ph-1', number: '555-000-9999', primary: true }],
  clientEmails = [{ id: 'em-1', address: 'ankur@beeorganized.com', primary: true }],
  fetchResult = null as any,
  editResult = { data: { clientEdit: { client: { id: gid('Client', '101') } } } } as any,
} = {}) {
  ;(jobberGraphQL as any).mockResolvedValue(
    fetchResult ?? {
      data: { client: { id: gid('Client', '101'), phones: clientPhones, emails: clientEmails } },
    },
  )
  ;(jobberMutation as any).mockResolvedValue(editResult)
}

function patchLead(body: any) {
  const req = new Request('http://test/api/leads/lead-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
  return PATCH(req as any, { params: Promise.resolve({ id: 'lead-1' }) } as any)
}

describe('PATCH /api/leads/[id] — contact write-back trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    leadRow = baseLead()
    wireDb()
    wireJobber()
  })

  it('real phone change on a jobber-linked lead → one by-id fetch + one clientEdit; response reports updated', async () => {
    const res = await patchLead({ phone: '4132978444' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.lead).toBeDefined()
    expect(body.contact_writeback).toEqual({ phone: 'updated', email: 'unchanged' })

    // Fetch is BY CLIENT ID — never the send path's email search.
    expect(jobberGraphQL).toHaveBeenCalledTimes(1)
    const [, query, vars] = (jobberGraphQL as any).mock.calls[0]
    expect(query).toContain('GetClientContacts')
    expect(query).not.toContain('searchTerm')
    expect(vars).toEqual({ clientId: gid('Client', '101') })

    expect(jobberMutation).toHaveBeenCalledTimes(1)
    const [, mutation, mvars] = (jobberMutation as any).mock.calls[0]
    expect(mutation).toContain('clientEdit')
    expect(mvars.input.phonesToEdit).toEqual([{ id: 'ph-1', number: '4132978444' }])
    expect(mvars.input.emailsToEdit).toBeUndefined()
    expect(mvars.input.emailsToAdd).toBeUndefined()
    expect(Object.keys(mvars.input)).not.toContain('phonesToDelete')
    // Contact-only edit — the lead-edit trigger never refreshes names.
    expect(mvars.input.firstName).toBeUndefined()
  })

  it('email change → emailsToEdit targeting the fetched id', async () => {
    const res = await patchLead({ email: 'new@example.com' })
    const body = await res.json()

    expect(body.contact_writeback).toEqual({ phone: 'unchanged', email: 'updated' })
    const [, , mvars] = (jobberMutation as any).mock.calls[0]
    expect(mvars.input.emailsToEdit).toEqual([{ id: 'em-1', address: 'new@example.com' }])
    expect(mvars.input.phonesToEdit).toBeUndefined()
  })

  it('formatting-only phone edit → save succeeds, ZERO Jobber calls, no contact_writeback', async () => {
    const res = await patchLead({ phone: '+1 (555) 000-9999' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalled()
    expect(body.contact_writeback).toBeUndefined()
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('non-contact patch (stage) → zero Jobber calls', async () => {
    const res = await patchLead({ stage: 'Attempting' })
    expect(res.status).toBe(200)
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('lead without jobber_client_id → zero Jobber calls', async () => {
    leadRow.jobber_client_id = null
    const res = await patchLead({ phone: '4132978444' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.contact_writeback).toBeUndefined()
    expect(jobberGraphQL).not.toHaveBeenCalled()
  })

  it('ECHO GUARD: one edit converges to exactly one Jobber mutation', async () => {
    // 1. User edits the phone → one clientEdit.
    await patchLead({ phone: '4132978444' })
    expect(jobberMutation).toHaveBeenCalledTimes(1)

    // 2. Jobber fires CLIENT_UPDATE back at us. handleClientUpdate applies
    //    it via upsertLead — a DIRECT DB write that never passes through
    //    this route, so the trigger can't re-fire. Simulate its effect:
    //    Jobber's (reformatted) copy of the number lands on the lead row.
    leadRow.phone = '(413) 297-8444'

    // 3. Any subsequent save of the same number (UI re-save, echo-shaped
    //    PATCH) is equal after normalization → no fetch, no mutation.
    const res = await patchLead({ phone: '413.297.8444' })
    expect(res.status).toBe(200)
    expect(jobberMutation).toHaveBeenCalledTimes(1) // still just the original
    expect(jobberGraphQL).toHaveBeenCalledTimes(1)
  })

  it('ECHO GUARD: stored value stale but Jobber already carries the number → fetch happens, zero mutations', async () => {
    // e.g. the CLIENT_UPDATE echo hasn't landed locally yet, or the value
    // was added Jobber-side: patch-vs-stored says changed, fetch-at-push
    // diff says already there → converge without a mutation.
    wireJobber({
      clientPhones: [{ id: 'ph-1', number: '+1 (413) 297-8444', primary: true }],
    })
    const res = await patchLead({ phone: '4132978444' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.contact_writeback).toEqual({ phone: 'unchanged', email: 'unchanged' })
    expect(jobberGraphQL).toHaveBeenCalledTimes(1)
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('client fetch fails (e.g. no valid token) → save still succeeds, writeback reports failed', async () => {
    wireJobber({ fetchResult: { errors: [{ message: 'no_valid_jobber_token' }] } })
    const res = await patchLead({ phone: '4132978444' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.lead).toBeDefined()
    expect(updateLead).toHaveBeenCalled()
    expect(body.contact_writeback).toEqual({ phone: 'failed', email: 'unchanged' })
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('clientEdit userErrors → save still succeeds, attempted field reports failed', async () => {
    wireJobber({ editResult: { userErrors: [{ message: 'phone rejected' }] } })
    const res = await patchLead({ phone: '4132978444' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.contact_writeback).toEqual({ phone: 'failed', email: 'unchanged' })
  })

  it('writes a sync_log breadcrumb: entity_type client, lead uuid, contact= outcome, no topic= token', async () => {
    await patchLead({ phone: '4132978444' })

    expect(writeSyncLog).toHaveBeenCalledTimes(1)
    const entry = (writeSyncLog as any).mock.calls[0][0]
    expect(entry.entity_type).toBe('client')
    expect(entry.entity_id).toBe('lead-1')
    expect(entry.direction).toBe('outbound')
    expect(entry.jobber_record_id).toBe('101')
    expect(entry.status).toBe('success')
    expect(entry.message).toContain('contact=phone:updated,email:unchanged')
    expect(entry.message).not.toContain('topic=')
  })
})
