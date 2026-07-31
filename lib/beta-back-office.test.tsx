// @vitest-environment happy-dom
//
// issue 140 — Back Office tab.
//
// One nav tab, TWO deliberately-different screens behind it (the split lives in
// BeeHub's screen()):
//   · super_admin           → BackOfficeScreen     (a visibly-distinct WIP stub)
//   · every other role       → BackOfficeComingSoon (the shared issue-139
//                              ComingSoonPlaceholder, title "Back Office")
// The tab is shown to EVERY role (no isLocked dimming) on purpose — build
// anticipation, don't hide.
//
// These are REAL mount tests: the actual App is mounted on initialRoute for each
// role and the rendered DOM is asserted. The whole point of issue 140 is that the
// two paths must NOT render the same thing (the issue 136 trap), so each split
// test asserts BOTH what shows AND what must be absent.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// useLeadsRealtime calls createClient(), which THROWS on missing env. It is
// guarded, but set the vars so the mount exercises the real path.
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/backoffice',
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

import App from '@/components/BeeHub'

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'

const baseProps = (over: any = {}) => ({
  initialRoute: 'backoffice',
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

// (role, franchiseRole, currentUser.role) triples covering the four audiences.
// locationId is set for the non-elevated pair so they mount as a scoped
// franchise user, not mid-onboarding.
const ROLES = [
  { label: 'owner',       elevated: false, superAdmin: false, props: { initialRole: 'franchise', initialFranchiseRole: 'owner',   currentUser: { id: 'o', email: 'o@x.com', name: 'O', role: 'owner',   locationId: KC } } },
  { label: 'manager',     elevated: false, superAdmin: false, props: { initialRole: 'franchise', initialFranchiseRole: 'manager', currentUser: { id: 'm', email: 'm@x.com', name: 'M', role: 'manager', locationId: KC } } },
  { label: 'super_admin', elevated: true,  superAdmin: true,  props: { initialRole: 'super_admin', initialFranchiseRole: 'owner', currentUser: { id: 's', email: 's@x.com', name: 'S', role: 'super_admin', locationId: null } } },
  { label: 'corporate',   elevated: true,  superAdmin: false, props: { initialRole: 'corporate',   initialFranchiseRole: 'owner', currentUser: { id: 'c', email: 'c@x.com', name: 'C', role: 'corporate',   locationId: null } } },
]

// Distinctive strings — chosen so nav labels can never satisfy a screen
// assertion and the two screens can never satisfy each other's.
const PLACEHOLDER_BODY = 'building a new Back Office' // BackOfficeComingSoon only
const WIP_HEADING      = 'Back Office build zone'     // BackOfficeScreen only
const WIP_BADGE        = 'Work in progress'           // BackOfficeScreen only

describe('Back Office tab is present in the nav for every role (issue 140)', () => {
  for (const { label, props } of ROLES) {
    it(`${label} sees the Back Office nav entry`, async () => {
      // Mount on the Reports route (known-mountable, issue 139) so any
      // "Back Office" text can ONLY come from the nav entry — the Reports
      // screen never says "Back Office".
      const host = await render(React.createElement(App as any, baseProps({ ...props, initialRoute: 'reports' })))
      expect(host.textContent || '').toContain('Back Office')
      // and no pre-existing tab was dropped
      for (const tab of ['Home', 'Clients', 'Network', 'Reports', 'Settings']) {
        expect(host.textContent, `${label} nav must still show "${tab}"`).toContain(tab)
      }
    })
  }
})

describe('Back Office render split — super_admin vs everyone else (issue 140)', () => {
  for (const { label, props, superAdmin } of ROLES) {
    it(`${label} lands on the ${superAdmin ? 'WIP build-out surface' : 'shared Coming Soon'}, not the other`, async () => {
      const host = await render(React.createElement(App as any, baseProps(props)))
      const txt = host.textContent || ''
      if (superAdmin) {
        // super_admin → the real BackOfficeScreen stub…
        expect(txt).toContain(WIP_HEADING)
        expect(txt).toContain(WIP_BADGE)
        // …and NOT the placeholder (the anti-#136 guarantee)
        expect(txt, 'super_admin must NOT render the Coming Soon placeholder').not.toContain(PLACEHOLDER_BODY)
      } else {
        // everyone else → the shared ComingSoonPlaceholder…
        expect(txt).toContain(PLACEHOLDER_BODY)
        // …and NOT the super-admin build-out surface
        expect(txt, `${label} must NOT render the super-admin build-out surface`).not.toContain(WIP_HEADING)
        expect(txt, `${label} must NOT render the WIP badge`).not.toContain(WIP_BADGE)
      }
    })
  }
})

describe('Back Office did not disturb the rest of the nav (issue 140)', () => {
  it('Back Office sits between Reports and Settings; existing order preserved', async () => {
    const host = await render(React.createElement(App as any, baseProps({ initialRoute: 'reports' })))
    // Pull the nav label sequence straight off the rendered nav buttons so the
    // screen body can't pollute the ordering.
    const KNOWN = ['Home', 'Clients', 'Network', 'Reports', 'Back Office', 'Settings']
    const seq = Array.from(host.querySelectorAll('button'))
      .map(b => (b.textContent || '').trim())
      .map(t => KNOWN.find(k => t === k || t.endsWith(k)))
      .filter((v, i, a): v is string => !!v && a.indexOf(v) === i) // first occurrence, in DOM order
    expect(seq).toEqual(KNOWN)
  })
})
