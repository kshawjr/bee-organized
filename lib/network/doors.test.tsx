// @vitest-environment happy-dom
//
// THE NINE DOORS INTO NETWORK, role by role (Network & Nurture, slice 3).
//
// Network is closed for every role but one. A super admin, acting as
// themselves, now gets the new Network list. These are REAL mounts of the
// whole app (the pattern lib/app-rail.test.tsx uses), once per role and per
// door, so each line below is something that was seen to happen:
//
//   owner · manager · read-only · corporate   every door ends at the grey:
//       the menu item is not a control, and any other road lands on the one
//       closed line, never on a list (old or new) and never on a contact.
//   super admin                                every door opens the new list,
//       and the three that point at a person or a tag open that person or
//       start the list filtered by that tag.
//
// The nine, found by reading the code rather than counted from memory:
//   1 the menu item                    6 a reminder on the Home screen
//   2 a typed /network                 7 Search → a Network person
//   3 a typed /contacts                8 Search → "All N tagged X in Network"
//   4 the back button onto /network    9 the client card's "In your Network"
//   5 a reminder on the Reminders page    link (a plain link to /network)
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

import App from '@/components/BeeHub'
import { maySeeNewNetwork } from '@/lib/network/access'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HUB = read('components/BeeHub.jsx')

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const PAT = {
  id: '11111111-2222-4333-8444-555555555555', locationId: KC, type: 'partner', name: 'Pat Partner', title: '', company: 'Keystone Realty',
  phone: '', email: '', website: '', stage: 'New Contact', tier: null, tagIds: ['t1'], howWeMet: '', metDate: '', lastContact: '',
  isCustomer: false, customerLeadId: null, cardImage: null, addresses: [], notes: [], nextSteps: [], referrals: [], activity: [],
  lastContactedAt: null, isDeleted: false, deletedAt: null,
}
const baseProps = (over: any = {}) => ({
  initialRoute: 'home',
  initialRole: 'super_admin',
  initialFranchiseRole: 'owner',
  initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
  initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
  initialPeople: [], initialBinPeople: [], initialTransferPeople: [],
  initialEngagements: [], initialPartners: [PAT], initialCompanies: [],
  initialGuideSlides: [], initialManualSlides: [], initialTierPrices: [],
  currentUser: { id: 'u1', email: 'k@x.com', name: 'Kevin Shaw', role: 'super_admin', locationId: null },
  currentLocation: null, currentSubscription: null,
  initialLocFilter: KC, initialScopeLocationId: KC,
  ...over,
})
type Role = { label: string; role: string; props: any }
const ROLES: Role[] = [
  { label: 'owner',       role: 'owner',       props: { initialRole: 'franchise', initialFranchiseRole: 'owner',   currentUser: { id: 'o', email: 'o@x.com', name: 'Olive Owner', role: 'owner', locationId: KC } } },
  { label: 'manager',     role: 'manager',     props: { initialRole: 'franchise', initialFranchiseRole: 'manager', currentUser: { id: 'm', email: 'm@x.com', name: 'Max Manager', role: 'manager', locationId: KC } } },
  { label: 'read-only',   role: 'lite_user',   props: { initialRole: 'franchise', initialFranchiseRole: 'viewer',  currentUser: { id: 'v', email: 'v@x.com', name: 'Vera Viewer', role: 'lite_user', locationId: KC } } },
  { label: 'corporate',   role: 'admin',       props: { initialRole: 'corporate', initialFranchiseRole: 'owner',   currentUser: { id: 'c', email: 'c@x.com', name: 'Cora Corp', role: 'admin', locationId: null } } },
  { label: 'super admin', role: 'super_admin', props: { initialRole: 'super_admin', initialFranchiseRole: 'owner', currentUser: { id: 's', email: 's@x.com', name: 'Sam Super', role: 'super_admin', locationId: null } } },
]
const SHUT = ROLES.filter(r => r.label !== 'super admin')
const SUPER = ROLES[4]

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string }[]
let errSpy: any
const store = (() => { let m: Record<string, string> = {}; return { getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = String(v) }, removeItem: (k: string) => { delete m[k] }, clear: () => { m = {} }, key: () => null, length: 0 } })()
Object.defineProperty(window, 'localStorage', { configurable: true, value: store })

