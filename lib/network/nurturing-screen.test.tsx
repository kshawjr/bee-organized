// @vitest-environment happy-dom
//
// Slice 7: the Nurturing tab (components/network/NurturingScreen.jsx), its
// person view (NurtureSheet.jsx) and the two tabs (NetworkTabs.jsx),
// mounted for real against a fake of their two addresses. The fake server
// pages like the real one (lib/network/nurturing.test.ts pins the real one).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NurturingScreen from '@/components/network/NurturingScreen'
import NetworkTabs from '@/components/network/NetworkTabs'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = Date.parse('2026-11-20T03:00:00Z')
const row = (i: number, over: any = {}) => ({
  id: `p${i}`, name: `Person ${String(i).padStart(5, '0')}`, email: `p${i}@x.com`, phone: null, city: 'Media', zip: '19063',
  createdAt: '2025-01-01T00:00:00Z', needsContactInfo: false, lastActivity: i % 3 ? null : { at: '2025-06-01T00:00:00Z', kind: 'quote' }, ...over,
})

let people: any[] = []
let quietDays = 90
let excludedLoc = false
let calls: { url: string; method: string }[] = []
const server = vi.fn(async (url: string, init?: any) => {
  calls.push({ url, method: init?.method || 'GET' })
  const u = new URL(url, 'http://x')
  if (u.pathname === '/api/network/nurturing') {
    const size = Number(u.searchParams.get('size'))
    const q = (u.searchParams.get('q') || '').toLowerCase()
    let rows = people
    if (u.searchParams.get('needs_contact') === '1') rows = rows.filter((r) => r.needsContactInfo)
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q))
    const pages = Math.max(1, Math.ceil(rows.length / size))
    const page = Math.min(Number(u.searchParams.get('page')), pages - 1)
    return { ok: true, status: 200, json: async () => ({
      location: { id: LOC, name: 'Philadelphia Suburbs' }, quietDays, excluded: excludedLoc,
      counts: { nurturing: people.length, needsContactInfo: people.filter((r) => r.needsContactInfo).length, hadQuoteOrAssessment: people.filter((r) => r.lastActivity).length },
      total: rows.length, page, size, sort: u.searchParams.get('sort'), rows: rows.slice(page * size, (page + 1) * size),
    }) }
  }
  if (u.pathname.startsWith('/api/network/nurturing/')) {
    const id = u.pathname.split('/').pop()
    const p = people.find((r) => r.id === id)!
    return { ok: true, status: 200, json: async () => ({
      person: { id, name: p.name, company: null, email: p.email, phone: p.phone, address: '12 Elm St', cityLine: 'Media, PA 19063', source: 'Website', projectType: 'Garage', requestDetails: 'Garage is chaos', notes: null, createdAt: p.createdAt, locationName: 'Philadelphia Suburbs', locationId: LOC, preferredContact: null, marketing: { state: 'ok', at: null }, mailchimpStatus: null, needsContactInfo: p.needsContactInfo },
      verdict: { nurturing: true, why: null, needsContactInfo: p.needsContactInfo, lastActivity: { at: '2025-06-01T00:00:00Z', kind: 'quote' } },
      quietDays,
      assessments: [], quotes: [{ id: 'q1', status: 'sent', total: 1200, at: '2025-06-01T00:00:00Z', counts: true }, { id: 'q2', status: 'draft', total: 50, at: '2026-11-01T00:00:00Z', counts: false }],
      jobs: [], requests: [{ id: 'r1', status: 'new', at: '2025-01-01T00:00:00Z' }],
      engagements: [{ id: 'e1', title: 'Garage', stage: 'Closed Lost', closedReason: 'stale_on_import', closedAt: '2025-02-05T00:00:00Z' }],
      tags: [{ id: 't1', label: 'Hot Lead', icon: '🔥' }], touchpoints: [], followUps: [],
    }) }
  }
  return { ok: false, status: 404, json: async () => ({}) }
})

let host: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  calls = []; quietDays = 90; excludedLoc = false; server.mockClear()
  people = Array.from({ length: 18826 }, (_, i) => row(i))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }); await settle() }
