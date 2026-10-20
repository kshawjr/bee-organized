// @vitest-environment node
//
// Inline address editing — server half. Under test:
//
//   * lead-address helpers: formatLeadAddress display normalization (the
//     Wendy Blanch duplication bug — stored `address` already carries
//     city/state/zip and the old renderer appended them AGAIN),
//     deriveStreet (full string → street line), diffAddressPatch
//     (normalized trigger decision — echo-safe)
//   * buildBillingAddressInput — clientEdit billingAddress plan:
//     full-replacement street1/street2, country preserved from Jobber,
//     ZERO mutations when Jobber already carries the address
//   * buildPropertyAddressPlan — the MANAGED-blast-radius property
//     (service address) policy: exactly one property → edit; multiple →
//     skipped_multiple (never guess); zero → nothing; converged → none
//   * hasUpcomingVisit — the single-property audit annotation
//   * PATCH /api/leads/[id] wiring: push fires only on a REAL address
//     change on a jobber-linked lead; clearing never pushes (we never
//     erase Jobber-side data); per-target outcomes ride the response
//     (address_writeback { billing, property, upcoming_visits }) +
//     audit touchpoint ('Address updated → …', old value + sync
//     annotations in notes) + addresses-jsonb coherence (people-mapper
//     prefers the jsonb — a hive edit must not be shadowed by a stale
//     Service entry); a propertyEdit failure never breaks the billing
//     edit or the save
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  composeLeadAddress,
  deriveStreet,
  diffAddressPatch,
  formatLeadAddress,
  formatLeadAddressLabeled,
} from '@/lib/lead-address'
import {
  buildBillingAddressInput,
  buildPropertyAddressPlan,
  hasUpcomingVisit,
  resolveAddressWriteback,
  resolvePropertyWriteback,
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

// ── unit: labeled variant for the lead NOTIFICATIONS (email row + Slack card) ──
// The label adapts to what the form actually collected — zip-alone is the
// dominant website-lead case, so a fixed "Address:" over a bare zip reads wrong.
// The VALUE reuses formatLeadAddress, so the de-dup (Wendy Blanch) still holds.
describe('formatLeadAddressLabeled', () => {
  it('street + city + state + zip → Address', () => {
    expect(formatLeadAddressLabeled({ address: '123 Main St', city: 'Seattle', state: 'WA', zip: '98101' }))
      .toEqual({ label: 'Address', value: '123 Main St, Seattle, WA 98101' })
  })

  it('city + state + zip, no street → Location', () => {
    expect(formatLeadAddressLabeled({ address: null, city: 'Seattle', state: 'WA', zip: '98101' }))
      .toEqual({ label: 'Location', value: 'Seattle, WA 98101' })
  })

  it('zip only → Zip (the dominant website-lead case)', () => {
    expect(formatLeadAddressLabeled({ zip: '98101' }))
      .toEqual({ label: 'Zip', value: '98101' })
  })

  it('nothing collected → null (caller omits the row)', () => {
    expect(formatLeadAddressLabeled({})).toBeNull()
    expect(formatLeadAddressLabeled(null)).toBeNull()
    expect(formatLeadAddressLabeled({ address: '', city: '  ', state: null, zip: undefined })).toBeNull()
  })

  it('no stray comma on any partial combination', () => {
    // state + zip, no city
    expect(formatLeadAddressLabeled({ state: 'WA', zip: '98101' }))
      .toEqual({ label: 'Location', value: 'WA 98101' })
    // city only
    expect(formatLeadAddressLabeled({ city: 'Seattle' }))
      .toEqual({ label: 'Location', value: 'Seattle' })
    // street + zip, no city/state
    expect(formatLeadAddressLabeled({ address: '123 Main St', zip: '98101' }))
      .toEqual({ label: 'Address', value: '123 Main St, 98101' })
    // no value should ever end or contain a dangling ", " next to nothing
    for (const parts of [
      { state: 'WA', zip: '98101' },
      { city: 'Seattle' },
      { address: '123 Main St', zip: '98101' },
      { zip: '98101' },
    ]) {
      const out = formatLeadAddressLabeled(parts)!
      expect(out.value).not.toMatch(/,\s*$/)
      expect(out.value).not.toMatch(/,\s*,/)
      expect(out.value).not.toMatch(/^\s*,/)
    }
  })

  it('full-joined address column (import convention) is NOT double-rendered, labeled Address', () => {
    expect(formatLeadAddressLabeled(WENDY))
      .toEqual({ label: 'Address', value: '29659 Calle Violeta, Temecula, California, 92592' })
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

// ── unit: property plan (the managed-blast-radius policy) ────────────────────

describe('buildPropertyAddressPlan', () => {
  const target = { street: '500 Oak Ave', city: 'Austin', state: 'TX', zip: '78701' }
  const prop = (id: string, address: any) => ({ id, address })
  const OLD = { street1: '29659 Calle Violeta', street2: '', city: 'Temecula', province: 'California', postalCode: '92592', country: 'United States' }

  it('exactly ONE property → edit it: full replacement, country preserved from the PROPERTY', () => {
    const { kind, propertyId, input } = buildPropertyAddressPlan(target, { totalCount: 1, nodes: [prop('prop-1', OLD)] })
    expect(kind).toBe('edit')
    expect(propertyId).toBe('prop-1')
    expect(input).toEqual({
      street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX',
      postalCode: '78701', country: 'United States',
    })
  })

  it('MULTIPLE properties → skipped_multiple, no target, no input (never guess)', () => {
    const { kind, propertyId, input } = buildPropertyAddressPlan(target, {
      totalCount: 2, nodes: [prop('prop-1', OLD), prop('prop-2', OLD)],
    })
    expect(kind).toBe('skipped_multiple')
    expect(propertyId).toBeNull()
    expect(input).toBeNull()
  })

  it('totalCount is the arbiter — 3+ properties skip even though the page only carries 2 nodes', () => {
    expect(buildPropertyAddressPlan(target, { totalCount: 7, nodes: [prop('prop-1', OLD), prop('prop-2', OLD)] }).kind)
      .toBe('skipped_multiple')
  })

  it('ZERO properties → nothing to update', () => {
    expect(buildPropertyAddressPlan(target, { totalCount: 0, nodes: [] }).kind).toBe('zero')
  })

  it('ECHO GUARD: the single property already carries the address → no mutation', () => {
    const { kind, input } = buildPropertyAddressPlan(target, {
      totalCount: 1,
      nodes: [prop('prop-1', { street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX', postalCode: '78701' })],
    })
    expect(kind).toBe('none')
    expect(input).toBeNull()
  })

  it('empty target → never a mutation (we never erase Jobber-side data)', () => {
    expect(buildPropertyAddressPlan({ street: '', city: '', state: '', zip: '' }, { totalCount: 1, nodes: [prop('prop-1', OLD)] }).kind)
      .toBe('none')
  })

  it('outcome mapping: edit→updated/failed, none→unchanged, skip and zero pass through', () => {
    expect(resolvePropertyWriteback('edit', false)).toBe('updated')
    expect(resolvePropertyWriteback('edit', true)).toBe('failed')
    expect(resolvePropertyWriteback('none', false)).toBe('unchanged')
    expect(resolvePropertyWriteback('skipped_multiple', false)).toBe('skipped_multiple')
    expect(resolvePropertyWriteback('zero', false)).toBe('none')
  })
})

describe('hasUpcomingVisit', () => {
  const NOW = Date.parse('2026-07-10T20:00:00Z')

  it('future startAt → true; past/invalid/empty → false', () => {
    expect(hasUpcomingVisit([{ startAt: '2026-07-12T15:00:00Z' }], NOW)).toBe(true)
    expect(hasUpcomingVisit([{ startAt: '2026-07-01T15:00:00Z' }], NOW)).toBe(false) // LATE-but-incomplete ≠ upcoming
    expect(hasUpcomingVisit([{ startAt: null }, {}], NOW)).toBe(false)
    expect(hasUpcomingVisit([], NOW)).toBe(false)
    expect(hasUpcomingVisit(null, NOW)).toBe(false)
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
// service_requests rows the open-request lookup returns, and the chain it
// was built on (to check the filters).
let srRows: any[] = []
let srError: any = null
let srChain: any = null

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
  for (const m of ['select', 'eq', 'neq', 'update', 'in']) chain[m] = vi.fn(() => chain)
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
    if (table === 'service_requests') {
      srChain = chainFor(() => null)
      srChain.then = (resolve: any) => resolve({ data: srError ? null : srRows, error: srError })
      return srChain
    }
    return chainFor(() => null)
  })
  ;(updateLead as any).mockImplementation(async (_id: string, patch: any) => {
    Object.assign(leadRow, patch)
  })
}

const OLD_JOBBER_ADDR = {
  street: '29659 Calle Violeta', street1: '29659 Calle Violeta', street2: '',
  city: 'Temecula', province: 'California', postalCode: '92592', country: 'United States',
}

function wireJobber({
  billingAddress = OLD_JOBBER_ADDR as any,
  // Default: the single-property client whose service address matches
  // the stored lead address — the happy path updates BOTH targets.
  properties = { totalCount: 1, nodes: [{ id: 'prop-1', address: OLD_JOBBER_ADDR }] } as any,
  visits = [] as any[],
  clientEditErrors = null as any,
  propertyEditErrors = null as any,
  requestProperty = null as any,
  requestFetchError = null as any,
  propertyCreateErrors = null as any,
  requestEditErrors = null as any,
} = {}) {
  ;(jobberGraphQL as any).mockImplementation(async (_loc: string, query: string) => {
    if (query.includes('GetRequestProperty')) {
      return requestFetchError
        ? { errors: [{ message: requestFetchError }] }
        : { data: { request: { id: gid('Request', '900'), property: requestProperty } } }
    }
    return {
      data: {
        client: {
          id: gid('Client', '101'),
          billingAddress,
          clientProperties: properties,
          scheduledItems: { nodes: visits },
        },
      },
    }
  })
  ;(jobberMutation as any).mockImplementation(async (_loc: string, mutation: string) => {
    if (mutation.includes('propertyCreate')) {
      return propertyCreateErrors
        ? { userErrors: propertyCreateErrors }
        : { data: { propertyCreate: { properties: [{ id: gid('Property', '777') }] } } }
    }
    if (mutation.includes('requestEdit')) {
      return requestEditErrors
        ? { userErrors: requestEditErrors }
        : { data: { requestEdit: { request: { id: gid('Request', '900') } } } }
    }
    if (mutation.includes('propertyEdit')) {
      return propertyEditErrors
        ? { userErrors: propertyEditErrors }
        : { data: { propertyEdit: { property: { id: 'prop-1' } } } }
    }
    return clientEditErrors
      ? { userErrors: clientEditErrors }
      : { data: { clientEdit: { client: { id: gid('Client', '101') } } } }
  })
}

const mutationCalls = (name: string) =>
  (jobberMutation as any).mock.calls.filter(([, m]: any[]) => m.includes(name))

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

  it('happy path (single-property client): ONE fetch + clientEdit billingAddress + propertyEdit; both report updated', async () => {
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'updated', upcoming_visits: false })

    expect(jobberGraphQL).toHaveBeenCalledTimes(1)
    const [, query, vars] = (jobberGraphQL as any).mock.calls[0]
    expect(query).toContain('GetClientAddressState')
    expect(query).toContain('clientProperties(first: 2)')
    expect(vars).toEqual({ clientId: gid('Client', '101') })

    expect(jobberMutation).toHaveBeenCalledTimes(2)
    const [, , cvars] = mutationCalls('clientEdit')[0]
    expect(cvars.input).toEqual({
      billingAddress: {
        street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX',
        postalCode: '78701', country: 'United States',
      },
    })
    const [, pmut, pvars] = mutationCalls('propertyEdit')[0]
    expect(pmut).toContain('propertyEdit')
    expect(pvars.propertyId).toBe('prop-1')
    expect(pvars.input).toEqual({
      address: {
        street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX',
        postalCode: '78701', country: 'United States',
      },
    })
  })

  it('MULTIPLE properties → billing pushed, propertyEdit NEVER sent; skip is explicit in outcome + audit note', async () => {
    wireJobber({
      properties: {
        totalCount: 2,
        nodes: [
          { id: 'prop-1', address: OLD_JOBBER_ADDR },
          { id: 'prop-2', address: { street1: '8 Shop Rd', city: 'Temecula', province: 'CA', postalCode: '92592' } },
        ],
      },
    })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()

    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'skipped_multiple', upcoming_visits: false })
    expect(mutationCalls('propertyEdit')).toHaveLength(0)
    expect(mutationCalls('clientEdit')).toHaveLength(1)

    const audit = touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))
    expect(audit).toHaveLength(1)
    expect(audit[0].notes).toContain('synced to Jobber billing — client has multiple properties, service address not changed')
  })

  it('ZERO properties → billing only, property outcome none, no property annotation', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] } })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()

    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'none', upcoming_visits: false })
    expect(mutationCalls('propertyEdit')).toHaveLength(0)
    const audit = touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))
    expect(audit[0].notes).toBe('was 29659 Calle Violeta, Temecula, California, 92592')
  })

  it('single property WITH upcoming visits → still updated; audit note appends the schedule warning', async () => {
    const future = new Date(Date.now() + 3 * 86400_000).toISOString()
    const past = new Date(Date.now() - 3 * 86400_000).toISOString()
    wireJobber({ visits: [{ startAt: past }, { startAt: future }] })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()

    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'updated', upcoming_visits: true })
    expect(mutationCalls('propertyEdit')).toHaveLength(1) // update, never a skip
    const audit = touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))
    expect(audit[0].notes).toBe(
      'was 29659 Calle Violeta, Temecula, California, 92592 · property has upcoming visits — verify schedule',
    )
  })

  it('propertyEdit userErrors → property failed WITHOUT breaking billing or the save', async () => {
    wireJobber({ propertyEditErrors: [{ message: 'address is invalid' }] })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.lead).toBeDefined()
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'failed', upcoming_visits: false })
  })

  it('clientEdit fails, propertyEdit lands → per-target truth (billing failed, property updated)', async () => {
    wireJobber({ clientEditErrors: [{ message: 'nope' }] })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(body.address_writeback).toMatchObject({ billing: 'failed', property: 'updated', upcoming_visits: false })
  })

  it('ECHO GUARD (property): single property already carries the target → clientEdit only, property unchanged', async () => {
    wireJobber({
      properties: {
        totalCount: 1,
        nodes: [{ id: 'prop-1', address: { street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX', postalCode: '78701' } }],
      },
    })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'unchanged', upcoming_visits: false })
    expect(mutationCalls('propertyEdit')).toHaveLength(0)
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

  it('ECHO GUARD (both targets): Jobber already carries the address everywhere → fetch, ZERO mutations, both unchanged', async () => {
    const AUSTIN_ADDR = {
      street1: '500 Oak Ave', street2: '', city: 'Austin', province: 'TX',
      postalCode: '78701', country: 'United States',
    }
    wireJobber({
      billingAddress: AUSTIN_ADDR,
      properties: { totalCount: 1, nodes: [{ id: 'prop-1', address: AUSTIN_ADDR }] },
    })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(body.address_writeback).toMatchObject({ billing: 'unchanged', property: 'unchanged', upcoming_visits: false })
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('BOTH mutations fail → non-fatal: lead saved, per-target failed', async () => {
    wireJobber({
      clientEditErrors: [{ message: 'billingAddress is invalid' }],
      propertyEditErrors: [{ message: 'address is invalid' }],
    })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.lead).toBeDefined()
    expect(body.address_writeback).toMatchObject({ billing: 'failed', property: 'failed', upcoming_visits: false })
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
      // the parts move with the value — Send to Jobber reads them first
      { type: 'Service', value: '500 Oak Ave, Austin, TX, 78701', street: '500 Oak Ave', city: 'Austin', state: 'TX', zip: '78701' },
    ])
  })

  it('classic addresses-managed PATCH (addresses in body) is left alone — no auto-rewrite', async () => {
    leadRow.addresses = [{ type: 'Service', value: 'old' }]
    await patchLead({ ...AUSTIN_PATCH, addresses: [{ type: 'Service', value: 'user-managed' }] })
    const [, applied] = (updateLead as any).mock.calls[0]
    expect(applied.addresses).toEqual([{ type: 'Service', value: 'user-managed' }])
  })
})

