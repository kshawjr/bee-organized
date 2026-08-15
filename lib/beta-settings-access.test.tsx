// @vitest-environment happy-dom
//
// Settings section access by franchiseRole — MOUNT tests of SettingsScreen.
//
// Regression suite for the lite_user Settings over-exposure: the nav lockout
// checked franchiseRole==='readonly' while mapRole (app/_hub-page.tsx) emits
// 'viewer' for a real lite_user session — the strings never matched, the
// lockout silently never fired, and inside SettingsScreen the section list
// was a MANAGER denylist, so 'viewer' saw My Location / Communication /
// Templates / Automation / Alerts. Both strings existed in the source, just
// never equal — which is why these are mount tests, not source pins: a source
// pin on either string would have passed throughout.
//
// The fix: the section list is an ALLOWLIST on franchiseRole==='owner'
// (a value mapRole actually produces), with Profile — a self-edit via
// PATCH /api/hub_users/me, including the booking link — for everyone. The
// divergence guard here is the fails-closed property: ANY franchiseRole
// string that is not exactly 'owner', including ones invented after this
// test was written, gets Profile only. If the vocabularies drift again the
// result is a too-small Settings, never a config leak.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen, CurrentUserContext } from '@/components/BeeHub'
import { READ_ONLY_FRANCHISE_ROLES, isReadOnlyFranchiseRole } from '@/components/hive/shared/betaGate'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const currentUser = {
  id: '9a8b7c6d-1111-4222-8333-444455556666',
  email: 'user@bee.test',
  name: 'Riley Park',
  role: 'franchise',
  locationId: 'loc-uuid-1',
  first_name: 'Riley',
  last_name: 'Park',
  phone: '(206) 555-0100',
  booking_link: null,
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// Mount SettingsScreen for a role and return the section keys it offers.
// Read from the DESKTOP RAIL (issue 246 step 1 — this used to read the mobile
// <select>, which is gone). Both navs render from the same SECTION_GROUPS, so
// either would do; the rail is asserted to match the drill-down below.
const sectionKeys = async (franchiseRole?: string): Promise<string[]> => {
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={currentUser}>
        <SettingsScreen initialSection="profile" {...(franchiseRole !== undefined ? { franchiseRole } : {})} />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
  return railKeys()
}

const railKeys = (): string[] => {
  const rail = container.querySelector('[data-settings-nav="rail"]')
  expect(rail, 'the settings rail').toBeTruthy()
  return Array.from(rail!.querySelectorAll('[data-section]')).map(b => b.getAttribute('data-section')!)
}

// Which section the nav says is current.
const currentKey = (): string | null =>
  container.querySelector('[data-settings-nav="rail"] [aria-current="page"]')?.getAttribute('data-section') ?? null

// 'billing' is gone as a standalone section (merged into 'team' — Team &
// Billing); it survives only as an initialSection alias, pinned below.
// 'automation' and 'notifs' are gone outright (issue 240 step 1) — the first
// was a hard-coded explainer for emails that do not exist, the second rendered
// toggles that were never fetched and never saved. Neither left an alias: a
// deep link to either now falls through sectionAllowed to the no-access
// notice, which is the honest outcome for a section that no longer exists.
// 'paths' and 'templates' became 'emails' / 'yourteam' / 'texts' (issue 240
// step 4). Unlike automation/notifs these did NOT go away — they were split by
// what an owner is doing, so both old keys stay live as deep-link aliases and
// are pinned in lib/beta-comms-tabs-240.test.tsx.
//
// 'yourteam' joined them as an alias in issue 246 step 1: it split three ways
// and stopped being a section. The order below is the RAIL order — group by
// group, top to bottom.
const ALL_SECTIONS = [
  'profile',                          // You
  'location', 'team',                 // Your business
  'emails', 'texts',                  // Client messages
  'newleads',                         // Notifications
  'slack', 'jobber', 'mailchimp',     // Connections
]

describe('SettingsScreen sections by franchiseRole', () => {
  it("owner sees the full section list (and elevated mounts pass franchiseRole='owner', so this also covers admin/super_admin)", async () => {
    expect(await sectionKeys('owner')).toEqual(ALL_SECTIONS)
  })

  it('the default mount (no franchiseRole prop) stays owner — unchanged', async () => {
    expect(await sectionKeys(undefined)).toEqual(ALL_SECTIONS)
  })

  it('manager sees Profile only — unchanged', async () => {
    expect(await sectionKeys('manager')).toEqual(['profile'])
  })

  it("lite_user (franchiseRole 'viewer' — what mapRole actually emits) sees Profile only, no config sections", async () => {
    expect(await sectionKeys('viewer')).toEqual(['profile'])
  })

  it('every role in the canonical read-only set gets Profile only (covers view-as light/readonly, and any alias added to the set later)', async () => {
    for (const fr of READ_ONLY_FRANCHISE_ROLES) {
      expect(await sectionKeys(fr), `franchiseRole='${fr}'`).toEqual(['profile'])
    }
  })

  it('DIVERGENCE GUARD: an unknown franchiseRole string fails CLOSED to Profile only', async () => {
    // If a producer ever emits a new string (the exact mechanism of the
    // 'viewer' vs 'readonly' bug), the allowlist must show LESS, never more.
    expect(await sectionKeys('some-future-role-nobody-produces')).toEqual(['profile'])
  })

  it("lite_user's Profile is genuinely useful: the Booking Link self-edit field renders (1bc9fa5)", async () => {
    await sectionKeys('viewer')
    expect(container.textContent).toContain('Booking Link')
  })
})

describe('Team & Billing merge', () => {
  const mount = async (initialSection: string) => {
    await act(async () => {
      root.render(
        <CurrentUserContext.Provider value={currentUser}>
          <SettingsScreen initialSection={initialSection} franchiseRole="owner" />
        </CurrentUserContext.Provider>,
      )
    })
    await act(async () => {})
  }

  it("initialSection='billing' is an alias — lands on the merged team section, not the no-access notice", async () => {
    await mount('billing')
    expect(currentKey()).toBe('team')
    expect(container.textContent).not.toContain("You don't have access to this section")
    // The billing deep-link opens with the billing footer EXPANDED, so the
    // old destination's content (the seat pool) is immediately visible.
    expect(container.textContent).toContain('Your seats this year')
  })

  it('the merged section shows the roster AND a collapsed billing footer by default', async () => {
    await mount('team')
    expect(currentKey()).toBe('team')
    expect(container.textContent).toContain('Team Members')
    expect(container.textContent).toContain('Billing & seat details')
    // Collapsed: the seat pool only renders after the footer is expanded.
    expect(container.textContent).not.toContain('Your seats this year')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Issue 246 step 1 — the grouped rail must not out-run the role gate. The
// items were already conditionally mounted and still are; what is new is the
// GROUP, which is a second thing that can leak. A header reading "Connections"
// over an empty space tells a manager that Settings has surfaces they cannot
// reach, which is exactly what conditional mounting exists to avoid saying.
describe('groups never render empty (issue 246 step 1)', () => {
  const groupTitles = (nav: Element): string[] =>
    Array.from(nav.querySelectorAll('p')).map(p => p.textContent?.trim() ?? '')

  const mountRole = async (franchiseRole: string) => {
    await act(async () => {
      root.render(
        <CurrentUserContext.Provider value={currentUser}>
          <SettingsScreen initialSection="profile" franchiseRole={franchiseRole} />
        </CurrentUserContext.Provider>,
      )
    })
    await act(async () => {})
  }

  it('an owner sees all five groups', async () => {
    await mountRole('owner')
    const rail = container.querySelector('[data-settings-nav="rail"]')!
    expect(groupTitles(rail)).toEqual(['You', 'Your business', 'Client messages', 'Notifications', 'Connections'])
  })

  it('a manager sees ONLY the group that has a visible item', async () => {
    await mountRole('manager')
    const rail = container.querySelector('[data-settings-nav="rail"]')!
    expect(groupTitles(rail)).toEqual(['You'])
    // Belt and braces: not a single header of the owner-only groups survives.
    for (const gone of ['Your business', 'Client messages', 'Notifications', 'Connections']) {
      expect(rail.textContent, `group '${gone}'`).not.toContain(gone)
    }
  })

  it('every group that renders has at least one item, for every role', async () => {
    for (const fr of ['owner', 'manager', 'viewer', 'some-future-role']) {
      await mountRole(fr)
      for (const nav of Array.from(container.querySelectorAll('[data-settings-nav]'))) {
        for (const group of Array.from(nav.children)) {
          expect(
            group.querySelectorAll('[data-section]').length,
            `role='${fr}', group '${group.querySelector('p')?.textContent}'`,
          ).toBeGreaterThan(0)
        }
      }
    }
  })

  it('the mobile drill-down offers exactly what the desktop rail offers', async () => {
    // Two navs, one source. A role gate applied to one and not the other is
    // the same class of bug as the manager denylist this file was written for.
    for (const fr of ['owner', 'manager', 'viewer']) {
      await mountRole(fr)
      const drill = container.querySelector('[data-settings-nav="drill"]')!
      const drillKeys = Array.from(drill.querySelectorAll('[data-section]')).map(b => b.getAttribute('data-section'))
      expect(drillKeys, `franchiseRole='${fr}'`).toEqual(railKeys())
    }
  })

  it('a manager deep-linking to an owner section still gets the lock panel, not the section', async () => {
    await act(async () => {
      root.render(
        <CurrentUserContext.Provider value={currentUser}>
          <SettingsScreen initialSection="newleads" franchiseRole="manager" />
        </CurrentUserContext.Provider>,
      )
    })
    await act(async () => {})
    expect(container.textContent).toContain("You don't have access to this section")
    expect(container.textContent).toContain('🔒')
    // And the section itself did not render behind the panel.
    expect(container.textContent).not.toContain('Who hears about new leads')
  })
})

describe('betaGate read-only vocabulary', () => {
  it("isReadOnlyFranchiseRole covers 'viewer' — the value a real lite_user session carries", () => {
    expect(isReadOnlyFranchiseRole('viewer')).toBe(true)
    expect(isReadOnlyFranchiseRole('light')).toBe(true)
    expect(isReadOnlyFranchiseRole('readonly')).toBe(true)
    expect(isReadOnlyFranchiseRole('owner')).toBe(false)
    expect(isReadOnlyFranchiseRole('manager')).toBe(false)
  })
})
