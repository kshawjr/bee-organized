// @vitest-environment happy-dom
//
// THE LEFT MENU, rebuilt (2026-11-13) — components/design/AppRail.jsx, the
// first rebuilt piece outside Settings. It frames every screen, so these are
// REAL mounts of the whole app (the pattern lib/beta-back-office.test.tsx
// uses), once per role, and they pin what a redesign of a menu breaks quietly:
//
//   1 · Home, Reminders, Clients, Settings, Help and Admin all still open.
//       (In the designer's export every one of them but Settings is disabled,
//       because that prototype contains nothing but Settings.)
//   2 · Network & Nurture, Reports and Back Office are greyed and cannot be
//       opened: not by click, not by keyboard, not by a typed address or the
//       back button — for any role.
//   3 · Admin is hidden from exactly the people it was hidden from.
//   4 · "Everyone" is gone from the menu.
//   5 · collapse (remembered), the menu filter, the phone drawer.
//   6 · what the export dropped and Bee Hub keeps: Ask Bee Hub, Search, the
//       identity control, the onboarding lock.
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
import { RAIL_W, RAIL_W_COLLAPSED, RAIL_COLLAPSED_KEY, APP_RAIL_CSS } from '@/components/design/AppRail'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HUB = read('components/BeeHub.jsx')
const RAIL = read('components/design/AppRail.jsx')
const RAIL_CODE = RAIL.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const baseProps = (over: any = {}) => ({
  initialRoute: 'home',
  initialRole: 'super_admin',
  initialFranchiseRole: 'owner',
  initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
  initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
  initialPeople: [], initialBinPeople: [], initialTransferPeople: [],
  initialEngagements: [], initialPartners: [], initialCompanies: [],
  initialGuideSlides: [], initialManualSlides: [], initialTierPrices: [],
  currentUser: { id: 'u1', email: 'k@x.com', name: 'Kevin Shaw', role: 'super_admin', locationId: null },
  currentLocation: null, currentSubscription: null,
  initialLocFilter: KC, initialScopeLocationId: KC,
  ...over,
})
const ROLES: Array<{ label: string; elevated: boolean; props: any }> = [
  { label: 'owner',       elevated: false, props: { initialRole: 'franchise', initialFranchiseRole: 'owner',   currentUser: { id: 'o', email: 'o@x.com', name: 'Olive Owner', role: 'owner', locationId: KC } } },
  { label: 'manager',     elevated: false, props: { initialRole: 'franchise', initialFranchiseRole: 'manager', currentUser: { id: 'm', email: 'm@x.com', name: 'Max Manager', role: 'manager', locationId: KC } } },
  { label: 'read-only',   elevated: false, props: { initialRole: 'franchise', initialFranchiseRole: 'viewer',  currentUser: { id: 'v', email: 'v@x.com', name: 'Vera Viewer', role: 'lite_user', locationId: KC } } },
  { label: 'corporate',   elevated: true,  props: { initialRole: 'corporate',   initialFranchiseRole: 'owner', currentUser: { id: 'c', email: 'c@x.com', name: 'Cora Corp', role: 'admin', locationId: null } } },
  { label: 'super_admin', elevated: true,  props: { initialRole: 'super_admin', initialFranchiseRole: 'owner', currentUser: { id: 's', email: 's@x.com', name: 'Sam Super', role: 'super_admin', locationId: null } } },
]
const LIVE = ['home', 'reminders', 'hive', 'settings', 'help']
const CLOSED: Array<[string, string, string]> = [
  ['partners', 'Network & Nurture', 'Network & Nurture is being redesigned.'],
  ['reports', 'Reports', 'Reports are on their way.'],
  ['backoffice', 'Back Office', 'Back Office is on its way.'],
]
const URL_OF: Record<string, string> = { home: '/', reminders: '/reminders', hive: '/clients', settings: '/settings', help: '/help', admin: '/admin' }

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let fetchMock: ReturnType<typeof vi.fn>
let errSpy: any
// This test browser has no storage of its own; give it one, emptied per test,
// so "remembered across a reload" is really exercised.
const store = (() => { let m: Record<string, string> = {}; return { getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = String(v) }, removeItem: (k: string) => { delete m[k] }, clear: () => { m = {} } } })()
Object.defineProperty(window, 'localStorage', { configurable: true, value: store })
beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  ;(globalThis as any).fetch = fetchMock
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  try { act(() => root.unmount()) } catch {}
  host?.remove()
  errSpy.mockRestore()
  document.body.style.overflow = ''
})

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(over: any = {}) {
  try { act(() => root?.unmount()) } catch {}
  host?.remove()
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(App as any, baseProps(over))) })
  await settle()
  return host
}
const rail = () => host.querySelector('aside.bee-sidebar[data-app-rail]') as HTMLElement
const item = (key: string, within: Element = rail()) => within.querySelector(`[data-nav="${key}"]`) as HTMLElement
const keys = (within: Element = rail()): string[] => Array.from(within.querySelectorAll('[data-nav]')).map(e => (e as HTMLElement).dataset.nav as string)
const current = (within: Element = rail()) => (within.querySelector('[aria-current="page"]') as HTMLElement | null)?.dataset.nav
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle(2) }
const type = async (input: Element | null, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true })) })
}
const drawer = () => host.querySelector('[role="dialog"][data-rail-drawer]') as HTMLElement | null
const openDrawer = async () => { await click(host.querySelector('button[aria-label="Open menu"]')); return drawer()! }
const closedLine = () => host.querySelector('[data-nav-closed]') as HTMLElement | null

