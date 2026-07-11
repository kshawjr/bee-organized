// @vitest-environment node
//
// PATCH /api/leads/[id] — contact-change AUDIT TRAIL (2026-07-10).
// Mirrors the stage_change auto-log for phone/email edits:
//
//   - one lead-level touchpoint per REAL change; kind 'system' with
//     method null (the touchpoints_kind_check vocabulary has no
//     contact_change value and migrations are SQL-editor-only — the
//     label carries the message, which is exactly what NotesStream and
//     Timeline render for method-less rows)
//   - label 'Phone updated → <new>' / 'Phone removed'; the OLD value
//     is retained in notes ('was <old>')
//   - the normalized compare is the SAME normalization diffContactPatch
//     uses: a formatting-only reformat writes NO entry, exactly as it
//     fires no Jobber mutation (beta-lead-edit-contact-sync pins that
//     half)
//   - inserted rows ride the response as contact_activity so open cards
//     prepend them into Recent activity without a refetch
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

let leadRow: any
let touchpointInserts: any[] = []

const baseLead = () => ({
  id: 'lead-1',
  location_id: 'loc_palmbeach',
  location_uuid: 'loc-uuid-1',
  stage: 'Nurturing',
  name: 'Ankur Patel',
  email: 'ankur@beeorganized.com',
  phone: '555-000-9999',
  jobber_client_id: null, // audit trail is Jobber-independent; sync tests live elsewhere
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

// touchpoints chain: records the insert payload and echoes it back from
// .single() the way PostgREST returns the inserted row.
function touchpointChain() {
  const chain: any = {}
  let inserted: any = null
  chain.insert = vi.fn((payload: any) => { inserted = payload; touchpointInserts.push(payload); return chain })
  chain.select = vi.fn(() => chain)
  chain.single = vi.fn(async () => ({ data: inserted ? { id: `tp-${touchpointInserts.length}`, ...inserted } : null, error: null }))
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
    if (table === 'touchpoints') return touchpointChain()
    return chainFor(() => null)
  })
  ;(updateLead as any).mockImplementation(async (_id: string, patch: any) => {
    Object.assign(leadRow, patch)
  })
}

function patchLead(body: any) {
  const req = new Request('http://test/api/leads/lead-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
  return PATCH(req as any, { params: Promise.resolve({ id: 'lead-1' }) } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  leadRow = baseLead()
  touchpointInserts = []
  wireDb()
})

describe('contact-change audit touchpoint', () => {
  it('real phone change → kind=system, method-less, label carries the new value, notes retains the old', async () => {
    const res = await patchLead({ phone: '(704) 555-0142' })
    const body = await res.json()
    expect(res.status).toBe(200)

    expect(touchpointInserts.length).toBe(1)
    const tp = touchpointInserts[0]
    expect(tp.kind).toBe('system')
    expect(tp.method).toBeUndefined() // method null — NotesStream falls through to the label
    expect(tp.label).toBe('Phone updated → (704) 555-0142')
    expect(tp.notes).toBe('was 555-000-9999')
    expect(tp.lead_id).toBe('lead-1')
    expect(tp.engagement_id).toBeUndefined() // lead-level, like stage_change
    expect(tp.user_id).toBe('u1')

    // The inserted row rides the response for instant Recent-activity prepend.
    expect(body.contact_activity).toHaveLength(1)
    expect(body.contact_activity[0].label).toBe('Phone updated → (704) 555-0142')
  })

  it('email change → its own entry', async () => {
    await patchLead({ email: 'new@example.com' })
    expect(touchpointInserts.length).toBe(1)
    expect(touchpointInserts[0].label).toBe('Email updated → new@example.com')
    expect(touchpointInserts[0].notes).toBe('was ankur@beeorganized.com')
  })

  it('both fields in one PATCH → two entries', async () => {
    await patchLead({ phone: '7045550142', email: 'new@example.com' })
    expect(touchpointInserts.map(t => t.label)).toEqual([
      'Phone updated → 7045550142',
      'Email updated → new@example.com',
    ])
  })

  it("clearing → 'removed' label, old value still retained, and ZERO Jobber calls (write-back never deletes)", async () => {
    leadRow.jobber_client_id = '101'
    const res = await patchLead({ phone: '' })
    const body = await res.json()
    expect(touchpointInserts.length).toBe(1)
    expect(touchpointInserts[0].label).toBe('Phone removed')
    expect(touchpointInserts[0].notes).toBe('was 555-000-9999')
    expect(body.contact_writeback).toBeUndefined()
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('FORMATTING-ONLY edit → save succeeds but NO audit entry (same normalized compare as diffContactPatch)', async () => {
    const res = await patchLead({ phone: '+1 (555) 000-9999' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalled() // the display string still saves
    expect(touchpointInserts).toEqual([])
    expect(body.contact_activity).toBeUndefined()
  })

  it('case-only email edit → no entry either', async () => {
    await patchLead({ email: 'ANKUR@beeorganized.com' })
    expect(touchpointInserts).toEqual([])
  })

  it('non-contact patch (stage) → stage_change touchpoint only, no contact entry', async () => {
    const res = await patchLead({ stage: 'Attempting' })
    expect(res.status).toBe(200)
    expect(touchpointInserts.length).toBe(1)
    expect(touchpointInserts[0].kind).toBe('stage_change')
    expect((await res.json()).contact_activity).toBeUndefined()
  })
})
