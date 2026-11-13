// @vitest-environment happy-dom
//
// Settings slice 3 of 4 (2026-11-13): Location is rebuilt, and Tags goes dark.
//
// LOCATION — the export's page. Three things differ from the old screen and
// each is pinned here:
//   · the address is ONE field with a typeahead (Bee Hub's own
//     AddressAutofill, mounted not rewritten) where there were four rows; it
//     still writes four columns, all in one request
//   · Location ID is kept, as a quiet line under the rows
//   · booking links, Google Reviews, hourly rate, website and social are not
//     on this page (they moved to Emails on 2026-10-30) — only a pointer is
// Territory stays view-only for an owner. Location stays owner-only.
//
// TAGS — closed, not rebuilt. The nav item is greyed with a "Soon" chip and
// is not a button; arriving on it by any road shows a short "being rebuilt"
// line; the one server route only that screen used refuses. TAGGING A RECORD
// IS UNTOUCHED: the Tags row on a client and on a Network contact still sends
// what it sent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHubModule from '@/components/BeeHub'
import TagsRow from '@/components/hive/shared/TagsRow'
import { formatLocationAddress } from '@/components/settings/LocationRows'
import { territoryEditableServer, territoryViewableServer } from '@/lib/territory-access'
import { GET as tagsOwnGET } from '@/app/api/tags/own/route'

const { SettingsScreen, CurrentUserContext } = BeeHubModule as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HUB = read('components/BeeHub.jsx')
const ROWS = read('components/settings/LocationRows.jsx')
const ROWS_CODE = ROWS.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

