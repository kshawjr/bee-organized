// @vitest-environment happy-dom
//
// The contact sheet's ADD forms (slice 4b), mounted for real against a
// stand-in for every address the sheet talks to. This file pins what the
// screen SENDS for each add, and that it sends nothing it should not:
//
//   a touchpoint  → POST /api/touchpoints          (Bee Hub's own route)
//   a follow-up   → POST /api/reminders            (it IS a reminder)
//   tags          → POST / DELETE /api/partner-tags, one per tag that changed
//   a note        → PATCH the sheet's own route, { addNote }
//   addresses     → PATCH the sheet's own route, { addresses: { from, to } }
//   company link  → PATCH the sheet's own route, { companyId: { from, to } }
//
// What each of those routes then writes is pinned in contact-adds-route.test.ts
// (the sheet's own) and in the routes' own tests (lib/reminders-api.test.ts
// and others), and was run against a copy of production.
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ContactSheet from '@/components/network/ContactSheet'
import { RULED_NOT_SURE_IDS } from '@/lib/network/live-mapping'
import { quickDates } from '@/lib/reminders'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ID = '11111111-2222-4333-8444-555555555555'
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CO2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FULL_ADDR = { type: 'Business', value: '1 Main St, Denver, CO, 80202', street: '1 Main St', apt: '', city: 'Denver', state: 'CO', zip: '80202' }
const LINE_ADDR = { type: 'Office', value: '9 Elm Rd' }
const contact = (over: any = {}) => ({
  id: ID, locationId: LOC, locationName: 'Greensboro', name: 'Lisa Snyder', title: null, company: null, companyId: null, linkedCompany: null,
  phone: null, email: null, website: null, addresses: [], howWeMet: null, specialties: [], relationship: null, notes: [], nextSteps: [], activity: [],
  isCustomer: false, customerLeadId: null, networkTypes: ['unsure'], partnerLevel: null, partnerStage: null, birthday: null, birthdayReminder: false,
  lastContactedAt: null, createdAt: '2026-08-24T15:00:00Z', updatedAt: '2026-08-24T15:00:00Z', tagIds: [], ...over,
})
const sheetOf = (c: any = {}, rest: any = {}) => ({ contact: contact(c), tags: [], touchpoints: [], followUps: [], ...rest })

// Bee Hub's tag list as /api/lookups answers it: two corporate sections and
// one tag the location made itself. None of the design's sample names.
const LOOKUPS = [
  { id: 'r1', label: 'VIP', attrs: { section: 'relationship' }, location_id: null, sort_order: 2, is_active: true },
  { id: 'r2', label: 'Hot Lead', attrs: { section: 'relationship' }, location_id: null, sort_order: 1, is_active: true },
  { id: 't1', label: 'Realtor', attrs: { section: 'trade' }, location_id: null, sort_order: 9, is_active: true },
  { id: 't2', label: 'Mover', attrs: { section: 'trade' }, location_id: null, sort_order: 1, is_active: true },
  { id: 'o1', label: 'Garden Club', attrs: { section: 'relationship' }, location_id: LOC, sort_order: 0, is_active: true },
  { id: 'x1', label: 'Housekeeper', attrs: { section: 'trade' }, location_id: null, sort_order: 0, is_active: false },
]
// The partner touchpoint list as production holds it (lookups, category
// touchpoint_types, read 2026-11-15), in a jumbled order, plus one switched off.
const TOUCH_LOOKUPS = [
  { id: 'l5', category: 'touchpoint_types', label: 'Text', icon: '💬', sort_order: 50, is_active: true, attrs: { key: 'text' } },
  { id: 'l1', category: 'touchpoint_types', label: 'Coffee / Lunch', icon: '☕', sort_order: 10, is_active: true, attrs: { key: 'coffee' } },
  { id: 'l2', category: 'touchpoint_types', label: 'Phone Call', icon: '📞', sort_order: 20, is_active: true, attrs: { key: 'call' } },
  { id: 'l3', category: 'touchpoint_types', label: 'Email', icon: '📧', sort_order: 30, is_active: true, attrs: { key: 'email' } },
  { id: 'l4', category: 'touchpoint_types', label: 'Event / Show', icon: '🎪', sort_order: 40, is_active: true, attrs: { key: 'event' } },
  { id: 'l6', category: 'touchpoint_types', label: 'They Sent a Lead', icon: '🤝', sort_order: 60, is_active: true, attrs: { key: 'referral' } },
  { id: 'l7', category: 'touchpoint_types', label: 'Thank You Sent', icon: '🙏', sort_order: 70, is_active: true, attrs: { key: 'thankyou' } },
  { id: 'l8', category: 'touchpoint_types', label: 'Fax', icon: null, sort_order: 5, is_active: false, attrs: { key: 'fax' } },
]
const COMPANIES = [{ id: CO, name: 'Compass Greenwood Village' }, { id: CO2, name: 'Oak & Key Realty' }]

