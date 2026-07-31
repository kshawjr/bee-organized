// @vitest-environment happy-dom
//
// issue 139 — Reports is a Coming Soon state, nothing behind it.
//
// The Gen 1 franchise Reports (revenue trend, pipeline, funnel, sources, service
// types, partner referrals) were mock-shaped and stale; franchise owners could
// still reach them. They were PURGED. Reports now renders the shared, section-
// agnostic ComingSoonPlaceholder — the SAME screen for every role — and the nav
// entry carries no role lock.
//
// These are REAL mount tests: the extracted component is rendered directly, and
// Reports is exercised by mounting the actual App on initialRoute='reports' for
// each role. The source-pin over-deletion guard is kept ONLY where a mount
// genuinely can't reach it (see its note below).
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ComingSoonPlaceholder from '@/components/hive/ComingSoonPlaceholder'

// useLeadsRealtime calls createClient(), which THROWS on missing env. It is
// guarded, but set the vars so the mount exercises the real path.
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/reports',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

async function render(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(el) })
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

describe('ComingSoonPlaceholder — the extracted, section-agnostic component', () => {
  it('renders the title and body it is handed', async () => {
    const host = await render(
      React.createElement(ComingSoonPlaceholder, {
        title: 'Reports are coming soon',
        body: 'Your leads, jobs, and revenue, all in one place.',
      }),
    )
    expect(host.textContent).toContain('Reports are coming soon')
    expect(host.textContent).toContain('Your leads, jobs, and revenue, all in one place.')
  })

  it('is section-agnostic — issue 140 can pass "Back Office" with no code change', async () => {
    const host = await render(
      React.createElement(ComingSoonPlaceholder, {
        title: 'Back Office is coming soon',
        body: 'Payroll, scheduling, and more are on the way.',
      }),
    )
    expect(host.textContent).toContain('Back Office is coming soon')
    expect(host.textContent).toContain('Payroll, scheduling, and more are on the way.')
    // no leftover Reports-specific copy leaks in
    expect(host.textContent).not.toContain('Reports')
  })
})

// Mount the real App on the Reports route. HiveShell (the Clients lens) is a
// next/dynamic ssr:false chunk that renders `loading: () => null` under vitest,
// but Reports is NOT lazy — ReportsScreen renders inline in screen(), so its
// content is fully present here.
import App from '@/components/BeeHub'

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'

const baseProps = (over: any = {}) => ({
  initialRoute: 'reports',
  initialRole: 'super_admin',
  initialFranchiseRole: 'owner',
  initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
  initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
  initialPeople: [], initialBinPeople: [], initialTransferPeople: [],
  initialEngagements: [], initialPartners: [], initialCompanies: [],
  initialGuideSlides: [], initialManualSlides: [], initialTierPrices: [],
  currentUser: { id: 'u1', email: 'kevin@bmave.com', name: 'Kevin', role: 'super_admin', locationId: null },
  currentLocation: null, currentSubscription: null,
  initialLocFilter: KC, initialScopeLocationId: KC,
  ...over,
})

// (role, franchiseRole, currentUser.role) triples covering the four audiences
// the follow-up names. locationId is set for the non-elevated pair so they mount
// as a scoped franchise user, not mid-onboarding.
const ROLES = [
  { label: 'owner',       props: { initialRole: 'franchise', initialFranchiseRole: 'owner',   currentUser: { id: 'o', email: 'o@x.com', name: 'O', role: 'owner',   locationId: KC } } },
  { label: 'manager',     props: { initialRole: 'franchise', initialFranchiseRole: 'manager', currentUser: { id: 'm', email: 'm@x.com', name: 'M', role: 'manager', locationId: KC } } },
  { label: 'super_admin', props: { initialRole: 'super_admin', initialFranchiseRole: 'owner', currentUser: { id: 's', email: 's@x.com', name: 'S', role: 'super_admin', locationId: null } } },
  { label: 'corporate',   props: { initialRole: 'corporate',   initialFranchiseRole: 'owner', currentUser: { id: 'c', email: 'c@x.com', name: 'C', role: 'corporate',   locationId: null } } },
]

describe('Reports route — identical Coming Soon for every role (issue 139)', () => {
  for (const { label, props } of ROLES) {
    it(`${label} clicking Reports gets the Coming Soon state, no report content`, async () => {
      const host = await render(React.createElement(App as any, baseProps(props)))
      const txt = host.textContent || ''
      // the Coming Soon copy is present…
      expect(txt).toContain('Reports are coming soon')
      // …and NO Gen 1 report section renders for this role
      for (const gone of ['Revenue Trend', 'My Pipeline', 'Conversion Funnel', 'Partner Referrals', 'Service Types']) {
        expect(txt, `${label} must not see "${gone}"`).not.toContain(gone)
      }
    })
  }
})

describe('Reports over-deletion guard — shared helpers stay (issue 139)', () => {
  // WHY A SOURCE PIN HERE: these helpers are consumed by the admin Location
  // drilldown (LocationDetailSheet), which is only reachable behind a demo-only
  // trigger with no stable mount path in this suite (see the LocationDrilldown
  // "no UI trigger" note in project memory). A mount can't reliably exercise it,
  // so this stays a source assertion — deleting BarChart / seedRevByLoc /
  // REPORT_MONTHS / REPORT_REVENUE_BY_MONTH as "report code" would silently break
  // that live elevated surface (the #136 lesson in reverse).
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  it('BarChart / seedRevByLoc / REPORT_MONTHS / REPORT_REVENUE_BY_MONTH are retained', () => {
    expect(beehub).toContain('function BarChart(')
    expect(beehub).toContain('function seedRevByLoc(')
    expect(beehub).toContain('const REPORT_MONTHS =')
    expect(beehub).toContain('const REPORT_REVENUE_BY_MONTH =')
  })
})
