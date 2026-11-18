// @vitest-environment happy-dom
//
// The add box, the import box and the three buttons on the new Network list
// (slice 5), mounted for real against a stand-in for every address they
// talk to. What this pins:
//
//   · a new tag made in the add flow cannot be saved without a group: Create
//     stays off, and pressing it sends nothing
//   · the add box sends ONE request, to /api/network/contacts, naming the
//     location the list is looking at; then the new contact opens
//   · the add box, on a duplicate email: names who, sends nothing more until
//     the email changes or "add anyway" is ticked; Open goes to that contact;
//     a changed email clears the warning
//   · the import box: EVERY unreadable row is listed by line and reason and
//     Add still adds the rest;
//     a duplicate is named by the existing contact's name; unmatched tag
//     words are named; a spreadsheet file is refused with how to save a CSV
//   · on All Locations, Add, Import and Export are all off, and say why
//   · Export saves this location's contacts only, in the import's columns
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AddContactDialog from '@/components/network/AddContactDialog'
import ImportDialog from '@/components/network/ImportDialog'
import NetworkListScreenJsx from '@/components/network/NetworkListScreen'
const NetworkListScreen = NetworkListScreenJsx as any
import { TAG_GROUP_NEEDED_WORDS, newTagPlacement } from '@/lib/tags'
import { parseCsv } from '@/lib/network/csv'
import { exportFileName } from '@/lib/network/csv-download'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TAGS = [
  { id: 't-realtor', label: 'Realtor', category: 'tags', location_id: null, is_active: true, icon: '🏡', attrs: { group: 'home_property', shows_on: ['network'] } },
  { id: 't-vip', label: 'VIP', category: 'tags', location_id: null, is_active: true, icon: null, attrs: { group: 'client_status', shows_on: ['clients'] } },
]

