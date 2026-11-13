// @vitest-environment happy-dom
//
// Settings slice 1 of 4 (2026-11-13) — the new look's shell and Profile.
// components/settings/SettingsShell.jsx draws; components/BeeHub.jsx still
// decides who sees what and does every save. These are the five things that
// slice promised would not move:
//
//   1 · every role sees exactly the sections it saw, and no group header
//       stands over nothing
//   2 · a deep link to a section a role cannot see still gets the polite
//       no-access notice
//   3 · Profile saves everything it saved
//   4 · Lato and Arvo are on Settings and nowhere else
//   5 · nothing outside Settings is touched
//
// MOUNT tests wherever the claim is about what a person sees; source sweeps
// only for "nowhere else", which no mount can show.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHubModule from '@/components/BeeHub'
// Neither is in BeeHub.d.ts; read untyped rather than add to the known type-error count.
const SettingsScreen = (BeeHubModule as any).SettingsScreen as React.ComponentType<any>
const CurrentUserContext = (BeeHubModule as any).CurrentUserContext as React.Context<any>
import { T, FONT, FONT_STYLESHEET_HREF } from '@/components/design/tokens'
import * as Shell from '@/components/settings/SettingsShell'
import { READ_ONLY_FRANCHISE_ROLES } from '@/components/hive/shared/betaGate'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const HUB = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const SHELL = readFileSync(join(process.cwd(), 'components/settings/SettingsShell.jsx'), 'utf8')
// The shell without its // comment lines — what actually runs.
const SHELL_CODE = SHELL.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

