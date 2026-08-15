// @vitest-environment node
//
// issue 243 — GET /api/clients/:id/profile separates NEVER ENROLLED from
// enrolled-and-running.
//
// #112 lifted terminal drip stops out of the paused/active flag, but its
// derivation was guarded on `dripRows.length > 0`, so the zero-rows case fell
// through with drip_stopped_reason=null and drip_completed=false — the exact
// shape of a healthy live drip. PreferencesBlock then rendered "Nurture drips
// active" with a Pause button for 279 unpaused stage-New leads (verified
// against production) that had never been enrolled at all.
//
// The three states collapse in the ROUTE, so they separate in the route: the
// component cannot tell "no rows" from "rows that ended" — it sees the same
// nulls either way.
//
// Pins:
//   — zero progress rows → drip_never_enrolled true.
//   — a live / stopped / completed row → drip_never_enrolled false, and the
//     #112 fields are unchanged (no regression).
//   — the reason is derived from the location gate that actually caused it
//     (startDripForLead requires lifecycle_status='active' at arrival):
//       not active now                    → 'location_not_active'
//       active now, lead predates it      → 'location_activated_later'
//       active now, lead postdates it     → null (no invented reason)
//   — the location row carrying it is the one the route ALREADY fetched for
//     `name` — no extra round trip.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const PROFILE_ID = 'lead-243'

let leadFixture: any
let locationFixture: any
let dripRowsFixture: any[]

// ── Chainable Supabase builder (same shape as beta-reverse-referral) ──
type Call = { m: string; args: any[] }
function makeBuilder(resolve: (chain: Call[]) => any) {
  const chain: Call[] = []
  const builder: any = new Proxy(function () {} as any, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === 'then') {
        const r = resolve(chain)
        return (onF: any, onR: any) => Promise.resolve(r).then(onF, onR)
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => { chain.push({ m: prop, args: [] }); return Promise.resolve(resolve(chain)) }
      }
      return (...args: any[]) => { chain.push({ m: prop, args }); return builder }
    },
  })
  return builder
}

// Every column list the route asks the `locations` table for. The reason
// derivation is only affordable because it rides the EXISTING name fetch —
// if someone splits it into a second query this records the drift.
const locationSelects: string[] = []

function serviceResolver(table: string) {
  return (chain: Call[]) => {
    switch (table) {
      case 'leads': return { data: leadFixture, count: null, error: null }
      case 'locations': {
        const sel = chain.find(c => c.m === 'select')
        if (sel) locationSelects.push(String(sel.args[0]))
        return { data: locationFixture, error: null }
      }
      case 'lead_drip_progress': return { data: dripRowsFixture, error: null }
      default: return { data: [], count: 0, error: null }
    }
  }
}

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => makeBuilder(serviceResolver(t)) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => makeBuilder(() => ({ data: { id: 'u1', role: 'super_admin', location_id: 'loc-1' }, error: null })),
  }),
}))
vi.mock('@/lib/auth', () => ({ isAdmin: () => true }))
vi.mock('@/lib/profile-aggregates', () => ({ profileAggregates: () => ({}) }))

import { GET } from '@/app/api/clients/[id]/profile/route'

const call = async () => {
  const res: any = await GET(
    new Request('http://test/api/clients/x/profile') as any,
    { params: Promise.resolve({ id: PROFILE_ID }) },
  )
  return { status: res.status, body: await res.json() }
}

const LEAD_CREATED = '2026-07-21T00:00:00Z'

const baseLead = (over: any = {}) => ({
  id: PROFILE_ID, name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
  email: 'dana@example.com', phone: null, address: null, city: null, state: null, zip: null,
  created_at: LEAD_CREATED, source: 'Website', paused: false, marketing_opt_out: false,
  snoozed_until: null, snoozed_note: null, assigned_to: null,
  referred_by_kind: null, referred_by_id: null,
  jobber_client_id: null, location_uuid: 'loc-1', location_id: null,
  paid_amount: 0, request_details: null, project_type: 'Kitchen',
  ...over,
})

// Location ACTIVE and activated BEFORE the lead arrived — the healthy case,
// so any never-enrolled reason in these fixtures comes from the drip rows.
const activeLocation = { name: 'Omaha', lifecycle_status: 'active', activated_at: '2026-07-13T00:00:00Z' }

