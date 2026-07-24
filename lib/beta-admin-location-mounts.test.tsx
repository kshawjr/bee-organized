// @vitest-environment happy-dom
//
// Admin location surfaces actually MOUNT and their pricing/seat identifiers
// actually EXECUTE.
//
// The unbound-identifier sweep (lib/beta-unbound-identifiers.test.ts) found
// three pre-existing ReferenceErrors on these surfaces:
//   - LocationDetailSheet: `livePrices` / `getTierPrice` — restored by the
//     36c2183 revert without the TierPricesContext bindings every sibling
//     pricing site has. Its demo Team list only renders for mock location ids
//     (real deployments hit locUsers.length === 0), so the throw was latent.
//   - LocationDrilldown: `locationSeats` ×2 — 5c71295 added the scheduled-
//     removal roster to the Team tab without the state + fetch that
//     LocationDetailSheet has.
// A source pin can't prove the fix (the names were always in the source), so
// these tests execute the exact lines: the sheet is reached by real clicks
// through App (admin → Locations → card), and the drilldown is mounted
// directly because no live UI trigger exists for it today.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// One seat scheduled for removal — the exact row shape /api/seats returns and
// the drilldown's amber roster filters for.
const SCHEDULED_SEAT = {
  id: 'seat1', tier: 'manager', status: 'active',
  user_id: null, scheduled_removal_at: '2026-08-01',
}

;(globalThis as any).fetch = vi.fn(async (url: any) => {
  const u = String(url)
  if (u.includes('/api/seats')) {
    return { ok: true, status: 200, json: async () => [SCHEDULED_SEAT] }
  }
  if (u.includes('/summary')) {
    return { ok: true, status: 200, json: async () => ({ leads: 3, active: 1, closedWon: 1, stageCounts: {} }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}) as any

import App, { LocationDrilldown } from '@/components/BeeHub'

// Mock-family location id ON PURPOSE: LocationDetailSheet's demo Team list
// filters the module-level USERS_DATA (loc_kc has users there), and that list
// is where the un-bound getTierPrice/livePrices lines live. A real UUID would
// hit locUsers.length === 0 and never execute them.
const LOC = {
  id: 'loc_kc', name: 'Kansas City', state: 'MO', crmStatus: 'active',
  owner: 'Lynette Ewy', revenue: 0, collected: 0, jobberConnected: true,
}

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

async function mount(element: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(element) })
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

async function clickByText(host: HTMLElement, text: string) {
  const nodes = Array.from(host.querySelectorAll('button, div, span, p')) as HTMLElement[]
  // Prefer the deepest node whose OWN text is exactly the label (clicks bubble
  // up to the React handler); fall back to deepest contains-match. A bare
  // contains-match can land on an unrelated card that merely mentions the word
  // (e.g. the sidebar item "Locations" vs the dashboard "Locations Overview").
  const exact = nodes.filter(n => (n.textContent || '').trim() === text).pop()
  const target = exact || nodes.filter(n => (n.textContent || '').includes(text)).pop()
  if (!target) throw new Error(`clickByText: "${text}" not found`)
  await act(async () => { target.click() })
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

describe('LocationDetailSheet mounts with pricing bound', () => {
  it('admin → Locations → card opens the sheet; the demo Team list prices render', async () => {
    const host = await mount(React.createElement(App as any, {
      initialRoute: 'admin',
      initialRole: 'super_admin',
      initialFranchiseRole: 'owner',
      initialLocations: [LOC],
      initialUsers: [{ id: 'hu1', locationId: 'loc_kc', name: 'Lynette Ewy', email: 'lewy@x.com', role: 'owner', status: 'active', initials: 'LE' }],
      initialSeats: [],
      initialPendingInvites: [],
      initialLookups: {},
      initialPeople: [],
      initialBinPeople: [],
      initialTransferPeople: [],
      initialEngagements: [],
      initialPartners: [],
      initialCompanies: [],
      initialGuideSlides: [],
      initialManualSlides: [],
      initialTierPrices: [],
      currentUser: { id: 'u1', email: 'kevin@bmave.com', name: 'Kevin', role: 'super_admin', locationId: null },
      currentLocation: null,
      currentSubscription: null,
    }))

    await clickByText(host, 'Locations')
    await clickByText(host, 'Kansas City')

    // The sheet is open (its header renders "Bee Organized <name>")…
    expect(host.textContent).toContain('Bee Organized Kansas City')
    // …and the demo Team list rendered: its header interpolates
    // calcRenewalTotal(…, livePrices) and each row calls getTierPrice(role) —
    // the two identifiers 36c2183 left unbound. Before the fix this click
    // threw `ReferenceError: livePrices is not defined`.
    expect(host.textContent).toMatch(/Team · \$[\d,]+\/yr/)
    expect(host.textContent).toMatch(/\$[\d,]+\/yr|TBD/)
  })
})

describe('LocationDrilldown mounts with the seat roster bound', () => {
  it('Team tab renders the scheduled-removal roster from /api/seats', async () => {
    const host = await mount(React.createElement(LocationDrilldown as any, {
      loc: LOC,
      people: [],
      users: [{ id: 'hu1', locationId: 'loc_kc', name: 'Lynette Ewy', email: 'lewy@x.com', role: 'owner', status: 'active', initials: 'LE' }],
      partners: [],
      onClose: () => {},
    }))

    // Team tab: before the fix, rendering it threw
    // `ReferenceError: locationSeats is not defined` at the roster filter.
    await clickByText(host, 'Team')

    expect(host.textContent).toContain('Lynette Ewy')
    expect(host.textContent).toContain('Scheduled for removal at renewal')
    expect(host.textContent).toContain('Removal scheduled')
  })
})
