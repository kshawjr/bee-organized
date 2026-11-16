// @vitest-environment happy-dom
//
// EACH SCREEN SHOWS ONLY ITS OWN TAG GROUPS (Kevin, 2026-11-15), in the one
// shared tag picker (components/hive/shared/PickerModal.jsx) that Clients and
// Network both open through the one shared tag row (TagsRow.jsx).
//
//   A) Clients: Client Status (and Referral). No trade is offered.
//   B) Network: Relationship and the trade groups. No client status.
//   C) a tag the record already carries from the other list stays in view
//   D) a tag made from the picker says which screen it was made on, so the
//      server can put it in that screen's group; and the limit is said plainly
//   E) the tag row tells the picker which screen it is on
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import PickerModal from '@/components/hive/shared/PickerModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const t = (id: string, label: string, attrs: any, over: any = {}) => ({ id, label, icon: null, category: 'tags', is_active: true, location_id: null, sort_order: 0, attrs, ...over })
const LOOKUPS = [
  t('hot', 'Hot Lead', { section: 'relationship', group: 'client_status', shows_on: ['clients'] }, { sort_order: 1010 }),
  t('dnb', 'DO NOT BOOK', { section: 'relationship', group: 'client_status', shows_on: ['clients'] }, { sort_order: 1080 }),
  t('ref', 'Referral', { section: 'relationship', group: 'relationship', shows_on: ['clients', 'network'] }, { sort_order: 1030 }),
  t('ven', 'Vendor', { section: 'relationship', group: 'relationship', shows_on: ['network'] }, { sort_order: 3020 }),
  t('rea', 'Realtor', { section: 'trade', group: 'home_property', shows_on: ['network'] }),
  t('mov', 'Mover', { section: 'trade', group: 'moving_hauling', shows_on: ['network'] }),
  t('own', 'Chamber', { section: 'trade', group: 'professional_services', shows_on: ['network'] }, { location_id: LOC }),
  t('snow', 'Snowbird', { section: 'relationship', group: 'client_status', shows_on: ['clients'] }, { location_id: LOC, sort_order: 4000 }),
]

let host: HTMLElement
let root: Root
let fetchCalls: { url: string; init: any }[] = []
const installFetch = (create?: (body: any) => { status: number; body: any }) => {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    if (init?.method === 'POST') { const a = create!(JSON.parse(init.body)); return { ok: a.status < 300, status: a.status, json: async () => a.body } }
    return { ok: true, status: 200, json: async () => ({ lookups: LOOKUPS, location: { id: LOC, name: 'Denver' } }) }
  }))
}
const mount = async (props: any = {}) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(<PickerModal category="tags" locationId={LOC} sections showIcons allowCreate mode="multi" selected={[]} onSave={() => {}} onClose={() => {}} {...props} />) })
  await act(async () => {})
}
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const sections = () => Array.from(host.querySelectorAll('[data-section]')).map((s) => s.getAttribute('data-section'))
const offered = () => Array.from(host.querySelectorAll('[data-section] [aria-checked]')).map((b) => b.textContent!.trim())
const inSection = (key: string) => Array.from(host.querySelectorAll(`[data-section="${key}"] [aria-checked]`)).map((b) => b.textContent!.trim())
const type = async (v: string) => act(async () => {
  const el = host.querySelector('[aria-label="Search options"]') as HTMLInputElement
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
})
const click = async (el: Element | null) => act(async () => { (el as HTMLElement).click() })

describe('A) on Clients', () => {
  it('shows Client Status, then Relationship holding only Referral', async () => {
    installFetch(); await mount({ screen: 'clients' })
    expect(sections()).toEqual(['client_status', 'relationship'])
    expect(inSection('client_status')).toEqual(['Hot Lead', 'DO NOT BOOK', 'Snowbird'])
    expect(inSection('relationship')).toEqual(['Referral'])
  })
  it('offers no trade and no Network-only relationship tag', async () => {
    installFetch(); await mount({ screen: 'clients' })
    for (const never of ['Realtor', 'Mover', 'Vendor', 'Chamber']) expect(offered()).not.toContain(never)
  })
  it("the location's own client tag sits in Client Status, not in a section of its own", async () => {
    installFetch(); await mount({ screen: 'clients' })
    expect(sections()).not.toContain('own')
    expect(inSection('client_status')).toContain('Snowbird')
  })
})

describe('B) on Network', () => {
  it('shows Relationship and the trade groups, in order', async () => {
    installFetch(); await mount({ screen: 'network' })
    expect(sections()).toEqual(['relationship', 'home_property', 'moving_hauling', 'professional_services'])
    expect(inSection('relationship')).toEqual(['Referral', 'Vendor'])
    expect(inSection('professional_services')).toEqual(['Chamber'])
  })
  it('offers no client status tag', async () => {
    installFetch(); await mount({ screen: 'network' })
    for (const never of ['Hot Lead', 'DO NOT BOOK', 'Snowbird']) expect(offered()).not.toContain(never)
  })
  it('the group headings are the group names', async () => {
    installFetch(); await mount({ screen: 'network' })
    expect(host.querySelector('[data-section="home_property"]')!.textContent).toContain('Home & Property')
    expect(host.querySelector('[data-section="professional_services"]')!.textContent).toContain('Professional Services')
  })
})