type Answer = { status: number; json: any }
type Opts = {
  sheet?: any; referral?: any
  touchpoint?: (body: any) => Answer | Promise<Answer>
  reminder?: (body: any) => Answer
  tag?: (method: string, tagId: string) => Answer
  patch?: (body: any) => Answer
  lookupsStatus?: number; companiesStatus?: number; touchTypesStatus?: number
}
let host: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[] = []
let current: any
const fakeFetch = (o: Opts) => vi.fn(async (url: string, init?: any) => {
  const method = init?.method || 'GET'
  const body = init?.body ? JSON.parse(init.body) : null
  calls.push({ url, method, body })
  const answer = (a: Answer) => ({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json })
  if (url.endsWith('/referrals')) return answer({ status: 200, json: o.referral || { total: 0, totals: { converted: 0, revenue: 0 } } })
  if (url.startsWith('/api/lookups') && url.includes('touchpoint_types')) return answer(o.touchTypesStatus ? { status: o.touchTypesStatus, json: {} } : { status: 200, json: { lookups: TOUCH_LOOKUPS, location: null } })
  if (url.startsWith('/api/lookups')) return answer(o.lookupsStatus ? { status: o.lookupsStatus, json: {} } : { status: 200, json: { lookups: LOOKUPS, location: { id: LOC, name: 'Greensboro' } } })
  if (url.startsWith('/api/companies')) return answer(o.companiesStatus ? { status: o.companiesStatus, json: {} } : { status: 200, json: { rows: COMPANIES, total: 2, truncated: false } })
  if (url === '/api/touchpoints') {
    const a = await (o.touchpoint ? o.touchpoint(body) : { status: 201, json: { touchpoint: { id: 'tp-new', occurred_at: '2026-11-15T16:00:00Z' } } })
    if (a.status === 201) current = { ...current, contact: { ...current.contact, lastContactedAt: '2026-11-15T16:00:00Z' }, touchpoints: [{ id: 'tp-new', kind: 'reach_out', method: body.method, label: body.label, status: body.status, notes: body.notes, occurred_at: '2026-11-15T16:00:00Z' }, ...current.touchpoints] }
    return answer(a)
  }
  if (url === '/api/reminders') {
    const a = o.reminder ? o.reminder(body) : { status: 201, json: { reminder: { id: 'rem-new', ...body } } }
    if (a.status === 201) current = { ...current, followUps: [...current.followUps, { id: 'rem-new', due_on: body.due_on, note: body.note }] }
    return answer(a)
  }
  if (url.startsWith('/api/partner-tags')) {
    const tagId = method === 'POST' ? body.tag_lookup_id : new URL(url, 'http://x').searchParams.get('tag_lookup_id')!
    const a = o.tag ? o.tag(method, tagId) : { status: method === 'POST' ? 201 : 200, json: {} }
    if (a.status < 300) {
      const def = LOOKUPS.find((l) => l.id === tagId)!
      current = { ...current, tags: method === 'POST' ? [...current.tags, { id: tagId, label: def.label, section: 'trade' }] : current.tags.filter((t: any) => t.id !== tagId) }
    }
    return answer(a)
  }
  if (method === 'PATCH') {
    const a = o.patch ? o.patch(body) : { status: 200, json: { ...current, written: ['x'], notes: [] } }
    if (a.status === 200) current = a.json
    return answer(a)
  }
  return answer({ status: 200, json: current })
})
const settle = async (k = 4) => { for (let i = 0; i < k; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
async function mount(o: Opts = {}) {
  calls = []; current = o.sheet || sheetOf()
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  const onClose = vi.fn(); const onSaved = vi.fn()
  await act(async () => { root.render(React.createElement(ContactSheet as any, { contactId: current.contact.id, onClose, onSaved, fetchImpl: fakeFetch(o) })) })
  await settle()
  calls = [] // what follows is what the person did
  return { onClose, onSaved }
}
afterEach(() => { try { act(() => root.unmount()) } catch {} host?.remove(); document.body.style.overflow = '' })

const $ = (sel: string) => host.querySelector(sel) as HTMLElement | null
const $$ = (sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[]
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle(2) }
const type = async (sel: string, value: string) => {
  const el = $(sel) as any
  if (!el) throw new Error(`no field ${sel}`)
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })
}
const submit = async (form: string) => { await act(async () => { ($(`[data-form="${form}"]`) as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle(4) }
const sent = () => calls.filter((c) => c.method !== 'GET')
// A tag's or a type's WORDS, without the emoji drawn in front of them.
const words = (el: Element) => Array.from(el.childNodes).filter((n) => !(n instanceof HTMLElement && n.classList.contains('ns-emoji'))).map((n) => n.textContent).join('')
const emoji = (el: Element) => el.querySelector('.ns-emoji')?.textContent ?? null
const pressed = (sel: string) => $$(sel).filter((b) => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true').map((b) => words(b))

describe('a touchpoint', () => {
  it("asks Bee Hub's settings for the PARTNER touchpoint list", async () => {
    await mount()
    await click($('[data-edit="touchpoint"]'))
    expect(calls.map((c) => c.url)).toEqual(['/api/lookups?category=touchpoint_types'])
  })
  it('offers the seven partner types, in order, each with its emoji, and nothing picked to start', async () => {
    await mount()
    await click($('[data-edit="touchpoint"]'))
    expect($$('[data-touch-type]').map((b) => [emoji(b), words(b)])).toEqual([
      ['☕', 'Coffee / Lunch'], ['📞', 'Phone Call'], ['📧', 'Email'], ['🎪', 'Event / Show'], ['💬', 'Text'], ['🤝', 'They Sent a Lead'], ['🙏', 'Thank You Sent'],
    ])
    expect(pressed('[data-touch-type]')).toEqual([])
  })
  it('offers none of the client call form: no Call / In person tiles, no Reached / No answer / Left voicemail', async () => {
    await mount()
    await click($('[data-edit="touchpoint"]'))
    const form = $('[data-form="touchpoint"]')!
    expect(form.querySelectorAll('[data-method], [data-outcome]')).toHaveLength(0)
    for (const word of ['Reached', 'No answer', 'Left voicemail', 'In person', 'How it went']) expect(form.textContent, word).not.toContain(word)
    expect($$('[data-touch-type]').map((b) => words(b))).not.toContain('Call')
  })
  it("is sent to Bee Hub's own touchpoints route, under the type's own words, with no outcome, and to nowhere else", async () => {
    const { onSaved } = await mount()
    await click($('[data-edit="touchpoint"]'))
    await click($('[data-touch-type="coffee"]')); await type('[data-field="touchNotes"]', ' Spring listings ')
    await submit('touchpoint')
    expect(sent()).toEqual([{ url: '/api/touchpoints', method: 'POST', body: { partner_id: ID, kind: 'reach_out', method: 'coffee', label: 'Coffee / Lunch', status: null, notes: 'Spring listings' } }])
    expect($('[data-form="touchpoint"]')).toBeNull()
    expect($('[data-card="log"] [data-saved]')!.textContent).toBe('Touchpoint logged')
    expect($('[data-log-line]')!.textContent).toBe('Last in touch Nov 15, 2026. Everything logged is under History (1).')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['call', 'call', 'Phone Call'], ['email', 'email', 'Email'], ['event', 'event', 'Event / Show'], ['text', 'sms', 'Text'], ['thankyou', 'thank_you', 'Thank You Sent'],
  ])('%s is stored as method %s, label "%s"', async (key, method, label) => {
    await mount()
    await click($('[data-edit="touchpoint"]')); await click($(`[data-touch-type="${key}"]`)); await submit('touchpoint')
    expect(sent()[0]!.body).toEqual({ partner_id: ID, kind: 'reach_out', method, label, status: null, notes: null })
  })
  it('"They Sent a Lead" has no method word of its own: it is stored by its label', async () => {
    await mount()
    await click($('[data-edit="touchpoint"]')); await click($('[data-touch-type="referral"]')); await submit('touchpoint')
    expect(sent()[0]!.body).toEqual({ partner_id: ID, kind: 'reach_out', method: null, label: 'They Sent a Lead', status: null, notes: null })
  })
  it('the one just logged reads by its own name under History', async () => {
    await mount()
    await click($('[data-edit="touchpoint"]')); await click($('[data-touch-type="event"]')); await type('[data-field="touchNotes"]', 'Home show'); await submit('touchpoint')
    await click($('[data-tab="history"]'))
    expect($('[data-history]')!.textContent).toBe('Event / Show — Home showNov 15, 2026')
  })
  it('nothing picked: stopped on the screen, nothing sent', async () => {
    await mount()
    await click($('[data-edit="touchpoint"]')); await type('[data-field="touchNotes"]', 'Keep me')
    await submit('touchpoint')
    expect(sent()).toEqual([])
    expect($('[data-save-error]')!.textContent).toBe('Pick what kind of touchpoint it was.')
    expect(($('[data-field="touchNotes"]') as HTMLTextAreaElement).value).toBe('Keep me')
  })
  it('if the list cannot be loaded it says so, offers no types of its own, and Log is off', async () => {
    await mount({ touchTypesStatus: 500 })
    await click($('[data-edit="touchpoint"]'))
    expect($('[data-touch-problem]')!.textContent).toBe('The touchpoint list could not be loaded. Nothing has been changed.')
    expect($$('[data-touch-type]')).toEqual([])
    expect(($('[data-form="touchpoint"] [data-save]') as HTMLButtonElement).disabled).toBe(true)
  })
  it('a refusal is said in plain words; the form and what was typed stay', async () => {
    const { onSaved } = await mount({ touchpoint: () => ({ status: 403, json: { error: 'forbidden_read_only_location' } }) })
    await click($('[data-edit="touchpoint"]')); await click($('[data-touch-type="call"]')); await type('[data-field="touchNotes"]', 'Keep me')
    await submit('touchpoint')
    expect($('[data-save-error]')!.textContent).toBe('This location is paused, so nothing can be changed.')
    expect(($('[data-field="touchNotes"]') as HTMLTextAreaElement).value).toBe('Keep me')
    expect(onSaved).not.toHaveBeenCalled()
  })
  it('while it is being logged: the button says so and nothing can be pressed', async () => {
    let finish: (a: Answer) => void = () => {}
    await mount({ touchpoint: () => new Promise<Answer>((res) => { finish = res }) })
    await click($('[data-edit="touchpoint"]')); await click($('[data-touch-type="call"]'))
    await act(async () => { ($('[data-form="touchpoint"]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await settle(1)
    expect($('[data-save]')!.textContent).toBe('Logging…')
    expect($$('[data-touch-type]')).toHaveLength(7)
    expect($$('[data-touch-type], [data-cancel], [data-close], [data-save]').every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    expect(($('[data-field="touchNotes"]') as HTMLTextAreaElement).disabled).toBe(true)
    // A second press while it is in flight sends nothing more.
    await act(async () => { ($('[data-form="touchpoint"]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(sent()).toHaveLength(1)
    // And nothing else on the sheet opens while it is in flight.
    for (const other of ['followUp', 'tags', 'identity', 'essentials']) await click($(`[data-edit="${other}"]`))
    expect($$('form').map((f) => f.dataset.form)).toEqual(['touchpoint'])
    await act(async () => { finish({ status: 201, json: { touchpoint: { id: 'tp-new' } } }) })
    await settle(4)
    expect($('[data-form="touchpoint"]')).toBeNull()
  })
})

describe('a note', () => {
  it("is sent to the sheet's own save as the text alone: no time, no author, no list of notes", async () => {
    const withNote = sheetOf({ notes: [{ id: 'n1', text: 'First', ts: '2026-09-20T10:00:00Z', user: 'Kevin' }] })
    await mount({ sheet: withNote })
    await click($('[data-edit="note"]')); await type('[data-field="note"]', 'Prefers a text')
    await submit('note')
    expect(sent()).toEqual([{ url: `/api/network/contacts/${ID}`, method: 'PATCH', body: { addNote: { text: 'Prefers a text' } } }])
    expect($('[data-card="log"] [data-saved]')!.textContent).toBe('Note added')
  })
  it('an empty note is stopped on the screen and nothing is sent', async () => {
    await mount()
    await click($('[data-edit="note"]')); await type('[data-field="note"]', '   ')
    await submit('note')
    expect(sent()).toEqual([])
    expect($('[data-save-error]')!.textContent).toBe('Write the note first.')
    expect($('[data-field="note"]')!.getAttribute('aria-invalid')).toBe('true')
  })
  it('the new note is under History once saved', async () => {
    await mount({ patch: () => ({ status: 200, json: { ...sheetOf({ notes: [{ id: 'n9', text: 'Prefers a text', ts: '2026-11-15T16:00:00Z', user: 'Kevin' }] }), written: ['notes'], notes: [] } }) })
    await click($('[data-edit="note"]')); await type('[data-field="note"]', 'Prefers a text'); await submit('note')
    await click($('[data-tab="history"]'))
    expect($('[data-history]')!.textContent).toBe('Prefers a textNov 15, 2026 · Kevin')
  })
})

describe('a follow-up is a reminder', () => {
  it("is sent to Bee Hub's own reminders route: the contact, the day and the note, and nothing else", async () => {
    const { onSaved } = await mount()
    await click($('[data-edit="followUp"]'))
    await type('[data-field="dueOn"]', '2026-11-20'); await type('[data-field="followNote"]', ' Coffee about spring ')
    await submit('followUp')
    expect(sent()).toEqual([{ url: '/api/reminders', method: 'POST', body: { partner_id: ID, due_on: '2026-11-20', note: 'Coffee about spring' } }])
    expect($('[data-follow-ups]')!.textContent).toBe('Coffee about springFri, Nov 20')
    expect($('[data-card="follow-ups"] [data-saved]')!.textContent).toBe('Follow-up set. It is on your Reminders page too.')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
  it('the follow-ups already set stay on top, and the form opens under them', async () => {
    await mount({ sheet: sheetOf({}, { followUps: [{ id: 'r1', due_on: '2026-11-20', note: 'Coffee' }] }) })
    await click($('[data-edit="followUp"]'))
    const card = $('[data-card="follow-ups"]')!
    const list = card.querySelector('[data-follow-ups]')!; const form = card.querySelector('[data-form="followUp"]')!
    expect(list.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('the form says, before saving, that it is one of your reminders', async () => {
    await mount()
    await click($('[data-edit="followUp"]'))
    expect($('[data-form="followUp"]')!.textContent).toContain('This is one of your reminders. It shows on your Reminders page, and on Home on its day.')
  })
  it('Tomorrow and Next week fill in the day, by the same rule the Reminders page uses', async () => {
    await mount()
    await click($('[data-edit="followUp"]'))
    await click($('[data-quick="tomorrow"]'))
    expect(($('[data-field="dueOn"]') as HTMLInputElement).value).toBe(quickDates().tomorrow)
    await click($('[data-quick="nextWeek"]'))
    expect(($('[data-field="dueOn"]') as HTMLInputElement).value).toBe(quickDates().nextWeek)
    expect(pressed('[data-quick]')).toEqual(['Next week'])
  })
  it.each([
    ['no day', '', 'Coffee', 'Pick the day to follow up.', '[data-field="dueOn"]'],
    ['no note', '2026-11-20', '  ', 'Say what the follow-up is about.', '[data-field="followNote"]'],
  ])('%s: stopped on the screen, nothing sent', async (_n, day, note, words, field) => {
    await mount()
    await click($('[data-edit="followUp"]'))
    if (day) await type('[data-field="dueOn"]', day)
    await type('[data-field="followNote"]', note)
    await submit('followUp')
    expect(sent()).toEqual([])
    expect($('[data-save-error]')!.textContent).toBe(words)
    expect($(field)!.getAttribute('aria-invalid')).toBe('true')
  })
  it('never writes to the contact itself', async () => {
    await mount()
    await click($('[data-edit="followUp"]')); await type('[data-field="dueOn"]', '2026-11-20'); await type('[data-field="followNote"]', 'Coffee'); await submit('followUp')
    expect(sent().filter((c) => c.url.includes('/api/network/') || c.url.includes('/api/partners'))).toEqual([])
  })
})

describe("tags are picked from Bee Hub's own list", () => {
  const TAGGED = sheetOf({ tagIds: ['t1', 'r1'] }, { tags: [{ id: 't1', label: 'Realtor', section: 'trade' }, { id: 'r1', label: 'VIP', section: 'relationship' }] })
  it("asks for the tag list of the contact's own location", async () => {
    await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]'))
    expect(calls.map((c) => c.url)).toEqual([`/api/lookups?category=tags&location_id=${LOC}`])
  })
  it('shows it in its sections, Relationship then Trade then the location\'s own, in Bee Hub\'s order', async () => {
    await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]'))
    expect($$('[data-tag-section]').map((s) => [s.dataset.tagSection, s.querySelector('.ns-sub')!.firstChild!.textContent, Array.from(s.querySelectorAll('[data-pick-tag]')).map((b) => words(b))])).toEqual([
      ['relationship', 'Relationship', ['Hot Lead', 'VIP']],
      ['trade', 'Trade', ['Mover', 'Realtor']],
      ['own', 'Greensboro’s own', ['Garden Club']],
    ])
  })
  it('never offers a switched-off tag, or any name that is not in the list', async () => {
    await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]'))
    const offered = $$('[data-pick-tag]').map((b) => words(b))
    expect(offered).not.toContain('Housekeeper')
    expect(offered.sort()).toEqual(LOOKUPS.filter((l) => l.is_active).map((l) => l.label).sort())
  })
  it('every tag in the picker shows its emoji: the stored one, or the stand-in where it has none', async () => {
    await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]'))
    // LOOKUPS above carry no emoji at all, so every one of these is a stand-in or the plain mark…
    expect($$('[data-pick-tag]').map((b) => emoji(b))).toEqual(['🏷️', '🏷️', '🏷️', '🏷️', '🏷️'])
    expect($$('[data-pick-tag] .ns-emoji').every((e) => e.getAttribute('aria-hidden') === 'true')).toBe(true)
  })
  it('on the sheet, a tag shows its stored emoji, and a tag with none shows its stand-in', async () => {
    await mount({ sheet: sheetOf({}, { tags: [
      { id: 't1', label: 'Realtor', icon: '🏠', section: 'trade' }, { id: 'p', label: 'Partner', icon: null, section: 'relationship' },
      { id: 'l', label: 'Lead', icon: null, section: 'location' }, { id: 'b', label: 'Business Networking Group', icon: null, section: 'location' },
      { id: 'o', label: 'Oak & Key', icon: null, section: 'location' }, { id: 'n', label: 'Brand New Tag', icon: null, section: 'trade' },
    ] }) })
    expect($$('[data-tag]').map((t) => [emoji(t), words(t)])).toEqual([
      ['🏠', 'Realtor'], ['🧑‍🤝‍🧑', 'Partner'], ['🌱', 'Lead'], ['🤝', 'Business Networking Group'], ['🔑', 'Oak & Key'], ['🏷️', 'Brand New Tag'],
    ])
  })
  it('the tags the contact has are the ones ticked', async () => {
    await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]'))
    expect(pressed('[data-pick-tag]').sort()).toEqual(['Realtor', 'VIP'])
  })
  it('one added and one removed: one link made, one link removed, and no other request', async () => {
    const { onSaved } = await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]'))
    await click($('[data-pick-tag="t2"]')); await click($('[data-pick-tag="r1"]'))
    await submit('tags')
    expect(sent()).toEqual([
      { url: '/api/partner-tags', method: 'POST', body: { partner_id: ID, tag_lookup_id: 't2' } },
      { url: `/api/partner-tags?partner_id=${ID}&tag_lookup_id=r1`, method: 'DELETE', body: null },
    ])
    expect($$('[data-tag]').map((t) => words(t)).sort()).toEqual(['Mover', 'Realtor'])
    expect($('[data-sheet-tags] [data-saved]')!.textContent).toBe('Tags saved')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
  it('ticking a tag and unticking it again changes nothing: nothing is sent', async () => {
    const { onSaved } = await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]'))
    await click($('[data-pick-tag="t2"]')); await click($('[data-pick-tag="t2"]'))
    await submit('tags')
    expect(sent()).toEqual([])
    expect($('[data-sheet-tags] [data-saved]')!.textContent).toBe('Nothing changed')
    expect(onSaved).not.toHaveBeenCalled()
  })
  it('a tag that could not be saved is said, and the picker shows what IS saved', async () => {
    await mount({ sheet: TAGGED, tag: (method, id) => (id === 't2' ? { status: 403, json: { error: 'tag_lookup_wrong_location' } } : { status: 200, json: {} }) })
    await click($('[data-edit="tags"]'))
    await click($('[data-pick-tag="t2"]')); await click($('[data-pick-tag="r1"]'))
    await submit('tags')
    expect($('[data-save-error]')!.textContent).toBe('1 of 2 tag changes could not be saved. What is ticked above is what is saved now.')
    expect(pressed('[data-pick-tag]')).toEqual(['Realtor'])
  })
  it('if the list cannot be loaded it says so, and Save is off', async () => {
    await mount({ sheet: TAGGED, lookupsStatus: 500 })
    await click($('[data-edit="tags"]'))
    expect($('[data-tags-problem]')!.textContent).toBe('The tag list could not be loaded. Nothing has been changed.')
    expect(($('[data-form="tags"] [data-save]') as HTMLButtonElement).disabled).toBe(true)
    expect($$('[data-pick-tag]')).toEqual([])
  })
  it('never writes to the contact itself', async () => {
    await mount({ sheet: TAGGED })
    await click($('[data-edit="tags"]')); await click($('[data-pick-tag="t2"]')); await submit('tags')
    expect(sent().filter((c) => c.url.includes('/api/network/') || c.url.startsWith('/api/partners'))).toEqual([])
  })
})

describe('addresses', () => {
  const WITH = sheetOf({ addresses: [FULL_ADDR, LINE_ADDR] })
  it('with no address there is no Address card, only a quiet way in; it opens one empty address', async () => {
    await mount()
    expect($('[data-card="addresses"]')).toBeNull()
    await click($('[data-add="addresses"]'))
    expect($$('[data-address-block]')).toHaveLength(1)
    expect($$('[data-address-block] input').map((i) => (i as HTMLInputElement).value)).toEqual(['', '', '', '', ''])
  })
  it('a first address: the list it was (empty) and the one typed', async () => {
    await mount()
    await click($('[data-add="addresses"]'))
    await type('[data-field="street-0"]', '5 Lake Dr'); await type('[data-field="city-0"]', 'Golden'); await type('[data-field="type-0"]', 'Home')
    await submit('addresses')
    expect(sent()).toEqual([{ url: `/api/network/contacts/${ID}`, method: 'PATCH', body: { addresses: { from: [], to: [{ type: 'Home', street: '5 Lake Dr', apt: '', city: 'Golden', state: '', zip: '' }] } } }])
  })
  it('opening the form and saving it untouched sends nothing', async () => {
    await mount({ sheet: WITH })
    await click($('[data-edit="addresses"]'))
    await submit('addresses')
    expect(sent()).toEqual([])
    expect($('[data-card="addresses"] [data-saved]')!.textContent).toBe('Nothing changed')
  })
  it('one address edited: the other is sent back exactly as it was stored', async () => {
    await mount({ sheet: WITH })
    await click($('[data-edit="addresses"]'))
    await type('[data-field="city-0"]', 'Golden')
    await submit('addresses')
    expect(sent()).toHaveLength(1)
    const { from, to } = sent()[0]!.body.addresses
    expect(from).toEqual([FULL_ADDR, LINE_ADDR])
    expect(to[0]).toEqual({ type: 'Business', street: '1 Main St', apt: '', city: 'Golden', state: 'CO', zip: '80202' })
    expect(to[1]).toEqual(LINE_ADDR)
    expect(Object.keys(sent()[0]!.body)).toEqual(['addresses'])
  })
  it('an older one-line address is edited as one line, not split into boxes', async () => {
    await mount({ sheet: WITH })
    await click($('[data-edit="addresses"]'))
    expect($('[data-field="value-1"]')).toBeTruthy()
    expect($('[data-field="street-1"]')).toBeNull()
    await type('[data-field="value-1"]', '10 Elm Rd')
    await submit('addresses')
    expect(sent()[0]!.body.addresses.to).toEqual([FULL_ADDR, { type: 'Office', value: '10 Elm Rd' }])
  })
  it('Remove takes one out; with none left the form says saving will remove the address', async () => {
    await mount({ sheet: WITH })
    await click($('[data-edit="addresses"]'))
    await click($('[data-remove-address="1"]'))
    expect($$('[data-address-block]')).toHaveLength(1)
    await click($('[data-remove-address="0"]'))
    expect($('[data-no-address]')!.textContent).toBe('No address. Saving now removes the address from this contact.')
    expect($('[data-add-address]')!.textContent).toBe('+ add an address')
    await submit('addresses')
    expect(sent()[0]!.body).toEqual({ addresses: { from: [FULL_ADDR, LINE_ADDR], to: [] } })
  })
  it('up to five addresses: the add button goes at five', async () => {
    await mount({ sheet: WITH })
    await click($('[data-edit="addresses"]'))
    for (let i = 0; i < 3; i++) await click($('[data-add-address]'))
    expect($$('[data-address-block]')).toHaveLength(5)
    expect($('[data-add-address]')).toBeNull()
  })
  it('changed by someone else: said, nothing saved, and the sheet reads the contact again', async () => {
    await mount({ sheet: WITH, patch: () => ({ status: 409, json: { error: 'changed_by_someone_else', field: 'addresses', written: [] } }) })
    await click($('[data-edit="addresses"]')); await type('[data-field="city-0"]', 'Golden'); await submit('addresses')
    expect($('[data-save-error]')!.textContent).toContain('Someone else changed this while you were editing. Nothing was saved.')
    expect(calls.filter((c) => c.method === 'GET' && c.url === `/api/network/contacts/${ID}`)).toHaveLength(1)
  })
})

describe('the company link', () => {
  const LINKED = sheetOf({ title: 'Agent', company: 'Compass', companyId: CO, linkedCompany: { id: CO, name: 'Compass Greenwood Village' } })
  it("is picked from the Companies list at the contact's own location", async () => {
    await mount({ sheet: LINKED })
    await click($('[data-edit="identity"]'))
    expect(calls.map((c) => c.url)).toEqual([`/api/companies?location_id=${LOC}`])
    expect(Array.from(($('[data-field="companyId"]') as HTMLSelectElement).options).map((o) => [o.value, o.textContent])).toEqual([['', 'No linked company'], [CO, 'Compass Greenwood Village'], [CO2, 'Oak & Key Realty']])
    expect(($('[data-field="companyId"]') as HTMLSelectElement).value).toBe(CO)
    expect($('[data-company-hint]')!.textContent).toBe('Picked from your Companies list. It does not change the company text above.')
  })
  it('changing only the link sends only the link: no name, no title, no company text', async () => {
    await mount({ sheet: LINKED })
    await click($('[data-edit="identity"]')); await type('[data-field="companyId"]', CO2)
    await submit('identity')
    expect(sent()).toEqual([{ url: `/api/network/contacts/${ID}`, method: 'PATCH', body: { companyId: { from: CO, to: CO2 } } }])
  })
  it('unlinking sends null', async () => {
    await mount({ sheet: LINKED })
    await click($('[data-edit="identity"]')); await type('[data-field="companyId"]', '')
    await submit('identity')
    expect(sent()[0]!.body).toEqual({ companyId: { from: CO, to: null } })
  })
  it('a title and the link changed together go as one save, each named', async () => {
    await mount({ sheet: LINKED })
    await click($('[data-edit="identity"]')); await type('[data-field="title"]', 'Broker'); await type('[data-field="companyId"]', CO2)
    await submit('identity')
    expect(sent()).toHaveLength(1)
    expect(sent()[0]!.body).toEqual({ changes: { title: { from: 'Agent', to: 'Broker' } }, companyId: { from: CO, to: CO2 } })
  })
  it('typing a company name in the company text never moves the link', async () => {
    await mount({ sheet: LINKED })
    await click($('[data-edit="identity"]')); await type('[data-field="company"]', 'Oak & Key Realty')
    await submit('identity')
    expect(sent()[0]!.body).toEqual({ changes: { company: { from: 'Compass', to: 'Oak & Key Realty' } } })
  })
  it('if the Companies list cannot be loaded the link is locked and left as it is', async () => {
    await mount({ sheet: LINKED, companiesStatus: 500 })
    await click($('[data-edit="identity"]'))
    expect(($('[data-field="companyId"]') as HTMLSelectElement).disabled).toBe(true)
    expect(($('[data-field="companyId"]') as HTMLSelectElement).value).toBe(CO)
    expect($('[data-company-hint]')!.textContent).toBe('Your Companies list could not be loaded, so the link is left as it is.')
    await type('[data-field="title"]', 'Broker'); await submit('identity')
    expect(sent()[0]!.body).toEqual({ changes: { title: { from: 'Agent', to: 'Broker' } } })
  })
})

describe('one form at a time, and the way out', () => {
  it('opening one add form closes the one before it', async () => {
    await mount()
    await click($('[data-edit="followUp"]'))
    await click($('[data-edit="note"]'))
    expect($$('form').map((f) => f.dataset.form)).toEqual(['note'])
  })
  it('Escape leaves an add form first, then closes the sheet', async () => {
    const { onClose } = await mount()
    await click($('[data-edit="touchpoint"]'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect($('form')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('Cancel sends nothing', async () => {
    await mount()
    for (const which of ['touchpoint', 'note', 'followUp', 'tags']) { await click($(`[data-edit="${which}"]`)); await click($('[data-cancel]')) }
    expect(sent()).toEqual([])
  })
})

describe('the referral badge and the four ruled contacts', () => {
  const REFERRED = { total: 1, totals: { converted: 0, revenue: 0 } }
  it.each([...RULED_NOT_SURE_IDS])('%s shows no referral badge although a lead points at it', async (id) => {
    await mount({ sheet: sheetOf({ id }), referral: REFERRED })
    expect($('[data-sheet-name]')!.textContent).toBe('Lisa Snyder')
    expect($('[data-referral-badge]')).toBeNull()
  })
  it('any other contact with a referral still shows it', async () => {
    await mount({ referral: REFERRED })
    expect($('[data-referral-badge]')!.textContent).toContain('1 referral')
  })
})