async function mount(el: any) { await act(async () => { root.render(el) }); await settle() }
const screen = (over: any = {}) => mount(React.createElement(NurturingScreen as any, { locationId: LOC, locationName: 'Philadelphia Suburbs', fetchImpl: server, nowMs: NOW, ...over }))
const $ = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
const $$ = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[]
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim()
// A real press: pointerdown, mousedown, click, each on its own (batched they hide bugs).
async function press(el: Element) {
  await act(async () => { el.dispatchEvent(new (window as any).PointerEvent('pointerdown', { bubbles: true })) })
  await act(async () => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  await act(async () => { (el as HTMLElement).click() })
  await settle()
}
const lastAsk = () => new URL(calls.filter((c) => c.url.startsWith('/api/network/nurturing?')).pop()!.url, 'http://x').searchParams
async function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const key = async (k: string) => { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }); await settle() }

describe('Philadelphia Suburbs: 18,826 people', () => {
  it('shows one page of 25, the counts, and where you are', async () => {
    await screen()
    expect($$('[data-row]')).toHaveLength(25)
    expect(text('[data-stat="nurturing"]')).toBe('18,826 nurturing')
    expect(text('[data-pager-summary]')).toBe('1–25 of 18,826 nurturing')
    expect(text('[data-page-pos]')).toBe('Page 1 of 754')
    expect(lastAsk().get('size')).toBe('25')
    expect($('[data-page="prev"]')!.hasAttribute('disabled')).toBe(true)
  })
  it('the second page and the last page', async () => {
    await screen()
    await press($('[data-page="next"]')!)
    expect(lastAsk().get('page')).toBe('1')
    expect(text('[data-pager-summary]')).toBe('26–50 of 18,826 nurturing')
    expect($$('[data-row]')[0].textContent).toContain('Person 00025')
    const before = calls.length
    await press($('[data-page="last"]')!)
    // the screen's own arithmetic: it asks for the last page, not one past it (the server would hide that)
    expect(calls.slice(before).map((c) => new URL(c.url, 'http://x').searchParams.get('page'))).toEqual(['753'])
    expect(text('[data-page-pos]')).toBe('Page 754 of 754')
    expect(text('[data-pager-summary]')).toBe('18,826 of 18,826 nurturing')
    expect($$('[data-row]')).toHaveLength(1)
    expect($('[data-page="next"]')!.hasAttribute('disabled')).toBe(true)
  })
  it('a phone starts at 10 a page', async () => {
    await screen({ isMobile: true })
    expect($$('[data-row]')).toHaveLength(10)
    expect(text('[data-page-pos]')).toBe('Page 1 of 1,883')
  })
  it('search asks the server after a pause, from the first page', async () => {
    await screen()
    await press($('[data-page="next"]')!)
    const before = calls.length
    await type($('[data-search]') as HTMLInputElement, 'Person 0001')
    expect(calls.length).toBe(before) // not on every key
    await wait(350)
    expect(lastAsk().get('q')).toBe('Person 0001')
    expect(lastAsk().get('page')).toBe('0')
    expect(text('[data-pager-summary]')).toBe('10 people matching')
  })
})

describe('a location with 12 people', () => {
  it('reads as a normal short list: no pages, no warning', async () => {
    people = people.slice(0, 12)
    await screen({ locationName: 'Tulsa' })
    expect($$('[data-row]')).toHaveLength(12)
    expect(text('[data-pager-summary]')).toBe('12 people nurturing')
    expect($('[data-page="next"]')).toBeNull()
    expect($('[data-page-pos]')).toBeNull()
    expect($('[data-empty]')).toBeNull()
    expect($('[data-problem]')).toBeNull()
    expect($$('[data-pager]')).toHaveLength(1)
    expect(text('.nn-title')).toBe('Nurturing · Tulsa')
  })
  it('nobody at all reads as nobody, not as broken', async () => {
    people = []
    await screen({ locationName: 'Reno' })
    expect(text('[data-empty]')).toBe('Nobody at Reno is Nurturing right now.')
    expect($('[data-problem]')).toBeNull()
  })
})

describe('Test Location', () => {
  it('says it is left out, not that nobody is Nurturing', async () => {
    people = []; excludedLoc = true
    await screen({ locationName: 'Test Location' })
    expect(text('[data-empty]')).toBe('Test Location is left out of Nurturing: it is Bee Hub’s test location or the transfer queue.')
  })
})