beforeEach(() => {
  leadFixture = baseLead()
  locationFixture = { ...activeLocation }
  dripRowsFixture = []
  locationSelects.length = 0
})

describe('#243 never-enrolled is its own state', () => {
  it('ZERO progress rows → drip_never_enrolled true (was indistinguishable from active)', async () => {
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.client.drip_never_enrolled).toBe(true)
    // The #112 fields stay null/false — which is precisely why they could not
    // carry this state on their own.
    expect(body.client.drip_stopped_reason).toBeNull()
    expect(body.client.drip_completed).toBe(false)
  })

  it('a LIVE progress row → drip_never_enrolled false (a real running drip)', async () => {
    dripRowsFixture = [{ stopped_at: null, stopped_reason: null, completed_at: null, created_at: '2026-07-22T00:00:00Z' }]
    const { body } = await call()
    expect(body.client.drip_never_enrolled).toBe(false)
    expect(body.client.drip_never_enrolled_reason).toBeNull()
    expect(body.client.drip_stopped_reason).toBeNull()
    expect(body.client.drip_completed).toBe(false)
  })

  it('#112 NO REGRESSION — a stopped row still reports its reason, and is not never-enrolled', async () => {
    dripRowsFixture = [{ stopped_at: '2026-07-25T00:00:00Z', stopped_reason: 'hard_bounce', completed_at: null, created_at: '2026-07-22T00:00:00Z' }]
    const { body } = await call()
    expect(body.client.drip_stopped_reason).toBe('hard_bounce')
    expect(body.client.drip_never_enrolled).toBe(false)
    expect(body.client.drip_never_enrolled_reason).toBeNull()
  })

  it('#112 NO REGRESSION — a completed row still reports completed, and is not never-enrolled', async () => {
    dripRowsFixture = [{ stopped_at: null, stopped_reason: null, completed_at: '2026-07-30T00:00:00Z', created_at: '2026-07-22T00:00:00Z' }]
    const { body } = await call()
    expect(body.client.drip_completed).toBe(true)
    expect(body.client.drip_never_enrolled).toBe(false)
  })
})

describe('#243 the reason, only where it is substantiable', () => {
  it('location NOT active → location_not_active (the 229-of-279 dominant cause)', async () => {
    locationFixture = { name: 'Northwest Austin', lifecycle_status: 'onboarding', activated_at: null }
    const { body } = await call()
    expect(body.client.drip_never_enrolled).toBe(true)
    expect(body.client.drip_never_enrolled_reason).toBe('location_not_active')
  })

  it('location active NOW but the lead predates activation → location_activated_later', async () => {
    locationFixture = { name: 'Boston', lifecycle_status: 'active', activated_at: '2026-08-05T00:00:00Z' }
    const { body } = await call()
    expect(body.client.drip_never_enrolled_reason).toBe('location_activated_later')
  })

  it('location active and the lead POSTDATES activation → null, no invented reason', async () => {
    // The Sophia Dongilli / Anne Weiss shape: arrived after the gate opened
    // and still has no progress row. The cause is not knowable from here, so
    // the route declines to guess.
    const { body } = await call()
    expect(body.client.drip_never_enrolled).toBe(true)
    expect(body.client.drip_never_enrolled_reason).toBeNull()
  })

  it('a lead with no location row gets no fabricated reason', async () => {
    locationFixture = null
    const { body } = await call()
    expect(body.client.drip_never_enrolled).toBe(true)
    expect(body.client.drip_never_enrolled_reason).toBeNull()
  })

  it('the reason costs no extra query — it rides the location row already fetched for `name`', async () => {
    await call()
    expect(locationSelects).toHaveLength(1)
    expect(locationSelects[0]).toContain('name')
    expect(locationSelects[0]).toContain('lifecycle_status')
    expect(locationSelects[0]).toContain('activated_at')
  })

  it('an ENROLLED lead carries no reason even at a non-active location', async () => {
    locationFixture = { name: 'Northwest Austin', lifecycle_status: 'onboarding', activated_at: null }
    dripRowsFixture = [{ stopped_at: null, stopped_reason: null, completed_at: null, created_at: '2026-07-22T00:00:00Z' }]
    const { body } = await call()
    expect(body.client.drip_never_enrolled).toBe(false)
    expect(body.client.drip_never_enrolled_reason).toBeNull()
  })
})
