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
import { headerSignature } from '@/lib/network/import-mapping'

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
    await type($('[data-field="firstName"]'), 'Dana')
    await type($('[data-field="lastName"]'), 'Whitfield')
    await type($('[data-field="email"]'), 'dana@x.co')
    await click($('[data-open-tags]'))
    await click($('[data-pick-tag="t-realtor"]'))
    await act(async () => { ($('[data-form="tags"]') as HTMLFormElement).requestSubmit() })
    await flush()
    await act(async () => { ($('[data-add-form]') as HTMLFormElement).requestSubmit() })
    await flush()
    const posts = sent.filter((s) => s.method === 'POST')
    expect(posts.map((p) => p.url)).toEqual(['/api/network/contacts'])
    expect(posts[0]!.body).not.toHaveProperty('name')
    expect(posts[0]!.body).toMatchObject({ location_id: LOC, firstName: 'Dana', lastName: 'Whitfield', types: ['partner'], email: 'dana@x.co', tagIds: ['t-realtor'] })
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
    await type($('[data-field="firstName"]'), 'Blaire')
    await type($('[data-field="lastName"]'), 'B')
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

  it('no email: the same name and phone warns the same way, naming who and why; a changed phone clears it; Add anyway sends', async () => {
    const posts: any[] = []
    const dupFetch = vi.fn((url: string, init?: any) => {
      if (url.startsWith('/api/lookups?')) return json({ lookups: TAGS, location: { name: 'Seattle' } })
      if (url === '/api/network/contacts') {
        const b = JSON.parse(init.body); posts.push(b)
        if (!b.email && b.phone.replace(/\D/g, '') === '3035550142' && b.addAnyway !== true) return json({ error: 'name_and_phone_already_here', field: 'name', matched: { id: 'p-pat', name: 'Pat Phone' } }, 409)
        if (!b.email && !b.phone && b.addAnyway !== true) return json({ error: 'name_already_here', field: 'name', matched: { id: 'p-pat2', name: 'Pat Phone' } }, 409)
        return json({ id: 'new-id' }, 201)
      }
      return json({}, 404)
    })
    const onAdded = vi.fn()
    mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={onAdded} onOpenExisting={vi.fn() as any} fetchImpl={dupFetch as any} />)
    await flush()
    await click($('[data-type="vendor"]'))
    await type($('[data-field="firstName"]'), 'Pat')
    await type($('[data-field="lastName"]'), 'Phone')
    await type($('[data-field="phone"]'), '303.555.0142')
    const submit = async () => { await act(async () => { ($('[data-add-form]') as HTMLFormElement).requestSubmit() }); await flush() }
    await submit()
    expect($('[data-duplicate]')!.getAttribute('data-rule')).toBe('name_phone')
    expect($('[data-duplicate]')!.textContent).toContain('Pat Phone at Seattle already has this name and phone, and you gave no email. Nothing was added.')
    expect($('[data-duplicate]')!.textContent).toContain('Add anyway: a different person with the same name and phone')
    expect(($('[data-save]') as HTMLButtonElement).disabled).toBe(true)
    await submit()
    expect(posts).toHaveLength(1)
    // a changed phone clears it
    await type($('[data-field="phone"]'), '303.555.0143')
    expect($('[data-duplicate]')).toBeNull()
    // no phone at all: the name-only rule, its own words
    await type($('[data-field="phone"]'), '')
    await submit()
    expect($('[data-duplicate]')!.getAttribute('data-rule')).toBe('name_only')
    expect($('[data-duplicate]')!.textContent).toContain('already has this name, and neither of you has a phone')
    await click($('[data-add-anyway]'))
    await submit()
    expect(posts.map((p) => !!p.addAnyway)).toEqual([false, false, true])
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
  /** Choose a file, then press Check on the column step (the mapping is the guess). */
  const chooseAndCheck = async (name: string, text: string) => { await chooseFile(name, text); await click($('[data-check]')) }
  /** The remembered mappings (a GET) answer nothing saved; everything else is the test's own. */
  const withMappings = (post: (u: string, init: any) => any) => vi.fn((u: string, init?: any) => (!init || init.method !== 'POST' ? json({ ok: true, remembered: true, mappings: {} }) : post(u, init)))

  it('EVERY unreadable row is listed with its line and reason (none cut off), and Add still adds the rest', async () => {
    const unreadable = Array.from({ length: 60 }, (_, i) => ({ line: i + 3, name: `Bad ${i}`, problems: ['Email looks wrong'] }))
    const check = { ok: true, mode: 'check', location: { id: LOC, name: 'Seattle' }, added: 0,
      adding: [{ line: 2, name: 'A', company: null, email: 'a@x.co', phone: null, tags: 0 }], unreadable, skipped: [], unmatchedTags: [], warnings: [] }
    const fetchImpl = withMappings((_u: string, init: any) => json(JSON.parse(init.body).mode === 'check' ? check : { ...check, mode: 'import', added: 1, ids: ['n1'] }))
    mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} fetchImpl={fetchImpl as any} />)
    await chooseAndCheck('mine.csv', 'Name,Email\nA,a@x.co\nCat,cat@')
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
      skipped: [{ line: 3, name: 'Tommy', email: 'tom@x.co', phone: null, rule: 'email', matched: { id: 'p1', name: 'Tom Minty', line: null } },
        { line: 4, name: 'Nora None', email: null, phone: '(206) 555-0100', rule: 'name_phone', matched: { id: 'p2', name: 'Nora None', line: null } },
        { line: 5, name: 'Bo Bare', email: null, phone: null, rule: 'name_only', matched: { id: null, name: 'Bo Bare', line: 2 } }],
      unmatchedTags: ['Downsizing', 'Garage'], warnings: [] }
    const fetchImpl = withMappings((_u: string, init: any) => json(JSON.parse(init.body).mode === 'check' ? check : { ...check, mode: 'import', added: 1, ids: ['n1'] }))
    const onImported = vi.fn()
    mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onImported={onImported} fetchImpl={fetchImpl as any} />)
    await chooseAndCheck('mine.csv', 'Name,Email\nAnn One,ann@x.co\nTommy,tom@x.co')
    expect($('[data-skipped]')!.textContent).toContain('Tom Minty')
    const why = $$('[data-skipped] li').map((li) => li.textContent)
    expect(why).toEqual([
      'Row 3Tommy (tom@x.co) matches Tom Minty',
      'Row 4Nora None has no email, and the same name and phone as Nora None',
      'Row 5Bo Bare has no email, and the same name as row 2 of this file, Bo Bare, with no phone on either',
    ])
    expect($('[data-skipped] h3')!.textContent).toBe('3 rows will be skipped: they’re already here')
    expect($$('[data-word]').map((w) => w.textContent)).toEqual(['Downsizing', 'Garage'])
    expect($('[data-add]')!.textContent).toBe('Add 1 contact')
    await click($('[data-add]'))
    const bodies = (fetchImpl.mock.calls as any[]).filter((c) => c[1]?.method === 'POST').map((c) => JSON.parse(c[1].body))
    expect(bodies.map((b) => [b.mode, b.location_id])).toEqual([['check', LOC], ['import', LOC]])
    expect(bodies[0].csv).toBe(bodies[1].csv)
    expect($('[data-done]')!.textContent).toContain('1 contact added to Seattle')
    expect(onImported).toHaveBeenCalledWith(1)
  })

  it('a spreadsheet file is refused with how to save it as CSV, and nothing is sent', async () => {
    const fetchImpl = withMappings(() => json({}))
    mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} fetchImpl={fetchImpl as any} />)
    await chooseFile('contacts.xlsx', 'PK\u0003\u0004')
    expect($('[data-refusal]')!.textContent).toContain('That file is not a CSV')
    // only the read of remembered mappings: the file itself is never sent
    expect((fetchImpl.mock.calls as any[]).filter((c) => c[1]?.method === 'POST')).toEqual([])
    expect(($('[data-add]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the buttons on the list', () => {
  const rows = [
    { id: 'c1', locationId: LOC, locationName: 'Seattle', name: 'Ann One', company: 'Keystone', title: 'Realtor', phone: '(206) 555-0101', email: 'ann@x.co', howWeMet: 'BNI', birthday: 'Mar 22', networkTypes: ['partner'], partnerLevel: 'power', partnerStage: null, isCustomer: false, lastContactedAt: null, tagIds: ['t-realtor'] },
    { id: 'c2', locationId: LOC, locationName: 'Seattle', name: '=HYPERLINK("x")', company: null, title: null, phone: null, email: null, howWeMet: null, birthday: null, networkTypes: ['vendor'], partnerLevel: null, partnerStage: null, isCustomer: false, lastContactedAt: null, tagIds: [] },
  ]
  const listFetch = (contacts: any[]) => vi.fn((url: string) => url.startsWith('/api/network/list') ? json({ contacts, tags: [{ id: 't-realtor', label: 'Realtor' }], followUps: {}, total: contacts.length, truncated: false }) : json({ referrers: [] }))

  it('on All Locations all three are off, and the screen says why', async () => {
    mount(<NetworkListScreen locationId={null} fetchImpl={listFetch([...rows, { ...rows[0], id: 'c3', locationId: OTHER }]) as any} />)
    await flush()
    expect(($('[data-act="add-contacts"]') as HTMLButtonElement).disabled).toBe(true)
    expect($('[data-act="add"]')).toBeNull() // the choices are inside the one button, which is off
    await click($('[data-act="more"]'))
    expect(($('[data-act="export"]') as HTMLButtonElement).disabled).toBe(true)
    expect($('[data-act="export"]')!.textContent).toContain('Pick one location first.')
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
      await click($('[data-act="more"]'))
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
      await click($('[data-act="more"]'))
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

describe('the add box: a person gets First and Last, an organization one name (2026-11-19)', () => {
  const posts: any[] = []
  const fetchImpl = vi.fn((url: string, init?: any) => {
    if (url.startsWith('/api/lookups?')) return json({ lookups: TAGS, location: { name: 'Seattle' } })
    if (url === '/api/network/contacts') { posts.push(JSON.parse(init.body)); return json({ id: 'new-id' }, 201) }
    return json({}, 404)
  })
  const open = async () => {
    posts.length = 0
    mount(<AddContactDialog locationId={LOC} locationName="Seattle" onClose={() => {}} onAdded={() => {}} fetchImpl={fetchImpl as any} />)
    await flush()
  }
  const submit = async () => { await act(async () => { ($('[data-add-form]') as HTMLFormElement).requestSubmit() }); await flush() }
  const val = (k: string) => ($(`[data-field="${k}"]`) as HTMLInputElement | null)?.value ?? null

  it('a person: two boxes, and the request carries first and last, no name', async () => {
    await open()
    await click($('[data-type="partner"]'))
    expect($('[data-field="name"]')).toBeNull()
    expect($('[data-person-name]')!.textContent).toContain('First name')
    expect($('[data-person-name]')!.textContent).toContain('Last name')
    await type($('[data-field="firstName"]'), 'Mary')
    await type($('[data-field="lastName"]'), 'Van Der Berg')
    await submit()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ firstName: 'Mary', lastName: 'Van Der Berg' })
    expect(posts[0]).not.toHaveProperty('name')
  })

  it('an organization: one name box, no First or Last, and the request carries the name whole', async () => {
    await open()
    await click($('[data-type="organization"]'))
    expect($('[data-field="firstName"]')).toBeNull()
    expect($('[data-field="lastName"]')).toBeNull()
    expect($('[data-field="name"]')!.closest('label')!.textContent).toContain('Organization name')
    await type($('[data-field="name"]'), 'Northside Chamber of Commerce')
    await submit()
    expect(posts[0]).toMatchObject({ name: 'Northside Chamber of Commerce' })
    expect(posts[0]).not.toHaveProperty('firstName')
    expect(posts[0]).not.toHaveProperty('lastName')
  })

  it('switching type carries what was typed across, both ways', async () => {
    await open()
    await click($('[data-type="vendor"]'))
    await type($('[data-field="firstName"]'), 'Keystone')
    await type($('[data-field="lastName"]'), 'Realty Group')
    await click($('[data-type="organization"]'))
    expect(val('name')).toBe('Keystone Realty Group')
    await click($('[data-type="organization"]')) // off again: back to a person
    expect([val('firstName'), val('lastName')]).toEqual(['Keystone', 'Realty Group'])
  })

  it('a name typed as an organization splits into First and Last when the type becomes a person', async () => {
    await open()
    await click($('[data-type="organization"]'))
    await type($('[data-field="name"]'), 'Mary Van Der Berg')
    await click($('[data-type="organization"]')) // off
    await click($('[data-type="partner"]'))
    expect([val('firstName'), val('lastName')]).toEqual(['Mary', 'Van Der Berg'])
  })

  it('a person with no name: Add stays off, and Enter shows why at the First box', async () => {
    await open()
    await click($('[data-type="partner"]'))
    await type($('[data-field="firstName"]'), '   ') // spaces only: the browser's own check lets it through
    expect(($('[data-add-form] [data-save]') as HTMLButtonElement).disabled).toBe(true)
    await submit()
    expect(posts).toEqual([])
    expect($('[data-error="firstName"]')!.textContent).toBe('A person needs a first or last name.')
  })
})

describe('the import box: their columns, Bee Hub’s fields (2026-11-19)', () => {
  const chooseFile = async (name: string, text: string) => {
    const input = $('[data-file-input]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File([text], name, { type: 'text/csv' })], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(); await flush()
  }
  const choose = async (col: number, value: string) => {
    const sel = $(`[data-map-select="${col}"]`) as HTMLSelectElement
    await act(async () => { sel.value = value; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
  }
  const picked = () => $$('[data-map-select]').map((s) => [s.closest('li')!.querySelector('b')!.textContent, (s as HTMLSelectElement).value])
  const posts: any[] = []
  const box = async (saved: any = {}) => {
    posts.length = 0
    const fetchImpl = vi.fn((url: string, init?: any) => {
      if (!init || init.method !== 'POST') return json({ ok: true, remembered: true, mappings: saved })
      const b = JSON.parse(init.body); posts.push(b)
      return json({ ok: true, mode: b.mode, location: { id: LOC, name: 'Seattle' }, added: b.mode === 'import' ? 1 : 0, ids: ['n1'], adding: [{ line: 2, name: 'Dana Whitfield', company: null, email: 'dana@x.co', phone: null, tags: 0 }], unreadable: [], skipped: [], unmatchedTags: [], warnings: [], mappingSaved: true })
    })
    mount(<ImportDialog locationId={LOC} locationName="Seattle" onClose={() => {}} fetchImpl={fetchImpl as any} />)
    await flush()
    return fetchImpl
  }
  const OUTLOOKISH = 'First Name,Middle Name,Last Name,Title,E-mail Address,Mobile Phone,Pager,Company\nDana,,Whitfield,Ms.,Dana@Keystone.COM,3035550142,,Keystone Realty\nMarcus,,Lee,,,720.555.0199,,'

  it('a good guess: their columns on the left, the guess on the right, empty columns left out', async () => {
    await box()
    await chooseFile('outlook.csv', OUTLOOKISH)
    expect($('[data-map-note]')!.getAttribute('data-map-note')).toBe('guessed')
    expect(picked()).toEqual([['First Name', 'firstName'], ['Last Name', 'lastName'], ['Title', 'title'], ['E-mail Address', 'email'], ['Mobile Phone', 'phone'], ['Company', 'company']])
    expect($('[data-empty-columns]')!.textContent).toBe('2 columns have nothing in them in this file, so they are left out.')
    expect(posts).toEqual([])
  })

  it('the preview shows the first rows as they would LAND, not the raw file', async () => {
    await box()
    await chooseFile('outlook.csv', OUTLOOKISH)
    const landed = $('[data-landing]')!.textContent!
    expect($$('[data-land-line]').map((li) => li.getAttribute('data-land-line'))).toEqual(['2', '3'])
    expect(landed).toContain('Dana Whitfield')
    expect(landed).toContain('Dana / Whitfield')
    expect(landed).toContain('dana@keystone.com') // tidied, as it would be stored
    expect(landed).toContain('(303) 555-0142')
    expect(landed).not.toContain('Dana@Keystone.COM') // the raw cell
    expect(landed).not.toContain('3035550142')
  })

  it('a wrong guess corrected: Outlook’s Title is Mr / Mrs, so it is ignored, and the preview and the file sent follow', async () => {
    await box()
    await chooseFile('outlook.csv', OUTLOOKISH)
    expect($('[data-landing]')!.textContent).toContain('Ms.')
    await choose(3, '')
    expect($('[data-landing]')!.textContent).not.toContain('Ms.')
    expect($('[data-column="3"]')!.hasAttribute('data-ignored')).toBe(true)
    await click($('[data-check]'))
    expect(posts[0].mode).toBe('check')
    expect(posts[0].csv.split('\n')[0]).toBe('First name,Last name,Email,Phone,Company')
    await click($('[data-add]'))
    expect(posts[1]).toMatchObject({ mode: 'import', mapping: { headers: ['First Name', 'Middle Name', 'Last Name', 'Title', 'E-mail Address', 'Mobile Phone', 'Pager', 'Company'], fields: ['firstName', null, 'lastName', null, 'email', 'phone', null, 'company'] } })
    expect(posts[1].csv).toBe(posts[0].csv)
  })

  it('three phone columns: the fullest is picked, the other two are named, and choosing one moves Phone', async () => {
    await box()
    await chooseFile('phones.csv', 'Name,Home Phone,Business Phone,Mobile Phone\nA One,303 555 0001,,303 555 0101\nB Two,,303 555 0202,303 555 0102\nC Three,,,303 555 0103')
    expect(picked()).toEqual([['Name', 'name'], ['Home Phone', ''], ['Business Phone', ''], ['Mobile Phone', 'phone']])
    expect($$('[data-also="phone"]').map((p) => p.closest('li')!.querySelector('b')!.textContent)).toEqual(['Home Phone', 'Business Phone'])
    expect($('[data-also="phone"]')!.textContent).toContain('Bee Hub keeps one phone per contact, from Mobile Phone')
    await choose(1, 'phone')
    expect(picked()).toEqual([['Name', 'name'], ['Home Phone', 'phone'], ['Business Phone', ''], ['Mobile Phone', '']])
    expect($('[data-landing]')!.textContent).toContain('(303) 555-0001')
  })

  it('no column set as Phone: the box says nobody gets one, and the file can still be checked', async () => {
    await box()
    await chooseFile('phones.csv', 'Name,Mobile Phone\nA One,303 555 0101')
    await choose(1, '')
    expect($('[data-missing-fields]')!.textContent).toContain('No column is set as Phone or Email')
    expect(($('[data-check]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('headings that match nothing: everything on Ignore, it says so, and nothing can be checked until a name column is picked', async () => {
    await box()
    await chooseFile('odd.csv', 'Col A,Col B\nDana Whitfield,dana@x.co')
    expect($('[data-map-note]')!.getAttribute('data-map-note')).toBe('nothing-known')
    expect(picked()).toEqual([['Col A', ''], ['Col B', '']])
    expect($('[data-no-name]')).not.toBeNull()
    expect(($('[data-check]') as HTMLButtonElement).disabled).toBe(true)
    await choose(0, 'name')
    await choose(1, 'email')
    expect($('[data-no-name]')).toBeNull()
    expect($('[data-landing]')!.textContent).toContain('Dana Whitfield')
  })

  it('a second file from the same source arrives already mapped, the way the owner left it', async () => {
    const headers = ['Contact', 'Title', 'Mail']
    const saved = { [headerSignature(headers)]: { headers, fields: ['name', null, 'email'], savedAt: '2026-11-19T10:00:00Z' } }
    await box(saved)
    await chooseFile('again.csv', 'Mail,Contact,Title\nann@x.co,Ann One,Mrs.')
    expect($('[data-map-note]')!.getAttribute('data-map-note')).toBe('recalled')
    expect(picked()).toEqual([['Mail', 'email'], ['Contact', 'name'], ['Title', '']])
  })
})

describe('one Add contacts button; Export by the search (2026-11-19)', () => {
  const rows = [{ id: 'c1', locationId: LOC, locationName: 'Seattle', name: 'Ann One', company: null, title: null, phone: null, email: 'ann@x.co', howWeMet: null, birthday: null, networkTypes: ['partner'], partnerLevel: null, partnerStage: null, isCustomer: false, lastContactedAt: null, tagIds: [] }]
  const listFetch = vi.fn((url: string) => url.startsWith('/api/network/list') ? json({ contacts: rows, tags: [], followUps: {}, total: 1, truncated: false })
    : url.startsWith('/api/lookups') ? json({ lookups: TAGS, location: { name: 'Seattle' } }) : url.startsWith('/api/network/import') ? json({ ok: true, mappings: {} }) : json({ referrers: [] }))
  const open = async () => { mount(<NetworkListScreen locationId={LOC} locationName="Seattle" fetchImpl={listFetch as any} />); await flush() }

  it('the header has one button for adding; its two choices open the add box and the import box', async () => {
    await open()
    // slice 6: and More, for the rare actions (Export)
    expect($$('[data-actions] button').map((b) => b.getAttribute('data-act'))).toEqual(['add-contacts', 'more'])
    await click($('[data-act="add-contacts"]'))
    expect($('[data-act="add-contacts"]')!.getAttribute('aria-expanded')).toBe('true')
    expect($$('[role="menuitem"]').map((b) => b.querySelector('b')!.textContent)).toEqual(['One person', 'From a spreadsheet'])
    await click($('[data-act="add"]'))
    expect($('[data-network-add]')).not.toBeNull()
    expect($('[role="menuitem"]')).toBeNull() // picking a choice closes the menu
  })

  it('From a spreadsheet opens the import box', async () => {
    await open()
    await click($('[data-act="add-contacts"]'))
    await click($('[data-act="import"]'))
    expect($('[data-network-import]')).not.toBeNull()
  })

  it('it closes by its own button or Escape, and NOT by a tap outside (Bee Hub’s rule, 75363e9)', async () => {
    await open()
    await click($('[data-act="add-contacts"]'))
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.click() })
    await flush()
    expect($('[role="menuitem"]')).not.toBeNull()
    await click($('[data-act="add-contacts"]'))
    expect($('[role="menuitem"]')).toBeNull()
    await click($('[data-act="add-contacts"]'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    await flush()
    expect($('[role="menuitem"]')).toBeNull()
  })

  it('Export lives in the More menu (slice 6: it is rare), and nowhere else', async () => {
    await open()
    expect($('[data-act="export"]')).toBeNull()
    expect($('.nw-controls [data-act="export"]')).toBeNull()
    await click($('[data-act="more"]'))
    expect($$('[data-act="export"]')).toHaveLength(1)
    expect($('[data-act="export"]')!.closest('[role="menu"]')).not.toBeNull()
    expect($('[data-act="export"]')!.textContent).toContain('Export CSV')
  })
  it('the More menu closes on its choice, on its button again, and on Escape, not on a tap outside', async () => {
    await open()
    await click($('[data-act="more"]'))
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.click() })
    await flush()
    expect($('[data-act="export"]')).not.toBeNull()
    await click($('[data-act="more"]'))
    expect($('[data-act="export"]')).toBeNull()
    await click($('[data-act="more"]'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    await flush()
    expect($('[data-act="export"]')).toBeNull()
  })
})
