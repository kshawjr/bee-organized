// @vitest-environment happy-dom
//
// The new Network list (components/network/NetworkListScreen.jsx), mounted
// for real against a fake of its two addresses. The contacts fed in are
// production's 263 live contacts by SHAPE: the slice 2 fixture holds every
// distinct shape with the type, level and stage the backfill stored (no
// names, no ids), so the numbers on screen here are the real ones.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkListScreen, { tagTone } from '@/components/network/NetworkListScreen'
import fixture from './__fixtures__/live-mapping-sql.json'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = new Date('2026-11-15T12:00:00Z')

// 263 rows in production's proportions. Tag names → ids; a few rows are given
// real-looking details so search has something to find.
const TAG_ID: Record<string, string> = {}
const tagId = (label: string) => (TAG_ID[label] ||= `tag-${Object.keys(TAG_ID).length + 1}`)
let n = 0
const PROD_ROWS = fixture.shapes.flatMap((s) => Array.from({ length: s.live }, () => {
  n += 1
  return {
    id: `c${n}`, locationId: LOC, locationName: 'Greensboro', name: `Contact ${String(n).padStart(3, '0')}`,
    company: null, title: null, phone: null, email: null, howWeMet: null,
    networkTypes: s.types, partnerLevel: s.level, partnerStage: s.stage_out,
    tagIds: s.tags.map(tagId), lastContactedAt: null, isCustomer: false,
  }
}))
const firstOf = (type: string) => PROD_ROWS.find((r) => r.networkTypes.join() === type)!
const NAMED_PARTNER = firstOf('partner')
Object.assign(NAMED_PARTNER, { name: 'Aaron Able', company: 'Keystone Realty', email: 'aaron@keystone.example', phone: '(303) 555-0142', lastContactedAt: '2026-08-01T00:00:00Z' })
const NAMED_VENDOR = firstOf('vendor')
Object.assign(NAMED_VENDOR, { name: 'Vera Vendor', company: 'Bright Line Electric', email: 'vera@brightline.example', phone: '(720) 555-0177' })
const NAMED_UNSURE = firstOf('unsure')
Object.assign(NAMED_UNSURE, { name: 'Una Unsure', isCustomer: true })

const listJson = (rows = PROD_ROWS, over: any = {}) => ({
  contacts: rows,
  tags: Object.entries(TAG_ID).map(([label, id]) => ({ id, label })),
  followUps: { [NAMED_PARTNER.id]: '2026-11-10', [NAMED_VENDOR.id]: '2026-12-01' },
  total: rows.length, truncated: false, ...over,
})
const summaryJson = { referrers: [{ kind: 'partner', id: NAMED_PARTNER.id, count: 3, converted: 2, revenue: 4200 }], totals: {} }

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string }[]
const fakeFetch = (list: any = listJson(), status = 200) => vi.fn(async (url: string, init?: any) => {
  calls.push({ url, method: init?.method || 'GET' })
  if (url.startsWith('/api/network/list')) return { ok: status === 200, status, json: async () => (status === 200 ? list : { error: 'forbidden' }) }
  if (url.startsWith('/api/network/summary')) return { ok: true, status: 200, json: async () => summaryJson }
  return { ok: false, status: 404, json: async () => ({}) }
})
const settle = async (k = 4) => { for (let i = 0; i < k; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
async function mount(props: any = {}) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(React.createElement(NetworkListScreen as any, { locationId: LOC, locationName: 'Greensboro', onOpenContact: vi.fn(), fetchImpl: fakeFetch(), now: NOW, ...props })) })
  await settle()
}
const $ = (sel: string) => host.querySelector(sel) as HTMLElement | null
const $$ = (sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[]
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle(1) }
const type = async (input: Element | null, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle(1)
}
const pill = (t: string) => $(`[data-type-pill="${t}"]`)!
const pillCount = (t: string) => Number(pill(t).querySelector('[data-count]')!.textContent)
const rows = () => $$('[data-row]')
const names = () => rows().map((r) => r.querySelector('[data-name]')!.textContent)
const openFilters = async () => { if (!$('[data-option="follow-up"]')) await click($('[data-filters-trigger]')) }
const option = (id: string) => $(`[data-option="${id}"]`)!
const matching = () => $('[data-matching]')?.textContent

beforeEach(() => { calls = [] })
afterEach(() => { try { act(() => root.unmount()) } catch {} host?.remove() })

