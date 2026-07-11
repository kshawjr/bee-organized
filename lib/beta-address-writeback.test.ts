// @vitest-environment node
//
// Inline address editing — server half. Under test:
//
//   * lead-address helpers: formatLeadAddress display normalization (the
//     Wendy Blanch duplication bug — stored `address` already carries
//     city/state/zip and the old renderer appended them AGAIN),
//     deriveStreet (full string → street line), diffAddressPatch
//     (normalized trigger decision — echo-safe)
//   * buildBillingAddressInput — the Jobber push plan is CLIENT-scoped
//     (clientEdit billingAddress), full-replacement street1/street2,
//     country preserved from Jobber, and converges with ZERO mutations
//     when Jobber already carries the address
//   * PATCH /api/leads/[id] wiring: push fires only on a REAL address
//     change on a jobber-linked lead; clearing never pushes (we never
//     erase Jobber-side data); outcome rides the response
//     (address_writeback) + audit touchpoint ('Address updated → …',
//     old value in notes) + addresses-jsonb coherence (people-mapper
//     prefers the jsonb — a hive edit must not be shadowed by a stale
//     Service entry)
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  composeLeadAddress,
  deriveStreet,
  diffAddressPatch,
  formatLeadAddress,
} from '@/lib/lead-address'
import {
  buildBillingAddressInput,
  resolveAddressWriteback,
} from '@/lib/jobber-address-writeback'

const WENDY = {
  address: '29659 Calle Violeta, Temecula, California, 92592',
  city: 'Temecula',
  state: 'California',
  zip: '92592',
}

// ── unit: display normalization ─────────────────────────────────────────────

describe('formatLeadAddress', () => {
  it('full stored string (import convention) renders ONCE — no duplicated city/state/zip (Wendy Blanch)', () => {
    expect(formatLeadAddress(WENDY)).toBe('29659 Calle Violeta, Temecula, California, 92592')
  })

  it('legacy street-only string gets the missing parts appended (old renderer grouping)', () => {
    expect(formatLeadAddress({ address: '123 Main St', city: 'Denver', state: 'CO', zip: '80202' }))
      .toBe('123 Main St, Denver, CO 80202')
  })

  it('parts-only (no address string) still renders', () => {
    expect(formatLeadAddress({ address: null, city: 'Denver', state: 'CO', zip: '80202' })).toBe('Denver, CO 80202')
  })

  it('empty everything → empty string', () => {
    expect(formatLeadAddress({})).toBe('')
    expect(formatLeadAddress(null)).toBe('')
  })

  it('partially-embedded parts: only the missing ones are appended', () => {
    expect(formatLeadAddress({ address: '123 Main St, Denver', city: 'Denver', state: 'CO', zip: '80202' }))
      .toBe('123 Main St, Denver, CO 80202')
  })
})

// ── unit: street derivation (full string → street line) ─────────────────────

describe('deriveStreet', () => {
  it('strips the trailing part segments off the import-format string', () => {
    expect(deriveStreet(WENDY.address, WENDY)).toBe('29659 Calle Violeta')
  })

  it('strips grouped "State ZIP" tails too', () => {
    expect(deriveStreet('123 Main St, Denver, CO 80202', { city: 'Denver', state: 'CO', zip: '80202' }))
      .toBe('123 Main St')
  })

  it('street-only strings pass through; unit segments survive', () => {
    expect(deriveStreet('123 Main St', { city: 'Denver', state: 'CO', zip: '80202' })).toBe('123 Main St')
    expect(deriveStreet('123 Main St, Apt 4, Denver, CO, 80202', { city: 'Denver', state: 'CO', zip: '80202' }))
      .toBe('123 Main St, Apt 4')
  })
})

// ── unit: patch trigger decision ─────────────────────────────────────────────

describe('diffAddressPatch', () => {
  it('real change → changed with derived parts', () => {
    const d = diffAddressPatch(
      { address: '500 Oak Ave, Austin, TX, 78701', city: 'Austin', state: 'TX', zip: '78701' },
      WENDY,
    )
    expect(d.changed).toBe(true)
    expect(d.cleared).toBe(false)
    expect(d.street).toBe('500 Oak Ave')
    expect(d.city).toBe('Austin')
    expect(d.state).toBe('TX')
    expect(d.zip).toBe('78701')
  })

  it('formatting-only re-save (webhook-echo shape) → NOT a change', () => {
    const d = diffAddressPatch(
      { address: '29659 calle violeta, temecula, california 92592', city: 'Temecula', state: 'California', zip: '92592' },
      WENDY,
    )
    expect(d.changed).toBe(false)
  })

  it('clearing all four → changed + cleared', () => {
    const d = diffAddressPatch({ address: null, city: null, state: null, zip: null }, WENDY)
    expect(d.changed).toBe(true)
    expect(d.cleared).toBe(true)
  })

  it('patch without address columns → untouched', () => {
    const d = diffAddressPatch({ stage: 'Nurturing', phone: '555' }, WENDY)
    expect(d.touched).toBe(false)
    expect(d.changed).toBe(false)
  })
})

