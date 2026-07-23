// @vitest-environment happy-dom
//
// Home actually MOUNTS — on the 'all' path and on a scoped path.
//
// WHY THIS EXISTS. Phase 4 shipped `allOverview={allOverview}` inside App's
// DashboardScreen mount, where the prop is named `initialAllOverview`. In App's
// scope `allOverview` is unbound, so creating the element threw:
//
//     ReferenceError: allOverview is not defined
//
// Home was down for EVERY user — elevated and franchise, 'all' and scoped —
// because that JSX prop is evaluated whenever the element is created, not only
// on the scope the prop is for. Other tabs return earlier in screen() and were
// unaffected.
//
// Every Phase 1–4 test was a SOURCE-PIN test (readFileSync + toContain). Those
// cannot catch an unbound identifier: the string is present, it just doesn't
// resolve at runtime. BeeHub.jsx is JS, so `next build` type-checking cannot
// catch it either. Only executing the render does.
//
// So: mount the real App, on the real Home route, on both paths. An unbound
// identifier anywhere in Home's render path now fails the suite.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// useLeadsRealtime calls createClient(), which THROWS on missing env. It is
// guarded (a passive effect that degrades to no-realtime), but set the vars
// anyway so the mount exercises the real path rather than the catch.
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

// NOTE: App's lens content (HiveShell) is a next/dynamic chunk with ssr:false.
// It does not resolve under vitest — it renders its `loading: () => null`
// placeholder — so these App-level mounts cover the SHELL and Home only.
// Asserting lens content here would assert against an empty container and pass
// for the wrong reason. The lens gating is mounted directly in
// lib/beta-hiveshell-all-scope.test.tsx instead.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any

import App from '@/components/BeeHub'

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'

const OVERVIEW = {
  newUncontacted: { count: 4, oldestDays: 12 },
  estimateFollowUps: { count: 2, oldestDays: 9 },
  upcomingAssessments: [{ id: 'a1', scheduled_at: new Date().toISOString(), client: 'Sarah M' }],
  agingInvoices: { count: 3, total: 1234.5, oldestDays: 40 },
  openEngagementsCount: 292,
  activeClientsCount: 285,
  newThisWeekCount: 111,
  outstandingTotal: 9876,
  leadCount: 7028,
  truncated: false,
}

const baseProps = (over: any = {}) => ({
  initialRoute: 'home',
  initialRole: 'super_admin',
  initialFranchiseRole: 'owner',
  initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
  initialUsers: [],
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
  ...over,
})

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

async function mountApp(props: any) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  // React logs render errors to console.error even when they propagate; keep
  // the output readable while still letting the throw surface.
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(React.createElement(App as any, props)) })
  // HiveShell / IdentityScopeControl are next/dynamic with ssr:false, so the
  // lens content arrives on a later tick than the shell. Flush real macrotasks
  // until it lands — a microtask turn is not enough for a lazy chunk, and
  // asserting too early would test the `loading: () => null` placeholder.
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

describe('Home mounts without unbound identifiers', () => {
  it("renders on the 'all' path (server overview present)", async () => {
    // THE regression: this threw ReferenceError: allOverview is not defined.
    const host = await mountApp(baseProps({
      initialLocFilter: 'all',
      initialScopeLocationId: null,
      initialAllOverview: OVERVIEW,
    }))
    expect(host.textContent).toBeTruthy()
    // The overview's numbers reached the hero, so the prop is genuinely wired
    // through — not merely defined.
    expect(host.textContent).toContain('4 new leads not contacted')
    expect(host.textContent).toContain('2 estimates awaiting follow-up')
  })

  it('renders on a SCOPED path (no overview)', async () => {
    // The same JSX prop is evaluated here too, which is why the bug took Home
    // down for franchise users and scoped elevated users as well.
    const host = await mountApp(baseProps({
      initialLocFilter: KC,
      initialScopeLocationId: KC,
      initialAllOverview: null,
    }))
    expect(host.textContent).toBeTruthy()
  })

  it('renders for a NON-ELEVATED user', async () => {
    const host = await mountApp(baseProps({
      initialRole: 'franchise',
      initialFranchiseRole: 'owner',
      initialLocFilter: KC,
      initialScopeLocationId: KC,
      initialAllOverview: null,
      currentUser: { id: 'u2', email: 'owner@x.com', name: 'Owner', role: 'owner', locationId: KC },
      currentLocation: { id: KC, name: 'Kansas City', jobber_connected: false, jobber_account_id: null, last_sync_status: null, token_expiry: null },
    }))
    expect(host.textContent).toBeTruthy()
  })

  it('renders the truncation notice when the load was short', async () => {
    // The banner is the user-visible half of the MAX_LEADS fix; if its
    // identifiers were unbound it would take Home down exactly like this bug.
    const host = await mountApp(baseProps({
      initialLocFilter: KC,
      initialScopeLocationId: KC,
      initialAllOverview: null,
      initialLeadsTruncated: true,
    }))
    expect(host.textContent).toContain("Some records weren't loaded")
  })

  it('renders with NO Phase-4 props at all (older/demo mount)', async () => {
    // Every new prop must be optional. A mount that predates them must not
    // throw on a missing binding or a missing default.
    const host = await mountApp(baseProps({ initialLocFilter: 'all' }))
    expect(host.textContent).toBeTruthy()
  })
})
