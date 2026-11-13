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
import * as BeeHubModule from '@/components/BeeHub'
// Not in BeeHub.d.ts (like most of that file's exports), so read it untyped
// rather than add to the known type-error count.
const CurrentLocationContext = (BeeHubModule as any).CurrentLocationContext as React.Context<any>
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
  'location', 'team', 'tags',         // Your business (tags: 2026-10-16). Bees is NOT a
                                      // section: it is the lower half of 'team' (2026-11-12).
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

  // A manager may manage the location's OWN tags (2026-10-16, Kevin) and its
  // bee roster. The roster lives on Team and Seats (2026-11-12), so that item
  // joins Profile and Tags — and NOTHING else does. What a manager finds
  // behind it is pinned in 'Team and Seats — two halves, two gates' below:
  // the nav item alone says nothing about which half they get.
  it('manager sees Profile, Team and Seats, and Tags — nothing else', async () => {
    expect(await sectionKeys('manager')).toEqual(['profile', 'team', 'tags'])
  })

  it('there is no Bees entry in the settings nav, for any role', async () => {
    for (const fr of ['owner', 'manager', 'viewer', 'some-future-role']) {
      const keys = await sectionKeys(fr)
      expect(keys, `role='${fr}'`).not.toContain('bees')
      for (const nav of Array.from(container.querySelectorAll('[data-settings-nav]'))) {
        const labels = Array.from(nav.querySelectorAll('[data-section]')).map(b => b.textContent || '')
        expect(labels.filter(l => /bees/i.test(l)), `role='${fr}' nav labels`).toEqual([])
      }
    }
  })

  it('the item is spelled "Team and Seats" — on the nav, and nowhere in the app is it "Team and seats"', async () => {
    await sectionKeys('owner')
    const item = container.querySelector('[data-settings-nav="rail"] [data-section="team"]')!
    expect(item.textContent).toContain('Team and Seats')
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : /\.(jsx?|tsx?)$/.test(n) && !/\.test\./.test(n) ? [p] : []
    })
    const offenders = [...walk('components'), ...walk('app')].filter(p => /Team (and|&) seats/.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
    expect(readFileSync('docs/screen-map.json', 'utf8')).not.toMatch(/Team (and|&) seats/)
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

  it("lite_user's Profile is genuinely useful: the Booking link self-edit field renders (1bc9fa5)", async () => {
    await sectionKeys('viewer')
    expect(container.querySelector('[data-settings-row="Booking link"] button[aria-label="Edit Booking link"]')).toBeTruthy()
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
// Team and Seats — two halves, two gates (2026-11-12).
//
// The screen used to be owner-only as a whole. It is open to managers now,
// because the bee roster moved onto it — and the thing that must NOT follow a
// manager through that door is seats: the roster of logins, the invite
// button, the billing strip, the seat pool. So these do not stop at "the
// manager sees Bees". They pin that the Seats half is not in the document at
// all, that its component never mounts (its requests never fire), and that
// no deep link — 'team', the old 'billing' alias that opens the billing
// footer expanded, or the day-old 'bees' key — gets a manager any of it.
// The server-side half of the same promise (a manager calling the seats
// routes directly) is lib/beta-team-seats-manager.test.ts.
describe('Team and Seats — two halves, two gates', () => {
  // Everything the Seats half says or offers. If any of these reaches a
  // manager's screen, seats followed them through the door.
  const SEATS_ONLY_TEXT = [
    'Team Members', '+ Invite', 'Billing & seat details', 'Your seats this year', 'Seat roster',
    'Pre-buy seats', 'Subscription active', 'Sponsored by Bee Organized', 'Prepaid by Bee Organized',
    'Manage billing in Stripe', 'View billing history', 'People who sign in', 'Who can sign in',
  ]
  // Requests that belong to the Seats half. Belt and braces only: on mount
  // that half reads its seats from SeatsContext and asks the server nothing
  // (checked — an owner's mount makes none of these either), so the DOM
  // assertions are what carry the weight. This catches a later change that
  // gives the half a mount-time fetch and forgets the gate.
  const SEATS_ONLY_REQUEST = /\/api\/(seats|pending_invites|hub_users|billing|locations\/[^/]+\/(billing|convert))/

  let fetchMock: ReturnType<typeof vi.fn>
  const mount = async (franchiseRole: string, initialSection: string) => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    // A REAL location (a uuid), so both halves do what they do in production:
    // the Bees half fetches its roster, and the Seats half gets a location to
    // manage. With the demo-id default neither half asks the server anything
    // and "no seats requests" would be true of everyone.
    await act(async () => {
      root.render(
        <CurrentUserContext.Provider value={currentUser}>
          <CurrentLocationContext.Provider value={{ id: LOC_UUID, location_id: 'loc_test', name: 'Test Territory' } as any}>
            <SettingsScreen initialSection={initialSection} franchiseRole={franchiseRole} />
          </CurrentLocationContext.Provider>
        </CurrentUserContext.Provider>,
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  const LOC_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const BEES_URL = `/api/locations/${LOC_UUID}/bees`
  // The Bees half is named for the location (so an admin can tell whose it is).
  const BEES_HEADING = 'Test Territory’s bees'
  const urls = () => fetchMock.mock.calls.map((a: any[]) => String(a[0]))
  const headings = () => Array.from(container.querySelectorAll('[data-team-screen] h2')).map(h => h.textContent)

  const expectNoSeats = (why: string) => {
    expect(container.querySelector('[data-team-seats]'), `${why}: the Seats block`).toBeNull()
    expect(container.querySelector('[data-team-seats-section]'), `${why}: the Seats heading`).toBeNull()
    for (const t of SEATS_ONLY_TEXT) expect(container.textContent, `${why}: '${t}'`).not.toContain(t)
    expect(urls().filter(u => SEATS_ONLY_REQUEST.test(u)), `${why}: seats requests`).toEqual([])
  }

  it('an owner sees both halves, Seats first, each saying what makes it different', async () => {
    await mount('owner', 'team')
    expect(headings()).toEqual(['Seats', BEES_HEADING])
    const seats = container.querySelector('[data-team-seats]')!
    const bees = container.querySelector('[data-team-bees]')!
    expect(seats.compareDocumentPosition(bees) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('[data-team-seats-section]')!.textContent).toContain('People who sign in. Each seat is billed.')
    expect(bees.textContent).toContain('nobody here signs in to Bee Hub and nobody is billed')
    // The Seats half is still the whole old screen: roster, invite, billing footer.
    for (const t of ['Team Members', '+ Invite', 'Billing & seat details']) expect(seats.textContent).toContain(t)
    // …and the list SEATS_ONLY_TEXT guards with is real: every always-on line of it is on an owner's screen.
    for (const t of ['Team Members', '+ Invite', 'Billing & seat details', 'People who sign in', 'Who can sign in']) {
      expect(container.textContent, `owner: '${t}'`).toContain(t)
    }
  })

  it('a manager sees Team and Seats with Bees — and no Seats half at all', async () => {
    await mount('manager', 'team')
    expect(currentKey()).toBe('team')
    expect(container.textContent).not.toContain("You don't have access to this section")
    expect(headings()).toEqual([BEES_HEADING])
    expect(container.querySelector('[data-team-bees]')).toBeTruthy()
    expect(container.querySelector('[data-team-lede]')!.textContent).toBe('The people who work your jobs.')
    // Their half is live — it asked for this location's roster…
    expect(urls()).toContain(BEES_URL)
    // …and the other half is not there.
    expectNoSeats('manager on team')
  })

  it("a manager on the old 'billing' deep link (which opens the billing footer expanded for an owner) still gets no Seats half", async () => {
    await mount('owner', 'billing')
    expect(container.textContent).toContain('Your seats this year')   // the link really does expand it — for an owner
    act(() => root.unmount()); root = createRoot(container)
    await mount('manager', 'billing')
    expect(currentKey()).toBe('team')
    expect(headings()).toEqual([BEES_HEADING])
    expectNoSeats('manager on billing')
  })

  it("the day-old 'bees' key is an alias for the screen, for owner and manager", async () => {
    await mount('manager', 'bees')
    expect(currentKey()).toBe('team')
    expect(headings()).toEqual([BEES_HEADING])
    expectNoSeats('manager on bees')
  })

  it('every other role gets NEITHER half: no-access notice, no bees, no seats, by any of the three keys', async () => {
    for (const fr of ['viewer', ...READ_ONLY_FRANCHISE_ROLES, 'some-future-role-nobody-produces']) {
      for (const key of ['team', 'billing', 'bees']) {
        act(() => root.unmount()); root = createRoot(container)
        await mount(fr, key)
        const why = `role='${fr}' key='${key}'`
        expect(container.textContent, why).toContain("You don't have access to this section")
        expect(container.querySelector('[data-team-screen]'), why).toBeNull()
        expect(container.querySelector('[data-team-bees]'), why).toBeNull()
        expect(urls().filter(u => /\/bees/.test(u)), why).toEqual([])
        expectNoSeats(why)
      }
    }
  })

  it('the eyebrow on this screen is the readable gold (brand.goldText), not the decorative one', async () => {
    const { T } = await import('@/components/hive/shared/tokens')
    await mount('owner', 'team')
    const eyebrow = Array.from(container.querySelectorAll('[data-team-screen] p')).find(p => p.textContent === 'Your business') as HTMLElement
    const hex = (c: string) => c.startsWith('rgb') ? '#' + c.match(/\d+/g)!.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('') : c
    expect(hex(eyebrow.style.color).toLowerCase()).toBe(T.brand.goldText.toLowerCase())
    // 4.5:1 on white, computed — not trusted from a comment.
    const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
    expect(1.05 / (lum(T.brand.goldText) + 0.05)).toBeGreaterThanOrEqual(4.5)
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

  it('a manager sees ONLY the groups that have a visible item', async () => {
    await mountRole('manager')
    const rail = container.querySelector('[data-settings-nav="rail"]')!
    expect(groupTitles(rail)).toEqual(['You', 'Your business'])   // Your business: Team and Seats + Tags only
    expect(Array.from(rail.querySelectorAll('[data-section]')).map(b => b.getAttribute('data-section'))).toEqual(['profile', 'team', 'tags'])
    expect(rail.textContent).not.toContain('Location')
    // Belt and braces: not a single header of the owner-only groups survives.
    for (const gone of ['Client messages', 'Notifications', 'Connections']) {
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