describe('a search with no results', () => {
  it('says so and offers to clear it', async () => {
    await screen()
    await type($('[data-search]') as HTMLInputElement, 'zebra')
    await wait(350)
    expect($$('[data-row]')).toHaveLength(0)
    expect(text('[data-empty]')).toContain('Nobody here matches “zebra”.')
    await press($('[data-clear-search]')!)
    await wait(350)
    expect($$('[data-row]')).toHaveLength(25)
  })
})

describe('Needs contact info', () => {
  beforeEach(() => { people[3] = row(3, { email: null, phone: null, needsContactInfo: true }); people[40] = row(40, { email: null, phone: null, needsContactInfo: true }) })
  it('they are listed with everyone else, flagged on the row', async () => {
    await screen()
    const r = $(`[data-row="p3"]`)!
    expect(r.querySelector('[data-flag="needs-contact"]')!.textContent).toBe('Needs contact info')
    expect(r.textContent).toContain('Media 19063') // what they do have is still shown
    expect(text('[data-stat="needs-contact"]')).toBe('2 need contact info')
  })
  it('the Filters menu finds just them, and says how many', async () => {
    await screen()
    await press($('[data-filters-trigger]')!)
    expect(text('[data-filter="needs-contact"]')).toBe('Needs contact info2')
    await press($('[data-filter="needs-contact"]')!)
    expect(lastAsk().get('needs_contact')).toBe('1')
    expect($$('[data-row]').map((e) => e.getAttribute('data-row'))).toEqual(['p3', 'p40'])
    expect(text('[data-pager-summary]')).toBe('2 people needing contact info')
    expect($('[data-filters-trigger]')!.getAttribute('aria-label')).toBe('Filters, 1 on')
  })
  it('the count in the band is a shortcut to the same filter', async () => {
    await screen()
    await press($('[data-stat="needs-contact"]')!)
    expect($('[data-stat="needs-contact"]')!.getAttribute('aria-pressed')).toBe('true')
    expect($$('[data-row]')).toHaveLength(2)
  })
})

describe('opening a person', () => {
  it('opens a view built for a lead, not the partner sheet', async () => {
    await screen()
    await press($('[data-row="p0"]')!)
    expect(calls.some((c) => c.url === '/api/network/nurturing/p0')).toBe(true)
    const sheet = $('[data-nurture-person="p0"]')!
    expect(sheet).toBeTruthy()
    expect($('[data-contact-sheet]')).toBeNull()
    const words = sheet.textContent!
    for (const s of ['Why they’re here', 'What they asked for', 'Garage is chaos', 'History', 'Closed Lost · Stale on import', 'Hot Lead', 'Never had a job.']) expect(words).toContain(s)
    expect(text('[data-why-last]')).toContain('Nurturing starts 90 days after the last assessment or quote.')
    expect(words).not.toContain('stale_on_import') // a code, never shown raw
    for (const partnerOnly of ['Partner level', 'Referral partner', 'Power Partner', 'Not sure yet', 'Vendor', 'New Contact', 'Reaching Out']) expect(words).not.toContain(partnerOnly)
    // slice 8: the only things to fill in are a lead's: a tag and a follow-up. No partner field.
    expect(Array.from(sheet.querySelectorAll('input, textarea, select')).map((e) => Object.keys((e as HTMLElement).dataset)[0]).sort()).toEqual(['dueInput', 'followUpNote', 'tagPick'])
  })
  it('it is a window: a click outside never closes it; its ✕ and Escape do', async () => {
    await screen()
    await press($('[data-row="p0"]')!)
    await press($('[data-nurture-sheet]')!) // the dim layer
    await press(document.body)
    expect($('[data-nurture-person]')).toBeTruthy()
    await press($('[data-nurture-sheet] [data-close]')!)
    expect($('[data-nurture-person]')).toBeNull()
    await press($('[data-row="p1"]')!)
    await key('Escape')
    expect($('[data-nurture-person]')).toBeNull()
  })
  it('the "why" line follows the server\'s number: lower it and the words change', async () => {
    quietDays = 60
    await screen()
    expect(text('[data-lede]')).toContain('in 60 days')
    await press($('[data-row="p0"]')!)
    expect(text('[data-why-last]')).toContain('Nurturing starts 60 days after')
  })
})

