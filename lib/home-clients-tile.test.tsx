// @vitest-environment happy-dom
//
// HOME'S "CLIENTS" TILE IS THE WAY IN TO THE FULL CLIENT LIST (2026-11-13).
//
// "Everyone" left the left menu with the menu rebuild, on Kevin's ruling. The
// Home tile that showed the same count (then labelled "Everyone") was a number
// with no link, so nothing an owner could click reached the client list.
// Kevin's ruling for this change:
//   · the tile is labelled "Clients";
//   · clicking it opens the full client list — the same list, the same way it
//     has always opened (the function the menu row called);
//   · it must LOOK like it opens, not only behave like it;
//   · it works for every role that could open the list, and nothing else on
//     Home changes for anyone.
//
// These mount the WHOLE app per role, with the real Clients screen (the app
// loads it lazily; here it is handed over directly so the click can be
// followed all the way to the list on screen).
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
// The Clients screen is the lazily-loaded piece that is handed `initialIntent`
// and `people`. Give the app the REAL one; every other lazy piece stays out.
vi.mock('next/dynamic', async () => {
  const R = await import('react')
  const Shell = (await import('@/components/hive/HiveShell')).default
  return {
    default: () => function DynamicStub(props: any) {
      if (props && 'initialIntent' in props && 'people' in props) return R.createElement(Shell as any, props)
      return null
    },
  }
})

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

import App from '@/components/BeeHub'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HUB = read('components/BeeHub.jsx')

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const person = (i: number) => ({
  id: `p-${i}`, name: `Client Number${i}`, firstName: 'Client', lastName: `Number${i}`, email: `c${i}@x.com`, phone: '',
  locationId: KC, location_id: KC, stage: 'New Lead', status: 'active', tags: [], createdAt: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
})
const baseProps = (over: any = {}) => ({
  initialRoute: 'home',
  initialRole: 'super_admin',
  initialFranchiseRole: 'owner',
  initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
  initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
  initialPeople: [1, 2, 3].map(person), initialBinPeople: [], initialTransferPeople: [],
  initialEngagements: [], initialPartners: [], initialCompanies: [],
  initialGuideSlides: [], initialManualSlides: [], initialTierPrices: [],
  currentUser: { id: 'u1', email: 'k@x.com', name: 'Kevin Shaw', role: 'super_admin', locationId: null },
  currentLocation: null, currentSubscription: null,
  initialLocFilter: KC, initialScopeLocationId: KC,
  ...over,
})
const ROLES: Array<{ label: string; props: any }> = [
  { label: 'owner',       props: { initialRole: 'franchise', initialFranchiseRole: 'owner',   currentUser: { id: 'o', email: 'o@x.com', name: 'Olive Owner', role: 'owner', locationId: KC } } },
  { label: 'manager',     props: { initialRole: 'franchise', initialFranchiseRole: 'manager', currentUser: { id: 'm', email: 'm@x.com', name: 'Max Manager', role: 'manager', locationId: KC } } },
  { label: 'read-only',   props: { initialRole: 'franchise', initialFranchiseRole: 'viewer',  currentUser: { id: 'v', email: 'v@x.com', name: 'Vera Viewer', role: 'lite_user', locationId: KC } } },
  { label: 'corporate',   props: { initialRole: 'corporate',   initialFranchiseRole: 'owner', currentUser: { id: 'c', email: 'c@x.com', name: 'Cora Corp', role: 'admin', locationId: null } } },
  { label: 'super_admin', props: { initialRole: 'super_admin', initialFranchiseRole: 'owner', currentUser: { id: 's', email: 's@x.com', name: 'Sam Super', role: 'super_admin', locationId: null } } },
]

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let errSpy: any
const store = (() => { let m: Record<string, string> = {}; return { getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = String(v) }, removeItem: (k: string) => { delete m[k] }, clear: () => { m = {} } } })()
Object.defineProperty(window, 'localStorage', { configurable: true, value: store })
beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
  ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  try { act(() => root.unmount()) } catch {}
  host?.remove()
  errSpy.mockRestore()
})
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(over: any = {}) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(App as any, baseProps(over))) })
  await settle()
  return host
}
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const tile = () => host.querySelector('[data-testid="home-everyone"]') as HTMLElement
const currentNav = () => (host.querySelector('aside.bee-sidebar [aria-current="page"]') as HTMLElement | null)?.dataset.nav
const main = () => host.querySelector('.bee-main') as HTMLElement
// The client list on screen: its bands ("… group") are drawn by the list only.
const bands = () => Array.from(main().querySelectorAll('[aria-label$=" group"]'))
const LENS_KEY = 'bee_hive_beta_lens'

