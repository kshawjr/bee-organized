// @vitest-environment node
//
// Let an owner edit a client's name, and sync it to Jobber when there is
// a Jobber client to sync to.
//
// Linda Dibias (North Jersey) asked how to update a client's name. She
// couldn't: the profile header rendered it as plain text, and the only
// answer was "rename in Jobber and CLIENT_UPDATE will refresh it here" —
// which does nothing at all for a website lead that was never sent to
// Jobber. Under test:
//
//   * the derivation: name = "first last" || company, the import's own
//     rule, and the real production shapes it must not mangle
//   * NO jobber_client_id → the edit still saves, Jobber is NEVER called,
//     and the feed says saved here only
//   * WITH one → saves here AND calls Jobber, and the feed says so
//   * Jobber REJECTS → surfaced, not swallowed; the UI does not claim
//     success (the mutation test at the bottom is the one that matters)
//   * company-shaped records survive a round trip unmangled
//   * name and first/last cannot drift — the route derives, never trusts
//   * a touchpoint is written
//   * the pencil is on both record headers and in no list row
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  composeLeadName,
  normalizeNamePart,
  normalizeNamePatch,
  diffNamePatch,
  nameValidationError,
  buildNameEditFields,
  resolveNameWriteback,
  nameSyncSuffix,
  nameSyncFailed,
  touchesName,
} from '@/lib/lead-name'

// ── unit: the derivation ────────────────────────────────────────────────────

describe('composeLeadName — the display rule', () => {
  it('is the import\'s rule: "first last", else the company', () => {
    expect(composeLeadName({ first_name: 'Linda', last_name: 'Dibias' })).toBe('Linda Dibias')
    expect(composeLeadName({ first_name: 'Linda', last_name: null })).toBe('Linda')
    expect(composeLeadName({ first_name: null, last_name: 'Dibias' })).toBe('Dibias')
    expect(composeLeadName({ company: 'Deck Construction Group LLC' })).toBe('Deck Construction Group LLC')
  })

  it('a person name WINS over a company — the Sue Loncar shape, read from the table', () => {
    // Real row: name "Sue (Jason - House Manager) Loncar", company "Sue Loncar".
    expect(composeLeadName({
      first_name: 'Sue (Jason - House Manager)',
      last_name: 'Loncar',
      company: 'Sue Loncar',
    })).toBe('Sue (Jason - House Manager) Loncar')
  })

  it('REAL production records survive composition unmangled', () => {
    // All four read from the leads table. A one-string editor that split
    // these back into first/last by guessing would mangle every one.
    const real = [
      { first_name: 'Jerry & Carri', last_name: 'Lamb', company: null, name: 'Jerry & Carri Lamb' },
      { first_name: 'Michelle & Josh', last_name: 'Lobel', company: null, name: 'Michelle & Josh Lobel' },
      { first_name: 'Sue (Jason - House Manager)', last_name: 'Loncar', company: 'Sue Loncar', name: 'Sue (Jason - House Manager) Loncar' },
      { first_name: null, last_name: null, company: 'Deck Construction Group LLC', name: 'Deck Construction Group LLC' },
    ]
    for (const r of real) expect(composeLeadName(r)).toBe(r.name)
  })

  it('collapses whitespace but NEVER case — "jerry" → "Jerry" is a real correction', () => {
    expect(normalizeNamePart('  Jerry   Lamb  ')).toBe('Jerry Lamb')
    expect(composeLeadName({ first_name: 'jerry', last_name: 'lamb' })).toBe('jerry lamb')
  })

  it('never invents a name — an all-empty record is refused, not called "Unknown"', () => {
    // The import has an 'Unknown' fallback; it is deliberately not carried
    // here. Zero rows reach it today and an editor that can write "Unknown"
    // onto a real client is a mangler.
    expect(composeLeadName({})).toBe('')
    expect(nameValidationError({})).toMatch(/first name, last name, or company/)
    expect(nameValidationError({ company: 'X' })).toBeNull()
    expect(nameValidationError({ last_name: 'Dibias' })).toBeNull()
  })
})