// ── unit: billingAddress plan ────────────────────────────────────────────────

describe('buildBillingAddressInput', () => {
  const target = { street: '500 Oak Ave', city: 'Austin', state: 'TX', zip: '78701' }

  it('differs from current → full-replacement edit, country PRESERVED, street2 cleared', () => {
    const { input, plan } = buildBillingAddressInput(target, {
      street: '29659 Calle Violeta', street1: '29659 Calle Violeta', street2: 'Unit 9',
      city: 'Temecula', province: 'California', postalCode: '92592', country: 'United States',
    })
    expect(plan).toBe('edit')
    expect(input).toEqual({
      street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX',
      postalCode: '78701', country: 'United States',
    })
  })

  it('no current billing address → add (no country key to send)', () => {
    const { input, plan } = buildBillingAddressInput(target, null)
    expect(plan).toBe('add')
    expect(input).not.toBeNull()
    expect(Object.keys(input!)).not.toContain('country')
  })

  it('ECHO GUARD: Jobber already carries the address → no mutation', () => {
    const { input, plan } = buildBillingAddressInput(target, {
      street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US',
    })
    expect(plan).toBe('none')
    expect(input).toBeNull()
  })

  it('combined-street current (no street1) still matches', () => {
    const { plan } = buildBillingAddressInput(target, {
      street: '500 Oak Ave', city: 'Austin', province: 'TX', postalCode: '78701',
    })
    expect(plan).toBe('none')
  })

  it('empty target → never a mutation (we never erase Jobber-side data)', () => {
    const { input, plan } = buildBillingAddressInput(
      { street: '', city: '', state: '', zip: '' },
      { street1: '500 Oak Ave', city: 'Austin', province: 'TX', postalCode: '78701' },
    )
    expect(plan).toBe('none')
    expect(input).toBeNull()
  })

  it('outcome mapping: edit→updated, add→added, none→unchanged, errors→failed', () => {
    expect(resolveAddressWriteback('edit', false)).toBe('updated')
    expect(resolveAddressWriteback('add', false)).toBe('added')
    expect(resolveAddressWriteback('none', false)).toBe('unchanged')
    expect(resolveAddressWriteback('edit', true)).toBe('failed')
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

const gid = (type: string, n: string) =>
  Buffer.from(`gid://Jobber/${type}/${n}`, 'utf8').toString('base64')

let leadRow: any
let touchpointInserts: any[]

const baseLead = () => ({
  id: 'lead-1',
  location_id: 'loc_palmbeach',
  location_uuid: 'loc-uuid-1',
  stage: 'Nurturing',
  name: 'Wendy Blanch',
  email: 'wendy@example.com',
  phone: '555-000-9999',
  jobber_client_id: '101',
  addresses: [],
  ...WENDY,
})

function chainFor(rowRef: () => any, inserts?: any[]) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'neq', 'update']) chain[m] = vi.fn(() => chain)
  chain.insert = vi.fn((row: any) => { inserts?.push(row); return chain })
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
    if (table === 'touchpoints') return chainFor(() => null, touchpointInserts)
    return chainFor(() => null)
  })
  ;(updateLead as any).mockImplementation(async (_id: string, patch: any) => {
    Object.assign(leadRow, patch)
  })
}