// ── the lead's Jobber REQUEST gets the address (2026-10-19) ──────────────────
//
// A request sent before the lead had an address is created with no property.
// The address added afterwards used to reach the client's billing only
// ("billing:added,property:none") and never the request. Now a request with
// no property gets one attached via requestEdit { propertyId }.
describe('PATCH /api/leads/[id] — the address reaches the Jobber request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    leadRow = { ...baseLead(), jobber_request_id: '900' }
    srRows = [{ jobber_request_id: '900' }]
    srError = null
    touchpointInserts = []
    wireDb()
  })

  const reqEdits = () => mutationCalls('requestEdit')
  const propCreates = () => mutationCalls('propertyCreate')
  const audit = () => touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))

  it('ZERO properties + request with none → property created on the client, then attached to the request', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] } })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.address_writeback).toMatchObject({
      billing: 'updated', property: 'added', request: 'attached', property_id: '777',
    })
    expect(propCreates()).toHaveLength(1)
    const [, , cvars] = propCreates()[0]
    expect(cvars.clientId).toBe(gid('Client', '101'))
    expect(cvars.input).toEqual({
      properties: [{ address: { street1: '500 Oak Ave', city: 'Austin', province: 'TX', postalCode: '78701' } }],
    })
    expect(reqEdits()).toHaveLength(1)
    const [, rmut, rvars] = reqEdits()[0]
    expect(rmut).toContain('requestEdit')
    expect(rvars).toEqual({ requestId: gid('Request', '900'), input: { propertyId: gid('Property', '777') } })
    expect(audit()[0].notes).toContain('address added to the Jobber request')
  })

  it('the new property becomes the lead link (jobber_property_id captured)', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] } })
    const updates: any[] = []
    const base = (supabaseService.from as any).getMockImplementation()
    ;(supabaseService.from as any).mockImplementation((table: string) => {
      if (table === 'service_requests') return base(table)
      const chain = chainFor(() => (table === 'leads' ? leadRow : null), table === 'touchpoints' ? touchpointInserts : undefined)
      if (table === 'leads') chain.update = vi.fn((row: any) => { updates.push(row); return chain })
      return chain
    })
    await patchLead(AUSTIN_PATCH)
    expect(updates).toContainEqual({ jobber_property_id: '777' })
  })

  it('SINGLE existing property + request with none → that property is attached, nothing created', async () => {
    wireJobber()
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ property: 'updated', request: 'attached' })
    expect(propCreates()).toHaveLength(0)
    expect(reqEdits()[0][2]).toEqual({ requestId: gid('Request', '900'), input: { propertyId: 'prop-1' } })
  })

  it('request ALREADY has a property → never re-pointed, no requestEdit, no create', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] }, requestProperty: { id: gid('Property', '555') } })
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ property: 'none', request: 'already_set' })
    expect(reqEdits()).toHaveLength(0)
    expect(propCreates()).toHaveLength(0)
  })

  it('MULTIPLE properties, none linked → request left alone (never guess), said in the audit', async () => {
    wireJobber({
      properties: {
        totalCount: 2,
        nodes: [{ id: 'prop-1', address: OLD_JOBBER_ADDR }, { id: 'prop-2', address: OLD_JOBBER_ADDR }],
      },
    })
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ property: 'skipped_multiple', request: 'skipped_multiple' })
    expect(reqEdits()).toHaveLength(0)
    expect(propCreates()).toHaveLength(0)
    expect(audit()[0].notes).toContain('Jobber request left without an address — client has multiple properties')
  })

  it('no street in the address → no property created, request untouched', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] }, billingAddress: null })
    leadRow = { ...baseLead(), jobber_request_id: '900', address: null, city: null, state: null, zip: '78701' }
    const body = await (await patchLead({ zip: '78702' })).json()
    expect(body.address_writeback?.request ?? null).not.toBe('attached')
    expect(propCreates()).toHaveLength(0)
    expect(reqEdits()).toHaveLength(0)
  })

  it('propertyCreate refused → property failed, request failed, billing still lands, save still 200', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] }, propertyCreateErrors: [{ message: 'bad address' }] })
    const res = await patchLead(AUSTIN_PATCH)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'failed', request: 'failed', property_id: null })
    expect(reqEdits()).toHaveLength(0)
    expect(audit()[0].notes).toContain('address NOT added to the Jobber request')
  })

  it('propertyCreate answers with errors AND an id → still treated as refused: nothing attached', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] } })
    const base = (jobberMutation as any).getMockImplementation()
    ;(jobberMutation as any).mockImplementation(async (loc: string, mutation: string, vars: any) =>
      mutation.includes('propertyCreate')
        ? { userErrors: [{ message: 'partial' }], data: { propertyCreate: { properties: [{ id: gid('Property', '777') }] } } }
        : base(loc, mutation, vars))
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ property: 'failed', request: 'failed', property_id: null })
    expect(reqEdits()).toHaveLength(0)
  })

  it('requestEdit refused → request failed, the created property and billing still reported', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] }, requestEditErrors: [{ message: 'nope' }] })
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'added', request: 'failed' })
  })

  it('request fetch fails → request failed, nothing created or attached', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] }, requestFetchError: 'boom' })
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ billing: 'updated', request: 'failed' })
    expect(propCreates()).toHaveLength(0)
    expect(reqEdits()).toHaveLength(0)
  })

  it('lead with NO open Jobber request → behaviour unchanged: no request read, no create, request null', async () => {
    leadRow = baseLead()
    srRows = []
    wireJobber({ properties: { totalCount: 0, nodes: [] } })
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'none', request: null })
    expect((jobberGraphQL as any).mock.calls.some(([, q]: any[]) => q.includes('GetRequestProperty'))).toBe(false)
    expect(propCreates()).toHaveLength(0)
  })

  it('breadcrumb carries the request outcome', async () => {
    wireJobber({ properties: { totalCount: 0, nodes: [] } })
    await patchLead(AUSTIN_PATCH)
    const { writeSyncLog } = await import('@/lib/sync-log')
    const msgs = (writeSyncLog as any).mock.calls.map(([r]: any[]) => r.message)
    expect(msgs).toContain('Lead edit address sync; client=101; billing:updated,property:added,request:attached')
  })
})