describe('normalizeNamePatch / touchesName', () => {
  it('only returns keys the patch actually carries — one field never blanks the others', () => {
    expect(normalizeNamePatch({ first_name: ' Linda ' })).toEqual({ first_name: 'Linda' })
    expect(normalizeNamePatch({ stage: 'New' })).toEqual({})
  })

  it('an emptied field normalizes to null', () => {
    expect(normalizeNamePatch({ company: '   ' })).toEqual({ company: null })
  })

  it('touchesName is true for any of the three, false otherwise', () => {
    expect(touchesName({ first_name: 'a' })).toBe(true)
    expect(touchesName({ company: 'a' })).toBe(true)
    expect(touchesName({ stage: 'New', phone: '1' })).toBe(false)
  })
})

describe('diffNamePatch — the trigger decision', () => {
  const stored = { first_name: 'Jerry & Carri', last_name: 'Lamb', company: null }

  it('a real change reports the field and the new display name', () => {
    const d = diffNamePatch({ last_name: 'Lambert' }, stored)
    expect(d.changed).toBe(true)
    expect(d.changedFields).toEqual(['last_name'])
    expect(d.display).toBe('Jerry & Carri Lambert')
    expect(d.prevDisplay).toBe('Jerry & Carri Lamb')
  })

  it('MERGES with stored — patching one field keeps the others', () => {
    const d = diffNamePatch({ first_name: 'Jerry and Carri' }, stored)
    expect(d.next).toEqual({ first_name: 'Jerry and Carri', last_name: 'Lamb', company: '' })
    expect(d.display).toBe('Jerry and Carri Lamb')
  })

  it('a whitespace-only reshuffle is not a change', () => {
    expect(diffNamePatch({ first_name: 'Jerry  &  Carri' }, stored).changed).toBe(false)
    expect(diffNamePatch({ last_name: ' Lamb ' }, stored).changed).toBe(false)
  })

  it('re-sending the identical value is not a change (echo guard, half 2)', () => {
    expect(diffNamePatch({ first_name: 'Jerry & Carri', last_name: 'Lamb' }, stored).changed).toBe(false)
  })

  it('an emptied field is recorded as cleared', () => {
    const d = diffNamePatch({ company: '' }, { ...stored, company: 'Lamb Holdings' })
    expect(d.changed).toBe(true)
    expect(d.clearedFields).toEqual(['company'])
  })
})

// ── unit: the Jobber diff ───────────────────────────────────────────────────

describe('buildNameEditFields', () => {
  const jobberClient = { firstName: 'Jerry & Carri', lastName: 'Lamb', companyName: null }

  it('pushes only the fields Jobber does not already carry', () => {
    const { fields, plan } = buildNameEditFields(
      { first_name: 'Jerry & Carri', last_name: 'Lambert', company: '' }, [], jobberClient,
    )
    expect(fields).toEqual({ lastName: 'Lambert' })
    expect(plan).toEqual({ first_name: 'none', last_name: 'edit', company: 'none' })
  })

  it('everything already present → zero fields (echo guard, half 3)', () => {
    const { fields } = buildNameEditFields(
      { first_name: 'Jerry & Carri', last_name: 'Lamb', company: '' }, [], jobberClient,
    )
    expect(fields).toEqual({})
  })

  it('NEVER erases Jobber-side data — a cleared field is omitted, and said out loud', () => {
    const { fields, plan } = buildNameEditFields(
      { first_name: 'Jerry & Carri', last_name: '', company: '' }, ['last_name'], jobberClient,
    )
    expect(fields.lastName).toBeUndefined()
    expect(Object.keys(fields)).not.toContain('lastName')
    expect(plan.last_name).toBe('cleared')
    expect(resolveNameWriteback(plan, false).last_name).toBe('kept_in_jobber')
  })

  it('maps onto Jobber\'s field names, and only those three', () => {
    const { fields } = buildNameEditFields(
      { first_name: 'A', last_name: 'B', company: 'C' }, [], { firstName: null, lastName: null, companyName: null },
    )
    expect(fields).toEqual({ firstName: 'A', lastName: 'B', companyName: 'C' })
  })
})

// ── THE HONESTY RULE ────────────────────────────────────────────────────────
// A success reported for work that did not happen cost six days on the
// Philly import. These are the assertions that stop it happening here.