function wireJobber({
  billingAddress = {
    street: '29659 Calle Violeta', street1: '29659 Calle Violeta', street2: '',
    city: 'Temecula', province: 'California', postalCode: '92592', country: 'United States',
  } as any,
  editResult = { data: { clientEdit: { client: { id: gid('Client', '101') } } } } as any,
} = {}) {
  ;(jobberGraphQL as any).mockResolvedValue({
    data: { client: { id: gid('Client', '101'), billingAddress } },
  })
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

const AUSTIN_PATCH = {
  address: '500 Oak Ave, Austin, TX, 78701',
  city: 'Austin', state: 'TX', zip: '78701',
}

describe('PATCH /api/leads/[id] — billing-address write-back trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    leadRow = baseLead()
    touchpointInserts = []
    wireDb()
    wireJobber()
  })

  it('real address change on a linked lead → by-id billing fetch + ONE clientEdit billingAddress; response reports updated', async () => {
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.address_writeback).toBe('updated')

    expect(jobberGraphQL).toHaveBeenCalledTimes(1)
    const [, query, vars] = (jobberGraphQL as any).mock.calls[0]
    expect(query).toContain('GetClientBillingAddress')
    expect(vars).toEqual({ clientId: gid('Client', '101') })

    expect(jobberMutation).toHaveBeenCalledTimes(1)
    const [, mutation, mvars] = (jobberMutation as any).mock.calls[0]
    expect(mutation).toContain('clientEdit')
    // CLIENT-scoped: billingAddress only — never a property mutation.
    expect(mutation).not.toMatch(/propert/i)
    expect(mvars.input).toEqual({
      billingAddress: {
        street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX',
        postalCode: '78701', country: 'United States',
      },
    })
  })

  it('audit touchpoint: one lead-level system entry, new display in label, old in notes', async () => {
    await patchLead(AUSTIN_PATCH)
    const audit = touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))
    expect(audit).toHaveLength(1)
    expect(audit[0].kind).toBe('system')
    expect(audit[0].label).toBe('Address updated → 500 Oak Ave, Austin, TX, 78701')
    expect(audit[0].notes).toBe('was 29659 Calle Violeta, Temecula, California, 92592')
    expect(audit[0].lead_id).toBe('lead-1')
  })

  it('formatting-only re-save → save succeeds, ZERO Jobber calls, no audit entry, no address_writeback', async () => {
    const res = await patchLead({
      address: '29659 calle violeta, temecula, california 92592',
      city: 'Temecula', state: 'California', zip: '92592',
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(updateLead).toHaveBeenCalled()
    expect(body.address_writeback).toBeUndefined()
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))).toHaveLength(0)
  })

  it('clearing the address → saved + audited, but NEVER pushed (no Jobber-side erasure)', async () => {
    const res = await patchLead({ address: null, city: null, state: null, zip: null })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.address_writeback).toBeUndefined()
    expect(jobberGraphQL).not.toHaveBeenCalled()
    const audit = touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))
    expect(audit).toHaveLength(1)
    expect(audit[0].label).toBe('Address removed')
  })

  it('unlinked lead → saved + audited, zero Jobber calls', async () => {
    leadRow.jobber_client_id = null
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.address_writeback).toBeUndefined()
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))).toHaveLength(1)
  })

  it('ECHO GUARD: Jobber already carries the target address → fetch, but ZERO mutations; reports unchanged', async () => {
    wireJobber({
      billingAddress: {
        street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX',
        postalCode: '78701', country: 'United States',
      },
    })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(body.address_writeback).toBe('unchanged')
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('clientEdit userErrors → non-fatal: lead saved, response reports failed', async () => {
    ;(jobberMutation as any).mockResolvedValue({
      userErrors: [{ message: 'billingAddress is invalid' }],
    })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.lead).toBeDefined()
    expect(body.address_writeback).toBe('failed')
  })

  it('addresses-jsonb coherence: a hive edit rewrites the Service entry so people-mapper cannot shadow it', async () => {
    leadRow.addresses = [
      { type: 'Billing', value: 'PO Box 12' },
      { type: 'Service', value: '29659 Calle Violeta, Temecula, California, 92592' },
    ]
    await patchLead(AUSTIN_PATCH)
    const [, applied] = (updateLead as any).mock.calls[0]
    expect(applied.addresses).toEqual([
      { type: 'Billing', value: 'PO Box 12' },
      { type: 'Service', value: '500 Oak Ave, Austin, TX, 78701' },
    ])
  })

  it('classic addresses-managed PATCH (addresses in body) is left alone — no auto-rewrite', async () => {
    leadRow.addresses = [{ type: 'Service', value: 'old' }]
    await patchLead({ ...AUSTIN_PATCH, addresses: [{ type: 'Service', value: 'user-managed' }] })
    const [, applied] = (updateLead as any).mock.calls[0]
    expect(applied.addresses).toEqual([{ type: 'Service', value: 'user-managed' }])
  })
})