describe('the menus: close on a click away, Escape, a choice or their own button', () => {
  it('Filters and Sort', async () => {
    await screen()
    for (const trig of ['[data-filters-trigger]', '[data-sort-trigger]']) {
      await press($(trig)!)
      expect($('.nn-menu'), `${trig} opens`).toBeTruthy()
      await press($('.nn-title')!)
      expect($('.nn-menu'), `${trig} click away`).toBeNull()
      await press($(trig)!)
      await key('Escape')
      expect($('.nn-menu'), `${trig} Escape`).toBeNull()
      await press($(trig)!)
      await press($(trig)!)
      expect($('.nn-menu'), `${trig} its own button`).toBeNull()
    }
    // a click away applied nothing
    expect(lastAsk().get('needs_contact')).toBeNull()
    expect(lastAsk().get('sort')).toBe('az')
  })
  it('a sort is one tap', async () => {
    await screen()
    await press($('[data-sort-trigger]')!)
    await press($('[data-sort="newest"]')!)
    expect(lastAsk().get('sort')).toBe('newest')
    expect($('.nn-menu')).toBeNull()
  })
})

describe('on a phone', () => {
  it('Filters opens from its own left edge, Sort from its right (Filters ran off the screen at 390px)', async () => {
    await screen({ isMobile: true })
    const css = Array.from(document.querySelectorAll('style')).map((x) => x.textContent).join('')
    expect(css).toContain('[data-nurture-ui] .nn-anchor[data-menu-side="left"] .nn-menu{left:0;right:auto}')
    expect($('[data-filters-trigger]')!.closest('.nn-anchor')!.getAttribute('data-menu-side')).toBe('left')
    expect($('[data-sort-trigger]')!.closest('.nn-anchor')!.getAttribute('data-menu-side')).toBe('right')
  })
})