describe('C) a tag the record already carries from the other list', () => {
  it('a client who carries Realtor still sees it, ticked, under "Also on this record", and can untick it', async () => {
    installFetch(); await mount({ screen: 'clients', selected: ['rea'] })
    expect(sections()).toEqual(['client_status', 'relationship', 'elsewhere'])
    expect(host.querySelector('[data-section="elsewhere"]')!.textContent).toContain('Also on this record')
    const row = host.querySelector('[data-section="elsewhere"] [aria-checked]')!
    expect([row.textContent!.trim(), row.getAttribute('aria-checked')]).toEqual(['Realtor', 'true'])
    await click(row)
    // Unticked, it stays in view until the picker closes, so it can be put back.
    expect(host.querySelector('[data-section="elsewhere"] [aria-checked]')!.getAttribute('aria-checked')).toBe('false')
  })
  it('nobody who does not carry it is offered it', async () => {
    installFetch(); await mount({ screen: 'clients', selected: [] })
    expect(sections()).not.toContain('elsewhere')
  })
})

describe('D) a tag made from the picker', () => {
  const made = (body: any) => ({ status: 200, body: { ok: true, lookup: { id: 'new', label: body.label, category: 'tags', location_id: LOC, is_active: true, attrs: { group: body.group || 'client_status', shows_on: [body.made_on] } } } })
  const pickGroup = async (value: string) => act(async () => {
    const el = host.querySelector('[data-create-group]') as HTMLSelectElement
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  it('made on Clients: there is one group, so nothing is asked; the request says it was made on Clients', async () => {
    installFetch(made); await mount({ screen: 'clients' })
    await type('Piano tuner')
    await click(host.querySelector('[data-create]'))
    expect(host.querySelector('[data-create-group]')).toBeNull()
    await click(host.querySelector('[data-create-go]'))
    expect(JSON.parse(fetchCalls.find((c) => c.init?.method === 'POST')!.init.body)).toEqual({ category: 'tags', label: 'Piano tuner', location_id: LOC, made_on: 'clients' })
    expect(inSection('client_status')).toContain('Piano tuner')
  })
  it('made on Network: it asks which of the eight Network groups, with none picked for them', async () => {
    installFetch(made); await mount({ screen: 'network' })
    await type('Piano tuner'); await click(host.querySelector('[data-create]'))
    const select = host.querySelector('[data-create-group]') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Pick a group', 'Relationship', 'Home & Property', 'Design & Staging', 'Cleaning', 'Moving & Hauling', 'Senior Living', 'Valuables', 'Professional Services'])
    expect(select.value).toBe('')
  })
  it('made on Network: Create is off until a group is picked, and nothing is sent', async () => {
    installFetch(made); await mount({ screen: 'network' })
    await type('Piano tuner'); await click(host.querySelector('[data-create]'))
    expect((host.querySelector('[data-create-go]') as HTMLButtonElement).disabled).toBe(true)
    await click(host.querySelector('[data-create-go]'))
    expect(fetchCalls.filter((c) => c.init?.method === 'POST')).toEqual([])
  })
  it('made on Network: the group picked is sent, and the tag appears in that group, ticked', async () => {
    installFetch(made); await mount({ screen: 'network' })
    await type('Piano tuner'); await click(host.querySelector('[data-create]'))
    await pickGroup('moving_hauling')
    await click(host.querySelector('[data-create-go]'))
    expect(JSON.parse(fetchCalls.find((c) => c.init?.method === 'POST')!.init.body)).toEqual({ category: 'tags', label: 'Piano tuner', location_id: LOC, made_on: 'network', group: 'moving_hauling' })
    expect(inSection('moving_hauling')).toEqual(['Mover', 'Piano tuner'])
  })
  it('at the limit of ten it says so in plain words and creates nothing', async () => {
    installFetch(() => ({ status: 409, body: { error: 'tag_limit', limit: 10, count: 10 } }))
    await mount({ screen: 'clients' })
    await type('Piano tuner')
    await click(host.querySelector('[data-create]')); await click(host.querySelector('[data-create-go]'))
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This location already has 10 tags of its own, and the limit is 10. Delete one you no longer use, or ask corporate to add this one to the main list.')
    expect(offered()).not.toContain('Piano tuner')
  })
  it('with no screen named, the picker is the two-section one it always was', async () => {
    installFetch(); await mount({})
    expect(sections()).toEqual(['relationship', 'trade', 'own'])
  })
})

describe('E) the one tag row tells the picker which screen it is on', () => {
  const row = readFileSync(join(process.cwd(), 'components/hive/shared/TagsRow.jsx'), 'utf8')
  it('a client record asks as Clients; a Network record asks as Network', () => {
    expect(row).toContain("screen={kind === 'partner' ? 'network' : 'clients'}")
  })
  it('there is still one tag picker and one tag list: nothing forks them', () => {
    expect(row.match(/<PickerModal/g)).toHaveLength(1)
    expect(row).toContain('category="tags"')
  })
})