let root: any = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
const mount = (el: React.ReactElement) => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(el)) }
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[]
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }
const click = async (el: HTMLElement | null) => { if (!el) throw new Error('missing'); await act(async () => { el.click() }); await flush() }
const type = async (el: HTMLElement | null, v: string) => {
  if (!el) throw new Error('missing')
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
  await act(async () => { set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const json = (body: any, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

describe('the add box', () => {
  const sent: { url: string; method: string; body: any }[] = []
  const fetchImpl = vi.fn((url: string, init?: any) => {
    sent.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    if (url.startsWith('/api/lookups?')) return json({ lookups: TAGS, location: { name: 'Seattle' } })
    if (url === '/api/network/contacts') return json({ id: 'new-id' }, 201)
    if (url === '/api/lookups') return json({ lookup: { id: 't-new', label: 'Stagers', location_id: LOC, is_active: true, attrs: { group: 'design_staging', shows_on: ['network'] } } }, 201)
    return json({}, 404)
  })

  it('a new tag cannot be made without a group: Create stays off and nothing is sent', async () => {
    sent.length = 0
    mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={() => {}} fetchImpl={fetchImpl as any} />)
    await flush()
    await click($('[data-open-tags]'))
    await type($('[data-field="tagSearch"]'), 'Stagers')
    await click($('[data-new-tag]'))
    const create = $('[data-create-tag]') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    await act(async () => { (create.closest('form') as HTMLFormElement).requestSubmit() })
    await flush()
    expect(sent.filter((s) => s.method === 'POST')).toEqual([])
    // and the rule underneath: no group, no placement
    expect(newTagPlacement('network', undefined)).toBeNull()
    expect(TAG_GROUP_NEEDED_WORDS).toBe('Pick which group this tag goes in.')
    // with a group picked it is made, for THIS location, on Network
    await click($('[data-group="design_staging"]'))
    expect(($('[data-create-tag]') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { ($('[data-create-tag]')!.closest('form') as HTMLFormElement).requestSubmit() })
    await flush()
    const made = sent.find((s) => s.url === '/api/lookups' && s.method === 'POST')!
    expect(made.body).toMatchObject({ category: 'tags', label: 'Stagers', location_id: LOC, made_on: 'network', group: 'design_staging' })
  })

  it('only Network tags are offered: a Clients-only tag is not in the box', async () => {
    mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={() => {}} fetchImpl={fetchImpl as any} />)
    await flush()
    await click($('[data-open-tags]'))
    expect($$('[data-pick-tag]').map((b) => b.getAttribute('data-pick-tag'))).toEqual(['t-realtor'])
  })

  it('Add contact sends one request naming the location the list is on, then opens the new contact', async () => {
    sent.length = 0
    const onAdded = vi.fn()
    mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={onAdded} fetchImpl={fetchImpl as any} />)
    await flush()
    expect($('[data-lands-in]')!.textContent).toBe('Goes into Seattle')
    expect(($('[data-add-form] [data-save]') as HTMLButtonElement).disabled).toBe(true)
    await click($('[data-type="partner"]'))
    await type($('[data-field="name"]'), 'Dana Whitfield')
    await type($('[data-field="email"]'), 'dana@x.co')
    await click($('[data-open-tags]'))
    await click($('[data-pick-tag="t-realtor"]'))
    await act(async () => { ($('[data-form="tags"]') as HTMLFormElement).requestSubmit() })
    await flush()
    await act(async () => { ($('[data-add-form]') as HTMLFormElement).requestSubmit() })
    await flush()
    const posts = sent.filter((s) => s.method === 'POST')
    expect(posts.map((p) => p.url)).toEqual(['/api/network/contacts'])
    expect(posts[0]!.body).toMatchObject({ location_id: LOC, name: 'Dana Whitfield', types: ['partner'], email: 'dana@x.co', tagIds: ['t-realtor'] })
    expect(onAdded).toHaveBeenCalledWith('new-id')
  })

  it('a duplicate email: names who, Add stays off until the email changes or Add anyway is ticked', async () => {
    const posts: any[] = []
    const dupFetch = vi.fn((url: string, init?: any) => {
      if (url.startsWith('/api/lookups?')) return json({ lookups: TAGS, location: { name: 'Seattle' } })
      if (url === '/api/network/contacts') {
        const b = JSON.parse(init.body); posts.push(b)
        if (b.email.trim().toLowerCase() === 'blaire@x.co' && b.addAnyway !== true) return json({ error: 'email_already_here', field: 'email', matched: { id: 'p-blaire', name: 'Blaire Brimer' } }, 409)
        return json({ id: 'new-id' }, 201)
      }
      return json({}, 404)
    })
    const onAdded = vi.fn(); const onOpenExisting = vi.fn()
    mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={onAdded} onOpenExisting={onOpenExisting as any} fetchImpl={dupFetch as any} />)
    await flush()
    await click($('[data-type="nurture"]'))
    await type($('[data-field="name"]'), 'Blaire B')
    await type($('[data-field="email"]'), 'Blaire@X.co')
    await type($('[data-field="interest"]'), 'Garage')
    const submit = async () => { await act(async () => { ($('[data-add-form]') as HTMLFormElement).requestSubmit() }); await flush() }
    await submit()
    expect($('[data-duplicate]')!.textContent).toContain('Blaire Brimer')
    expect($('[data-duplicate]')!.textContent).toContain('Nothing was added')
    expect(onAdded).not.toHaveBeenCalled()
    expect(($('[data-save]') as HTMLButtonElement).disabled).toBe(true)
    await submit()
    expect(posts).toHaveLength(1)
    // Open goes to the one found
    await click($('[data-open-existing]'))
    expect(onOpenExisting).toHaveBeenCalledWith('p-blaire')
    // a changed email clears the warning
    await click($('[data-add-anyway]'))
    await type($('[data-field="email"]'), 'blaire2@x.co')
    expect($('[data-duplicate]')).toBeNull()
    await type($('[data-field="email"]'), 'blaire@x.co')
    expect($('[data-duplicate]')).not.toBeNull()
    // ticked on purpose: Add goes, and says addAnyway
    if (!($('[data-add-anyway]') as HTMLInputElement).checked) await click($('[data-add-anyway]'))
    await submit()
    expect(posts).toHaveLength(2)
    expect(posts[0].addAnyway).toBeUndefined()
    expect(posts[1]).toMatchObject({ email: 'blaire@x.co', addAnyway: true, interest: 'Garage' })
    expect(onAdded).toHaveBeenCalledWith('new-id')
  })

  it('has none of the design’s cut steps: no card reader, level, stage, consent, Mailchimp, drip or workflow', async () => {
    mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={() => {}} fetchImpl={fetchImpl as any} />)
    await flush()
    const words = ($('[data-network-add] aside')!.textContent || '').toLowerCase()
    for (const w of ['scan a', 'business card', 'partner level', 'stage', 'consent', 'mailchimp', 'drip', 'workflow', 'campaign']) expect(words, words).not.toContain(w)
  })
})

