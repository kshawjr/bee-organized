// @vitest-environment happy-dom
//
// The contact sheet (components/network/ContactSheet.jsx), mounted for real
// against a stand-in for its addresses. What the SERVER does with a save is
// pinned in contact-route.test.ts and contact-edit.test.ts; this file pins
// what the SCREEN shows and what it sends.
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ContactSheet, { addressLines, historyOf, initialsOf, whenLabel } from '@/components/network/ContactSheet'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ID = '11111111-2222-4333-8444-555555555555'
const contact = (over: any = {}) => ({
  id: ID, locationId: 'loc', locationName: 'Greensboro', name: 'Lisa Snyder', title: null, company: null, companyId: null, linkedCompany: null,
  phone: null, email: null, website: null, addresses: [], howWeMet: null, specialties: [], relationship: null, notes: [], nextSteps: [], activity: [],
  isCustomer: false, customerLeadId: null, networkTypes: ['unsure'], partnerLevel: null, partnerStage: null, birthday: null, birthdayReminder: false,
  lastContactedAt: null, createdAt: '2026-08-24T15:00:00Z', updatedAt: '2026-08-24T15:00:00Z', tagIds: [], ...over,
})
const sheetOf = (c: any = {}, rest: any = {}) => ({ contact: contact(c), tags: [], touchpoints: [], followUps: [], ...rest })
const FULL = sheetOf({
  title: 'Real Estate Agent', company: 'Compass', companyId: 'co1', linkedCompany: { id: 'co1', name: 'Compass Greenwood Village' },
  phone: '(303) 555-0142', email: 'lisa@compass.com', website: 'compass.com', howWeMet: 'Chamber breakfast',
  addresses: [{ type: 'Office', value: '1 Main St, Denver CO', street: '1 Main St', apt: 'Suite 4', city: 'Denver', state: 'CO', zip: '80202' }, { type: 'Home', value: '9 Elm Rd' }],
  specialties: ['real-estate'], relationship: 'Realtor', nextSteps: [{ id: 's1', text: 'Send the packet', done: false }],
  notes: [{ id: 'n1', text: 'Loves the pantry photos', ts: '2026-09-20T10:00:00Z', user: 'Kevin' }],
  activity: [{ type: 'event', label: 'Added to Network', ts: '2026-08-24T15:00:00Z' }],
  networkTypes: ['partner'], partnerLevel: 'referral', partnerStage: 'Reaching Out', birthday: 'Mar 22', birthdayReminder: true, isCustomer: true,
}, {
  tags: [{ id: 't1', label: 'Realtor', section: 'trade' }, { id: 't2', label: 'VIP', section: 'relationship' }, { id: 't3', label: 'Oak & Key', section: 'location' }],
  touchpoints: [{ id: 'tp1', kind: 'reach_out', method: 'call', label: 'Phone Call', notes: 'Spring listings', occurred_at: '2026-10-02T15:00:00Z' }],
  followUps: [{ id: 'r1', due_on: '2026-11-20', note: 'Coffee about spring' }],
})

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[] = []
type Opts = { sheet?: any; referral?: any; patch?: (body: any) => { status: number; json: any } | Promise<{ status: number; json: any }>; getStatus?: number }
const fakeFetch = (o: Opts = {}) => {
  let current = o.sheet || sheetOf()
  return vi.fn(async (url: string, init?: any) => {
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body })
    if (url.endsWith('/referrals')) return { ok: true, status: 200, json: async () => (o.referral || { total: 0, totals: { converted: 0, revenue: 0 } }) }
    if (method === 'PATCH') {
      const r = await (o.patch ? o.patch(body) : { status: 200, json: { ...current, written: ['x'], notes: [] } })
      if (r.status === 200) current = r.json
      return { ok: r.status === 200, status: r.status, json: async () => r.json }
    }
    if (o.getStatus && o.getStatus !== 200) return { ok: false, status: o.getStatus, json: async () => ({ error: 'forbidden' }) }
    return { ok: true, status: 200, json: async () => current }
  })
}
const settle = async (k = 4) => { for (let i = 0; i < k; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
async function mount(o: Opts = {}, props: any = {}) {
  calls = []
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  const onClose = vi.fn(); const onSaved = vi.fn()
  await act(async () => { root.render(React.createElement(ContactSheet as any, { contactId: ID, onClose, onSaved, fetchImpl: fakeFetch(o), ...props })) })
  await settle()
  return { onClose, onSaved }
}
afterEach(() => { try { act(() => root.unmount()) } catch {} host?.remove(); document.body.style.overflow = '' })

const $ = (sel: string) => host.querySelector(sel) as HTMLElement | null
const $$ = (sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[]
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle(2) }
const type = async (sel: string, value: string) => {
  const el = $(sel) as HTMLInputElement | HTMLSelectElement
  if (!el) throw new Error(`no field ${sel}`)
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })
}
const submit = async () => { await act(async () => { ($('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle(3) }
const patches = () => calls.filter((c) => c.method === 'PATCH')
const card = (id: string) => $(`[data-card="${id}"]`)
const value = (k: string) => $(`[data-value="${k}"]`)!.textContent

describe('a contact with nothing on it: the normal sheet', () => {
  it('reads as calm: the name, its type, and quiet lines; no warning, no error', async () => {
    await mount()
    expect($('[data-sheet-name]')!.textContent).toBe('Lisa Snyder')
    expect($$('.ns-type').map((t) => t.textContent)).toEqual(['Not sure yet'])
    expect($('[data-sheet-tags]')!.textContent).toBe('TagsAdd tags')
    expect($('[data-follow-ups-empty]')!.textContent).toBe('No follow-up set. Yours show here and on your Reminders page.')
    expect($('[role="alert"]')).toBeNull()
    expect(host.querySelector('.ns-problem, .ns-error')).toBeNull()
  })
  it('offers each missing detail as something to add, not as a hole', async () => {
    await mount()
    expect($$('[data-add]').map((b) => b.textContent)).toEqual(['+ add phone', '+ add email', '+ add website', '+ add how you met', '+ add birthday', '+ add address'])
  })
  it('draws no card for what it does not have', async () => {
    await mount()
    // Slice 4b: the "Touchpoints & notes" card is always there, because it is
    // where a touchpoint or a note is added. There is still no Address card.
    expect($$('[data-card]').map((c) => c.dataset.card)).toEqual(['essentials', 'log', 'follow-ups'])
    expect($('[data-log-line]')!.textContent).toBe('Nothing logged with Lisa yet.')
    expect($('[data-referral-badge]')).toBeNull()
    expect($('[data-sheet-title]')).toBeNull()
    expect($('[data-sheet-company]')).toBeNull()
  })
  it('History says nothing is logged yet, in one line', async () => {
    await mount()
    expect($('[data-tab="history"]')!.textContent).toBe('History 0')
    await click($('[data-tab="history"]'))
    expect($('[data-history-empty]')!.textContent).toBe('Nothing logged with Lisa yet.')
  })
})

describe('a contact with everything', () => {
  it('shows what the design has no field for: address, website, the linked company, how you met, specialties, relationship, next steps', async () => {
    await mount({ sheet: FULL })
    expect(value('website')).toBe('compass.com')
    expect(($('[data-value="website"] a') as HTMLAnchorElement).getAttribute('href')).toBe('https://compass.com')
    expect(value('howWeMet')).toBe('Chamber breakfast')
    expect($('[data-addresses]')!.textContent).toBe('Office1 Main St, Suite 4Denver, CO 80202Home9 Elm Rd')
    expect(card('addresses')!.querySelector('.ns-card-title')!.textContent).toBe('Addresses')
    expect($('[data-on-file]')!.textContent).toBe('RelationshipRealtorSpecialtiesreal-estateNext stepsSend the packet')
  })
  it('the company shown is the LINKED company, marked as a link, not the company text', async () => {
    await mount({ sheet: FULL })
    expect($('[data-sheet-company]')!.textContent).toBe('Compass Greenwood VillageLinked company')
    expect($('[data-linked-company]')).toBeTruthy()
  })
  it('with no link, the company text is shown and nothing claims a link', async () => {
    await mount({ sheet: sheetOf({ company: 'Compass' }) })
    expect($('[data-sheet-company]')!.textContent).toBe('Compass')
    expect($('[data-linked-company]')).toBeNull()
  })
  it('phone and email are links that call and write', async () => {
    await mount({ sheet: FULL })
    expect(($('[data-value="phone"] a') as HTMLAnchorElement).getAttribute('href')).toBe('tel:3035550142')
    expect(($('[data-value="email"] a') as HTMLAnchorElement).getAttribute('href')).toBe('mailto:lisa@compass.com')
  })
  it('shows a birthday with its reminder, and that the contact is also a client', async () => {
    await mount({ sheet: FULL })
    expect(value('birthday')).toBe('Mar 22 · reminder on')
    expect($('[data-also-client]')!.textContent).toBe('also a client')
  })
  it("follow-ups are the reminders it was sent, with their dates", async () => {
    await mount({ sheet: FULL })
    expect($('[data-follow-ups]')!.textContent).toBe('Coffee about springFri, Nov 20')
    expect($('[data-follow-ups-empty]')).toBeNull()
  })
  it('History lists touchpoints, notes and events, newest first', async () => {
    await mount({ sheet: FULL })
    expect($('[data-tab="history"]')!.textContent).toBe('History 3')
    await click($('[data-tab="history"]'))
    expect($$('.ns-history li').map((l) => [l.dataset.kind, l.textContent])).toEqual([
      ['touchpoint', 'Phone Call — Spring listingsOct 2, 2026'],
      ['note', 'Loves the pantry photosSep 20, 2026 · Kevin'],
      ['event', 'Added to NetworkAug 24, 2026'],
    ])
  })
  it('a partner who has sent nobody yet gets no "$0" badge', async () => {
    await mount({ sheet: FULL, referral: { total: 0, totals: { converted: 0, revenue: 0 } } })
    expect($('[data-referral-badge]')).toBeNull()
  })
  it('real referral numbers show for a partner', async () => {
    await mount({ sheet: FULL, referral: { total: 3, totals: { converted: 2, revenue: 4200 } } })
    expect($('[data-referral-badge]')!.textContent).toBe("Work they’ve sent you$4,2003 referrals · 2 clients")
  })
})

describe('the tags are Bee Hub\'s', () => {
  it('shows the tags it was sent, each carrying its Bee Hub section', async () => {
    await mount({ sheet: FULL })
    expect($$('[data-tag]').map((t) => [t.lastChild!.textContent, t.dataset.section])).toEqual([['Realtor', 'trade'], ['VIP', 'relationship'], ['Oak & Key', 'location']])
  })
  it('carries none of the design\'s sample tags, and no tag list of its own', () => {
    const src = readFileSync(join(process.cwd(), 'components/network/ContactSheet.jsx'), 'utf8')
    for (const sample of ['Senior living', 'General contractor', 'Estate sale', 'Electrician', 'Handyman', 'Painter', 'Storage', 'Organizer']) expect(src, sample).not.toContain(`'${sample}'`)
    expect(src).not.toMatch(/const TAGS\b|allowCreate/)
  })
  it('the tags themselves are not controls; one button opens the picker (contact-sheet-adds.test.tsx)', async () => {
    await mount({ sheet: FULL })
    expect($$('[data-sheet-tags] button').map((b) => b.dataset.edit)).toEqual(['tags'])
    expect($$('[data-sheet-tags] [data-tag]').map((t) => t.tagName)).toEqual(['SPAN', 'SPAN', 'SPAN'])
    expect($('[data-sheet-tags] input')).toBeNull()
  })
})

describe('met_date is not used', () => {
  it('"Added" is the created date', async () => {
    await mount()
    expect(value('added')).toBe('Aug 24, 2026')
  })
  it('the sheet never reads, shows or sends met_date', async () => {
    await mount({ sheet: { ...sheetOf(), contact: { ...contact(), metDate: 'Just now', met_date: 'Just now' } } })
    expect(host.textContent).not.toContain('Just now')
    const src = readFileSync(join(process.cwd(), 'components/network/ContactSheet.jsx'), 'utf8')
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(code).not.toMatch(/metDate|met_date/)
  })
})

describe('partner level and stage: shown, plainly not editable', () => {
  const PARTNER = sheetOf({ networkTypes: ['partner'], partnerLevel: 'referral', partnerStage: 'Reaching Out' })
  it('a Referral partner sees their level and where they are in the five stages', async () => {
    await mount({ sheet: PARTNER })
    expect($('[data-sheet-level]')!.textContent).toBe('Referral Partner')
    expect($$('.ns-step').map((s) => s.textContent)).toEqual(['1New Contact', '2Reaching Out', '3Building the Relationship', '4Active Partner', '5Gone quiet'])
    expect($$('.ns-step').filter((s) => s.dataset.current === 'true').map((s) => s.textContent)).toEqual(['2Reaching Out'])
    expect($$('.ns-step').filter((s) => s.dataset.done === 'true').map((s) => s.textContent)).toEqual(['1New Contact'])
  })
  it('nothing in that card is a control, and it says so and why', async () => {
    await mount({ sheet: PARTNER })
    expect(card('partner')!.querySelector('button, input, select, a, [tabindex], [role="button"]')).toBeNull()
    expect($('[data-sheet-stages]')!.getAttribute('aria-disabled')).toBe('true')
    expect($('[data-level-stage-note]')!.textContent).toBe('Now at Reaching Out. Level and stage can’t be changed from here yet: changing them will ask you to confirm, and that step is still being built.')
  })
  it('a Vendor has no level, no stage and no such card', async () => {
    await mount({ sheet: sheetOf({ networkTypes: ['vendor'], partnerLevel: 'power', partnerStage: 'Active Partner' }) })
    expect(card('partner')).toBeNull()
    expect($('[data-sheet-level]')).toBeNull()
    expect($$('.ns-type').map((t) => t.textContent)).toEqual(['Vendor / Service Provider'])
  })
  it('a contact who is both shows both types, and the partner card', async () => {
    await mount({ sheet: sheetOf({ networkTypes: ['vendor', 'partner'], partnerLevel: 'referral', partnerStage: 'New Contact' }) })
    expect($$('.ns-type').map((t) => t.textContent)).toEqual(['Referral partner', 'Vendor / Service Provider'])
    expect(card('partner')).toBeTruthy()
  })
  it('the types are shown, not changed, on this sheet', async () => {
    await mount({ sheet: PARTNER })
    expect($('.ns-types button, .ns-types input, .ns-types select')).toBeNull()
  })
})

describe('a save sends only what the person changed', () => {
  const edited = (over: any) => ({ status: 200, json: { ...sheetOf(over), written: Object.keys(over), notes: [] } })
  it('one field edited: the request names that field, what it said, and what it says now', async () => {
    await mount({ sheet: FULL, patch: () => edited({ phone: '(720) 555-0199' }) })
    await click($('[data-edit="essentials"]'))
    await type('[data-field="phone"]', '720-555-0199')
    await submit()
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.url).toBe(`/api/network/contacts/${ID}`)
    expect(patches()[0]!.body).toEqual({ changes: { phone: { from: '(303) 555-0142', to: '720-555-0199' } } })
  })
  it('a field left alone is never in the request, however full the form', async () => {
    await mount({ sheet: FULL, patch: () => edited({ website: 'new.example' }) })
    await click($('[data-edit="essentials"]'))
    await type('[data-field="website"]', 'new.example')
    await submit()
    expect(Object.keys(patches()[0]!.body.changes)).toEqual(['website'])
    for (const never of ['addresses', 'companyId', 'networkTypes', 'partnerLevel', 'partnerStage', 'notes', 'tagIds', 'metDate', 'name', 'email']) expect(patches()[0]!.body.changes).not.toHaveProperty(never)
  })
  it('opening the form and saving with nothing changed sends nothing at all', async () => {
    await mount({ sheet: FULL })
    await click($('[data-edit="essentials"]'))
    await submit()
    expect(patches()).toEqual([])
    expect($('[data-saved]')!.textContent).toBe('Nothing changed')
  })
  it('the name form sends the last name alone, not job title or company', async () => {
    const split = sheetOf({ ...FULL.contact, firstName: 'Lisa', lastName: 'Snyder' })
    await mount({ sheet: split, patch: () => edited({ name: 'Lisa S', lastName: 'S' }) })
    await click($('[data-edit="identity"]'))
    expect($('[data-field="name"]')).toBeNull()
    expect(($('[data-field="firstName"]') as HTMLInputElement).value).toBe('Lisa')
    await type('[data-field="lastName"]', 'S')
    await submit()
    expect(patches()[0]!.body).toEqual({ changes: { lastName: { from: 'Snyder', to: 'S' } } })
  })
  it('a name not split yet: empty First and Last, a line saying so, and editing the job title leaves the name alone', async () => {
    await mount({ sheet: FULL, patch: () => edited({ title: 'Broker' }) })
    await click($('[data-edit="identity"]'))
    expect(($('[data-field="firstName"]') as HTMLInputElement).value).toBe('')
    expect(($('[data-field="lastName"]') as HTMLInputElement).value).toBe('')
    expect($('[data-name-not-split]')!.textContent).toContain('hasn’t split “Lisa Snyder”')
    await type('[data-field="title"]', 'Broker')
    await submit()
    expect(patches()[0]!.body).toEqual({ changes: { title: { from: 'Real Estate Agent', to: 'Broker' } } })
  })
  it('an organization: one Name box, no First or Last', async () => {
    await mount({ sheet: sheetOf({ name: 'Northside Chamber', networkTypes: ['organization'] }), patch: () => edited({ name: 'Northside Chamber of Commerce' }) })
    await click($('[data-edit="identity"]'))
    expect($('[data-field="firstName"]')).toBeNull()
    await type('[data-field="name"]', 'Northside Chamber of Commerce')
    await submit()
    expect(patches()[0]!.body).toEqual({ changes: { name: { from: 'Northside Chamber', to: 'Northside Chamber of Commerce' } } })
  })
  it('a birthday and its reminder go as two named fields', async () => {
    await mount({ patch: () => edited({ birthday: 'Jul 4', birthdayReminder: true }) })
    await click($('[data-add="birthday"]'))
    await type('[data-field="month"]', 'Jul'); await type('[data-field="day"]', '4')
    await click($('[data-field="birthdayReminder"]'))
    await submit()
    expect(patches()[0]!.body).toEqual({ changes: { birthday: { from: null, to: 'Jul 4' }, birthdayReminder: { from: false, to: true } } })
  })
  it('the reminder box cannot be ticked without a birthday', async () => {
    await mount()
    await click($('[data-add="birthday"]'))
    expect(($('[data-field="birthdayReminder"]') as HTMLInputElement).disabled).toBe(true)
    expect(($('[data-field="day"]') as HTMLSelectElement).disabled).toBe(true)
  })
  it('after a save the sheet shows what the server sent back, says Saved, and tells the list', async () => {
    const { onSaved } = await mount({ sheet: FULL, patch: () => edited({ phone: '(720) 555-0199' }) })
    await click($('[data-edit="essentials"]')); await type('[data-field="phone"]', '720-555-0199'); await submit()
    expect(value('phone')).toBe('(720) 555-0199')
    expect($('[data-saved]')!.textContent).toBe('Saved')
    expect($('form')).toBeNull()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
  it('when the server writes nothing, the list is not told to reload', async () => {
    const { onSaved } = await mount({ sheet: FULL, patch: () => ({ status: 200, json: { ...FULL, written: [], notes: [] } }) })
    await click($('[data-edit="essentials"]')); await type('[data-field="phone"]', '303.555.0142'); await submit()
    expect($('[data-saved]')!.textContent).toBe('Nothing changed')
    expect(onSaved).not.toHaveBeenCalled()
  })
  it('Cancel sends nothing and puts the sheet back as it was', async () => {
    await mount({ sheet: FULL })
    await click($('[data-edit="essentials"]')); await type('[data-field="phone"]', '720-555-0199')
    await click($('[data-cancel]'))
    expect(patches()).toEqual([])
    expect(value('phone')).toBe('(303) 555-0142')
  })
  it('only ever talks to its own contact: two reads, and saves to the same address', async () => {
    await mount({ sheet: FULL, patch: () => edited({ phone: '(720) 555-0199' }) })
    await click($('[data-edit="essentials"]')); await type('[data-field="phone"]', '720-555-0199'); await submit()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/network/contacts/${ID}`, `GET /api/partners/${ID}/referrals`, `PATCH /api/network/contacts/${ID}`,
    ])
  })
})

describe('mid-save, and when a save is refused', () => {
  it('while saving: the button says so, and the fields, Cancel and close cannot be used', async () => {
    let finish: (v: any) => void = () => {}
    await mount({ sheet: FULL, patch: () => new Promise((res) => { finish = res }) })
    await click($('[data-edit="essentials"]')); await type('[data-field="phone"]', '720-555-0199')
    await act(async () => { ($('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await settle(1)
    expect($('[data-save]')!.textContent).toBe('Saving…')
    expect(($('[data-save]') as HTMLButtonElement).disabled).toBe(true)
    expect($('[data-save]')!.getAttribute('aria-busy')).toBe('true')
    expect(($('[data-cancel]') as HTMLButtonElement).disabled).toBe(true)
    expect(($('[data-close]') as HTMLButtonElement).disabled).toBe(true)
    expect($$('form input, form select').every((i) => (i as HTMLInputElement).disabled)).toBe(true)
    // Escape does nothing while the save is in flight: the form and the sheet both stay.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect($('form')).toBeTruthy()
    expect($('[data-save]')!.textContent).toBe('Saving…')
    await act(async () => { finish({ status: 200, json: { ...FULL, written: ['phone'], notes: [] } }) })
    await settle(3)
    expect($('form')).toBeNull()
  })
  it('a bad value: the reason is shown in plain words, the form stays, nothing is lost', async () => {
    await mount({ sheet: FULL, patch: () => ({ status: 422, json: { error: 'email_looks_wrong', field: 'email', written: [] } }) })
    await click($('[data-edit="essentials"]')); await type('[data-field="email"]', 'nope'); await submit()
    expect($('[data-save-error]')!.textContent).toBe('That email does not look right. It should read like name@example.com.')
    expect($('[data-field="email"]')!.getAttribute('aria-invalid')).toBe('true')
    expect(($('[data-field="email"]') as HTMLInputElement).value).toBe('nope')
  })
  it('changed by someone else: it says nothing was saved and reads the contact again', async () => {
    await mount({ sheet: FULL, patch: () => ({ status: 409, json: { error: 'changed_by_someone_else', field: 'phone', current: '(999) 000-0000', written: [] } }) })
    await click($('[data-edit="essentials"]')); await type('[data-field="phone"]', '720-555-0199'); await submit()
    expect($('[data-save-error]')!.textContent).toContain('Someone else changed this while you were editing. Nothing was saved.')
    expect(calls.filter((c) => c.method === 'GET' && c.url === `/api/network/contacts/${ID}`)).toHaveLength(2)
  })
  it('a half-picked birthday is caught before anything is sent', async () => {
    await mount()
    await click($('[data-add="birthday"]')); await type('[data-field="month"]', 'Mar'); await submit()
    expect($('[data-save-error]')!.textContent).toBe('Pick a month and a day that exists.')
    expect(patches()).toEqual([])
  })
})

describe('opening and closing', () => {
  it('closes by its own ✕', async () => {
    const { onClose } = await mount()
    await click($('[data-close]'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('a tap outside the sheet does not close it', async () => {
    const { onClose } = await mount()
    for (const ev of ['pointerdown', 'mousedown', 'click']) await act(async () => { $('[data-network-sheet]')!.dispatchEvent(new MouseEvent(ev, { bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
  })
  it('Escape leaves the form first, then closes the sheet', async () => {
    const { onClose } = await mount({ sheet: FULL })
    await click($('[data-edit="essentials"]'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect($('form')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('a refusal to open is said, not shown as an empty contact', async () => {
    await mount({ getStatus: 403 })
    expect($('[data-sheet-problem]')!.textContent).toContain('forbidden')
    expect($('[data-sheet-name]')).toBeNull()
  })
  it('is a dialog named for the contact', async () => {
    await mount()
    expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Contact details for Lisa Snyder')
    expect($('[role="dialog"]')!.getAttribute('aria-modal')).toBe('true')
  })
})

describe('the small helpers', () => {
  it('a website is shown without its scheme or trailing slash; the link and the form keep what is stored', async () => {
    await mount({ sheet: sheetOf({ website: 'https://www.shorepourfection.com/' }) })
    expect(value('website')).toBe('www.shorepourfection.com')
    expect(($('[data-value="website"] a') as HTMLAnchorElement).getAttribute('href')).toBe('https://www.shorepourfection.com/')
    await click($('[data-edit="essentials"]'))
    expect(($('[data-field="website"]') as HTMLInputElement).value).toBe('https://www.shorepourfection.com/')
    await submit()
    expect(patches()).toEqual([])
  })
  it('an address reads from either shape the table holds', () => {
    expect(addressLines({ street: '1 Main St', apt: 'Suite 4', city: 'Denver', state: 'CO', zip: '80202', value: 'ignored' })).toEqual(['1 Main St, Suite 4', 'Denver, CO 80202'])
    expect(addressLines({ type: 'Home', value: '9 Elm Rd' })).toEqual(['9 Elm Rd'])
    expect(addressLines(null)).toEqual([])
  })
  it('a date is shown as a date; text that is not a date is never printed', () => {
    expect(whenLabel('2026-08-24T15:00:00Z')).toBe('Aug 24, 2026')
    expect(whenLabel('2026-08-23T18:04:11.123+00:00')).toBe('Aug 23, 2026')
    expect(whenLabel('Just now')).toBe('')
    expect(whenLabel('Sep 14')).toBe('')
    expect(whenLabel(null)).toBe('')
  })
  it('"Added to Network" is dated by the day the contact was made, never by the stored "Just now"', () => {
    const c = { createdAt: '2026-08-24T15:00:00Z', notes: [], activity: [{ type: 'event', label: 'Added to Network - Chamber email', ts: 'Just now' }] }
    const h = historyOf(c, [])
    expect(h).toHaveLength(1)
    expect(whenLabel(h[0]!.at)).toBe('Aug 24, 2026')
  })
  it('any other event with no readable time is listed with no date, not a wrong one', () => {
    const h = historyOf({ createdAt: '2026-08-24T15:00:00Z', notes: [], activity: [{ type: 'event', label: 'Something else happened', ts: 'Just now' }] }, [])
    expect(h[0]!.at).toBeNull()
    expect(whenLabel(h[0]!.at)).toBe('')
  })
  it('initials come from words, not from an ampersand', () => {
    expect(initialsOf('Drew & Bill Crowley')).toBe('DB')
    expect(initialsOf('Lisa Snyder')).toBe('LS')
    expect(initialsOf('angie mouse')).toBe('AM')
    expect(initialsOf('Two Men and a Truck — Denver')).toBe('TM')
    expect(initialsOf('')).toBe('')
  })
  it('history with no readable dates keeps the order it was stored in', () => {
    const h = historyOf({ notes: [{ text: 'first', ts: 'a while ago' }, { text: 'second', ts: 'later' }], activity: [] } as never, [])
    expect(h.map((x) => x.text)).toEqual(['first', 'second'])
  })
})

describe('the look is the design, scoped to the sheet', () => {
  const src = readFileSync(join(process.cwd(), 'components/network/ContactSheet.jsx'), 'utf8')
  const css = src.slice(src.indexOf('const CSS = `') + 13, src.indexOf('`\n\nconst Svg ='))
  it('declares no colour of its own', () => {
    expect(css.match(/#[0-9A-Fa-f]{3,8}\b/g)).toBeNull()
  })
  it('and none anywhere else in the file either: no colour is written out by hand', () => {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code.match(/['"`]#[0-9A-Fa-f]{3,8}['"`;\s]/g)).toBeNull()
  })
  it('scopes every rule to the sheet', () => {
    const selectors = css.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('@') && l !== '}' && l.includes('{'))
    for (const s of selectors) expect(s.startsWith('[data-network-sheet]'), s.slice(0, 60)).toBe(true)
  })
  it('listens for no click, mousedown, pointerdown or touchstart on the page', () => {
    expect(src).not.toMatch(/addEventListener\(\s*['"](click|mousedown|pointerdown|touchstart)/)
  })
})