describe('what a super admin sees: the real counts', () => {
  it('Everyone 263, Referral partner 51, Not sure yet 197', async () => {
    await mount()
    expect(pillCount('all')).toBe(263)
    expect(pillCount('partner')).toBe(51)
    expect(pillCount('unsure')).toBe(197)
  })
  it('Vendor reads 21: the 15 who are only vendors plus the 6 who are also Referral partners', async () => {
    await mount()
    expect(pillCount('vendor')).toBe(21)
    await click(pill('vendor'))
    expect(matching()).toBe('21 matching contacts')
    expect(rows()).toHaveLength(21)
    expect(rows().filter((r) => r.querySelectorAll('[data-type]').length === 2)).toHaveLength(6)
    expect(rows().filter((r) => r.querySelectorAll('[data-type]').length === 1)).toHaveLength(15)
  })
  it('Nurture and Organization are there, at 0: nothing maps to them yet', async () => {
    await mount()
    expect(pillCount('nurture')).toBe(0)
    expect(pillCount('organization')).toBe(0)
  })
  it('names the five types in full, in order, after Everyone, and has no Client', async () => {
    await mount()
    expect($$('[data-type-pill]').map((p) => p.firstChild!.textContent)).toEqual([
      'Everyone', 'Not sure yet', 'Referral partner', 'Vendor / Service Provider', 'Nurture', 'Organization',
    ]) // Not sure yet first: the biggest group (Kevin, 2026-11-19)
    expect(host.textContent).not.toMatch(/\bClient\b/)
  })
  it('opens on the groups: Not sure yet first and open (Kevin, 2026-11-19), the rest closed, each with its count', async () => {
    await mount()
    expect($$('[data-group]').map((g) => [g.dataset.group, g.querySelector('[data-group-count]')!.textContent])).toEqual([
      ['unsure', '197'], ['partner', '51'], ['vendor', '21'], ['nurture', '0'], ['organization', '0'],
    ])
    expect($('[data-group="unsure"] .nw-group-heading')!.getAttribute('aria-expanded')).toBe('true')
    expect($('[data-group="partner"] .nw-group-heading')!.getAttribute('aria-expanded')).toBe('false')
    expect($$('[data-group="partner"] [data-row]')).toHaveLength(0)
  })
  it('says it is a preview only super admins can see', async () => {
    await mount()
    expect($('[data-preview-note]')!.textContent).toContain('Only super admins can see this')
  })
})