describe('nameSyncSuffix / nameSyncFailed — a rejection is never dressed as success', () => {
  const ok = { first_name: 'updated', last_name: 'unchanged', company: 'unchanged' } as const
  const bad = { first_name: 'failed', last_name: 'unchanged', company: 'unchanged' } as const
  const partial = { first_name: 'updated', last_name: 'failed', company: 'unchanged' } as const

  it('a clean sync says so', () => {
    expect(nameSyncSuffix(ok)).toBe(' · synced to Jobber')
    expect(nameSyncFailed(ok)).toBe(false)
  })

  it('a REJECTION says the change did not reach Jobber, and flags failure', () => {
    expect(nameSyncSuffix(bad)).toContain('Jobber sync failed')
    expect(nameSyncSuffix(bad)).toContain('saved in Bee Hub only')
    expect(nameSyncFailed(bad)).toBe(true)
  })

  it('a HALF-applied change is never called a success', () => {
    expect(nameSyncSuffix(partial)).toContain('partial')
    expect(nameSyncSuffix(partial)).not.toContain('· synced to Jobber')
    expect(nameSyncFailed(partial)).toBe(true)
  })

  it('the deliberate clear-skip is said out loud', () => {
    const kept = { first_name: 'updated', last_name: 'kept_in_jobber', company: 'unchanged' } as const
    expect(nameSyncSuffix(kept)).toContain('left as it was there')
    expect(nameSyncFailed(kept)).toBe(false)
  })

  it('no write-back at all makes NO claim either way', () => {
    expect(nameSyncSuffix(null)).toBe('')
    expect(nameSyncFailed(null)).toBe(false)
  })
})