const currentUser = {
  id: '9a8b7c6d-1111-4222-8333-444455556666',
  email: 'riley@bee.test',
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
let fetchMock: ReturnType<typeof vi.fn>
let alerts: string[]

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  alerts = []
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  window.history.replaceState(null, '', '/')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mount = async (props: Record<string, any> = {}, user: any = currentUser) => {
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={user}>
        <SettingsScreen initialSection="profile" {...props} />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
}

const rail = () => container.querySelector('[data-settings-nav="rail"]')!
const drill = () => container.querySelector('[data-settings-nav="drill"]')!
const pane = () => drill().nextElementSibling as HTMLElement
// What a nav offers: [[group title, [section keys]], …] — exactly as drawn.
const offered = (nav: Element) =>
  Array.from(nav.children).map(g => [
    g.querySelector('p')?.textContent?.trim(),
    Array.from(g.querySelectorAll('[data-section]')).map(b => b.getAttribute('data-section')),
  ])
const NO_ACCESS = "You don't have access to this section"

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ROLE GATING
// ═══════════════════════════════════════════════════════════════════════════
// The export's nav has no roles in it. If the nav were rebuilt FROM the export
// a manager would be handed Location, Emails and Connections — links to
// screens the server refuses. The expected lists below are what each role saw
// on main before this slice (a03f889).
const OWNER = [
  ['You', ['profile']],
  ['Your business', ['location', 'team', 'tags']],
  ['Client messages', ['emails', 'texts']],
  ['Notifications', ['newleads']],
  ['Connections', ['slack', 'jobber', 'mailchimp']],
]
const MANAGER = [
  ['You', ['profile']],
  ['Your business', ['team', 'tags']],
]
const PROFILE_ONLY = [['You', ['profile']]]

describe('each role is offered exactly the sections it was, in both navs', () => {
  const cases: Array<[string, Record<string, any>, any[]]> = [
    ['owner', { franchiseRole: 'owner' }, OWNER],
    ['manager', { franchiseRole: 'manager' }, MANAGER],
    // Elevated mounts pass franchiseRole='owner' and isSuperAdmin.
    ['super_admin', { franchiseRole: 'owner', isSuperAdmin: true }, OWNER],
    ...READ_ONLY_FRANCHISE_ROLES.map(fr => [`read-only (${fr})`, { franchiseRole: fr }, PROFILE_ONLY] as [string, Record<string, any>, any[]]),
    ['a role nobody produces yet', { franchiseRole: 'some-future-role' }, PROFILE_ONLY],
  ]
  for (const [name, props, expected] of cases) {
    it(`${name}`, async () => {
      await mount(props)
      expect(offered(rail()), 'desktop rail').toEqual(expected)
      expect(offered(drill()), 'phone list').toEqual(expected)
    })
  }

  it('no group header stands over nothing, for any role', async () => {
    for (const fr of ['owner', 'manager', 'viewer', 'some-future-role']) {
      await mount({ franchiseRole: fr })
      for (const nav of [rail(), drill()]) {
        for (const [title, keys] of offered(nav) as Array<[string, string[]]>) {
          expect(keys.length, `role='${fr}': "${title}" has items`).toBeGreaterThan(0)
        }
      }
      // …and none of the owner-only group titles is anywhere on a manager's screen.
      if (fr !== 'owner') {
        for (const t of ['Client messages', 'Notifications', 'Connections']) {
          expect(container.textContent, `role='${fr}' sees no "${t}" header`).not.toContain(t)
        }
      }
    }
  })

  it('the names are today\'s names — the section list did not change in this slice', async () => {
    await mount({ franchiseRole: 'owner' })
    const labels = Array.from(rail().querySelectorAll('[data-section]')).map(b => b.textContent)
    expect(labels).toEqual(['Profile', 'Location', 'Team and Seats', 'Tags', 'Emails', 'Texts and scripts', 'New leads', 'Slack', 'Jobber', 'Mailchimp'])
  })

  it('the nav has no section list and no role in it — it draws what BeeHub hands it', () => {
    // The shell must not know a role exists…
    expect(SHELL_CODE).not.toMatch(/franchiseRole|ownerConfig|canManage|canSee|isSuperAdmin|manager|owner/i)
    // …and BeeHub hands both navs the SAME filtered list.
    expect(HUB).toContain('<SUI.SettingsRail groups={SECTION_GROUPS} active={activeSection} onOpen={openSection} />')
    expect(HUB).toContain('<SUI.SettingsDrill groups={SECTION_GROUPS} hidden={mobileDrilled} onOpen={openSection} />')
    // The predicates, word for word as they were on main.
    expect(HUB).toContain("...(ownerConfig   ? [{ key:'location', label:'Location',       icon:'📍' }] : []),")
    expect(HUB).toContain("...(canSeeTeamScreen ? [{ key:'team', label:'Team and Seats', icon:'👥' }] : []),")
    expect(HUB).toContain("...(canManageOwnTags ? [{ key:'tags', label:'Tags', icon:'🏷️' }] : []),")
    expect(HUB).toContain("{ title:'Client messages', items: ownerConfig ? [")
    expect(HUB).toContain("{ title:'Notifications', items: ownerConfig ? [")
    expect(HUB).toContain("{ title:'Connections', items: ownerConfig ? [")
    expect(HUB).toContain('].filter(g => g.items.length > 0)')
  })

  it('the current section is marked on the rail, and only one is', async () => {
    await mount({ franchiseRole: 'owner', initialSection: 'tags' })
    const current = Array.from(rail().querySelectorAll('[aria-current="page"]')).map(b => b.getAttribute('data-section'))
    expect(current).toEqual(['tags'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE NO-ACCESS NOTICE
// ═══════════════════════════════════════════════════════════════════════════
describe('a deep link to a section the role cannot see', () => {
  const blocked: Array<[string, string]> = [
    ['manager', 'location'], ['manager', 'emails'], ['manager', 'slack'], ['manager', 'newleads'],
    ['viewer', 'team'], ['viewer', 'tags'], ['viewer', 'emails'],
    ['some-future-role', 'location'],
  ]
  for (const [fr, section] of blocked) {
    it(`${fr} → ${section}: the notice, and none of that section`, async () => {
      await mount({ franchiseRole: fr, initialSection: section })
      expect(pane().textContent).toContain(NO_ACCESS)
      expect(pane().textContent).toContain('Go to Profile')
      // Nothing of a rebuilt page, and the nav did not grow the hidden item.
      expect(pane().querySelector('[data-settings-page]')).toBeNull()
      expect(rail().querySelector(`[data-section="${section}"]`)).toBeNull()
      expect(rail().querySelector('[aria-current="page"]')).toBeNull()
    })
  }

  it('it works from the address bar too (?section=), not only from a prop', async () => {
    window.history.replaceState(null, '', '/?section=emails')
    await mount({ franchiseRole: 'manager', initialSection: undefined })
    expect(pane().textContent).toContain(NO_ACCESS)
    expect(container.textContent).not.toContain('Everything about the emails your clients receive')
  })

  it('"Go to Profile" lands on the rebuilt Profile', async () => {
    await mount({ franchiseRole: 'manager', initialSection: 'emails' })
    const go = Array.from(pane().querySelectorAll('button')).find(b => b.textContent === 'Go to Profile')!
    await act(async () => { go.click() })
    expect(pane().textContent).not.toContain(NO_ACCESS)
    expect(pane().querySelector('[data-settings-page] h1')?.textContent).toBe('Profile')
  })

  it('Profile does not offer "Open Emails" to someone with no Emails section', async () => {
    // The old Profile showed its "now on Settings → Emails" link to everyone,
    // so a manager's click landed on the notice above.
    const openEmails = () => Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').includes('Open Emails'))
    await mount({ franchiseRole: 'manager' })
    expect(openEmails()).toBeUndefined()
    await mount({ franchiseRole: 'viewer' })
    expect(openEmails()).toBeUndefined()
    await mount({ franchiseRole: 'owner' })
    expect(openEmails()).toBeTruthy()
    await act(async () => { openEmails()!.click() })
    expect(rail().querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe('emails')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · PROFILE SAVES WHAT IT SAVED
// ═══════════════════════════════════════════════════════════════════════════
const row = (label: string) => {
  const r = container.querySelector(`[data-settings-row="${label}"]`)
  if (!r) throw new Error(`no row "${label}"`)
  return r as HTMLElement
}
const shown = (label: string) => (row(label).querySelector('[data-row-value]')?.textContent ?? '').trim()
const pencil = (label: string) => row(label).querySelector(`button[aria-label="Edit ${label}"]`) as HTMLButtonElement | null
const typeInto = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const key = async (input: HTMLInputElement, k: string) => {
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
  await act(async () => {})
}
const blur = async (input: HTMLInputElement) => {
  await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  await act(async () => {})
}
const open = async (label: string) => {
  await act(async () => { pencil(label)!.click() })
  return row(label).querySelector('input') as HTMLInputElement
}
const patches = () =>
  fetchMock.mock.calls
    .filter(c => String(c[0]) === '/api/hub_users/me' && (c[1] as any)?.method === 'PATCH')
    .map(c => JSON.parse(String((c[1] as any).body)))

describe('Profile: every row that saved still saves, to the same place', () => {
  const editable: Array<[string, string, string]> = [
    ['First name', 'first_name', 'Alex'],
    ['Last name', 'last_name', 'Nguyen'],
    ['Phone', 'phone', '(312) 555-0177'],
    ['Booking link', 'booking_link', 'https://calendly.com/alex'],
  ]
  for (const [label, column, value] of editable) {
    it(`${label} → PATCH /api/hub_users/me { ${column} } on Enter, and the row shows it`, async () => {
      await mount({ franchiseRole: 'owner' })
      const input = await open(label)
      await typeInto(input, value)
      await key(input, 'Enter')
      expect(patches()).toEqual([{ [column]: value }])
      expect(shown(label)).toBe(value)
      expect(row(label).textContent).toContain('Saved')
    })
  }

  it('the rows are the six there were — and only four can be edited', async () => {
    await mount({ franchiseRole: 'owner' })
    const labels = Array.from(container.querySelectorAll('[data-settings-row]')).map(r => r.getAttribute('data-settings-row'))
    expect(labels).toEqual(['First name', 'Last name', 'Email', 'Phone', 'Role', 'Booking link'])
    expect(labels.filter(l => pencil(l!))).toEqual(['First name', 'Last name', 'Phone', 'Booking link'])
    expect(shown('Email')).toBe('riley@bee.test')
    // Clicking a read-only value opens nothing.
    await act(async () => { (row('Email').querySelector('[data-row-value]') as HTMLElement).click() })
    expect(row('Email').querySelector('input')).toBeNull()
  })

  it('leaving the field saves too', async () => {
    await mount({ franchiseRole: 'owner' })
    const input = await open('Phone')
    await typeInto(input, '(312) 555-0177')
    await blur(input)
    expect(patches()).toEqual([{ phone: '(312) 555-0177' }])
  })

  it('clicking the VALUE opens the field, the same as the pencil', async () => {
    await mount({ franchiseRole: 'owner' })
    await act(async () => { (row('First name').querySelector('[data-row-value]') as HTMLElement).click() })
    expect(row('First name').querySelector('input')).toBeTruthy()
  })

  it('Enter saves ONCE — the blur that follows the field closing is not a second write', async () => {
    await mount({ franchiseRole: 'owner' })
    const input = await open('First name')
    await typeInto(input, 'Alex')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await act(async () => {})
    expect(patches()).toEqual([{ first_name: 'Alex' }])
  })

  it('Escape puts it back and writes nothing', async () => {
    await mount({ franchiseRole: 'owner' })
    const input = await open('First name')
    await typeInto(input, 'Alex')
    await key(input, 'Escape')
    expect(patches()).toEqual([])
    expect(shown('First name')).toBe('Riley')
    expect(row('First name').querySelector('input')).toBeNull()
  })

  it('an unchanged value writes nothing; spaces round the edges are trimmed, as before', async () => {
    await mount({ franchiseRole: 'owner' })
    let input = await open('First name')
    await key(input, 'Enter')
    input = await open('First name')
    await typeInto(input, '  Riley ')
    await key(input, 'Enter')
    expect(patches()).toEqual([])
    input = await open('Last name')
    await typeInto(input, '  Nguyen  ')
    await key(input, 'Enter')
    expect(patches()).toEqual([{ last_name: 'Nguyen' }])
  })

  it('clearing the booking link sends an empty string (the API stores null = use the location\'s)', async () => {
    await mount({ franchiseRole: 'owner' }, { ...currentUser, booking_link: 'https://cal.com/riley' })
    expect(shown('Booking link')).toBe('https://cal.com/riley')
    const input = await open('Booking link')
    await typeInto(input, '')
    await key(input, 'Enter')
    expect(patches()).toEqual([{ booking_link: '' }])
    expect(shown('Booking link')).toBe('Not set')
  })

  it('a refused write keeps the OLD value, tells the person, and never says Saved', async () => {
    fetchMock.mockImplementation(async (url: any, opts: any) =>
      String(url) === '/api/hub_users/me' && opts?.method === 'PATCH'
        ? { ok: false, status: 400, json: async () => ({ error: 'phone must be 10 digits' }) }
        : { ok: true, status: 200, json: async () => ({}) })
    await mount({ franchiseRole: 'owner' })
    const input = await open('Phone')
    await typeInto(input, '12')
    await key(input, 'Enter')
    expect(shown('Phone')).toBe('(206) 555-0100')
    expect(alerts.join('\n')).toContain('phone must be 10 digits')
    expect(row('Phone').textContent).not.toContain('Saved')
  })

  it('every role that has a Profile can save its own name', async () => {
    for (const fr of ['owner', 'manager', 'viewer']) {
      fetchMock.mockClear()
      await mount({ franchiseRole: fr })
      const input = await open('First name')
      await typeInto(input, 'Alex')
      await key(input, 'Enter')
      expect(patches(), `role='${fr}'`).toEqual([{ first_name: 'Alex' }])
    }
  })

  it('the account rows do what they did: Sign out navigates, Change password explains Google', async () => {
    await mount({ franchiseRole: 'owner' })
    const btn = (t: string) => Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === t)!
    await act(async () => { btn('Change password').click() })
    expect(alerts.join('\n')).toMatch(/You sign in with Google/)
    const navigations: string[] = []
    const real = window.location
    Object.defineProperty(window, 'location', { configurable: true, writable: true,
      value: { get href() { return '' }, set href(v: string) { navigations.push(v) } } })
    try { await act(async () => { btn('Sign out').click() }) }
    finally { Object.defineProperty(window, 'location', { configurable: true, writable: true, value: real }) }
    expect(navigations).toEqual(['/api/auth/signout'])
  })

  it('a past-due location still gets its payment card on Profile', async () => {
    await mount({ franchiseRole: 'owner', isPastDue: true, graceDaysLeft: 5 })
    const section = Array.from(container.querySelectorAll('[data-ssection]')).find(s => (s.textContent || '').includes('Action required'))
    expect(section, 'the Action required card').toBeTruthy()
    expect(section!.querySelectorAll('button').length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3b · THE ROLE PROFILE SHOWS IS THE TEAM SCREEN'S
// ═══════════════════════════════════════════════════════════════════════════
// Profile used to say "Franchise Owner" to everyone, managers included (a
// fixed string). It now reads FRANCHISE_ROLES — the table the Team screen
// names roles from — on the card and on the Role row. The expected words
// below are read OUT OF that table in the source, not typed here, so the test
// cannot agree with Profile while both disagree with Team.
const TEAM_ROLE_TABLE: Record<string, string> = Object.fromEntries(
  Array.from(
    HUB.slice(HUB.indexOf('const FRANCHISE_ROLES = ['), HUB.indexOf(']', HUB.indexOf('const FRANCHISE_ROLES = [')))
      .matchAll(/key:'(\w+)',\s*label:'([^']+)'/g),
  ).map(m => [m[1], m[2]]),
)
const card = () => (container.querySelector('[data-sident]') as HTMLElement).textContent ?? ''
const hasRow = (label: string) => !!container.querySelector(`[data-settings-row="${label}"]`)
const admin = { ...currentUser, role: 'admin' }

describe('Profile shows the role the Team screen would', () => {
  it('the table is the one Team uses, and says what Kevin said it says', () => {
    expect(TEAM_ROLE_TABLE).toEqual({ owner: 'Zee Bee', manager: 'Hive Manager', light: 'Worker Bee', readonly: 'Honey Watcher' })
  })

  // [who, props, signed-in user, the table row they read]
  const inTable: Array<[string, Record<string, any>, any, string]> = [
    ['owner', { franchiseRole: 'owner' }, currentUser, 'owner'],
    ['manager', { franchiseRole: 'manager' }, currentUser, 'manager'],
    ['light (view-as only)', { franchiseRole: 'light' }, currentUser, 'light'],
    ['readonly (view-as only)', { franchiseRole: 'readonly' }, currentUser, 'readonly'],
    // A real read-only sign-in arrives as 'viewer', which has no row of its
    // own: it reads the table's read-only row, as the sidebar already does.
    ['viewer (a real read-only sign-in)', { franchiseRole: 'viewer' }, currentUser, 'readonly'],
    // A super admin looking AS a manager is shown what the manager is shown.
    ['super admin viewing as a manager', { franchiseRole: 'manager', isSuperAdmin: false }, { ...currentUser, role: 'super_admin' }, 'manager'],
  ]
  for (const [who, props, user, key] of inTable) {
    it(`${who} reads "${TEAM_ROLE_TABLE[key]}" on the card and on the Role row, and nobody else's label`, async () => {
      await mount(props, user)
      const label = TEAM_ROLE_TABLE[key]
      expect(shown('Role')).toBe(label)
      expect(card()).toContain(label)
      for (const other of Object.values(TEAM_ROLE_TABLE)) {
        if (other !== label) expect(pane().textContent, `${who} must not see "${other}"`).not.toContain(other)
      }
      expect(pane().textContent).not.toContain('Franchise Owner')
      // Still read-only: no pencil, and a click opens nothing.
      expect(pencil('Role')).toBeNull()
    })
  }

  // Super admin and corporate are not in the Team table. Both arrive as
  // franchiseRole='owner' and neither is a Zee Bee. They read the words Bee
  // Hub ALREADY uses for them, found in the source here, not typed:
  //   'Super Admin'      the ROLES table
  //   'Corporate Admin'  the Role line of the corporate Profile screen
  const SUPER_ADMIN_LABEL = HUB.slice(HUB.indexOf('\nconst ROLES = [')).match(/key:'super_admin',\s*label:'([^']+)'/)![1]
  const CORPORATE_LABEL = HUB.slice(HUB.indexOf('function SuperAdminProfile(')).match(/role === 'super_admin' \? '([^']+)' : '([^']+)'/)![2]

  it('the two elevated labels are the ones Bee Hub already shows, and both screens agree on Super Admin', () => {
    expect(SUPER_ADMIN_LABEL).toBe('Super Admin')
    expect(CORPORATE_LABEL).toBe('Corporate Admin')
    expect(HUB.slice(HUB.indexOf('function SuperAdminProfile(')).match(/role === 'super_admin' \? '([^']+)'/)![1]).toBe(SUPER_ADMIN_LABEL)
  })

  const superAdmin = { ...currentUser, role: 'super_admin' }
  // [who, props, signed-in user, the label]
  const elevated: Array<[string, Record<string, any>, any, () => string]> = [
    ['super admin', { franchiseRole: 'owner', isSuperAdmin: true, appRole: 'super_admin' }, superAdmin, () => SUPER_ADMIN_LABEL],
    ['corporate, signed in themselves', { franchiseRole: 'owner', appRole: 'corporate' }, admin, () => CORPORATE_LABEL],
    // The gap: view-as turns isSuperAdmin off and hands Settings
    // franchiseRole='owner' for a corporate person. Only appRole tells them
    // from a real owner.
    ['super admin viewing as a corporate person', { franchiseRole: 'owner', isSuperAdmin: false, appRole: 'corporate' }, superAdmin, () => CORPORATE_LABEL],
  ]
  for (const [who, props, user, want] of elevated) {
    it(`${who} reads the label Bee Hub already gives them, never "Zee Bee"`, async () => {
      await mount(props, user)
      const label = want()
      expect(shown('Role')).toBe(label)
      expect(card()).toContain(label)
      for (const other of [...Object.values(TEAM_ROLE_TABLE), 'Franchise Owner', SUPER_ADMIN_LABEL, CORPORATE_LABEL]) {
        if (other !== label) expect(pane().textContent, `${who} must not see "${other}"`).not.toContain(other)
      }
      expect(pencil('Role')).toBeNull()
    })
  }

  it('a super admin viewing as an owner or a manager still reads THEIR label, not Super Admin', async () => {
    await mount({ franchiseRole: 'owner', isSuperAdmin: false, appRole: 'franchise' }, superAdmin)
    expect(shown('Role')).toBe('Zee Bee')
    await mount({ franchiseRole: 'manager', isSuperAdmin: false, appRole: 'franchise' }, superAdmin)
    expect(shown('Role')).toBe('Hive Manager')
  })

  it('the app hands Settings its current role: the one line outside Settings', () => {
    const calls = HUB.split('\n').filter(l => l.includes('<SettingsScreen onStatusChange'))
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("isSuperAdmin={role==='super_admin'&&!viewAsUser} appRole={role} ")
  })

  // A role with no label anywhere: nothing is shown and nothing is made up.
  it('a role nobody produces yet is shown no role: no Role row, and no role name anywhere on Profile', async () => {
    await mount({ franchiseRole: 'some-future-role' })
    expect(hasRow('Role')).toBe(false)
    for (const label of [...Object.values(TEAM_ROLE_TABLE), 'Franchise Owner', SUPER_ADMIN_LABEL, CORPORATE_LABEL, 'Corporate']) {
      expect(pane().textContent, `must not see "${label}"`).not.toContain(label)
    }
    const labels = Array.from(container.querySelectorAll('[data-settings-row]')).map(r => r.getAttribute('data-settings-row'))
    expect(labels).toEqual(['First name', 'Last name', 'Email', 'Phone', 'Booking link'])
    expect(card()).not.toMatch(/·\s*$|^\s*·/)
  })

  it('Settings no longer reads the fixed "Franchise Owner" string', () => {
    expect(HUB).not.toMatch(/settings\.profile\.role/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE NEW FONTS ARE ON SETTINGS AND NOWHERE ELSE
// ═══════════════════════════════════════════════════════════════════════════
const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
  const p = join(d, n)
  if (n === 'node_modules' || n.startsWith('.')) return []
  return statSync(p).isDirectory() ? walk(p) : /\.(jsx?|tsx?|css|mjs)$/.test(n) && !/\.test\./.test(n) ? [p] : []
})
const newFace = /\b(Lato|Arvo)\b/

describe('Lato and Arvo cannot leak', () => {
  it('nothing global loads or names them — not the layout, not globals.css', () => {
    for (const f of ['app/layout.tsx', 'app/globals.css']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(newFace)
      expect(src, f).not.toContain('design/tokens')
    }
  })

  it('the only app files that name them are the tokens, the two rebuilt Settings files, and the email builder', () => {
    const named = [...walk('components'), ...walk('app')].filter(p => newFace.test(readFileSync(p, 'utf8'))).sort()
    expect(named).toEqual([
      'components/design/tokens.js',
      'components/settings/EmailsScreen.jsx',
      'components/settings/SettingsShell.jsx',
    ])
    // BeeHub.jsx — every other screen in the app — never names either face.
    expect(HUB).not.toMatch(newFace)
  })

  it('the font request is made by the Settings screen itself, once, and the shell is the only file that makes it', async () => {
    const users = [...walk('components'), ...walk('app')].filter(p => readFileSync(p, 'utf8').includes('FONT_STYLESHEET_HREF')).sort()
    expect(users).toEqual(['components/design/tokens.js', 'components/settings/SettingsShell.jsx'])
    await mount({ franchiseRole: 'owner' })
    const links = Array.from(container.querySelectorAll('link[rel="stylesheet"]')).map(l => l.getAttribute('href'))
    expect(links).toEqual([FONT_STYLESHEET_HREF])
    // …and it is INSIDE the screen, so it leaves the page when Settings does.
    act(() => root.unmount())
    expect(document.querySelectorAll('link[rel="stylesheet"]').length).toBe(0)
    root = createRoot(container)
  })

  it('the Settings root is still DM Sans — that is what an unrebuilt section inherits', async () => {
    await mount({ franchiseRole: 'owner', initialSection: 'location' })
    const rootEl = container.firstElementChild as HTMLElement
    expect(rootEl.style.fontFamily).toContain('DM Sans')
    expect(rootEl.style.fontFamily).not.toMatch(newFace)
  })

  it('an unrebuilt section (Location) carries no new font and sits outside every data-settings-ui', async () => {
    await mount({ franchiseRole: 'owner', initialSection: 'location' })
    const body = pane().lastElementChild as HTMLElement
    expect(body.textContent).toContain('Location Details')
    expect(body.querySelector('[data-settings-ui]'), 'no rebuilt piece inside it').toBeNull()
    expect(body.closest('[data-settings-ui]'), 'not inside a rebuilt piece').toBeNull()
    for (const el of Array.from(body.querySelectorAll('*')) as HTMLElement[]) {
      expect(el.style?.fontFamily || '', el.tagName).not.toMatch(newFace)
    }
  })

  it('every element that asks for Lato or Arvo is inside a rebuilt piece', async () => {
    for (const section of ['profile', 'location', 'team', 'tags', 'texts', 'newleads', 'slack', 'jobber', 'mailchimp']) {
      await mount({ franchiseRole: 'owner', initialSection: section })
      for (const el of Array.from(container.querySelectorAll('*')) as HTMLElement[]) {
        if (!newFace.test(el.style?.fontFamily || '')) continue
        expect(el.closest('[data-settings-ui]'), `${section}: <${el.tagName.toLowerCase()}> "${(el.textContent || '').slice(0, 30)}"`).toBeTruthy()
      }
    }
  })

  it('Profile itself IS in the new fonts: Lato for the heading, Arvo for the running text', async () => {
    await mount({ franchiseRole: 'owner' })
    const page = pane().querySelector('[data-settings-page]') as HTMLElement
    const fam = (v: string) => v.replace(/['"]/g, '')
    expect(fam(page.style.fontFamily)).toBe(fam(FONT.ui))
    expect(fam((page.querySelector('h1') as HTMLElement).style.fontFamily)).toBe(fam(FONT.heading))
    expect(fam((page.querySelector('header p') as HTMLElement).style.fontFamily)).toBe(fam(FONT.body))
    expect(fam((rail().closest('aside') as HTMLElement).style.fontFamily)).toBe(fam(FONT.ui))
    expect(fam(FONT.heading)).toMatch(/^Lato,/)
    expect(fam(FONT.body)).toMatch(/^Arvo,/)
  })

  it('every CSS rule the shell adds is fenced to its own attributes', () => {
    const css = (Shell as any).SETTINGS_CSS as string
    const selectors = Array.from(css.replace(/@media[^{]+\{/g, '').matchAll(/([^{}]+)\{/g)).flatMap(m => m[1].split(/,(?![^()]*\))/)).map(s => s.trim()).filter(Boolean)
    expect(selectors.length).toBeGreaterThan(15)
    for (const sel of selectors) expect(sel, sel).toMatch(/^\[data-(settings-ui|settings-page|s[a-z-]+)\]/)
    // (That every selector STARTS with one of the shell's own attributes is the
    // whole fence: a bare `button{}` or `*{}` could not pass the loop above.)
    expect(css).not.toContain('.bee-')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · NOTHING OUTSIDE SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
describe('the new pieces are used by Settings and by nothing else', () => {
  const lines = HUB.split('\n')
  const start = lines.findIndex(l => l.startsWith('export function SettingsScreen('))
  // The component ends at the first line that is exactly "}" after its start.
  const end = lines.findIndex((l, i) => i > start && l === '}')

  it('BeeHub.jsx uses them only inside SettingsScreen', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const outside = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => /\bSUI\b/.test(l) && (i < start || i > end))
      .map(({ l }) => l.trim())
    expect(outside).toEqual(['import * as SUI from "@/components/settings/SettingsShell"'])
  })

  it('no other file imports the shell or the shared tokens yet', () => {
    const importers = (needle: string) =>
      [...walk('components'), ...walk('app'), ...walk('lib')].filter(p => readFileSync(p, 'utf8').includes(needle)).sort()
    expect(importers("settings/SettingsShell'").concat(importers('settings/SettingsShell"'))).toEqual(['components/BeeHub.jsx'])
    expect(importers("from '@/components/design/tokens'")).toEqual(['components/settings/SettingsShell.jsx'])
  })

  it('the old cream stays behind every section that has not been rebuilt', async () => {
    const bg = () => (container.firstElementChild as HTMLElement).style.background
    const hex = (v: string) => v.replace(/\s/g, '').toLowerCase()
    const asRgb = (h: string) => { const n = parseInt(h.slice(1), 16); return `rgb(${n >> 16},${(n >> 8) & 255},${n & 255})` }
    const is = (v: string, h: string) => [h.toLowerCase(), asRgb(h)].includes(hex(v))
    await mount({ franchiseRole: 'owner', initialSection: 'profile' })
    expect(is(bg(), T.background), `profile: ${bg()}`).toBe(true)
    for (const section of ['location', 'team', 'tags', 'emails', 'texts', 'newleads', 'slack', 'jobber', 'mailchimp']) {
      await mount({ franchiseRole: 'owner', initialSection: section })
      expect(is(bg(), '#f7f5f0'), `${section}: ${bg()}`).toBe(true)
    }
    // The no-access notice is old-look too.
    await mount({ franchiseRole: 'manager', initialSection: 'emails' })
    expect(is(bg(), '#f7f5f0'), `notice: ${bg()}`).toBe(true)
    expect(Shell.REBUILT_SECTIONS).toEqual(['profile'])
  })

  it('no new dependency: the shell imports React, the tokens and Bee Hub\'s own icons — nothing else', () => {
    const imports = Array.from(SHELL.matchAll(/from '([^']+)'/g)).map(m => m[1]).sort()
    expect(imports).toEqual(['@/components/design/tokens', '@/components/ui/icons', 'react'])
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    for (const banned of ['tailwindcss', 'lucide-react', '@tanstack/react-router'])
      expect(deps, banned).not.toContain(banned)
    expect(deps.filter(d => d.startsWith('@radix-ui'))).toEqual([])
  })

  it('the shell declares no colour of its own — every one comes from the tokens', () => {
    const code = SHELL_CODE
    expect(code.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([])
    expect(code).not.toMatch(/oklch\(/)
  })
})