describe('paging', () => {
  it('shows 25 at a time and says where you are', async () => {
    await mount()
    expect(rows()).toHaveLength(25)
    expect($('[data-pager-summary]')!.textContent).toBe('1–25 of 197 contacts')
    expect($('.nw-pager-pos')!.textContent).toBe('Page 1 of 8')
  })
  it('next page replaces the rows; the last page holds the remainder', async () => {
    await mount()
    const first = names()
    await click($('[aria-label="Not sure yet next page"]'))
    expect(rows()).toHaveLength(25)
    expect(names().some((x) => first.includes(x))).toBe(false)
    await click($('[aria-label="Not sure yet last page"]'))
    expect(rows()).toHaveLength(22)
    expect($('[data-pager-summary]')!.textContent).toBe('176–197 of 197 contacts')
    expect(($('[aria-label="Not sure yet next page"]') as HTMLButtonElement).disabled).toBe(true)
  })
  it('a different page size shows that many, from the first page', async () => {
    await mount()
    await click($('[aria-label="Not sure yet next page"]'))
    const select = $('[aria-label="Not sure yet per page"]') as HTMLSelectElement
    await act(async () => { select.value = '50'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(rows()).toHaveLength(50)
    expect($('[data-pager-summary]')!.textContent).toBe('1–50 of 197 contacts')
  })
  it('changing a filter goes back to the first page', async () => {
    await mount()
    await click($('[aria-label="Not sure yet next page"]'))
    await click(pill('unsure'))
    expect($('.nw-pager-pos')!.textContent).toBe('Page 1 of 8')
  })
})

describe('search: name, company, email and phone', () => {
  it.each([
    ['aaron', 'Aaron Able'], ['KEYSTONE', 'Aaron Able'], ['aaron@keystone', 'Aaron Able'], ['303-555', 'Aaron Able'],
    ['bright line', 'Vera Vendor'], ['720 555 0177', 'Vera Vendor'],
  ])('“%s” finds %s, in one flat list', async (q, who) => {
    await mount()
    await type($('[data-search]'), q)
    expect(names()).toEqual([who])
    expect(matching()).toBe('1 matching contact')
    expect($$('[data-group]').map((g) => g.dataset.group)).toEqual(['all'])
  })
  it('says so when nobody matches, and Clear filters brings everyone back', async () => {
    await mount()
    await type($('[data-search]'), 'zzzz nobody')
    expect($('[data-empty]')!.textContent).toBe('Nobody matches those filters.')
    await click($('[data-clear-filters]'))
    expect($('[data-empty]')).toBeNull()
    expect($('[data-matching]')).toBeNull()
    expect(($('[data-search]') as HTMLInputElement).value).toBe('')
  })
})

describe('filters', () => {
  it('by type: one pill, one group, that many contacts', async () => {
    await mount()
    await click(pill('unsure'))
    expect(pill('unsure').getAttribute('aria-selected')).toBe('true')
    expect(matching()).toBe('197 matching contacts')
    expect($$('[data-group]').map((g) => g.dataset.group)).toEqual(['unsure'])
    expect(rows().every((r) => r.querySelector('[data-type]')!.getAttribute('data-type') === 'unsure')).toBe(true)
  })
  it('by partner level: all 51 Referral partners are at Referral Partner, none at Power or Potential', async () => {
    await mount()
    await openFilters()
    expect(['level-potential', 'level-referral', 'level-power'].map((id) => option(id).textContent)).toEqual(['Potential', 'Referral Partner', 'Power Partner'])
    await click(option('level-referral'))
    expect(matching()).toBe('51 matching contacts')
    await click(option('level-referral'))
    await click(option('level-power'))
    expect(matching()).toBe('0 matching contacts')
  })
  it('by partner stage: the five stages, 50 at New Contact and 1 at Reaching Out', async () => {
    await mount()
    await openFilters()
    expect($$('[data-option^="stage-"]').map((o) => o.textContent)).toEqual(['New Contact', 'Reaching Out', 'Building the Relationship', 'Active Partner', 'Gone quiet'])
    await click(option('stage-Reaching Out'))
    expect(matching()).toBe('1 matching contact')
    await click(option('stage-New Contact'))
    expect(matching()).toBe('51 matching contacts')
  })
  it('the Filters button counts what is on, and Clear all turns it all off', async () => {
    await mount()
    await openFilters()
    await click(option('level-referral')); await click(option('stage-New Contact')); await click(option('follow-up'))
    expect($('[data-filters-trigger] .nw-trigger-count')!.textContent).toBe('3')
    await click($$('.nw-menu-footer button')[0])
    expect($('[data-filters-trigger] .nw-trigger-count')).toBeNull()
    expect($('[data-matching]')).toBeNull()
  })
  it('by tag: the tags in use with their counts; picking one lists who carries it', async () => {
    await mount()
    await click($('[data-tags-trigger]'))
    const realtor = option(`tag-${TAG_ID['Realtor']}`)
    const carrying = PROD_ROWS.filter((r) => r.tagIds.includes(TAG_ID['Realtor'])).length
    expect(realtor.querySelector('.nw-option-count')!.textContent).toBe(String(carrying))
    await click(realtor)
    expect(matching()).toBe(`${carrying} matching contacts`)
    expect($('[data-tags-trigger] .nw-trigger-count')!.textContent).toBe('1')
  })
  it('a tag handed in from Search starts the list filtered by it, once', async () => {
    const consumed = vi.fn()
    await mount({ initialTagId: TAG_ID['Vendor'], onInitialTagConsumed: consumed })
    const carrying = PROD_ROWS.filter((r) => r.tagIds.includes(TAG_ID['Vendor'])).length
    expect(matching()).toBe(`${carrying} matching contacts`)
    expect(consumed).toHaveBeenCalledTimes(1)
  })
})

describe('a menu closes on a click anywhere outside it, and applies nothing (Kevin, 2026-11-19)', () => {
  // Kevin reversed Bee Hub's 2026-09-30 "nothing closes on an outside click"
  // rule FOR THE NETWORK SCREENS: "anywhere on the screen should clear the
  // prompt." The rest of Bee Hub is unchanged until he rules on it.
  const press = async (el: Element) => {
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click']) await act(async () => { el.dispatchEvent(new MouseEvent(ev, { bubbles: true })) })
  }
  const MENUS = [
    ['Filters', '[data-filters-trigger]'], ['Tags', '[data-tags-trigger]'],
    ['Add contacts', '[data-act="add-contacts"]'], ['More', '[data-act="more"]'],
  ] as const
  for (const [name, trigger] of MENUS) {
    it(`${name}: a click on the page outside it closes it`, async () => {
      await mount()
      await click($(trigger))
      expect($('.nw-menu')).toBeTruthy()
      await press($('[data-preview-note]')!)
      expect($('.nw-menu')).toBeNull()
      expect($(trigger)!.getAttribute('aria-expanded')).toBe('false')
    })
    it(`${name}: a tap on the bare page closes it too`, async () => {
      await mount()
      await click($(trigger))
      await press(document.body)
      expect($('.nw-menu')).toBeNull()
    })
    it(`${name}: a click inside it does not close it`, async () => {
      await mount()
      await click($(trigger))
      await press($('.nw-menu')!)
      expect($('.nw-menu')).toBeTruthy()
    })
    it(`${name}: its button again closes it, and Escape closes it`, async () => {
      await mount()
      await click($(trigger)); await click($(trigger))
      expect($('.nw-menu')).toBeNull()
      await click($(trigger))
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect($('.nw-menu')).toBeNull()
    })
  }
  for (const [name, trigger] of [['Filters', '[data-filters-trigger]'], ['Tags', '[data-tags-trigger]']] as const) {
    it(`${name}: Done closes it`, async () => {
      await mount()
      await click($(trigger))
      expect($('[data-menu-done]')!.textContent).toBe('Done')
      await click($('[data-menu-done]'))
      expect($('.nw-menu')).toBeNull()
    })
  }
  it('closing from outside applies nothing: the list, the filters and the counts are exactly as before', async () => {
    await mount()
    for (const [, trigger] of MENUS) {
      const before = [names().join('|'), $('[data-matching]')?.textContent ?? null, $$('[data-type-pill][aria-selected="true"]')[0]?.dataset.typePill]
      await click($(trigger))
      await press($('[data-preview-note]')!)
      expect([names().join('|'), $('[data-matching]')?.textContent ?? null, $$('[data-type-pill][aria-selected="true"]')[0]?.dataset.typePill]).toEqual(before)
      expect($('[data-network-add]')).toBeNull() // Add contacts opened nothing
      expect($('[data-network-import]')).toBeNull()
    }
    expect(calls).toHaveLength(3) // the three first reads; nothing else was asked for or sent
  })
  it('a filter ticked before the outside click stays ticked, the same as Escape or Done', async () => {
    await mount()
    await openFilters()
    await click(option('level-referral'))
    const after = $('[data-matching]')!.textContent
    await press($('[data-preview-note]')!)
    expect($('.nw-menu')).toBeNull()
    expect($('[data-matching]')!.textContent).toBe(after)
  })
  it('picking a filter keeps the menu open, so several can be picked', async () => {
    await mount()
    await openFilters()
    await click(option('level-referral'))
    expect($('.nw-menu')).toBeTruthy()
  })
  it('opening one menu closes the other', async () => {
    await mount()
    await click($('[data-tags-trigger]'))
    await press($('[data-filters-trigger]')!)
    expect($$('.nw-menu')).toHaveLength(1)
    expect($('[data-tags-trigger]')!.getAttribute('aria-expanded')).toBe('false')
    expect($('[data-filters-trigger]')!.getAttribute('aria-expanded')).toBe('true')
  })
  it('the screen adds no page listener of its own: the menu uses Bee Hub’s one click-away hook, taken off when the menu closes', async () => {
    const src = readFileSync(join(process.cwd(), 'components/network/NetworkListScreen.jsx'), 'utf8')
    expect(src).not.toMatch(/addEventListener\(\s*['"](click|mousedown|pointerdown|touchstart)['"]/)
    expect(src.match(/useClickAway\(/g)).toHaveLength(1)
    expect(src).toContain('useClickAway(open, () => setOpen(false), insideRefs(anchor))')
    const add = vi.spyOn(document, 'addEventListener'); const off = vi.spyOn(document, 'removeEventListener')
    await mount()
    await click($('[data-tags-trigger]'))
    expect(add.mock.calls.filter((c) => c[0] === 'pointerdown')).toHaveLength(1)
    await press(document.body)
    expect(off.mock.calls.filter((c) => c[0] === 'pointerdown')).toHaveLength(1)
    add.mockRestore(); off.mockRestore()
  })
})

describe('Needs follow-up, from reminders', () => {
  it('lists only the contact whose reminder is due; a later reminder and no reminder are left out', async () => {
    await mount()
    await openFilters()
    expect(option('follow-up').querySelector('.nw-option-count')!.textContent).toBe('1')
    await click(option('follow-up'))
    expect(names()).toEqual(['Aaron Able'])
    expect($('[data-follow-up="due"]')!.textContent).toBe('Follow-up due Tue, Nov 10')
  })
  it('a reminder for a later day shows on the row but is not due', async () => {
    await mount()
    await type($('[data-search]'), 'vera')
    expect($('[data-follow-up="set"]')!.textContent).toBe('Follow-up Tue, Dec 1')
  })
  it('a contact never contacted is not painted as overdue', async () => {
    await mount()
    await type($('[data-search]'), 'una')
    expect(rows()[0]!.textContent).toContain("Haven't talked yet")
    expect(rows()[0]!.querySelector('.nw-warn')).toBeNull()
  })
})

describe('a row', () => {
  it('shows name, type, level, stage and real referral numbers', async () => {
    await mount()
    await type($('[data-search]'), 'aaron')
    const r = rows()[0]!
    expect(r.querySelector('[data-type]')!.textContent).toBe('Referral partner')
    expect(r.querySelector('[data-level]')!.textContent).toBe('Referral Partner')
    expect(r.querySelector('[data-stage]')!.textContent).toBe(NAMED_PARTNER.partnerStage)
    expect(r.textContent).toContain('Level: Referral Partner')
    expect(r.textContent).toContain(`Stage: ${NAMED_PARTNER.partnerStage}`)
    expect(r.querySelector('[data-referrals]')!.textContent).toBe('3 leads · $4,200')
  })
  it('a vendor has no level and no stage on its row', async () => {
    await mount()
    await type($('[data-search]'), 'vera')
    expect(rows()[0]!.querySelector('[data-level]')).toBeNull()
    expect(rows()[0]!.querySelector('[data-stage]')).toBeNull()
  })
  it('says when a contact is also a client', async () => {
    await mount()
    await type($('[data-search]'), 'una')
    expect(rows()[0]!.querySelector('[data-also-client]')).toBeTruthy()
  })
  it('in one location a row opens that contact, by id', async () => {
    const onOpenContact = vi.fn()
    await mount({ onOpenContact })
    await type($('[data-search]'), 'aaron')
    expect(rows()[0]!.tagName).toBe('BUTTON')
    await click(rows()[0])
    expect(onOpenContact).toHaveBeenCalledWith(NAMED_PARTNER.id)
  })
  it('on every location a row is not a button, the location is named, and the screen says why', async () => {
    await mount({ locationId: null, onOpenContact: null })
    expect(rows()[0]!.tagName).toBe('DIV')
    expect(rows()[0]!.textContent).toContain('Greensboro')
    expect($('[data-open-hint]')!.textContent).toBe('Pick one location to open a contact.')
  })
  it('gives the same tag the same colour every time', () => {
    expect(tagTone('Realtor')).toBe(tagTone('Realtor'))
    expect(new Set(['Realtor', 'Vendor', 'Mover', 'Designer', 'Senior Living', 'Handyman', 'Cleaner'].map(tagTone)).size).toBeGreaterThan(2)
  })
})

// Slice 6 changed this on purpose: the list now has ONE write, the bulk
// action, and only after its confirmation. Everything else still only reads.
describe('it reads, and writes only a confirmed bulk action', () => {
  it('asks three addresses, all GET, with the location on each (the third is the tag list, for bulk tags)', async () => {
    await mount()
    expect(calls).toEqual([
      { url: `/api/network/list?location_id=${LOC}`, method: 'GET' },
      { url: `/api/network/summary?location_id=${LOC}`, method: 'GET' },
      { url: `/api/lookups?category=tags&location_id=${LOC}`, method: 'GET' },
    ])
  })
  it('on every location it asks for everything', async () => {
    await mount({ locationId: null, onOpenContact: null })
    expect(calls.map((c) => c.url)).toEqual(['/api/network/list', '/api/network/summary'])
  })
  it('using every control makes no further request and never anything but GET', async () => {
    await mount()
    await click(pill('vendor')); await type($('[data-search]'), 'vera'); await openFilters()
    await click(option('follow-up')); await click($('[data-clear-filters]')); await click($('[aria-label="Not sure yet next page"]'))
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })
  it('nothing on the list can change a type; the only extra inputs are the pick boxes; level and stage appear only once someone is picked', async () => {
    await mount()
    await openFilters()
    const kinds = $$('input').map((i) => (i as HTMLInputElement).type)
    expect(kinds[0]).toBe('search')
    expect(kinds.slice(1).every((k) => k === 'checkbox')).toBe(true)
    expect($$('input[type="checkbox"]').every((i) => i.hasAttribute('data-select') || i.hasAttribute('data-select-page'))).toBe(true)
    expect($$('select').map((s) => s.getAttribute('aria-label'))).toEqual(['Not sure yet per page'])
    expect($$('[role="menuitemcheckbox"]').every((o) => o.closest('.nw-menu'))).toBe(true)
  })
  it('its source writes in one place only: the confirmed bulk action', () => {
    const src = readFileSync(join(process.cwd(), 'components/network/NetworkListScreen.jsx'), 'utf8')
    expect(src.match(/method:/g)).toHaveLength(1)
    expect(src).not.toMatch(/PATCH|DELETE/)
    const at = src.indexOf("method: 'POST'")
    expect(src.slice(src.lastIndexOf('async function', at), at)).toMatch(/^async function confirmBulk\(\)[\s\S]*doFetch\('\/api\/network\/contacts\/bulk'/)
    expect(src.slice(at, at + 300)).toMatch(/confirmed: true/)
    expect(Array.from(src.matchAll(/doFetch\(`([^`$]+)/g)).map((m) => m[1])).toEqual(['/api/network/list', '/api/network/summary', '/api/lookups?category=tags&location_id='])
  })
})

describe('when it cannot load', () => {
  it('a refusal is shown as a problem, never as an empty network', async () => {
    await mount({ fetchImpl: fakeFetch(listJson(), 403) })
    expect($('[data-problem]')!.textContent).toContain('forbidden')
    expect($('[data-type-pill]')).toBeNull()
    expect($('[data-empty]')).toBeNull()
  })
  it('an empty network says so', async () => {
    await mount({ fetchImpl: fakeFetch(listJson([])) })
    expect(pillCount('all')).toBe(0)
    expect($('[data-empty]')!.textContent).toBe('Nobody in this network yet.')
  })
  it('a list cut short says its counts are not the whole network', async () => {
    await mount({ fetchImpl: fakeFetch(listJson(PROD_ROWS, { truncated: true, total: 5000 })) })
    expect($('[data-truncated]')!.textContent).toContain('cut short at 5,000')
  })
})

describe('the look is the design', () => {
  const src = readFileSync(join(process.cwd(), 'components/network/NetworkListScreen.jsx'), 'utf8')
  it('asks for Lato and Arvo itself, not app-wide', async () => {
    await mount()
    expect($('link[rel="stylesheet"]')!.getAttribute('href')).toContain('family=Arvo')
    expect(readFileSync(join(process.cwd(), 'app/layout.tsx'), 'utf8')).not.toMatch(/Lato|Arvo/)
  })
  it('declares no colour of its own: every hex comes from the design tokens', () => {
    const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('const Svg ='))
    expect(css.match(/#[0-9A-Fa-f]{3,8}\b/g)).toBeNull()
  })
  it('on a phone the type pills wrap (no sideways scroll), so every pill and Filters stay on screen', () => {
    // Layout cannot be seen here (this test browser lays nothing out); it was
    // measured in Chromium at 390px and 360px. Until 2026-11-20 the pills
    // scrolled sideways here; Kevin ruled they wrap at every width
    // (lib/network/pills-wrap.test.ts holds the rule for all widths).
    const phone = src.slice(src.indexOf('@media (max-width:767px){'), src.indexOf('@media (prefers-reduced-motion'))
    expect(phone).not.toMatch(/\.nw-pills\{/)
    expect(src).not.toMatch(/\.nw-pills\{[^}]*overflow-x/)
    expect(src).not.toMatch(/\.nw-refine\{[^}]*overflow-x/)
    expect(src).not.toMatch(/\.nw-menu-row[^{]*\{[^}]*overflow/)
  })
  it('the Tags menu opens leftwards from the right edge, so it cannot run off a desktop screen', () => {
    expect(src).toContain('[data-network-ui] .nw-menu-row .nw-menu,[data-network-ui] .nw-tags-anchor .nw-menu{left:auto;right:0}')
  })
  it('scopes every rule to this screen', () => {
    const css = src.slice(src.indexOf('const CSS = `') + 13, src.indexOf('`\n\nconst Svg ='))
    const selectors = css.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('@') && l !== '}' && l.includes('{'))
    for (const s of selectors) expect(s.startsWith('[data-network-ui]') || s.startsWith('@keyframes'), s.slice(0, 60)).toBe(true)
  })
})