// ── BOTH kinds of request (2026-10-20) ───────────────────────────────────────
//
// The first cut found the request through leads.jobber_request_id — which
// only OUR Send ever sets. A request the owner made in Jobber arrives by
// webhook into service_requests and never touches that column, so it was
// silently skipped (Stagnant Lead Jr, Test Location, 2026-10-20 02:32:38:
// "billing:added,property:none" with no request step at all). The lookup now
// reads the lead's open service_requests rows, whoever made the request.
describe('PATCH /api/leads/[id] — the address reaches requests OURS and the OWNER\'S', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    touchpointInserts = []
    srError = null
    wireDb()
    wireJobber({ properties: { totalCount: 0, nodes: [] } })
  })

  const reqEdits = () => mutationCalls('requestEdit')
  const propCreates = () => mutationCalls('propertyCreate')
  const requestReads = () => (jobberGraphQL as any).mock.calls.filter(([, q]: any[]) => q.includes('GetRequestProperty'))

  it('a request WE created (lead column set, open SR row) → property attached to it', async () => {
    leadRow = { ...baseLead(), jobber_request_id: '35282235' }
    srRows = [{ jobber_request_id: '35282235' }]
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ property: 'added', request: 'attached' })
    expect(reqEdits()[0][2].requestId).toBe(gid('Request', '35282235'))
  })

  it('a request the OWNER made in Jobber (lead column NULL, open SR row) → property attached to it', async () => {
    // Exactly the Stagnant Lead Jr shape that the first cut skipped.
    leadRow = { ...baseLead(), jobber_request_id: null }
    srRows = [{ jobber_request_id: '28562815' }]
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'added', request: 'attached' })
    expect(requestReads()[0][2]).toEqual({ requestId: gid('Request', '28562815') })
    expect(propCreates()).toHaveLength(1)
    expect(reqEdits()[0][2]).toEqual({ requestId: gid('Request', '28562815'), input: { propertyId: gid('Property', '777') } })
  })

  it('the lookup is the lead\'s OPEN requests: this lead, active, stage New / Request / Nurturing', async () => {
    leadRow = { ...baseLead(), jobber_request_id: null }
    srRows = [{ jobber_request_id: '28562815' }]
    await patchLead(AUSTIN_PATCH)
    expect(supabaseService.from).toHaveBeenCalledWith('service_requests')
    expect(srChain.eq).toHaveBeenCalledWith('lead_id', 'lead-1')
    expect(srChain.eq).toHaveBeenCalledWith('status', 'active')
    expect(srChain.in).toHaveBeenCalledWith('stage', ['New', 'Request', 'Nurturing'])
  })

  it('a STALE lead column is ignored: the open SR request is the one that gets the address', async () => {
    leadRow = { ...baseLead(), jobber_request_id: '800' }
    srRows = [{ jobber_request_id: '901' }]
    await patchLead(AUSTIN_PATCH)
    expect(reqEdits()).toHaveLength(1)
    expect(reqEdits()[0][2].requestId).toBe(gid('Request', '901'))
  })

  it('lead column set but NO open request (it moved on to a quote/job) → no request step', async () => {
    leadRow = { ...baseLead(), jobber_request_id: '800' }
    srRows = []
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ request: null })
    expect(requestReads()).toHaveLength(0)
    expect(reqEdits()).toHaveLength(0)
  })

  it('SEVERAL open requests → skipped (never guess), said in the audit and the log line', async () => {
    leadRow = { ...baseLead(), jobber_request_id: null }
    srRows = [{ jobber_request_id: '901' }, { jobber_request_id: '902' }]
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ billing: 'updated', property: 'none', request: 'several_requests' })
    expect(requestReads()).toHaveLength(0)
    expect(propCreates()).toHaveLength(0)
    expect(reqEdits()).toHaveLength(0)
    const audit = touchpointInserts.filter(t => String(t.label || '').startsWith('Address'))
    expect(audit[0].notes).toContain('Jobber requests left without an address — lead has several open requests')
    const { writeSyncLog } = await import('@/lib/sync-log')
    const msgs = (writeSyncLog as any).mock.calls.map(([r]: any[]) => r.message)
    expect(msgs).toContain('Lead edit address sync; client=101; billing:updated,property:none,request:several_requests')
  })

  it('the same request listed twice counts as ONE open request', async () => {
    leadRow = { ...baseLead(), jobber_request_id: null }
    srRows = [{ jobber_request_id: '901' }, { jobber_request_id: '901' }]
    const body = await (await patchLead(AUSTIN_PATCH)).json()
    expect(body.address_writeback).toMatchObject({ request: 'attached' })
  })

  it('the lookup failing never blocks the save: treated as no open request', async () => {
    leadRow = { ...baseLead(), jobber_request_id: null }
    srError = { message: 'boom' }
    const res = await patchLead(AUSTIN_PATCH)
    expect(res.status).toBe(200)
    expect((await res.json()).address_writeback).toMatchObject({ billing: 'updated', request: null })
    expect(reqEdits()).toHaveLength(0)
  })
})