describe('read only', () => {
  // Slice 8 ended "read only" on purpose (ticks, a bulk bar, tags and follow-ups:
  // lib/network/nurturing-actions-screen.test.tsx). Looking and paging still only read.
  it('opening a person, closing and paging only read', async () => {
    await screen()
    await press($('[data-row="p0"]')!)
    await press($('[data-nurture-sheet] [data-close]')!)
    await press($('[data-page="next"]')!)
    expect(calls.length).toBeGreaterThan(2)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(text('[data-preview-note]')).toContain('Only super admins')
  })
  it('the person view is not the partner sheet, and imports nothing that saves', () => {
    const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
    for (const f of ['components/network/NurturingScreen.jsx', 'components/network/NurtureSheet.jsx']) {
      const imports = src(f).split('\n').filter((l) => /^import /.test(l)).join('\n')
      expect(imports, f).not.toMatch(/ContactSheet/)
      expect(imports, f).not.toMatch(/contact-edit|contact-adds|contact-writes|bulk/)
    }
  })
  it('on All Locations it asks for one location and reads nothing', async () => {
    await screen({ locationId: null })
    expect($('[data-pick-location]')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})

describe('the two tabs', () => {
  // The Network list's reads, plus the tab counts. The list loads ZERO rows
  // here on purpose: the numbers on the tabs must come from the counts read,
  // never from what a screen loaded (a Supabase read stops at 1,000 rows).
  const tabsFetch = (countsAnswer: any = { ok: true, status: 200, json: async () => ({ network: 100, nurturing: 5037 }) }) => vi.fn(async (url: string, init?: any) => {
    if (String(url).startsWith('/api/network/counts')) { calls.push({ url, method: 'GET' }); return countsAnswer }
    if (String(url).startsWith('/api/network/list')) { calls.push({ url, method: 'GET' }); return { ok: true, status: 200, json: async () => ({ contacts: [], tags: [], followUps: {}, total: 0, truncated: false }) } }
    if (String(url).startsWith('/api/network/summary')) { calls.push({ url, method: 'GET' }); return { ok: true, status: 200, json: async () => ({ referrers: [], totals: {} }) } }
    if (String(url).startsWith('/api/lookups')) { calls.push({ url, method: 'GET' }); return { ok: true, status: 200, json: async () => ({ lookups: [] }) } }
    return server(url, init)
  })
  const tabs = (fetchImpl: any, over: any = {}) => mount(React.createElement(NetworkTabs as any, { locationId: LOC, locationName: 'Philadelphia Suburbs', fetchImpl, ...over }))
  const networkReads = () => calls.filter((c) => /^\/api\/(network\/list|network\/summary|lookups)/.test(c.url))

  it('open on Network, and switch to Nurturing: the Network list goes away', async () => {
    await tabs(tabsFetch())
    expect($('[data-tab="network"]')!.getAttribute('aria-selected')).toBe('true')
    expect($('[data-network-list]')).toBeTruthy()
    expect($('[data-nurture-ui]')).toBeNull()
    await press($('[data-tab="nurture"]')!)
    expect($('[data-network-list]')).toBeNull()
    expect($('[data-nurture-ui]')).toBeTruthy()
    expect($$('[data-row]')).toHaveLength(25)
  })

  it('the Network list is not loaded while the Nurturing tab is showing (Kevin, 2026-11-25)', async () => {
    await tabs(tabsFetch(), { startOnNurturing: true })
    expect($('[data-nurture-ui]')).toBeTruthy()
    expect($('[data-network-list]')).toBeNull()
    expect(networkReads()).toEqual([])
    // Going to Network loads it then, and not before.
    await press($('[data-tab="network"]')!)
    expect(networkReads().map((c) => c.url.split('?')[0])).toContain('/api/network/list')
  })

  it('each tab shows its count from the server, written with commas, on either tab', async () => {
    await tabs(tabsFetch())
    expect($('[data-tab="network"]')!.textContent).toBe('Network & Partners(100)')
    expect($('[data-tab="nurture"]')!.textContent).toBe('Nurturing Clients(5,037)')
    await press($('[data-tab="nurture"]')!)
    expect($('[data-tab="network"]')!.textContent).toBe('Network & Partners(100)')
    expect($('[data-tab="nurture"]')!.textContent).toBe('Nurturing Clients(5,037)')
    expect(calls.filter((c) => c.url.startsWith('/api/network/counts')).map((c) => c.url)).toEqual([`/api/network/counts?location_id=${LOC}`])
  })

  it('no count from the server means no number on the tab, never a made-up zero', async () => {
    await tabs(tabsFetch({ ok: false, status: 500, json: async () => ({ error: 'x' }) }))
    expect($('[data-tab="network"]')!.textContent).toBe('Network & Partners')
    expect($('[data-tab="nurture"]')!.textContent).toBe('Nurturing Clients')
    expect($('[data-tab-count]')).toBeNull()
  })

  it('Network: Add and the three dots sit at the top right of the tab bar', async () => {
    await tabs(tabsFetch())
    const spot = $('[data-network-tab-actions]')!
    expect(spot.closest('.nt-bar')).toBeTruthy()
    expect($$('[data-network-tab-actions] button').map((b) => b.getAttribute('data-act'))).toEqual(['add-contacts', 'more'])
    expect($('[data-actions]')).toBeNull() // not under the title any more
    expect(($('[data-act="add-contacts"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Nurturing: no Add and no three dots (Kevin, 2026-11-25: nothing to add a person to)', async () => {
    await tabs(tabsFetch())
    await press($('[data-tab="nurture"]')!)
    expect($('[data-network-tab-actions]')).toBeNull()
    expect($('[data-act="add-contacts"]')).toBeNull()
    expect($('[data-act="more"]')).toBeNull()
    // and back on Network they are there again
    await press($('[data-tab="network"]')!)
    expect($$('[data-network-tab-actions] button').map((b) => b.getAttribute('data-act'))).toEqual(['add-contacts', 'more'])
  })

  it('the three dots hold Export, and only Export', async () => {
    await tabs(tabsFetch())
    await press($('[data-act="more"]')!)
    expect($$('[data-network-tab-actions] [role="menuitem"]').map((b) => b.getAttribute('data-act'))).toEqual(['export'])
  })
})