const REMINDER = { id: 'r1', user_id: 'me', partner_id: PAT.id, lead_id: null, engagement_id: null, due_on: '2026-11-10', note: 'call Pat about spring listings', record_type: 'network', record_name: 'Pat Partner', done_at: null, created_at: '2026-11-01T00:00:00Z' }
const answer = (url: string) => {
  if (url.startsWith('/api/network/list')) return { contacts: [{ id: PAT.id, locationId: KC, locationName: 'Kansas City', name: PAT.name, company: PAT.company, networkTypes: ['partner'], partnerLevel: 'referral', partnerStage: 'New Contact', tagIds: ['t1'], lastContactedAt: null, isCustomer: false }], tags: [{ id: 't1', label: 'Realtor' }], followUps: {}, total: 1, truncated: false }
  if (url.startsWith('/api/network/summary')) return { referrers: [], totals: { count: 0, converted: 0, revenue: 0 } }
  if (url.startsWith('/api/reminders')) return { reminders: [REMINDER] }
  if (url.startsWith('/api/search')) return { results: [], partners: [PAT], tagMatches: [{ id: 't1', label: 'Realtor', clients: 0, network: 1 }] }
  return {}
}
beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
  calls = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => { calls.push({ url: String(url), method: init?.method || 'GET' }); return { ok: true, status: 200, json: async () => answer(String(url)) } })
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  try { act(() => root.unmount()) } catch {}
  host?.remove()
  errSpy.mockRestore()
  document.body.style.overflow = ''
})

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const wait = async (ms: number) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }); await settle(2) }
async function mount(over: any = {}) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(App as any, baseProps(over))) })
  await settle()
  return host
}
const rail = () => host.querySelector('aside.bee-sidebar[data-app-rail]') as HTMLElement
const item = (key: string) => rail().querySelector(`[data-nav="${key}"]`) as HTMLElement
const current = () => (rail().querySelector('[aria-current="page"]') as HTMLElement | null)?.dataset.nav
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle(3) }
const type = async (input: Element | null, value: string) => {
  if (!input) throw new Error('no input to type into')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

// What a viewer can end up looking at.
const closedLine = () => host.querySelector('[data-nav-closed]') as HTMLElement | null
const newList = () => host.querySelector('[data-network-list]') as HTMLElement | null
const personOpen = () => !!document.body.querySelector('[data-testid="person-stats"]')
const networkRead = () => calls.some(c => c.url.startsWith('/api/network/list'))
// Text only the OLD Network screen and its add doors draw.
const OLD_SCREEN = ['Add Contact', 'Add Company', 'in your referral network', 'Gone cold 60d+']

const expectGrey = (label: string) => {
  expect(closedLine(), `${label}: the closed line`).toBeTruthy()
  expect(closedLine()!.textContent).toContain('Network & Nurture is being redesigned.')
  expect(host.querySelector('[data-section-closed-page] h1')!.textContent).toBe('Network & Nurture')
  expectNothingOfNetwork(label)
}
const expectNothingOfNetwork = (label: string) => {
  expect(newList(), `${label}: the new list`).toBeNull()
  expect(personOpen(), `${label}: a contact`).toBe(false)
  expect(networkRead(), `${label}: a read of the new list`).toBe(false)
  const body = (host.querySelector('.bee-main') as HTMLElement).textContent || ''
  for (const t of OLD_SCREEN) expect(body, `${label}: "${t}"`).not.toContain(t)
  expect(body).not.toContain('Pat Partner · Keystone')
  // Still greyed in the menu, still not a control.
  const el = item('partners')
  expect(el.tagName, label).toBe('DIV')
  expect(el.getAttribute('aria-disabled'), label).toBe('true')
  expect(el.querySelector('[data-soon-chip]')!.textContent, label).toBe('Under redesign')
}
const expectNewList = () => {
  expect(closedLine()).toBeNull()
  expect(newList(), 'the new list').toBeTruthy()
  expect(current()).toBe('partners')
  expect(item('partners').tagName).toBe('BUTTON')
  expect(item('partners').querySelector('[data-soon-chip]')).toBeNull()
  expect(newList()!.querySelector('[data-type-pill="partner"] [data-count]')!.textContent).toBe('1')
  expect(newList()!.querySelector('[data-row] [data-name]')!.textContent).toBe('Pat Partner')
  const body = (host.querySelector('.bee-main') as HTMLElement).textContent || ''
  for (const t of OLD_SCREEN) expect(body, `"${t}"`).not.toContain(t)
}

const openSearch = async () => {
  await click(rail().querySelector('[data-rail-search]'))
  const input = Array.from(document.body.querySelectorAll('input')).find(i => /search/i.test(i.getAttribute('placeholder') || '')) as HTMLInputElement
  await type(input, 'Pat')
  await wait(320)
}
const searchPerson = () => Array.from(document.body.querySelectorAll('button')).find(b => (b.textContent || '').includes('Pat Partner') && !b.closest('[data-network-list]'))
const searchTagLine = () => Array.from(document.body.querySelectorAll('button, [role="button"], a')).find(b => /All 1 tagged Realtor in Network/.test(b.textContent || ''))
const reminderButton = (within: Element | Document = document.body) =>
  Array.from(within.querySelectorAll('[data-testid="reminder-row"] button')).find(b => (b.textContent || '').includes('Pat Partner'))

describe('the gate is one rule', () => {
  it('the roles in these mounts are the roles the rule is asked about', () => {
    expect(ROLES.map(r => [r.label, maySeeNewNetwork(r.props.initialRole)])).toEqual([
      ['owner', false], ['manager', false], ['read-only', false], ['corporate', false], ['super admin', true],
    ])
  })
  it('the menu and the page ask the same question, and Network is its only exception', () => {
    expect(HUB).toContain('const networkOpen = maySeeNewNetwork(role)')
    expect(HUB).toContain("const closedFor = key => (key === 'partners' && networkOpen ? null : (CLOSED_NAV[key] || null))")
    expect(HUB).toContain('soon: !!closedFor(item.key), note: closedFor(item.key)?.note,')
    expect(HUB).toContain('newList={networkOpen}')
    // Defined once, read twice: by closedFor and by the screen it mounts.
    expect(HUB.match(/networkOpen/g)!.length).toBe(3)
  })
})

describe('1 · the menu item', () => {
  for (const r of SHUT) it(`${r.label}: greyed, not a control; clicking it goes nowhere`, async () => {
    await mount(r.props)
    const push = vi.spyOn(window.history, 'pushState')
    await click(item('partners'))
    expect(push).not.toHaveBeenCalled()
    expect(current()).toBe('home')
    expect(closedLine()).toBeNull()
    expectNothingOfNetwork(r.label)
    push.mockRestore()
  })
  it('super admin: a live item that opens the new list at /network', async () => {
    await mount(SUPER.props)
    await click(item('partners'))
    expectNewList()
    expect(window.location.pathname).toBe('/network')
  })
})

describe('2 and 3 · a typed address', () => {
  for (const route of ['network', 'contacts']) {
    for (const r of SHUT) it(`${r.label}, /${route}: the closed line`, async () => {
      await mount({ ...r.props, initialRoute: route })
      expectGrey(r.label)
    })
    it(`super admin, /${route}: the new list`, async () => {
      await mount({ ...SUPER.props, initialRoute: route })
      expectNewList()
    })
  }
})

describe('4 · the back button onto /network', () => {
  const back = async () => { await act(async () => { window.history.pushState({}, '', '/network'); window.dispatchEvent(new PopStateEvent('popstate')) }); await settle(3) }
  for (const r of SHUT) it(`${r.label}: the closed line`, async () => {
    await mount(r.props); await back()
    expectGrey(r.label)
  })
  it('super admin: the new list', async () => {
    await mount(SUPER.props); await back()
    expectNewList()
  })
})

describe('5 · a reminder about a Network person, on the Reminders page', () => {
  for (const r of SHUT) it(`${r.label}: the closed line, and the person does not open`, async () => {
    await mount({ ...r.props, initialRoute: 'reminders' })
    await click(reminderButton())
    expectGrey(r.label)
  })
  it('super admin: the new list, with that person open on it', async () => {
    await mount({ ...SUPER.props, initialRoute: 'reminders' })
    await click(reminderButton())
    expectNewList()
    expect(personOpen()).toBe(true)
  })
})

describe('6 · a reminder about a Network person, on the Home screen', () => {
  const homeReminder = () => { const block = host.querySelector('[data-testid="home-reminders"]'); return block ? reminderButton(block) : undefined }
  for (const r of SHUT) it(`${r.label}: the closed line, and the person does not open`, async () => {
    await mount(r.props)
    await click(homeReminder())
    expectGrey(r.label)
  })
  it('super admin: the new list, with that person open on it', async () => {
    await mount(SUPER.props)
    await click(homeReminder())
    expectNewList()
    expect(personOpen()).toBe(true)
  })
})

describe('7 · Search → a Network person', () => {
  for (const r of SHUT) it(`${r.label}: the closed line, and the person does not open`, async () => {
    await mount(r.props); await openSearch()
    await click(searchPerson())
    expectGrey(r.label)
  })
  it('super admin: the new list, with that person open on it', async () => {
    await mount(SUPER.props); await openSearch()
    await click(searchPerson())
    expectNewList()
    expect(personOpen()).toBe(true)
  })
})

describe('8 · Search → "All N tagged X in Network"', () => {
  for (const r of SHUT) it(`${r.label}: the closed line`, async () => {
    await mount(r.props); await openSearch()
    await click(searchTagLine())
    expectGrey(r.label)
  })
  it('super admin: the new list, already filtered by that tag', async () => {
    await mount(SUPER.props); await openSearch()
    await click(searchTagLine())
    expectNewList()
    expect(newList()!.querySelector('[data-tags-trigger] .nw-trigger-count')!.textContent).toBe('1')
    expect(newList()!.querySelector('[data-matching]')!.textContent).toBe('1 matching contact')
  })
})

describe('9 · the client card\'s "In your Network" link', () => {
  it('is a plain link to /network, which is door 2 for every role', () => {
    const card = read('components/hive/ClientProfile.jsx')
    expect(card).toContain('data-testid="client-network-twin" href="/network"')
    expect(read('app/network/page.tsx')).toContain('initialRoute="network"')
  })
})

describe('a super admin viewing as someone else sees what they see', () => {
  it('the rule is asked about the role being acted as, which view-as changes', () => {
    // `role` is the app's acted-as role: view-as sets it (setRole) to the role
    // of the person picked, and the gate reads nothing else.
    expect(HUB).toContain('const [role, setRole]                     = useState(initialRole ?? \'super_admin\')')
    expect(HUB).toContain('const networkOpen = maySeeNewNetwork(role)')
  })
})

describe('on All Locations the new list is look-only', () => {
  // The existing record saves through the app's own list of contacts, which
  // holds none on All Locations: opened there, an edit would be sent as the
  // whole record instead of the one field that changed. So there a row is
  // not a button at all.
  it('a super admin on All Locations sees the list, but no row opens a contact', async () => {
    await mount({ ...SUPER.props, initialRoute: 'network', initialLocFilter: 'all', initialScopeLocationId: null })
    expect(newList(), 'the new list').toBeTruthy()
    expect(calls.some(c => c.url === '/api/network/list')).toBe(true)
    const row = newList()!.querySelector('[data-row]') as HTMLElement
    expect(row.tagName).toBe('DIV')
    expect(newList()!.querySelector('button[data-row]')).toBeNull()
    expect(newList()!.querySelector('[data-open-hint]')!.textContent).toBe('Pick one location to open a contact.')
    await click(row)
    expect(personOpen()).toBe(false)
  })
  it('inside one location the same row is a button, and the list asks for that location only', async () => {
    await mount({ ...SUPER.props, initialRoute: 'network' })
    expect(newList()!.querySelector('[data-row]')!.tagName).toBe('BUTTON')
    expect(newList()!.querySelector('[data-open-hint]')).toBeNull()
    expect(calls.some(c => c.url === `/api/network/list?location_id=${KC}`)).toBe(true)
  })
})

describe('opening the new list changes nothing', () => {
  it('a super admin walking every door makes no request that is not a GET', async () => {
    await mount({ ...SUPER.props, initialRoute: 'network' })
    await click(newList()!.querySelector('[data-type-pill="partner"]'))
    await click(newList()!.querySelector('[data-row]'))
    expect(personOpen()).toBe(true)
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })
})