describe('the import box', () => {
  const chooseFile = async (name: string, text: string) => {
    const input = $('[data-file-input]') as HTMLInputElement
    const file = new File([text], name, { type: 'text/csv' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(); await flush()
  }

  it('EVERY unreadable row is listed with its line and reason (none cut off), and Add still adds the rest', async () => {
    const unreadable = Array.from({ length: 60 }, (_, i) => ({ line: i + 3, name: `Bad ${i}`, problems: ['Email looks wrong'] }))
    const check = { ok: true, mode: 'check', location: { id: LOC, name: 'Seattle' }, added: 0,
      adding: [{ line: 2, name: 'A', company: null, email: 'a@x.co', phone: null, tags: 0 }], unreadable, skipped: [], unmatchedTags: [], warnings: [] }
    const fetchImpl = vi.fn((_u: string, init: any) => json(JSON.parse(init.body).mode === 'check' ? check : { ...check, mode: 'import', added: 1, ids: ['n1'] }))
    mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} fetchImpl={fetchImpl as any} />)
    await chooseFile('mine.csv', 'Name,Email\nA,a@x.co\nCat,cat@')
    const lines = $$('[data-unreadable-line]')
    expect(lines).toHaveLength(60)
    expect(lines[0]!.textContent).toBe('Row 3Bad 0: Email looks wrong')
    expect(lines[59]!.textContent).toContain('Row 62')
    expect($('[data-unreadable] h3')!.textContent).toBe('60 rows will be skipped: they couldn’t be read')
    expect($('[data-file]')!.textContent).toContain('60 can’t be read')
    expect(($('[data-add]') as HTMLButtonElement).disabled).toBe(false)
    await click($('[data-add]'))
    expect($('[data-done]')!.textContent).toContain('1 contact added')
    expect($('[data-unreadable] h3')!.textContent).toBe('60 rows were skipped: they couldn’t be read')
  })

  it('a duplicate is named by the existing contact’s name; unmatched words are named; Add sends the file once', async () => {
    const check = { ok: true, mode: 'check', location: { id: LOC, name: 'Seattle' }, added: 0,
      adding: [{ line: 2, name: 'Ann One', company: null, email: 'ann@x.co', phone: null, tags: 1 }],
      skipped: [{ line: 3, name: 'Tommy', email: 'tom@x.co', matched: { id: 'p1', name: 'Tom Minty', line: null } }],
      unmatchedTags: ['Downsizing', 'Garage'], warnings: [] }
    const fetchImpl = vi.fn((_u: string, init: any) => json(JSON.parse(init.body).mode === 'check' ? check : { ...check, mode: 'import', added: 1, ids: ['n1'] }))
    const onImported = vi.fn()
    mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onImported={onImported} fetchImpl={fetchImpl as any} />)
    await chooseFile('mine.csv', 'Name,Email\nAnn One,ann@x.co\nTommy,tom@x.co')
    expect($('[data-skipped]')!.textContent).toContain('Tom Minty')
    expect($$('[data-word]').map((w) => w.textContent)).toEqual(['Downsizing', 'Garage'])
    expect($('[data-add]')!.textContent).toBe('Add 1 contact')
    await click($('[data-add]'))
    const bodies = (fetchImpl.mock.calls as any[]).map((c) => JSON.parse(c[1].body))
    expect(bodies.map((b) => [b.mode, b.location_id])).toEqual([['check', LOC], ['import', LOC]])
    expect(bodies[0].csv).toBe(bodies[1].csv)
    expect($('[data-done]')!.textContent).toContain('1 contact added to Seattle')
    expect(onImported).toHaveBeenCalledWith(1)
  })

  it('a spreadsheet file is refused with how to save it as CSV, and nothing is sent', async () => {
    const fetchImpl = vi.fn(() => json({}))
    mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} fetchImpl={fetchImpl as any} />)
    await chooseFile('contacts.xlsx', 'PK\u0003\u0004')
    expect($('[data-refusal]')!.textContent).toContain('That file is not a CSV')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(($('[data-add]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the three buttons on the list', () => {
  const rows = [
    { id: 'c1', locationId: LOC, locationName: 'Seattle', name: 'Ann One', company: 'Keystone', title: 'Realtor', phone: '(206) 555-0101', email: 'ann@x.co', howWeMet: 'BNI', birthday: 'Mar 22', networkTypes: ['partner'], partnerLevel: 'power', partnerStage: null, isCustomer: false, lastContactedAt: null, tagIds: ['t-realtor'] },
    { id: 'c2', locationId: LOC, locationName: 'Seattle', name: '=HYPERLINK("x")', company: null, title: null, phone: null, email: null, howWeMet: null, birthday: null, networkTypes: ['vendor'], partnerLevel: null, partnerStage: null, isCustomer: false, lastContactedAt: null, tagIds: [] },
  ]
  const listFetch = (contacts: any[]) => vi.fn((url: string) => url.startsWith('/api/network/list') ? json({ contacts, tags: [{ id: 't-realtor', label: 'Realtor' }], followUps: {}, total: contacts.length, truncated: false }) : json({ referrers: [] }))

  it('on All Locations all three are off, and the screen says why', async () => {
    mount(<NetworkListScreen locationId={null} fetchImpl={listFetch([...rows, { ...rows[0], id: 'c3', locationId: OTHER }]) as any} />)
    await flush()
    for (const a of ['add', 'import', 'export']) expect(($(`[data-act="${a}"]`) as HTMLButtonElement).disabled).toBe(true)
    expect($('[data-act-note="pick-location"]')!.textContent).toContain('Pick one location')
  })

  it('Export saves this location’s contacts, in the columns the import reads, readable back in', async () => {
    let saved = ''
    const origCreate = URL.createObjectURL
    ;(URL as any).createObjectURL = (b: Blob) => { (b as any).text().then((t: string) => { saved = t }); return 'blob:x' }
    ;(URL as any).revokeObjectURL = () => {}
    const names: string[] = []
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () { names.push((this as HTMLAnchorElement).download) }
    try {
      mount(<NetworkListScreen locationId={LOC} locationName="Seattle" now={new Date('2026-11-17T15:00:00')} fetchImpl={listFetch(rows) as any} />)
      await flush()
      await click($('[data-act="export"]'))
      await flush()
    } finally {
      HTMLAnchorElement.prototype.click = origClick
      ;(URL as any).createObjectURL = origCreate
    }
    expect(names).toEqual([exportFileName('Seattle', new Date('2026-11-17T15:00:00'))])
    expect(names[0]).toBe('network-seattle-2026-11-17.csv')
    expect(saved.startsWith('﻿')).toBe(true)
    const table = parseCsv(saved)
    expect(table[0]!.slice(0, 12)).toEqual(['Name', 'Type', 'Company', 'Job title', 'Phone', 'Email', 'Birthday', 'Tags', 'Partner level', 'Stage', 'Interest', 'How met'])
    expect(table.slice(1).map((r) => r.slice(0, 9))).toEqual([
      ["'=HYPERLINK(\"x\")", 'vendor', '', '', '', '', '', '', ''],
      ['Ann One', 'partner', 'Keystone', 'Realtor', '(206) 555-0101', 'ann@x.co', 'Mar 22', 'Realtor', 'power'],
    ].sort((a, b) => a[0]!.localeCompare(b[0]!)).sort((a, b) => (a[0] === 'Ann One' ? -1 : b[0] === 'Ann One' ? 1 : 0)))
    expect($('[data-act-note="done"]')!.textContent).toContain('2 contacts at Seattle')
  })

  it('Export never writes a made-up zero: until the referral numbers answer, those columns are blank', async () => {
    const files: string[] = []
    const origCreate = URL.createObjectURL
    ;(URL as any).createObjectURL = (b: Blob) => { (b as any).text().then((t: string) => files.push(t)); return 'blob:x' }
    ;(URL as any).revokeObjectURL = () => {}
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {}
    const read = async (summary: 'never' | 'answers') => {
      const f = vi.fn((url: string) => url.startsWith('/api/network/list')
        ? json({ contacts: rows.slice(0, 1), tags: [{ id: 't-realtor', label: 'Realtor' }], followUps: {}, total: 1, truncated: false })
        : summary === 'never' ? new Promise(() => {}) : json({ referrers: [{ kind: 'partner', id: 'c1', count: 3, converted: 2, revenue: 900 }] }))
      mount(<NetworkListScreen locationId={LOC} locationName="Seattle" fetchImpl={f as any} />)
      await flush()
      await click($('[data-act="export"]'))
      await flush()
      act(() => root?.unmount()); host?.remove(); root = null; host = null
      const t = parseCsv(files[files.length - 1]!)
      const i = t[0]!.indexOf('Referrals')
      return [t[1]![i], t[1]![i + 1]]
    }
    try {
      expect(await read('never')).toEqual(['', ''])
      expect(await read('answers')).toEqual(['3', '2'])
    } finally {
      HTMLAnchorElement.prototype.click = origClick
      ;(URL as any).createObjectURL = origCreate
    }
  })
})