describe('the tile is labelled "Clients"', () => {
  for (const { label, props } of ROLES) {
    it(`${label}: reads "Clients" with the count, never "Everyone"`, async () => {
      await mount(props)
      expect(tile().textContent).toContain('Clients')
      expect(tile().textContent).not.toContain('Everyone')
      expect(tile().querySelector('[data-tile-value]')!.textContent).toBe('3')
      expect(tile().textContent).toContain('all your clients and contacts')
    })
  }
})

describe('clicking it opens the full client list', () => {
  for (const { label, props } of ROLES) {
    it(`${label}: lands on Clients, at /clients, on the client list itself`, async () => {
      await mount(props)
      expect(currentNav()).toBe('home')
      expect(bands().length).toBe(0)
      await click(tile())
      expect(currentNav()).toBe('hive')
      expect(window.location.pathname).toBe('/clients')
      // the Clients screen is showing its client list, not Inbox or Engagements
      expect(window.localStorage.getItem(LENS_KEY)).toBe('clients')
      expect(bands().length).toBeGreaterThan(0)
      // …and its groups add up to the three clients the tile counted
      const total = bands().reduce((n, h) => n + Number((h.textContent || '').split('·')[1].replace(/[^0-9]/g, '')), 0)
      expect(total).toBe(3)
    })
  }

  it('it wins over a remembered Inbox or Engagements tab', async () => {
    window.localStorage.setItem(LENS_KEY, 'engagements')
    await mount(ROLES[0].props)
    await click(tile())
    expect(window.localStorage.getItem(LENS_KEY)).toBe('clients')
    expect(bands().length).toBeGreaterThan(0)
  })

  it('the menu’s Clients button still opens Inbox, not the client list', async () => {
    await mount(ROLES[0].props)
    await click(host.querySelector('aside.bee-sidebar [data-nav="hive"]'))
    expect(currentNav()).toBe('hive')
    expect(bands().length).toBe(0)
    expect(window.localStorage.getItem(LENS_KEY)).not.toBe('clients')
  })

  it('it opens it the SAME way the menu row did: the one function, handed down', () => {
    expect(HUB).toContain('onOpenClientList={openClientListLens}')
    const use = HUB.slice(HUB.indexOf('<HomeMetricTile label="Clients" testId="home-everyone"'))
    expect(use.slice(0, 400)).toContain('onOpen={onOpenClientList}')
    const fn = HUB.slice(HUB.indexOf('const openClientListLens = () => {'), HUB.indexOf('const openClientListLens = () => {') + 320)
    expect(fn).toContain("setHiveIntent({ tab: 'clients' })")
    expect(fn).toContain("setActiveNav('hive')")
    expect(fn).toContain("pushState({}, '', '/clients')")
  })
})