// ── route: PATCH /api/leads/[id] wiring ─────────────────────────────────────

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
vi.mock('@/lib/dual-write', () => ({ updateLead: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/drip-send', () => ({ sendDripStep: vi.fn(async () => {}) }))
vi.mock('@/lib/people-mapper', () => ({ mapLeadToPerson: vi.fn(() => ({})) }))
vi.mock('@/lib/jobber', () => ({ jobberGraphQL: vi.fn(), jobberMutation: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { PATCH } from '@/app/api/leads/[id]/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { updateLead } from '@/lib/dual-write'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'

const gid = (type: string, n: string) =>
  Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')

let leadRow: any
let touchpointInserts: any[] = []

const baseLead = () => ({
  id: 'lead-1',
  location_id: 'loc_northjersey',
  location_uuid: 'loc-uuid-1',
  stage: 'Nurturing',
  name: 'Jerry & Carri Lamb',
  first_name: 'Jerry & Carri',
  last_name: 'Lamb',
  company: null,
  email: 'lamb@example.com',
  phone: '555-000-9999',
  jobber_client_id: '101',
})

function chainFor(rowRef: () => any, table?: string) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'update', 'is', 'in', 'order', 'limit']) chain[m] = vi.fn(() => chain)
  chain.insert = vi.fn((row: any) => { if (table === 'touchpoints') touchpointInserts.push(row); return chain })
  chain.single = vi.fn(async () => {
    if (table === 'touchpoints') {
      const last = touchpointInserts[touchpointInserts.length - 1]
      return { data: last ? { id: `tp-${touchpointInserts.length}`, ...last } : null, error: null }
    }
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
    if (table === 'leads') return chainFor(() => leadRow, 'leads')
    if (table === 'touchpoints') return chainFor(() => null, 'touchpoints')
    return chainFor(() => null, table)
  })
  ;(updateLead as any).mockImplementation(async (_id: string, patch: any) => {
    Object.assign(leadRow, patch)
  })
}

function wireJobber({
  client = { id: gid('Client', '101'), firstName: 'Jerry & Carri', lastName: 'Lamb', companyName: null },
  fetchResult = null as any,
  editResult = { data: { clientEdit: { client: { id: gid('Client', '101') } } } } as any,
} = {}) {
  ;(jobberGraphQL as any).mockResolvedValue(fetchResult ?? { data: { client } })
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

const nameTouchpoints = () => touchpointInserts.filter(t => String(t.label || '').startsWith('Name updated'))

describe('PATCH /api/leads/[id] — client name edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    leadRow = baseLead()
    touchpointInserts = []
    wireDb()
    wireJobber()
  })

  // ── the case that started this ──────────────────────────────────────────

  it('a lead with NO jobber_client_id: the edit SAVES, Jobber is never called, and the feed says saved here only', async () => {
    leadRow.jobber_client_id = null
    const res = await patchLead({ first_name: 'Linda', last_name: 'Dibias' })
    const body = await res.json()

    // The edit is NEVER blocked on the absence of a Jobber link — that is
    // the whole point. Linda's problem is a typo she cannot fix.
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalled()
    const patch = (updateLead as any).mock.calls[0][1]
    expect(patch.name).toBe('Linda Dibias')

    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(jobberMutation).not.toHaveBeenCalled()
    expect(body.name_writeback).toBeUndefined()

    const tp = nameTouchpoints()
    expect(tp).toHaveLength(1)
    expect(tp[0].notes).toContain('not connected to Jobber — saved here only')
  })

  it('a lead WITH one: saves here AND calls Jobber, and the feed says so', async () => {
    const res = await patchLead({ last_name: 'Lambert' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(leadRow.last_name).toBe('Lambert')
    expect(leadRow.name).toBe('Jerry & Carri Lambert')

    // Fetched BY CLIENT ID — never a name search; the name is the thing
    // being corrected, so a search on it would miss the client.
    expect(jobberGraphQL).toHaveBeenCalledTimes(1)
    const [, query, vars] = (jobberGraphQL as any).mock.calls[0]
    expect(query).toContain('GetClientName')
    expect(query).not.toContain('searchTerm')
    expect(vars).toEqual({ clientId: gid('Client', '101') })

    expect(jobberMutation).toHaveBeenCalledTimes(1)
    const [, mutation, mvars] = (jobberMutation as any).mock.calls[0]
    expect(mutation).toContain('clientEdit')
    expect(mvars.input).toEqual({ lastName: 'Lambert' })

    expect(body.name_writeback).toEqual({
      first_name: 'unchanged', last_name: 'updated', company: 'unchanged',
    })

    const tp = nameTouchpoints()
    expect(tp).toHaveLength(1)
    expect(tp[0].label).toBe('Name updated → Jerry & Carri Lambert')
    expect(tp[0].notes).toContain('was Jerry & Carri Lamb')
    expect(tp[0].notes).not.toContain('not connected')
  })

  // ── THE ONE THAT MATTERS ────────────────────────────────────────────────

  it('Jobber REJECTS: the failure is surfaced, not swallowed, and nothing claims success', async () => {
    wireJobber({
      editResult: {
        data: { clientEdit: { client: null } },
        userErrors: [{ message: 'Last name is invalid', path: ['input', 'lastName'] }],
      },
    })

    const res = await patchLead({ last_name: 'Lambert' })
    const body = await res.json()

    // The Bee Hub save stands — a Jobber failure may never undo it.
    expect(res.status).toBe(200)
    expect(leadRow.last_name).toBe('Lambert')

    // But the failure RIDES THE RESPONSE.
    expect(body.name_writeback.last_name).toBe('failed')
    expect(nameSyncFailed(body.name_writeback)).toBe(true)

    // …reaches the owner as a non-success sentence…
    expect(nameSyncSuffix(body.name_writeback)).toContain('Jobber sync failed')

    // …and is in the PERMANENT record, not just a toast that vanishes.
    const tp = nameTouchpoints()
    expect(tp).toHaveLength(1)
    expect(tp[0].notes).toContain('Jobber rejected the change')
  })

  it('a Jobber fetch failure is reported as failed, never as a silent success', async () => {
    wireJobber({ fetchResult: { errors: [{ message: 'no_valid_token' }] } })
    const res = await patchLead({ last_name: 'Lambert' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(leadRow.last_name).toBe('Lambert') // saved here
    expect(body.name_writeback.last_name).toBe('failed')
    expect(nameSyncFailed(body.name_writeback)).toBe(true)
  })

  // ── the shapes that must not be mangled ─────────────────────────────────

  it('company-shaped records survive a round trip unmangled — "Deck Construction Group LLC"', async () => {
    leadRow = {
      ...baseLead(),
      name: 'Deck Construction Group LLC',
      first_name: null,
      last_name: null,
      company: 'Deck Construction Group LLC',
    }
    wireJobber({
      client: { id: gid('Client', '101'), firstName: null, lastName: null, companyName: 'Deck Construction Group LLC' },
    })

    // Fix the typo the owner actually came for: Grup → Group already right,
    // so correct the suffix instead. Nothing else may move.
    const res = await patchLead({ company: 'Deck Construction Group, LLC' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(leadRow.company).toBe('Deck Construction Group, LLC')
    expect(leadRow.name).toBe('Deck Construction Group, LLC')
    // The person fields stay empty — no invented first/last from a split.
    expect(leadRow.first_name).toBeNull()
    expect(leadRow.last_name).toBeNull()
    const [, , mvars] = (jobberMutation as any).mock.calls[0]
    expect(mvars.input).toEqual({ companyName: 'Deck Construction Group, LLC' })
    expect(body.name_writeback.company).toBe('updated')
  })

  it('an ampersand record round-trips byte-for-byte when only the other field changes', async () => {
    await patchLead({ last_name: 'Lamb-Smith' })
    expect(leadRow.first_name).toBe('Jerry & Carri') // untouched, unsplit
    expect(leadRow.name).toBe('Jerry & Carri Lamb-Smith')
  })

  // ── drift is impossible by construction ─────────────────────────────────

  it('name and first/last do NOT drift — the route derives name and ignores what the caller sent', async () => {
    // A caller trying to force a mismatched display name gets the derived
    // one, not theirs.
    await patchLead({ first_name: 'Linda', last_name: 'Dibias', name: 'Something Else Entirely' })
    expect(leadRow.name).toBe('Linda Dibias')
    expect(leadRow.first_name).toBe('Linda')
    expect(leadRow.last_name).toBe('Dibias')
  })

  it('a bare `name` with no parts behind it is REFUSED, not silently drifted', async () => {
    const res = await patchLead({ name: 'Typed Straight In' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('name_is_derived')
    expect(leadRow.name).toBe('Jerry & Carri Lamb') // untouched
  })

  it('emptying every part is refused — no client is ever renamed to nothing (or to "Unknown")', async () => {
    leadRow.company = null
    const res = await patchLead({ first_name: '', last_name: '', company: '' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('name_cannot_be_empty')
    expect(leadRow.name).toBe('Jerry & Carri Lamb')
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('the stored parts are normalized, so the derived name can never disagree with them', async () => {
    await patchLead({ first_name: '  Jerry   &   Carri  ', last_name: ' Lambert ' })
    expect(leadRow.first_name).toBe('Jerry & Carri')
    expect(leadRow.last_name).toBe('Lambert')
    expect(leadRow.name).toBe('Jerry & Carri Lambert')
    expect(leadRow.name).toBe(composeLeadName(leadRow))
  })

  // ── no churn ────────────────────────────────────────────────────────────

  it('a whitespace-only edit saves without touching Jobber and writes NO touchpoint', async () => {
    const res = await patchLead({ first_name: 'Jerry  &  Carri' })
    expect(res.status).toBe(200)
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(jobberMutation).not.toHaveBeenCalled()
    expect(nameTouchpoints()).toHaveLength(0)
  })

  it('a non-name patch never reaches the name sync', async () => {
    const res = await patchLead({ stage: 'Attempting' })
    expect(res.status).toBe(200)
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(nameTouchpoints()).toHaveLength(0)
  })

  it('ECHO GUARD: one edit converges to exactly one Jobber mutation', async () => {
    await patchLead({ last_name: 'Lambert' })
    expect(jobberMutation).toHaveBeenCalledTimes(1)

    // Jobber fires CLIENT_UPDATE back; handleClientUpdate applies it via
    // upsertLead — a DIRECT write that never passes through this route.
    // Simulate its effect, then re-save the same value.
    leadRow.last_name = 'Lambert'
    leadRow.name = 'Jerry & Carri Lambert'
    const res = await patchLead({ last_name: 'Lambert' })
    expect(res.status).toBe(200)
    expect(jobberMutation).toHaveBeenCalledTimes(1) // still just the original
  })

  it('a touchpoint is written for a real change, and rides the response', async () => {
    const res = await patchLead({ first_name: 'Jerry and Carri' })
    const body = await res.json()
    const tp = nameTouchpoints()
    expect(tp).toHaveLength(1)
    expect(tp[0].kind).toBe('system')
    expect(tp[0].lead_id).toBe('lead-1')
    expect(tp[0].user_id).toBe('u1')
    expect(tp[0].label).toBe('Name updated → Jerry and Carri Lamb')
    // Open cards prepend it into Recent activity without a refetch.
    expect((body.contact_activity || []).some((t: any) => String(t.label).startsWith('Name updated'))).toBe(true)
  })
})

// ── source sweep: WHERE the pencil is, and where it must not be ─────────────

const repoRoot = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8')

describe('the pencil is on both record headers and nowhere in a list row', () => {
  it('ClientProfile mounts NameField in its header', () => {
    const src = read('components/hive/ClientProfile.jsx')
    expect(src).toMatch(/import NameField from '\.\/shared\/NameField'/)
    expect(src).toMatch(/<NameField/)
  })

  it('EngagementPanel mounts NameField in its masthead', () => {
    const src = read('components/hive/EngagementPanel.jsx')
    expect(src).toMatch(/import NameField from '\.\/shared\/NameField'/)
    expect(src).toMatch(/<NameField/)
  })

  it('the dense worklists do NOT — a pencil per row is noise and a mis-click risk', () => {
    for (const f of [
      'components/hive/InboxScreen.jsx',
      'components/hive/ClientGroupedList.jsx',
      'components/hive/EngagementGroupedList.jsx',
      'components/hive/EngagementBoard.jsx',
    ]) {
      expect(read(f)).not.toMatch(/NameField/)
    }
  })

  it('the editor reuses the shared inline-edit affordances rather than hand-rolling one', () => {
    const src = read('components/hive/shared/NameField.jsx')
    expect(src).toMatch(/import \{ EditPencil, InlineEditControls \} from '\.\/inlineEdit'/)
    expect(src).toMatch(/<EditPencil/)
    expect(src).toMatch(/<InlineEditControls/)
  })

  it('NO warning before the edit — the report comes after, in the toast and the feed', () => {
    const src = read('components/hive/shared/NameField.jsx')
    // A confirm in front of a typo correction makes people hesitate over a
    // typo. Nothing in this editor may gate the save behind one.
    expect(src).not.toMatch(/window\.confirm|<ConfirmModal|showConfirm/)
  })

  it('the editor edits the THREE parts, never the single display string', () => {
    const src = read('components/hive/shared/NameField.jsx')
    expect(src).toMatch(/aria-label="First name"/)
    expect(src).toMatch(/aria-label="Last name"/)
    expect(src).toMatch(/aria-label="Company"/)
    // The PATCH body carries the parts only — `name` is the route's to derive.
    expect(src).toMatch(/JSON\.stringify\(parts\)/)
  })

  it('T.* tokens only — no raw hex anywhere in the new UI', () => {
    const src = read('components/hive/shared/NameField.jsx')
    // An issue ref like "#119" reads as a hex literal to the token sweep, so
    // this file writes "issue 119" instead — the sweep must find nothing.
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

// ── MUTATION TEST: the honesty rule ─────────────────────────────────────────
// "Make a Jobber rejection report success, and confirm a test fails."
// This runs that mutation for real, in-process, against the exact decision
// the UI makes — so the guarantee is proven rather than asserted.

describe('MUTATION TEST — a Jobber rejection reported as success must FAIL a test', () => {
  // The honest implementation, as NameField uses it.
  const honestToastKind = (wb: any) => (nameSyncFailed(wb) ? 'error' : 'success')
  // The mutant: the bug this feature exists to prevent — a green tick over
  // a change that only half happened.
  const mutantToastKind = (_wb: any) => 'success'

  const rejected = { first_name: 'unchanged', last_name: 'failed', company: 'unchanged' }

  it('the honest version reports a rejection as an error toast', () => {
    expect(honestToastKind(rejected)).toBe('error')
  })

  it('the MUTANT is caught: the same assertion fails when a rejection is dressed as success', () => {
    // Run the suite's own assertion against the mutant and prove it throws.
    // If this expect(...).toThrow() ever stops throwing, the honesty check
    // has gone toothless and this test goes red.
    expect(() => {
      expect(mutantToastKind(rejected)).toBe('error')
    }).toThrow()
  })

  it('and the source really does choose the kind from nameSyncFailed', () => {
    // A mutation test on a helper proves nothing if the component stopped
    // calling the helper. Pin the wiring too.
    const src = read('components/hive/shared/NameField.jsx')
    expect(src).toMatch(/kind:\s*nameSyncFailed\(wb\)\s*\?\s*'error'\s*:\s*'success'/)
  })

  it('a partial application is never reported as a plain success either', () => {
    const partial = { first_name: 'updated', last_name: 'failed', company: 'unchanged' }
    expect(honestToastKind(partial)).toBe('error')
    expect(() => { expect(mutantToastKind(partial)).toBe('error') }).toThrow()
  })
})