const LOC = '2b3c4d5e-1111-4222-8333-444455556666'
const user = { id: 'u-owner', email: 'riley@bee.test', name: 'Riley Park', role: 'franchise', locationId: LOC, first_name: 'Riley', last_name: 'Park', phone: '', booking_link: null }
const selectedLoc = (over: Record<string, any> = {}) => ({
  id: LOC, name: 'Seattle', street: '101 Pine St', city: 'Seattle', state: 'WA', zip: '98101', phone: '(206) 555-0100',
  timezone: 'Pacific Time (PT)', assessmentType: 'in-person', crmStatus: 'active', ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: Array<{ url: string; method: string; body: any }>
let alerts: string[]
let patchFails = false
let zips: any = null
let details: any = null

const res = (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body })
beforeEach(() => {
  calls = []; alerts = []; patchFails = false; details = null
  zips = { location: { id: LOC, name: 'Seattle' }, zips: [{ zip: '98101', location_uuid: LOC }, { zip: '98102', location_uuid: LOC }], count: 2, conflicts: [], not_live_routes_to_other: false, can_edit: false }
  vi.stubGlobal('fetch', vi.fn(async (u: any, init: any = {}) => {
    const url = String(u); const method = init.method || 'GET'
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined })
    if (url.endsWith('/zips')) return res(zips)
    if (url === '/api/places/autocomplete') return res({ predictions: [{ place_id: 'p1', description: '42 Rainier Ave, Bellevue, WA, USA', main_text: '42 Rainier Ave', secondary_text: 'Bellevue, WA, USA' }] })
    if (url === '/api/places/details') return details === 'fail' ? res({}, false, 500) : res(details || { formatted: '42 Rainier Ave, Bellevue, WA 98004', street: '42 Rainier Ave', city: 'Bellevue', state: 'WA', zip: '98004' })
    if (url.startsWith('/api/locations/') && method === 'PATCH') return patchFails ? res({ error: 'boom' }, false, 500) : res({})
    return res({})
  }))
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  window.history.replaceState(null, '', '/')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const settle = async (ms = 15) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }
const render = async (node: React.ReactNode) => {
  await act(async () => root.unmount()); container.remove()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => { root.render(node) })
  await settle()
}
const mount = (props: Record<string, any> = {}, loc: any = selectedLoc()) => render(
  <CurrentUserContext.Provider value={user}>
    <SettingsScreen initialSection="location" franchiseRole="owner" selectedLoc={loc} {...props} />
  </CurrentUserContext.Provider>,
)
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const all = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const type = async (input: Element | null, value: string) => {
  if (!input) throw new Error('no input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const row = (label: string) => q(`[data-settings-row="${label}"]`)
const shown = (label: string) => (row(label)!.querySelector('[data-row-value]')?.textContent ?? '').trim()
const patches = () => calls.filter(c => c.method === 'PATCH' && c.url.startsWith('/api/locations/'))
const rail = () => q('[data-settings-nav="rail"]')!
const drill = () => q('[data-settings-nav="drill"]')!
const pane = () => drill().nextElementSibling as HTMLElement
const NO_ACCESS = "You don't have access to this section"
const field = (form: string, label: string) => all(`${form} label`).find(l => l.querySelector('span')!.textContent === label)!.querySelector('input')

// ═══════════════════════════════════════════════════════════════════════════
// 1 · LOCATION: WHO, AND WHAT IS ON IT
// ═══════════════════════════════════════════════════════════════════════════
describe('Location is owner-only, as it was', () => {
  it('an owner gets the page', async () => {
    await mount()
    expect(q('[data-settings-page] h1')!.textContent).toBe('Location')
    expect(rail().querySelector('[aria-current="page"]')!.getAttribute('data-section')).toBe('location')
  })

  for (const fr of ['manager', 'viewer', 'light', 'readonly', 'some-future-role']) {
    it(`${fr} gets the no-access notice, none of the page, no Location item, and asks for no territory`, async () => {
      await mount({ franchiseRole: fr })
      expect(pane().textContent).toContain(NO_ACCESS)
      expect(q('[data-settings-row]')).toBeNull()
      expect(q('[data-location-id]')).toBeNull()
      expect(q('[data-testid="location-territory"]')).toBeNull()
      expect(rail().querySelector('[data-section="location"]')).toBeNull()
      expect(drill().querySelector('[data-section="location"]')).toBeNull()
      // (Settings itself reads drip-paths and drip-followups on opening for every
      // role, as it did before this slice; the server answers those. Nothing of
      // the Location page is asked for, and nothing is written.)
      expect(calls.filter(c => c.url.includes('/zips') || c.method !== 'GET')).toEqual([])
    })
  }

  it('the gate is the predicate that was there', () => {
    expect(HUB).toContain("const ownerConfig = franchiseRole === 'owner'")
    expect(HUB).toContain("...(ownerConfig   ? [{ key:'location', label:'Location',       icon:'📍' }] : []),")
    expect(ROWS_CODE).not.toMatch(/franchiseRole|ownerConfig|canSee|canManage|isSuperAdmin/)
  })
})

describe('what the Location page holds', () => {
  it('four rows — name, ONE address, phone, timezone — and no City, State or ZIP row', async () => {
    await mount()
    expect(all('[data-settings-row]').map(r => r.getAttribute('data-settings-row'))).toEqual(['Location name', 'Address', 'Phone', 'Timezone'])
    expect(shown('Location name')).toBe('Seattle')
    expect(shown('Address')).toBe('101 Pine St, Seattle, WA 98101')
    expect(shown('Phone')).toBe('(206) 555-0100')
    expect(shown('Timezone')).toBe('Pacific Time (PT) — Los Angeles, Seattle')
    expect(q('[data-ssection] h2')!.textContent).toBe('Seattle')
    expect(q('[data-location-status]')!.textContent).toBe('Active')
  })

  it('the one line is for the eye only: it is built from the four parts and skips a missing one', () => {
    expect(formatLocationAddress({ address: '101 Pine St', city: 'Seattle', state: 'WA', zip: '98101' })).toBe('101 Pine St, Seattle, WA 98101')
    expect(formatLocationAddress({ address: '101 Pine St', city: '', state: 'WA', zip: '' })).toBe('101 Pine St, WA')
    expect(formatLocationAddress({ address: '', city: 'Seattle', state: '', zip: '98101' })).toBe('Seattle, 98101')
    expect(formatLocationAddress({})).toBe('')
    expect(formatLocationAddress()).toBe('')
  })

  it('Location ID is kept: a quiet line under the rows, showing the id, with nothing to edit', async () => {
    await mount()
    const line = q('[data-location-id]')!
    expect(q('[data-location-id-value]')!.textContent).toBe(LOC)
    expect(line.textContent).toContain('Location ID')
    expect(line.querySelector('button, input')).toBeNull()
    // Inside the details card, after the last row.
    const card = line.closest('[data-ssection]')!
    expect(card.querySelector('h2')!.textContent).toBe('Seattle')
    expect(row('Timezone')!.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('booking links, Google Reviews, the hourly rate, website and social are NOT here — only the pointer to Emails', async () => {
    await mount()
    const labels = all('[data-settings-page] p, [data-settings-page] label, [data-settings-page] h2').map(e => (e.textContent || '').trim().toLowerCase())
    for (const gone of ['booking link', 'booking links', 'google reviews', 'google reviews link', 'hourly rate', 'rate per hour', 'website', 'facebook', 'instagram', 'linkedin']) {
      expect(labels, `"${gone}" as a row or heading`).not.toContain(gone)
    }
    expect(all('[data-settings-page] input')).toEqual([])
    const link = q('[data-semails-link]')!
    expect(link.textContent).toContain('Booking links, Google Reviews link, hourly rate, website and social links now live on Emails')
    await click(link.querySelector('button'))
    expect(rail().querySelector('[aria-current="page"]')!.getAttribute('data-section')).toBe('emails')
  })

  it('a location that is not active says so on the pill', async () => {
    await mount({}, selectedLoc({ crmStatus: 'onboarding' }))
    expect(q('[data-location-status="onboarding"]')!.textContent).toBe('Onboarding')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE ADDRESS: ONE FIELD, FOUR COLUMNS, ONE REQUEST
// ═══════════════════════════════════════════════════════════════════════════
describe('the address still saves street, city, state and ZIP separately', () => {
  const openSearch = async () => { await click(q('button[aria-label="Edit Address"]')) }
  const openHand = async () => { await openSearch(); await click(q('[data-address-by-hand]')) }
  const fillHand = async (a: string, c: string, s: string, z: string) => {
    await type(field('[data-address-hand]', 'Street address'), a); await type(field('[data-address-hand]', 'City'), c)
    await type(field('[data-address-hand]', 'State'), s); await type(field('[data-address-hand]', 'ZIP'), z)
  }
  const pickFirst = async (typed = '42 Rain') => {
    await openSearch()
    await type(q('[data-address-search] input'), typed)
    await settle(260)   // the typeahead waits 175ms before it asks
    const suggestion = all('[data-address-search] button').find(b => (b.textContent || '').includes('42 Rainier Ave'))
    expect(suggestion, 'a suggestion is offered').toBeTruthy()
    await act(async () => { suggestion!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await settle(30)
  }

  it('the pencil opens the typeahead with the cursor in it', async () => {
    await mount()
    await openSearch()
    const input = q('[data-address-search] input')!
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('placeholder')).toBe('Start typing the street address…')
  })

  it('picking a suggestion sends ONE request holding all four columns, each on its own, then shows the new address', async () => {
    await mount()
    await pickFirst()
    expect(calls.filter(c => c.url === '/api/places/autocomplete').length).toBeGreaterThan(0)
    expect(calls.filter(c => c.url === '/api/places/details').map(c => c.body.place_id)).toEqual(['p1'])
    expect(patches()).toEqual([{ url: `/api/locations/${LOC}`, method: 'PATCH', body: { address: '42 Rainier Ave', city: 'Bellevue', state: 'WA', zip: '98004' } }])
    expect(shown('Address')).toBe('42 Rainier Ave, Bellevue, WA 98004')
    expect(row('Address')!.textContent).toContain('Saved')
    expect(q('[data-address-search]')).toBeNull()
  })

  it('a unit rides on the street line; city, state and ZIP are still their own values', async () => {
    details = { formatted: 'x', street: '42 Rainier Ave', apt: 'Suite 200', city: 'Bellevue', state: 'WA', zip: '98004' }
    await mount()
    await pickFirst()
    expect(patches().map(c => c.body)).toEqual([{ address: '42 Rainier Ave Suite 200', city: 'Bellevue', state: 'WA', zip: '98004' }])
  })

  it('a pick with no ZIP CLEARS the old ZIP — the new street is never left over the old one’s ZIP', async () => {
    details = { formatted: 'x', street: '42 Rainier Ave', city: 'Bellevue', state: 'WA', zip: '' }
    await mount()
    await pickFirst()
    expect(patches().map(c => c.body)).toEqual([{ address: '42 Rainier Ave', city: 'Bellevue', state: 'WA', zip: '' }])
    expect(shown('Address')).toBe('42 Rainier Ave, Bellevue, WA')
  })

  it('if the lookup for the picked place fails, the parts are read from the suggestion itself, still as four', async () => {
    details = 'fail'
    await mount()
    await pickFirst()
    const body = patches()[0].body
    expect(Object.keys(body).sort()).toEqual(['address', 'city', 'state', 'zip'])
    expect(body.address).toBe('42 Rainier Ave')
  })

  it('by hand: four labelled boxes, starting from what is stored; Save sends the same one request', async () => {
    await mount()
    await openHand()
    expect(all('[data-address-hand] label span').map(s => s.textContent)).toEqual(['Street address', 'City', 'State', 'ZIP'])
    expect(all('[data-address-hand] input').map(i => (i as HTMLInputElement).value)).toEqual(['101 Pine St', 'Seattle', 'WA', '98101'])
    await fillHand(' 9 Nowhere Lane ', 'Twisp', 'WA', '98856')
    await click(q('[data-address-hand] button[type="submit"]'))
    expect(patches().map(c => c.body)).toEqual([{ address: '9 Nowhere Lane', city: 'Twisp', state: 'WA', zip: '98856' }])
    expect(shown('Address')).toBe('9 Nowhere Lane, Twisp, WA 98856')
  })

  it('Enter in the typeahead opens the by-hand boxes, pre-filled from what was typed', async () => {
    await mount()
    await openSearch()
    const input = q('[data-address-search] input')!
    await type(input, '9 Nowhere Lane, Twisp WA 98856')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(all('[data-address-hand] input').map(i => (i as HTMLInputElement).value)).toEqual(['9 Nowhere Lane', 'Twisp', 'WA', '98856'])
    expect(patches()).toEqual([])   // nothing is saved until Save
  })

  it('saving the address it already has sends nothing', async () => {
    await mount()
    await openHand()
    await click(q('[data-address-hand] button[type="submit"]'))
    expect(patches()).toEqual([])
    expect(row('Address')!.textContent).not.toContain('Saved')
  })

  it('Cancel and Escape send nothing and leave the address as it was', async () => {
    await mount()
    await openSearch()
    await type(q('[data-address-search] input'), '42 Rain')
    await click(q('[data-address-cancel]'))
    await settle(260)
    await openSearch()
    await act(async () => { q('[data-address-search] input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(q('[data-address-search]')).toBeNull()
    expect(patches()).toEqual([])
    expect(shown('Address')).toBe('101 Pine St, Seattle, WA 98101')
  })

  it('the server refusing it: said out loud, the OLD address stays on screen, and it does not say Saved', async () => {
    patchFails = true
    await mount()
    await pickFirst()
    expect(patches().length).toBe(1)
    expect(alerts).toEqual(['Could not save your address: boom'])
    expect(shown('Address')).toBe('101 Pine St, Seattle, WA 98101')
    expect(row('Address')!.textContent).not.toContain('Saved')
  })

  it('looking at a location you are not signed in to: said, nothing sent, nothing painted', async () => {
    await mount({}, selectedLoc({ id: 'loc_demo_slug' }))
    await openHand()
    await fillHand('9 Nowhere Lane', 'Twisp', 'WA', '98856')
    await click(q('[data-address-hand] button[type="submit"]'))
    expect(patches()).toEqual([])
    expect(alerts.length).toBe(1)
    expect(alerts[0]).toContain('not signed in to it')
    expect(shown('Address')).toBe('101 Pine St, Seattle, WA 98101')
  })

  it('the typeahead is Bee Hub’s own, mounted — not a second one, and this file never calls Places itself', () => {
    expect(ROWS).toContain("import AddressAutofill, { parseAddress } from '@/components/hive/shared/AddressAutofill'")
    expect(ROWS_CODE).toContain('<AddressAutofill ')
    expect(ROWS_CODE).not.toMatch(/fetch\(/)
    expect(ROWS_CODE).not.toContain('/api/places')
    // One save for the four columns, to the route every Location row uses.
    const save = HUB.slice(HUB.indexOf('async function persistLocationAddress('), HUB.indexOf('async function persistLocationAddress(') + 1400)
    expect(save).toContain("const body = { address: parts.address || '', city: parts.city || '', state: parts.state || '', zip: parts.zip || '' }")
    expect(save.split('fetch(').length - 1).toBe(1)
    expect(save).toContain('fetch(`/api/locations/${realLocId}`')
    // …and the route still takes each of the four as its own column.
    const route = read('app/api/locations/[id]/route.ts')
    for (const col of ['address', 'city', 'state', 'zip']) expect(route).toContain(`  '${col}',`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · TERRITORY: AN OWNER LOOKS, CORPORATE CHANGES
// ═══════════════════════════════════════════════════════════════════════════
describe('an owner cannot change their territory from this screen', () => {
  it('the zips are shown, with the line saying changes go through corporate — and nothing to add, edit or remove', async () => {
    await mount()
    const t = q('[data-testid="location-territory"]')!
    expect(q('[data-testid="territory-count"]')!.textContent).toBe('2 zips')
    expect(t.textContent).toContain('98101'); expect(t.textContent).toContain('98102')
    expect(t.textContent).toContain('Territory changes go through corporate.')
    expect(t.querySelectorAll('input, button, select, textarea').length).toBe(0)
    expect(calls.filter(c => c.url.includes('location-zips'))).toEqual([])
    expect(calls.filter(c => c.url.endsWith('/zips')).map(c => c.method)).toEqual(['GET'])
  })

  it('a location with no zips says so', async () => {
    zips = { ...zips, zips: [], count: 0 }
    await mount()
    const t = q('[data-testid="location-territory"]')!
    expect(q('[data-testid="territory-count"]')!.textContent).toBe('0 zips')
    expect(t.textContent).toContain('No website leads route to Seattle by zip yet.')
    expect(t.querySelectorAll('input, button').length).toBe(0)
  })

  it('the controls exist only when the SERVER says this caller may edit (corporate) — the screen does not decide', async () => {
    zips = { ...zips, can_edit: true, locations: [{ id: LOC, name: 'Seattle' }] }
    await mount()
    expect(q('[data-testid="location-territory"]')!.querySelectorAll('input, button').length).toBeGreaterThan(0)
    expect(q('[data-testid="location-territory"]')!.textContent).not.toContain('Territory changes go through corporate.')
  })

  it('and the server’s rule: an owner or manager may view their own territory, and only corporate may change one', () => {
    for (const role of ['owner', 'manager', 'lite_user']) expect(territoryEditableServer(role), role).toBe(false)
    expect(territoryEditableServer('admin')).toBe(true)
    expect(territoryEditableServer('super_admin')).toBe(true)
    expect(territoryViewableServer('owner', LOC, LOC)).toBe(true)
    expect(territoryViewableServer('owner', 'another', LOC)).toBe(false)
    // This slice did not touch the panel: it is the one Admin uses.
    expect(HUB.split('<LocationZipsPanel ').length - 1).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · TAGS IS CLOSED
// ═══════════════════════════════════════════════════════════════════════════
const closed = () => q('[data-section-closed="tags"]')
const oldTagsScreen = () => q('[data-own-tag]') || all('h1, h2, p').find(e => /own tags/i.test(e.textContent || ''))

describe('the Tags item is greyed and is not a button', () => {
  for (const fr of ['owner', 'manager']) {
    it(`${fr}: still listed where it was, with a "Soon" chip, and nothing to click or tab to`, async () => {
      await mount({ franchiseRole: fr, initialSection: 'profile' })
      const item = rail().querySelector('[data-section="tags"]') as HTMLElement
      expect(item.tagName).toBe('DIV')
      expect(item.hasAttribute('data-soon')).toBe(true)
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(item.querySelector('[data-soon-chip]')!.textContent).toBe('Soon')
      expect(item.querySelector('button, a, [tabindex]')).toBeNull()
      expect(item.hasAttribute('tabindex')).toBe(false)
      // The name is at half strength.
      expect(Array.from(item.querySelectorAll('span')).find(s => s.textContent === 'Tags')!.style.opacity).toBe('0.5')
      // The phone list says the same thing in words.
      const phone = drill().querySelector('[data-section="tags"]') as HTMLElement
      expect(phone.tagName).toBe('DIV')
      expect(phone.querySelector('[data-soon-chip]')!.textContent).toBe('Coming soon')
      expect(phone.querySelector('button, a')).toBeNull()
      // No button anywhere in either nav leads to it.
      expect(all('[data-settings-nav] button[data-section="tags"]')).toEqual([])
    })

    it(`${fr}: clicking it does nothing at all`, async () => {
      await mount({ franchiseRole: fr, initialSection: 'profile' })
      for (const nav of [rail(), drill()]) {
        await click(nav.querySelector('[data-section="tags"]'))
        await click(nav.querySelector('[data-section="tags"] [data-soon-chip]'))
      }
      expect(closed()).toBeNull()
      expect(q('[data-settings-page] h1')!.textContent).toBe('Profile')
      expect(window.location.search).not.toContain('tags')
    })
  }

  it('a read-only sign-in never had the item and still does not', async () => {
    await mount({ franchiseRole: 'viewer', initialSection: 'profile' })
    expect(q('[data-settings-nav] [data-section="tags"]')).toBeNull()
  })
})

describe('Settings → Tags cannot be opened by any road', () => {
  const roads: Array<[string, (fr: string) => Promise<void>]> = [
    ['opened straight onto it (initialSection)', fr => mount({ franchiseRole: fr, initialSection: 'tags' })],
    ['a ?section=tags link', async fr => {
      window.history.replaceState(null, '', '/?section=tags')
      await mount({ franchiseRole: fr, initialSection: undefined })
      await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
      await settle()
    }],
    ['the back button onto a remembered Tags page', async fr => {
      await mount({ franchiseRole: fr, initialSection: 'profile' })
      await act(async () => {
        window.history.replaceState({ beeSettingsSection: 'tags' }, '', '/?section=tags')
        window.dispatchEvent(new PopStateEvent('popstate', { state: { beeSettingsSection: 'tags' } }))
      })
      await settle()
    }],
  ]
  for (const fr of ['owner', 'manager']) for (const [name, go] of roads) {
    it(`${fr}, ${name}: a short line saying tags are being rebuilt — not the old screen, not a blank one, and the server is not asked`, async () => {
      await go(fr)
      expect(closed(), 'the closed line').toBeTruthy()
      expect(closed()!.textContent).toContain('Tags are being rebuilt.')
      expect(closed()!.textContent).toContain('You can still add and remove tags on a client or a Network contact')
      expect(q('[data-settings-page] h1')!.textContent).toBe('Tags')
      expect((pane().textContent || '').trim().length).toBeGreaterThan(40)
      expect(pane().textContent).not.toContain(NO_ACCESS)
      expect(oldTagsScreen(), 'the old Tags screen').toBeFalsy()
      expect(calls.filter(c => c.url.includes('/api/tags') || c.url.includes('/api/lookups'))).toEqual([])
      // It is not the current page in the nav.
      expect(rail().querySelector('[aria-current="page"]')).toBeNull()
    })
  }

  it('from the closed line there is a way out: Go to Profile', async () => {
    await mount({ initialSection: 'tags' })
    await click(q('[data-closed-back]'))
    expect(q('[data-settings-page] h1')!.textContent).toBe('Profile')
  })

  it('someone who could never open it still gets the no-access notice, not the closed line', async () => {
    await mount({ franchiseRole: 'viewer', initialSection: 'tags' })
    expect(pane().textContent).toContain(NO_ACCESS)
    expect(closed()).toBeNull()
  })

  it('nothing in the app mounts the old screen, and a caller that asks for the section anyway is refused', () => {
    const files = ['components/BeeHub.jsx', 'components/settings/SettingsShell.jsx', 'components/settings/LocationRows.jsx', 'components/settings/TeamAndLeads.jsx']
    for (const f of files) {
      expect(read(f), f).not.toContain('<OwnTagsSettings')
      expect(read(f), f).not.toMatch(/import OwnTagsSettings/)
    }
    expect(HUB).toContain("const CLOSED_SETTINGS_SECTIONS = ['tags']")
    expect(HUB).toContain('if (CLOSED_SETTINGS_SECTIONS.includes(key)) return')
    expect(HUB).not.toContain('/api/tags/own')
  })
})

describe('the server refuses too, for the one route only that screen used', () => {
  it('GET /api/tags/own answers 410 with a plain reason, and lists nothing', async () => {
    const r = await (tagsOwnGET as any)(new Request(`http://t.local/api/tags/own?location_id=${LOC}`))
    expect(r.status).toBe(410)
    const j = await r.json()
    expect(j).toEqual({ error: 'tags_settings_closed', message: 'Settings › Tags is closed while tags are being rebuilt. You can still add and remove tags on a client or a Network contact.' })
  })

  it('it reads nothing and exports no other verb', () => {
    const src = read('app/api/tags/own/route.ts')
    const code = src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    expect(code).not.toMatch(/supabase|\.from\(|requireAuth|getHubUser/)
    expect(Array.from(code.matchAll(/export (?:async )?function (\w+)/g)).map(m => m[1])).toEqual(['GET'])
  })

  it('its only caller was the Settings screen, which nothing mounts', () => {
    const callers = ['components/BeeHub.jsx', 'components/hive/shared/TagsRow.jsx', 'components/hive/shared/PickerModal.jsx', 'components/hive/NetworkPersonRecord.jsx', 'components/hive/ClientProfile.jsx', 'components/hive/LocationTagsPanel.jsx', 'components/hive/RetiredTagsPanel.jsx']
      .filter(f => read(f).includes('/api/tags/own'))
    expect(callers).toEqual([])
    expect(read('components/hive/OwnTagsSettings.jsx')).toContain('/api/tags/own')
  })

  it('the routes tagging a record uses are NOT closed', () => {
    for (const f of ['app/api/lead-tags/route.ts', 'app/api/partner-tags/route.ts', 'app/api/tags/delete/route.ts', 'app/api/tags/locations/route.ts', 'app/api/tags/retired/route.ts']) {
      expect(read(f), f).not.toMatch(/tags_settings_closed|status: 410/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · TAGGING A RECORD STILL WORKS
// ═══════════════════════════════════════════════════════════════════════════
// The Tags row on a client and on a Network contact is one component. That
// nothing about it changed is proved against the last commit by fingerprint
// (the slice report); this is the same row, mounted, doing its job.
describe('a client and a Network contact can still be tagged and untagged', () => {
  const TAGS = [{ id: 't-realtor', label: 'Realtor', icon: null }, { id: 't-vip', label: 'VIP', icon: null }]
  for (const [kind, api, idParam] of [['client', '/api/lead-tags', 'lead_id'], ['partner', '/api/partner-tags', 'partner_id']] as const) {
    it(`${kind}: the row shows the tags and offers "+ Tag"`, async () => {
      await render(<TagsRow {...({ recordId: 'rec-1', kind, locationId: LOC, tags: TAGS } as any)} />)
      expect(q('button[aria-label="Remove tag Realtor"]')).toBeTruthy()
      expect(q('button[aria-label="Add tag"]')).toBeTruthy()
      expect(container.textContent).toContain('Realtor'); expect(container.textContent).toContain('VIP')
    })

    it(`${kind}: taking a tag off sends DELETE to ${api} for that record and that tag`, async () => {
      let after: any[] | null = null
      await render(<TagsRow {...({ recordId: 'rec-1', kind, locationId: LOC, tags: TAGS, onChange: (t: any[]) => { after = t } } as any)} />)
      calls = []
      await click(q('button[aria-label="Remove tag Realtor"]'))
      expect(calls.map(c => [c.url, c.method])).toEqual([[`${api}?${idParam}=rec-1&tag_lookup_id=t-realtor`, 'DELETE']])
      expect(after).toEqual([TAGS[1]])
    })

    it(`${kind}: "+ Tag" opens the picker`, async () => {
      await render(<TagsRow {...({ recordId: 'rec-1', kind, locationId: LOC, tags: TAGS } as any)} />)
      await click(q('button[aria-label="Add tag"]'))
      expect(document.body.querySelector('[role="dialog"], input')).toBeTruthy()
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · NO DEAD HEADING IN THE NAV
// ═══════════════════════════════════════════════════════════════════════════
describe('nobody is shown a heading over nothing they can open', () => {
  const groups = (nav: Element) => Array.from(nav.children).map(g => ({
    title: g.querySelector('p')?.textContent?.trim(),
    open: Array.from(g.querySelectorAll('[data-section]:not([data-soon])')).map(b => b.getAttribute('data-section')),
    closed: Array.from(g.querySelectorAll('[data-section][data-soon]')).map(b => b.getAttribute('data-section')),
  }))

  it('a manager: You → Profile; Your business → Team, with Tags greyed under it', async () => {
    await mount({ franchiseRole: 'manager', initialSection: 'profile' })
    const want = [{ title: 'You', open: ['profile'], closed: [] }, { title: 'Your business', open: ['team'], closed: ['tags'] }]
    expect(groups(rail())).toEqual(want)
    expect(groups(drill())).toEqual(want)
  })

  it('an owner: the same four groups, Tags greyed between Team and Emails', async () => {
    await mount({ initialSection: 'profile' })
    expect(groups(rail())).toEqual([
      { title: 'You', open: ['profile'], closed: [] },
      { title: 'Your business', open: ['location', 'team'], closed: ['tags'] },
      { title: 'Client messages', open: ['emails', 'texts'], closed: [] },
      { title: 'Connections', open: ['slack', 'jobber', 'mailchimp'], closed: [] },
    ])
  })

  for (const fr of ['owner', 'manager', 'viewer', 'light', 'readonly', 'some-future-role']) {
    it(`${fr}: every group in both navs has at least one item that opens`, async () => {
      await mount({ franchiseRole: fr, initialSection: 'profile' })
      for (const nav of [rail(), drill()]) for (const g of groups(nav)) expect(g.open.length, `${fr}: "${g.title}"`).toBeGreaterThan(0)
    })
  }

  it('the rule is in the list itself: a group with nothing that opens is dropped — and whoever has Tags always has Team', () => {
    expect(HUB).toContain('.filter(g => g.items.some(i => !i.soon))')
    expect(HUB).toContain('const canSeeBees = canManageOwnTags')
    expect(HUB).toContain('const canSeeTeamScreen = canSeeSeats || canSeeBees')
  })
})