describe('it looks like it opens', () => {
  it('it is a real button with a name that says what it does', async () => {
    await mount(ROLES[0].props)
    expect(tile().tagName).toBe('BUTTON')
    expect((tile() as HTMLButtonElement).type).toBe('button')
    expect((tile() as HTMLButtonElement).disabled).toBe(false)
    expect(tile().getAttribute('aria-label')).toBe('Clients: 3. Open the full list')
    expect(tile().style.cursor).toBe('pointer')
  })

  it('it carries an arrow and the words "Open the full list", both in the link colour', async () => {
    await mount(ROLES[0].props)
    const arrow = tile().querySelector('[data-tile-arrow]') as HTMLElement
    const words = tile().querySelector('[data-tile-open-label]') as HTMLElement
    expect(arrow.textContent).toBe('→')
    expect(arrow.getAttribute('aria-hidden')).toBe('true')
    expect(words.textContent).toBe('Open the full list')
    expect(words.style.color).toBeTruthy()
    expect(words.style.color).toBe(arrow.style.color)
    // not the grey of the lines above it
    const value = tile().querySelector('[data-tile-value]') as HTMLElement
    expect(words.style.color).not.toBe(value.style.color)
    expect(words.style.fontWeight).toBe('600')
  })

  it('every piece of text sets its own size, so the app-wide 16px button rule cannot swell it', async () => {
    await mount(ROLES[0].props)
    const spans = Array.from(tile().querySelectorAll('span')) as HTMLElement[]
    expect(spans.length).toBe(5)
    for (const s of spans) expect(s.style.fontSize, s.textContent || '').toMatch(/^\d+px$/)
    // no bare text directly inside the button
    expect(Array.from(tile().childNodes).every(n => n.nodeType === 1)).toBe(true)
  })

  it('hovering shows a wash, an outline and underlines the words', async () => {
    await mount(ROLES[0].props)
    const words = () => tile().querySelector('[data-tile-open-label]') as HTMLElement
    const before = { bg: tile().style.background, border: tile().style.border }
    expect(words().style.textDecoration).toBe('none')
    await act(async () => { tile().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(tile().style.background).not.toBe(before.bg)
    expect(tile().style.border).not.toBe(before.border)
    expect(words().style.textDecoration).toBe('underline')
    await act(async () => { tile().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(tile().style.background).toBe(before.bg)
    expect(words().style.textDecoration).toBe('none')
  })

  it('when the count could not be made it still opens the list', async () => {
    await mount({ ...ROLES[0].props, initialLeadsTruncated: true, initialClientsCutoff: { loadedBackTo: '2026-01-01T00:00:00Z', notListed: null } })
    expect(tile().querySelector('[data-tile-value]')!.textContent).toBe('—')
    expect(tile().textContent).toContain("Couldn't be counted just now")
    await click(tile())
    expect(currentNav()).toBe('hive')
    expect(window.localStorage.getItem(LENS_KEY)).toBe('clients')
  })
})

describe('nothing else on Home changed', () => {
  it('the other tiles are plain numbers: not buttons, no arrow, no "Open"', async () => {
    await mount(ROLES[0].props)
    const row = tile().parentElement as HTMLElement
    const others = Array.from(row.children).filter(c => c !== tile()) as HTMLElement[]
    expect(others.length).toBeGreaterThanOrEqual(3)
    for (const o of others) {
      expect(o.tagName, o.textContent || '').toBe('DIV')
      expect(o.querySelector('button, [data-tile-arrow], [data-tile-open-label]'), o.textContent || '').toBeNull()
      expect(o.textContent).not.toContain('Open the full list')
    }
    expect(row.querySelectorAll('[data-tile-opens]').length).toBe(1)
    expect(tile().previousElementSibling!.textContent).toContain('Active clients')
  })

  it('only one tile is handed a way to open anything', () => {
    const strip = HUB.slice(HUB.indexOf('<HomeMetricTile label="Open engagements"'), HUB.indexOf('<HomeMetricTile label="Open engagements"') + 3200)
    expect(strip.match(/<HomeMetricTile /g)!.length).toBeGreaterThanOrEqual(4)
    expect(strip.match(/onOpen=/g)!.length).toBe(1)
  })

  it('a tile handed no way to open is the old plain tile, even through the same component', () => {
    const fn = HUB.slice(HUB.indexOf('function HomeMetricTile('), HUB.indexOf('function HomeAllClearCard') > 0 ? HUB.indexOf('function HomeMetricTile(') + 3200 : undefined)
    expect(fn).toContain('if (onOpen) return (')
    expect(fn).toContain('onOpen = null')
  })

  it('"Everyone" is still not in the menu', async () => {
    await mount(ROLES[0].props)
    const menu = host.querySelector('aside.bee-sidebar') as HTMLElement
    expect(menu.textContent).not.toContain('Everyone')
    expect(menu.querySelectorAll('[data-nav="hive-clients"]').length).toBe(0)
  })
})
