// @vitest-environment node
//
// GET /api/clients/:id/profile — the reverse-referral cap + dangling
// referrer resolution. Drives the real route handler with a chainable
// Supabase mock that EMULATES range() (slices) and count:'exact' (full
// total), so a regression to the old hard `.range(0, 49)` — or a dropped
// count — fails here, not silently in prod.
//
//   1) reverse-referral list returns >50 rows when they exist, and the
//      response carries the full total (referred_us_total) even past the
//      returned page.
//   2) a dangling referred_by_id (referrer row deleted) resolves to a
//      safe "removed" state: referred_by_missing=true, name null, no throw.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Fixtures the mock serves ───────────────────────────────────
const PROFILE_ID = 'lead-under-test'
// 250 leads referred by this client — deliberately > the 200 ceiling so
// the returned page is capped AND the total exceeds it.
const REVERSE_ALL = Array.from({ length: 250 }, (_, i) => ({
  id: `ref-${i}`, name: `Referred Person ${i}`, created_at: `2026-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
}))

let leadFixture: any

// ── Chainable Supabase builder ─────────────────────────────────
// Records the call chain; resolves (as a thenable, or via maybeSingle)
// using a per-table resolver so we can honour range()/count().
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
const has = (chain: Call[], m: string, a0?: any, a1?: any) =>
  chain.some(c => c.m === m && (a0 === undefined || c.args[0] === a0) && (a1 === undefined || c.args[1] === a1))

function resolveLeads(chain: Call[]) {
  // Reverse-referral query — eq('referred_by_kind','lead').
  if (has(chain, 'eq', 'referred_by_kind', 'lead')) {
    const rangeCall = chain.find(c => c.m === 'range')
    const [from, to] = rangeCall ? rangeCall.args : [0, REVERSE_ALL.length - 1]
    const selectCall = chain.find(c => c.m === 'select')
    const wantsCount = !!(selectCall && selectCall.args[1] && selectCall.args[1].count === 'exact')
    return { data: REVERSE_ALL.slice(from, to + 1), count: wantsCount ? REVERSE_ALL.length : null, error: null }
  }
  // Lead identity fetch — eq('id', PROFILE_ID).maybeSingle().
  if (has(chain, 'eq', 'id', PROFILE_ID)) return { data: leadFixture, error: null }
  // A referrer that happens to be a lead — eq('id', <referred_by_id>).
  return { data: null, error: null }
}

function serviceResolver(table: string) {
  return (chain: Call[]) => {
    switch (table) {
      case 'leads': return resolveLeads(chain)
      case 'partners': return { data: null, error: null } // dangling: row gone
      case 'locations': return { data: { name: 'Denver' }, error: null }
      case 'engagements': return { data: [], error: null }
      case 'lead_contacts': return { data: [], error: null }
      case 'touchpoints': return { data: [], error: null }
      case 'lead_notes': return { data: [], error: null }
      case 'lead_tags': return { data: [], error: null }
      default: return { data: [], error: null }
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
  const res: any = await GET(new Request('http://test/api/clients/x/profile') as any, { params: Promise.resolve({ id: PROFILE_ID }) })
  return { status: res.status, body: await res.json() }
}

const baseLead = (over: any = {}) => ({
  id: PROFILE_ID, name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
  email: null, phone: null, address: null, city: null, state: null, zip: null,
  created_at: '2026-01-01T00:00:00Z', source: 'Referral', paused: false, marketing_opt_out: false,
  snoozed_until: null, snoozed_note: null, assigned_to: null,
  referred_by_kind: null, referred_by_id: null,
  jobber_client_id: null, location_uuid: 'loc-1', location_id: null,
  paid_amount: 0, request_details: null, project_type: 'Client',
  ...over,
})

beforeEach(() => { leadFixture = baseLead() })

describe('reverse-referral cap', () => {
  it('returns MORE than 50 referred leads (old hard .range(0,49) is gone)', async () => {
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.referred_us.length).toBeGreaterThan(50)
    // Capped to the ceiling, not the full 250.
    expect(body.referred_us.length).toBe(200)
  })

  it('carries the full total alongside the capped page (count:exact wired through)', async () => {
    const { body } = await call()
    // 250 total even though only 200 rows came back — only true if
    // count:'exact' was requested; a dropped count would fall back to
    // the page length (200) and fail this.
    expect(body.referred_us_total).toBe(250)
    expect(body.referred_us_total).toBeGreaterThan(body.referred_us.length)
  })
})

describe('dangling referred_by_id', () => {
  it('resolves to a safe removed state — missing flag set, name null, no throw', async () => {
    leadFixture = baseLead({ referred_by_kind: 'partner', referred_by_id: 'gone' })
    const { body } = await call()
    expect(body.client.referred_by_missing).toBe(true)
    expect(body.client.referred_by_name).toBeNull()
  })

  it('a live referrer is NOT flagged missing', async () => {
    // No referrer set → not missing (distinct from removed).
    const { body } = await call()
    expect(body.client.referred_by_missing).toBe(false)
    expect(body.client.referred_by_name).toBeNull()
  })
})
