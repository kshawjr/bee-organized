// @vitest-environment happy-dom
//
// SLICE 7: the Nurturing tab, role by role, on a REAL mount of the whole app.
// The setup below is lib/network/doors.test.tsx's (that file is pinned byte
// for byte by an earlier slice, so it is copied here, not edited).
//
// FROM THE COPIED FILE: THE NINE DOORS INTO NETWORK, role by role (Network & Nurture, slice 3).
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
  if (url.startsWith('/api/network/nurturing?')) return { location: { id: KC, name: 'Kansas City' }, quietDays: 90, counts: { nurturing: 1, needsContactInfo: 0, hadQuoteOrAssessment: 0 }, total: 1, page: 0, size: 25, sort: 'az', rows: [{ id: 'n1', name: 'Nora Nurture', email: 'n@x.com', phone: null, city: null, zip: null, createdAt: '2025-01-01T00:00:00Z', needsContactInfo: false, lastActivity: null }] }
  if (url.startsWith('/api/network/contacts/')) return { contact: { id: PAT.id, locationId: KC, locationName: 'Kansas City', name: PAT.name, title: null, company: PAT.company, companyId: null, linkedCompany: null, phone: null, email: null, website: null, addresses: [], howWeMet: null, specialties: [], relationship: null, notes: [], nextSteps: [], activity: [], isCustomer: false, networkTypes: ['partner'], partnerLevel: 'referral', partnerStage: 'New Contact', birthday: null, birthdayReminder: false, createdAt: '2026-08-24T15:00:00Z', tagIds: ['t1'] }, tags: [{ id: 't1', label: 'Realtor', section: 'trade' }], touchpoints: [], followUps: [] }
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
// A contact is "open" if EITHER record is on screen: the old one
// (NetworkPersonRecord) or the new contact sheet (slice 4a). The closed roles
// must get neither. A super admin must get the new sheet and never the old.
const oldRecordOpen = () => !!document.body.querySelector('[data-testid="person-stats"]')
const sheetOpen = () => document.body.querySelector('[data-contact-sheet]') as HTMLElement | null
const personOpen = () => oldRecordOpen() || !!sheetOpen()
const expectSheetFor = (id: string) => {
  expect(sheetOpen(), 'the new contact sheet').toBeTruthy()
  expect(sheetOpen()!.getAttribute('data-contact-sheet')).toBe(id)
  expect(sheetOpen()!.querySelector('[data-sheet-name]')!.textContent).toBe('Pat Partner')
  expect(oldRecordOpen(), 'the old record').toBe(false)
}
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

// SLICE 7: the Nurturing tab rides inside the same gate. Nothing new for the
// four shut roles; the super admin gets two tabs, Network first.
describe('slice 7 · the Nurturing tab', () => {
  const nurtureRead = () => calls.some(c => c.url.startsWith('/api/network/nurturing'))
  for (const r of SHUT) it(`${r.label}: no tabs, no Nurturing list, nothing read`, async () => {
    await mount({ ...r.props, initialRoute: 'network' })
    expectGrey(r.label)
    expect(host.querySelector('[data-network-tabs]')).toBeNull()
    expect(host.querySelector('[data-tab="nurture"]')).toBeNull()
    expect(host.querySelector('[data-nurture-ui]')).toBeNull()
    expect(nurtureRead()).toBe(false)
  })
  it('super admin: Network & Partners first, then Nurturing clients at the picked location', async () => {
    await mount({ ...SUPER.props, initialRoute: 'network' })
    expectNewList()
    expect(host.querySelector('[data-tab="network"]')!.getAttribute('aria-selected')).toBe('true')
    expect(nurtureRead()).toBe(false)
    await click(host.querySelector('[data-tab="nurture"]'))
    await settle(4)
    expect(host.querySelector('[data-nurture-ui]')).toBeTruthy()
    expect(calls.find(c => c.url.startsWith('/api/network/nurturing?'))!.url).toContain(`location_id=${KC}`)
    expect(host.querySelector('[data-row="n1"]')!.textContent).toContain('Nora Nurture')
  })
})