// ═══════════════════════════════════════════════════════════════════════════
// 1 · WHAT IS IN THE MENU, FOR WHOM
// ═══════════════════════════════════════════════════════════════════════════
describe('the menu, per role', () => {
  for (const { label, elevated, props } of ROLES) {
    it(`${label}: the same items, in order — ${elevated ? 'with' : 'without'} Admin`, async () => {
      await mount(props)
      expect(keys()).toEqual(['home', 'reminders', 'hive', 'partners', 'reports', 'backoffice', 'settings', 'help', ...(elevated ? ['admin'] : [])])
      expect(keys().map(k => item(k).textContent)).toEqual([
        'Home', 'Reminders', 'Clients', 'Network & NurtureUnder redesign', 'Reports', 'Back Office', 'Settings', 'Help',
        ...(elevated ? [label === 'super_admin' ? 'Admin' : 'Corp'] : []),
      ])
    })
  }

  it('Admin is hidden from exactly the people it was hidden from: the rule is the line that was there', () => {
    expect(HUB).toContain("...(isElevated ? [{ key:'admin', icon:'🏢', label:role==='super_admin'?'Admin':'Corp' }] : []),")
    expect(HUB).toContain('const isElevated  = isElevatedRole(role)')
    // The menu draws what it is handed and knows no role.
    expect(RAIL_CODE).not.toMatch(/isElevated|super_admin|franchiseRole|corporate|role ===|role===/)
  })

  it('"Everyone" is gone, and Network reads "Network & Nurture"', async () => {
    await mount(ROLES[0].props)
    expect(rail().textContent).not.toContain('Everyone')
    expect(rail().textContent).not.toMatch(/Network(?! & Nurture)/)
    expect(rail().querySelectorAll('[data-nav]').length).toBe(8)
    const d = await openDrawer()
    expect(d.textContent).not.toContain('Everyone')
    expect(keys(d)).toEqual(keys())
  })

  it('Help and Admin sit under the line, as in the design', async () => {
    await mount(ROLES[4].props)
    expect(keys(rail().querySelector('[data-rail-list="lower"]')!)).toEqual(['help', 'admin'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE LIVE ITEMS OPEN
// ═══════════════════════════════════════════════════════════════════════════
describe('Home, Reminders, Clients, Settings, Help and Admin all still open', () => {
  for (const { label, elevated, props } of ROLES) {
    it(`${label}: each is a button that goes to its screen and its address`, async () => {
      await mount({ ...props, initialRoute: 'help' })
      for (const key of [...LIVE, ...(elevated ? ['admin'] : [])].reverse().concat(['home'])) {
        const el = item(key)
        expect(el.tagName, key).toBe('BUTTON')
        expect((el as HTMLButtonElement).disabled, key).toBe(false)
        expect(el.hasAttribute('data-soon'), key).toBe(false)
        expect(el.style.opacity, key).toBe('1')
        await click(el)
        expect(current(), `${label} clicked ${key}`).toBe(key)
        expect(window.location.pathname, key).toBe(URL_OF[key])
        expect(closedLine(), key).toBeNull()
      }
    })
  }

  it('each lands on its real screen (super admin)', async () => {
    await mount(ROLES[4].props)
    const body = () => (host.querySelector('.bee-main') as HTMLElement).textContent || ''
    await click(item('settings')); expect(body()).toContain('Personal details')
    await click(item('help')); expect(current()).toBe('help'); expect(body().length).toBeGreaterThan(20)
    await click(item('reminders')); expect(body()).toMatch(/Reminders|reminder/i)
    await click(item('admin')); expect(current()).toBe('admin')
    await click(item('home')); expect(current()).toBe('home')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE THREE CLOSED SECTIONS
// ═══════════════════════════════════════════════════════════════════════════
describe('Network & Nurture, Reports and Back Office are greyed and are not controls', () => {
  for (const { label, props } of ROLES) {
    it(`${label}: each is a plain element — no button, no link, nothing to tab to — in the menu and in the phone drawer`, async () => {
      await mount(props)
      const d = await openDrawer()
      for (const nav of [rail(), d]) for (const [key, name] of CLOSED) {
        const el = item(key, nav)
        expect(el.tagName, key).toBe('DIV')
        expect(el.hasAttribute('data-soon'), key).toBe(true)
        expect(el.getAttribute('aria-disabled'), key).toBe('true')
        expect(el.hasAttribute('tabindex'), key).toBe(false)
        expect(el.querySelector('button, a, input, [tabindex]'), key).toBeNull()
        expect(el.textContent, key).toContain(name)
        expect(el.style.cursor, key).toBe('default')
        // Greyed: the name at half strength, the treatment Settings gives Tags.
        const nameEl = Array.from(el.querySelectorAll('span')).filter(s => s.children.length === 0 && s.textContent === name).pop() as HTMLElement
        expect(nameEl.style.opacity, key).toBe('0.5')
      }
      expect(item('partners').querySelector('[data-soon-chip]')!.textContent).toBe('Under redesign')
      expect(item('reports').querySelector('[data-soon-chip]')).toBeNull()
    })

    it(`${label}: clicking one, or pressing Enter or Space on it, goes nowhere`, async () => {
      await mount(props)
      const push = vi.spyOn(window.history, 'pushState')
      for (const [key] of CLOSED) {
        const el = item(key)
        await click(el)
        for (const k of ['Enter', ' ']) await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true })) })
        await click(el.querySelector('span'))
      }
      expect(push).not.toHaveBeenCalled()
      expect(current()).toBe('home')
      expect(closedLine()).toBeNull()
      expect(window.location.pathname).toBe('/')
      push.mockRestore()
    })
  }

  it('nothing in the menu can be focused that leads to one: every focusable thing is a live item, search, Ask, the account or collapse', async () => {
    await mount(ROLES[4].props)
    const focusable = Array.from(rail().querySelectorAll('button, a, input, [tabindex]')) as HTMLElement[]
    for (const f of focusable) {
      expect(f.closest('[data-soon]'), f.outerHTML.slice(0, 80)).toBeNull()
      expect(['partners', 'reports', 'backoffice']).not.toContain(f.dataset.nav)
    }
    expect(focusable.filter(f => f.dataset.nav).map(f => f.dataset.nav)).toEqual(['home', 'reminders', 'hive', 'settings', 'help', 'admin'])
  })
})

describe('…and cannot be opened by any road', () => {
  const ROUTES: Array<[string, string]> = [['network', 'partners'], ['contacts', 'partners'], ['partners', 'partners'], ['reports', 'reports'], ['backoffice', 'backoffice']]
  // Text only the real screens draw.
  const REAL_SCREEN = ['Back Office build zone', 'Work in progress', 'building a new Back Office', 'Reports are coming soon', 'Add Contact', 'Add Company']

  for (const { label, props } of ROLES) for (const [route, key] of ROUTES) {
    it(`${label}, a typed /${route}: the closed line — not the screen, not a blank page`, async () => {
      await mount({ ...props, initialRoute: route })
      const c = CLOSED.find(x => x[0] === key)!
      expect(closedLine(), 'the closed line').toBeTruthy()
      expect(closedLine()!.textContent).toContain(c[2])
      expect(host.querySelector('[data-section-closed-page] h1')!.textContent).toBe(c[1])
      const body = (host.querySelector('.bee-main') as HTMLElement).textContent || ''
      for (const t of REAL_SCREEN) expect(body, `${label} /${route}: "${t}"`).not.toContain(t)
      // It is not lit in the menu, and it is still not a button there.
      expect(current()).toBeUndefined()
      expect(item(key).tagName).toBe('DIV')
    })
  }

  for (const [route, key] of ROUTES) {
    it(`the back button onto /${route} gets the closed line too`, async () => {
      await mount(ROLES[0].props)
      await act(async () => { window.history.pushState({}, '', `/${route}`); window.dispatchEvent(new PopStateEvent('popstate')) })
      await settle(2)
      expect(closedLine()!.textContent).toContain(CLOSED.find(x => x[0] === key)![2])
    })
  }

  it('from the closed line there is a way out: Go to Home', async () => {
    await mount({ ...ROLES[0].props, initialRoute: 'network' })
    await click(host.querySelector('[data-closed-home]'))
    expect(closedLine()).toBeNull()
    expect(current()).toBe('home')
    expect(window.location.pathname).toBe('/')
  })

  it('a link from elsewhere in the app that points at Network lands on the closed line, not the screen', () => {
    // The three that exist: a reminder about a Network person, a Network
    // person picked in Search, and a tag count on Admin › Tags. All three set
    // the section to 'partners' — and screen() answers a closed section before
    // it looks at anything else.
    expect(HUB).toContain("      nav('partners')\n      if (partner) setGlobalSelectedPartner(partner)")
    expect(HUB).toContain("onSelectPartner={(p)=>{ setActiveNav('partners'); setGlobalSelectedPartner(p); setShowGlobalSearch(false) }}")
    expect(HUB).toContain("if (kind === 'network') { setNetworkTagIntent(tagId); nav('partners') }")
    const screen = HUB.slice(HUB.indexOf('  const screen = () => {'), HUB.indexOf('  const screen = () => {') + 900)
    const closedAt = screen.indexOf('if (CLOSED_NAV[activeNav]) {')
    expect(closedAt).toBeGreaterThan(0)
    // …before every other branch of screen().
    expect(screen.slice(0, closedAt)).not.toMatch(/if \(.*activeNav/)
    expect(HUB).toMatch(/const CLOSED_NAV = \{\s*partners:[\s\S]{0,400}reports:[\s\S]{0,200}backoffice:/)
    // The screens themselves are untouched and still there, behind it.
    for (const s of ['<PartnersScreen onNavigate={nav}', '<ReportsScreen />', '<BackOfficeScreen />', '<BackOfficeComingSoon />']) expect(HUB).toContain(s)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · NARROWER, COLLAPSIBLE, REMEMBERED
// ═══════════════════════════════════════════════════════════════════════════
describe('192px wide, every label on one line', () => {
  it('the column is 192px and the page beside it is told so', async () => {
    await mount(ROLES[4].props)
    expect([RAIL_W, RAIL_W_COLLAPSED]).toEqual([192, 80])
    expect(rail().style.width).toBe('192px')
    expect((host.firstElementChild as HTMLElement).style.getPropertyValue('--bee-rail-w')).toBe('192px')
    const css = read('app/globals.css')
    expect(css).toContain('.bee-main{margin-left:var(--bee-rail-w,192px)!important}')
    expect(css).toContain('.bee-loc-banner{left:var(--bee-rail-w,192px)!important}')
    expect(css).not.toContain('220px!important')
  })

  it('no label can wrap: each is told to stay on one line', async () => {
    await mount(ROLES[4].props)
    for (const k of keys()) {
      const name = Array.from(item(k).querySelectorAll('span')).filter(s => s.children.length === 0 && (s.textContent || '').trim() && !s.hasAttribute('aria-hidden')) as HTMLElement[]
      expect(name.length, k).toBeGreaterThan(0)
      for (const n of name) expect(n.style.whiteSpace, `${k}: "${n.textContent}"`).toBe('nowrap')
    }
  })
})

describe('the collapse control', () => {
  it('folds the menu to an 80px icon strip and back; every item keeps its name for a screen reader', async () => {
    await mount(ROLES[4].props)
    const toggle = () => rail().querySelector('[data-rail-collapse]') as HTMLElement
    expect(toggle().getAttribute('aria-label')).toBe('Collapse menu')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await click(toggle())
    expect(rail().style.width).toBe('80px')
    expect(rail().hasAttribute('data-collapsed')).toBe(true)
    expect((host.firstElementChild as HTMLElement).style.getPropertyValue('--bee-rail-w')).toBe('80px')
    expect(toggle().getAttribute('aria-label')).toBe('Expand menu')
    // Icons only: no names drawn, but each live item still says what it is.
    expect(rail().querySelector('nav')!.textContent).toBe('')
    expect(['home', 'reminders', 'hive', 'settings', 'help', 'admin'].map(k => item(k).getAttribute('aria-label'))).toEqual(['Home', 'Reminders', 'Clients', 'Settings', 'Help', 'Admin'])
    expect(item('partners').getAttribute('title')).toBe('Network & Nurture — under redesign')
    // Still the same items, the live ones still work, the closed ones are still not buttons.
    expect(keys()).toEqual(['home', 'reminders', 'hive', 'partners', 'reports', 'backoffice', 'settings', 'help', 'admin'])
    await click(item('settings')); expect(current()).toBe('settings')
    expect(item('reports').tagName).toBe('DIV')
    // No menu filter on the strip; search and Ask are still there.
    expect(rail().querySelector('[data-rail-filter]')).toBeNull()
    expect(rail().querySelector('[data-rail-search]')).toBeTruthy()
    expect(rail().querySelector('button[aria-label="Ask Bee Hub"]')).toBeTruthy()
    await click(toggle())
    expect(rail().style.width).toBe('192px')
    expect(rail().querySelector('nav')!.textContent).toContain('Home')
  })

  it('the collapsed state SURVIVES A RELOAD: it is remembered in this browser, and read back on the next load', async () => {
    await mount(ROLES[0].props)
    expect(window.localStorage.getItem(RAIL_COLLAPSED_KEY)).toBeNull()
    await click(rail().querySelector('[data-rail-collapse]'))
    expect(window.localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('1')
    await mount(ROLES[0].props)                       // a reload
    expect(rail().style.width).toBe('80px')
    await click(rail().querySelector('[data-rail-collapse]'))
    expect(window.localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('0')
    await mount(ROLES[0].props)
    expect(rail().style.width).toBe('192px')
  })

  it('on the strip the account is a face that opens the menu back out (the identity control needs the room)', async () => {
    await mount(ROLES[4].props)
    await click(rail().querySelector('[data-rail-collapse]'))
    const face = rail().querySelector('[data-rail-account]') as HTMLElement
    expect(face.textContent).toBe('SS')
    expect(rail().querySelector('[data-rail-identity]')).toBeNull()
    await click(face)
    expect(rail().style.width).toBe('192px')
    expect(rail().querySelector('[data-rail-identity]')).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE MENU FILTER
// ═══════════════════════════════════════════════════════════════════════════
describe('the search box filters the menu', () => {
  it('typing narrows the items; clearing brings them back; nothing matching says so', async () => {
    await mount(ROLES[4].props)
    const box = rail().querySelector('input[aria-label="Search menu"]')!
    await type(box, 'se')
    expect(keys()).toEqual(['settings'])
    await type(box, 'RE')                              // any case; closed items are still listed, still closed
    expect(keys()).toEqual(['reminders', 'partners', 'reports'])
    expect(item('reports').tagName).toBe('DIV')
    await type(box, 'adm')
    expect(keys()).toEqual(['admin'])
    await type(box, 'zzz')
    expect(keys()).toEqual([])
    expect(rail().querySelector('[data-rail-empty]')!.textContent).toBe('Nothing in the menu matches “zzz”.')
    await type(box, '')
    expect(keys().length).toBe(9)
  })

  it('it cannot surface an item the viewer does not have', async () => {
    await mount(ROLES[0].props)
    await type(rail().querySelector('input[aria-label="Search menu"]'), 'adm')
    expect(keys()).toEqual([])
  })

  it('it is the menu filter, not the client search: that is still its own button, and ⌘K still opens it', async () => {
    await mount(ROLES[0].props)
    const search = rail().querySelector('[data-rail-search]') as HTMLElement
    expect(search.getAttribute('aria-label')).toBe('Search clients and contacts')
    expect(HUB).toContain('onSearch={()=>setShowGlobalSearch(true)}')
    expect(HUB).toContain("function onKey(e) { if ((e.metaKey||e.ctrlKey) && e.key==='k') { e.preventDefault(); setShowGlobalSearch(true) } }")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · THE PHONE DRAWER
// ═══════════════════════════════════════════════════════════════════════════
describe('the phone drawer is the same menu, sliding in', () => {
  it('opens from the top bar as a dialog holding the same items', async () => {
    await mount(ROLES[4].props)
    expect(drawer()).toBeNull()
    const d = await openDrawer()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.hasAttribute('data-rail-drawer')).toBe(true)          // the slide-in is on this attribute
    expect(RAIL).toContain('[data-app-rail][data-rail-drawer]{animation:bee-rail-drawer-in .25s ease-out}')
    expect(keys(d)).toEqual(keys())
    expect(current(d)).toBe('home')
    // The page behind does not scroll while it is open.
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('tapping the dimmed page closes it', async () => {
    await mount(ROLES[0].props)
    await openDrawer()
    const away = host.querySelector('[data-rail-dismiss]') as HTMLElement
    expect(away.getAttribute('aria-label')).toBe('Close menu')
    await click(away)
    expect(drawer()).toBeNull()
    expect(document.body.style.overflow).toBe('')
  })

  it('so do the × and Escape', async () => {
    await mount(ROLES[0].props)
    let d = await openDrawer()
    await click(d.querySelector('button[aria-label="Close menu"]'))
    expect(drawer()).toBeNull()
    d = await openDrawer()
    await act(async () => { d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(drawer()).toBeNull()
  })

  it('picking an item goes there and closes the drawer; a closed item does neither', async () => {
    await mount(ROLES[0].props)
    let d = await openDrawer()
    await click(item('reports', d))
    expect(drawer(), 'still open').toBeTruthy()
    expect(current()).toBe('home')
    await click(item('settings', d))
    expect(drawer()).toBeNull()
    expect(current()).toBe('settings')
    expect(window.location.pathname).toBe('/settings')
  })

  it('it ends the way the old drawer did: who you are, and Sign Out — and has no collapse control', async () => {
    await mount(ROLES[1].props)
    const d = await openDrawer()
    const acct = d.querySelector('[data-rail-mobile-account]')!
    expect(acct.textContent).toContain('Max Manager'); expect(acct.textContent).toContain('Hive Manager')
    expect((acct.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('/api/auth/signout')
    expect(d.querySelector('[data-rail-collapse]')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7 · WHAT THE EXPORT DROPPED AND BEE HUB KEEPS
// ═══════════════════════════════════════════════════════════════════════════
describe('kept, though the export has none of them', () => {
  it('Ask Bee Hub is in the menu and in the drawer — on a desktop it is the only way to the Guide and the Manual', async () => {
    await mount(ROLES[0].props)
    expect(rail().querySelector('[data-rail-ask] button[aria-label="Ask Bee Hub"]')).toBeTruthy()
    const d = await openDrawer()
    expect(d.querySelector('[data-rail-ask] button[aria-label="Ask Bee Hub"]')).toBeTruthy()
    expect(HUB.split('<AskBeeHubButton ').length - 1).toBe(2)   // the menu, and the phone top bar
  })

  it('the identity control is the footer, handed in whole with the handlers it had', () => {
    expect(HUB.split('<IdentityScopeControl').length - 1).toBe(1)
    for (const h of ['onOpenViewAs={()=>{', 'onExitViewAs={()=>{', 'onOpenLocationPicker={()=>setShowLocPicker(true)}', 'signOutHref="/api/auth/signout"', 'canSwitchLocation={isElevated}']) expect(HUB).toContain(h)
  })

  it('the onboarding lock is what it was: a franchise still setting up may open only Home and Help', async () => {
    const onboarding = { ...ROLES[0].props, currentLocation: { id: KC, name: 'Kansas City', lifecycle_status: 'onboarding' }, currentSubscription: { subscription_status: 'active' } }
    await mount({ ...onboarding, initialRoute: 'help' })
    const locked = keys().filter(k => item(k).hasAttribute('data-locked'))
    expect(locked).toEqual(['reminders', 'hive', 'settings'])
    for (const k of locked) { expect(item(k).style.opacity).toBe('0.3'); await click(item(k)) }
    expect(current()).toBe('help')
    expect(item('home').hasAttribute('data-locked')).toBe(false)
    // …and corporate and super admin are never locked.
    await mount({ ...ROLES[4].props, currentLocation: { id: KC, lifecycle_status: 'onboarding' } })
    expect(keys().filter(k => item(k).hasAttribute('data-locked'))).toEqual([])
    expect(HUB).toContain("locked: effectiveCrmStatus==='onboarding' && !isElevated && !['home','backoffice','help'].includes(item.key),")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8 · THE LOGO, THE FONT, NO DEPENDENCY
// ═══════════════════════════════════════════════════════════════════════════
describe('the logo, the font and what the file brings in', () => {
  it('the logo is not in the export, so the bee that was there stays — nothing is drawn or fetched in its place', async () => {
    await mount(ROLES[0].props)
    const brand = rail().querySelector('[data-rail-brand]')!
    expect(brand.textContent).toBe('🐝')
    expect(brand.querySelector('img, svg')).toBeNull()
    expect(rail().querySelector('img')).toBeNull()
    // No pointer to the file Lovable hosts, and no picture of any kind in the menu's code.
    for (const src of [RAIL, HUB]) expect(src).not.toMatch(/__l5e|bee-organized-logo|assets-v1/i)
    expect(RAIL_CODE).not.toMatch(/<img|\.png|\.svg['"]/)
    expect(HUB).toContain("brandMark={<span style={{ fontSize:'24px', lineHeight:1 }}>🐝</span>}")
  })

  it('the new font is asked for by the menu and reaches only the menu', async () => {
    const { FONT_STYLESHEET_HREF, FONT } = await import('@/components/design/tokens')
    await mount({ ...ROLES[0].props, initialRoute: 'home' })
    expect(Array.from(host.querySelectorAll('link[rel="stylesheet"]')).map(l => l.getAttribute('href'))).toEqual([FONT_STYLESHEET_HREF])
    expect(rail().style.fontFamily.replace(/['"]/g, '')).toBe(FONT.ui.replace(/['"]/g, ''))
    expect(rail().style.fontFamily).toMatch(/^.?Lato/)
    // The page it frames names neither new font anywhere.
    for (const el of Array.from(host.querySelectorAll('.bee-main *')) as HTMLElement[]) expect(el.style?.fontFamily || '').not.toMatch(/Lato|Arvo/)
    // Every rule the menu adds is fenced to the menu.
    // (the stylesheet as the browser gets it; the two slide-in animations' own steps are not selectors)
    const css = (APP_RAIL_CSS as string).replace(/@keyframes [\w-]+\{(?:[^{}]*\{[^{}]*\})*\}/g, '').replace(/@media[^{]+\{/g, '')
    const selectors = Array.from(css.matchAll(/([^{}]+)\{/g)).flatMap(m => m[1].split(/,(?![^()]*\))/)).map(x => x.trim()).filter(Boolean)
    expect(selectors.length).toBeGreaterThan(6)
    for (const sel of selectors) expect(sel, sel).toMatch(/^\[data-(app-rail|rail-overlay)\]/)
  })

  it('no new dependency: the menu imports React and the shared tokens, and draws its own icons', () => {
    expect(Array.from(RAIL.matchAll(/from '([^']+)'/g)).map(m => m[1]).sort()).toEqual(['@/components/design/tokens', 'react'])
    expect(RAIL_CODE).not.toMatch(/lucide|tanstack|radix|tailwind|className="[^"]*\b(flex|grid|px-|py-)/)
    const pkg = JSON.parse(read('package.json'))
    for (const banned of ['lucide-react', 'tailwindcss', '@tanstack/react-router']) expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(banned)
    // No colour of its own.
    expect(RAIL_CODE.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([])
  })
})

