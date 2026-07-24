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
// Read from the mobile <select> options — that IS the `sections` array, one
// option per entry, so this sees exactly what the role can reach (the pill
// row renders from the same array).
const sectionKeys = async (franchiseRole?: string): Promise<string[]> => {
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={currentUser}>
        <SettingsScreen initialSection="profile" {...(franchiseRole !== undefined ? { franchiseRole } : {})} />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
  const select = container.querySelector('select[aria-label="Settings section"]')
  expect(select, 'the section select').toBeTruthy()
  return Array.from(select!.querySelectorAll('option')).map(o => (o as HTMLOptionElement).value)
}

const ALL_SECTIONS = ['profile', 'location', 'team', 'billing', 'paths', 'templates', 'automation', 'notifs']

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

describe('betaGate read-only vocabulary', () => {
  it("isReadOnlyFranchiseRole covers 'viewer' — the value a real lite_user session carries", () => {
    expect(isReadOnlyFranchiseRole('viewer')).toBe(true)
    expect(isReadOnlyFranchiseRole('light')).toBe(true)
    expect(isReadOnlyFranchiseRole('readonly')).toBe(true)
    expect(isReadOnlyFranchiseRole('owner')).toBe(false)
    expect(isReadOnlyFranchiseRole('manager')).toBe(false)
  })
})
