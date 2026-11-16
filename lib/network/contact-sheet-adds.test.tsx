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
  lookups?: any[]; createTag?: (body: any) => Answer
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
  if (url === '/api/lookups' && method === 'POST') return answer(o.createTag ? o.createTag(body) : { status: 200, json: { ok: true, lookup: { id: 'made', label: body.label, icon: body.icon || null, category: 'tags', location_id: body.location_id, is_active: true, sort_order: 9000, attrs: { group: body.group, shows_on: ['network'], section: 'trade' } } } })
  if (url.startsWith('/api/lookups')) return answer(o.lookupsStatus ? { status: o.lookupsStatus, json: {} } : { status: 200, json: { lookups: o.lookups || LOOKUPS, location: { id: LOC, name: 'Greensboro' } } })
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
const enter = async (sel: string) => { await act(async () => { $(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }); await settle(2) }
const submit = async (form: string) => { await act(async () => { ($(`[data-form="${form}"]`) as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle(4) }
const sent = () => calls.filter((c) => c.method !== 'GET')
// A tag's or a type's WORDS, without the emoji drawn in front of them.
const words = (el: Element) => Array.from(el.childNodes).filter((n) => !(n instanceof HTMLElement && (n.classList.contains('ns-emoji') || n.classList.contains('td-emoji')))).map((n) => n.textContent).join('')
const emoji = (el: Element) => el.querySelector('.ns-emoji, .td-emoji')?.textContent ?? null
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
    expect($$('[data-tag-section]').filter((s) => s.querySelector('[data-pick-tag]')).map((s) => [s.dataset.tagSection, s.querySelector('h3')!.firstChild!.textContent, Array.from(s.querySelectorAll('[data-pick-tag]')).map((b) => words(b))])).toEqual([
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
    expect($$('[data-pick-tag] .td-emoji')).toHaveLength(5)
    expect($$('[data-pick-tag] .td-emoji').every((e) => e.getAttribute('aria-hidden') === 'true')).toBe(true)
  })
  it('on the sheet, a tag shows its stored emoji, and a tag with none shows its stand-in', async () => {
    await mount({ sheet: sheetOf({}, { tags: [
      { id: 't1', label: 'Realtor', icon: '🏠', section: 'trade' }, { id: 'p', label: 'Partner', icon: null, section: 'relationship' },
      { id: 'n', label: 'Brand New Tag', icon: null, section: 'trade' },
    ] }) })
    expect($$('[data-tag]').map((t) => [emoji(t), words(t)])).toEqual([
      ['🏠', 'Realtor'], ['🧑‍🤝‍🧑', 'Partner'], ['🏷️', 'Brand New Tag'],
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

// ── Kevin's tag rulings, 2026-11-15: groups, and making a tag from the picker ──
const g = (id: string, label: string, group: string, shows: string[], over: any = {}) => ({ id, label, icon: null, location_id: null, sort_order: 0, is_active: true, attrs: { group, shows_on: shows, section: group === 'client_status' || group === 'relationship' ? 'relationship' : 'trade' }, ...over })
const GROUPED = [
  g('hot', 'Hot Lead', 'client_status', ['clients'], { sort_order: 1010 }), g('dnb', 'DO NOT BOOK', 'client_status', ['clients'], { sort_order: 1080 }),
  g('ref', 'Referral', 'relationship', ['clients', 'network'], { sort_order: 1030 }), g('ven', 'Vendor', 'relationship', ['network'], { sort_order: 3020 }),
  g('rea', 'Realtor', 'home_property', ['network']), g('gc', 'General Contractor', 'home_property', ['network']),
  g('des', 'Designer', 'design_staging', ['network']), g('cle', 'Cleaner', 'cleaning_care', ['network']), g('mov', 'Mover', 'moving_hauling', ['network']),
  g('sen', 'Senior Living', 'senior_living', ['network']), g('est', 'Estate Sale', 'valuables_specialty', ['network']),
  g('net', 'Networking Group', 'professional_services', ['network']), g('own', 'Garden Club', 'professional_services', ['network'], { location_id: LOC }),
]

describe('the Network sheet shows only the Network groups', () => {
  const open = async (o: Opts = {}) => { await mount({ lookups: GROUPED, ...o }); await click($('[data-edit="tags"]')) }
  const groups = () => $$('[data-tag-section]').map((s) => [s.querySelector('h3')!.firstChild!.textContent, Array.from(s.querySelectorAll('[data-pick-tag]')).map((b) => words(b))])
  it('Relationship, then the seven trade groups, in order, each A to Z', async () => {
    await open()
    expect(groups()).toEqual([
      ['Relationship', ['Referral', 'Vendor']], ['Home & Property', ['General Contractor', 'Realtor']], ['Design & Staging', ['Designer']], ['Cleaning', ['Cleaner']],
      ['Moving & Hauling', ['Mover']], ['Senior Living', ['Senior Living']], ['Valuables', ['Estate Sale']], ['Professional Services', ['Garden Club', 'Networking Group']],
    ])
  })
  it('no Client Status tag is offered on a Network contact', async () => {
    await open()
    const all = $$('[data-pick-tag]').map((b) => words(b))
    for (const never of ['Hot Lead', 'DO NOT BOOK']) expect(all).not.toContain(never)
    expect($('[data-tag-section="client_status"]')).toBeNull()
  })
  it("the location's own tag sits in its group, with no section of its own", async () => {
    await open()
    expect($('[data-tag-section="own"]')).toBeNull()
    expect($$('[data-tag-section="professional_services"] [data-pick-tag]').map((b) => words(b))).toContain('Garden Club')
  })
  it('a client-status tag this contact already carries is kept in view, ticked, so it can be taken off', async () => {
    await open({ sheet: sheetOf({ tagIds: ['hot'] }, { tags: [{ id: 'hot', label: 'Hot Lead', icon: null, section: 'relationship' }] }) })
    expect(groups().at(-1)).toEqual(['Also on this record', ['Hot Lead']])
    expect(pressed('[data-tag-section="elsewhere"] [data-pick-tag]')).toEqual(['Hot Lead'])
    await click($('[data-pick-tag="hot"]')); await submit('tags')
    expect(sent()).toEqual([{ url: `/api/partner-tags?partner_id=${ID}&tag_lookup_id=hot`, method: 'DELETE', body: null }])
  })
})

describe('the tag box (the design\'s picker)', () => {
  const open = async (o: Opts = {}) => { const m = await mount({ lookups: GROUPED, ...o }); await click($('[data-edit="tags"]')); return m }
  it('opens over the sheet as its own box, with search, the count of the location\'s own tags, and Done', async () => {
    await open()
    const box = $('[data-tag-dialog] [role="dialog"]')!
    expect(box.getAttribute('aria-modal')).toBe('true')
    expect($('#td-title')!.textContent).toBe('Tags')
    expect($('[data-field="tagSearch"]')!.getAttribute('placeholder')).toBe('Search tags or type a new one…')
    expect($('[data-new-tag]')).toBeNull() // nothing typed: nothing to create
    expect($('[data-tag-dialog]')!.textContent).not.toContain('Create a new tag')
    expect($('[data-own-count]')!.textContent).toBe('1 / 10 location tags')
    expect($('[data-picked-count]')!.textContent).toBe('0 selected')
    expect($('[data-form="tags"] [data-save]')!.textContent).toBe('Done')
    expect($('[data-clear-tags]')).toBeNull()
  })
  it('a group with no tags is still shown, saying so', async () => {
    await open({ lookups: GROUPED.filter((t) => t.id !== 'des') })
    expect($('[data-tag-section="design_staging"]')!.textContent).toBe('Design & StagingNo tags yet')
    expect($$('[data-tag-section]')).toHaveLength(8)
  })
  it('search narrows the list as you type, hides groups with no match, and says when nothing matches', async () => {
    await open()
    await type('[data-field="tagSearch"]', 'REAL')
    expect($$('[data-tag-section]').map((s) => s.dataset.tagSection)).toEqual(['home_property'])
    expect($$('[data-pick-tag]').map((b) => words(b))).toEqual(['Realtor'])
    expect($('[data-no-match]')).toBeNull()
    await type('[data-field="tagSearch"]', 'zzz')
    expect($$('[data-tag-section]')).toEqual([])
    expect($('[data-no-match]')!.textContent).toBe('No tags match.')
  })
  it('the same search bar offers to create what was typed, at the top of the list, unless a tag has exactly that name', async () => {
    await open()
    await type('[data-field="tagSearch"]', '   ')
    expect($('[data-new-tag]')).toBeNull() // spaces are not a name
    await type('[data-field="tagSearch"]', ' Real ')
    expect($('[data-new-tag]')!.textContent).toBe('Create “Real”')
    expect($('.td-list')!.firstElementChild).toBe($('[data-new-tag]')) // in the list, above the matches
    expect($$('[data-pick-tag]').map((b) => words(b))).toEqual(['Realtor']) // the near matches are still offered
    for (const same of ['Realtor', ' rEALTOR ']) {
      await type('[data-field="tagSearch"]', same)
      expect($('[data-new-tag]')).toBeNull()
    }
    await type('[data-field="tagSearch"]', 'zzz')
    expect($('[data-new-tag]')!.textContent).toBe('Create “zzz”')
  })
  it('Enter in the search bar opens the create screen for what was typed; with an exact match it does nothing', async () => {
    await open()
    await type('[data-field="tagSearch"]', 'Realtor'); await enter('[data-field="tagSearch"]')
    expect($('#td-title')!.textContent).toBe('Tags')
    await type('[data-field="tagSearch"]', 'Plumber'); await enter('[data-field="tagSearch"]')
    expect($('#td-title')!.textContent).toBe('Create a new tag')
    expect(($('[data-field="newTag"]') as HTMLInputElement).value).toBe('Plumber')
    expect(sent()).toEqual([])
  })
  it('the count of ticked tags follows the ticks, and Clear all unticks every one', async () => {
    await open({ sheet: sheetOf({ tagIds: ['rea', 'ven'] }, { tags: [{ id: 'rea', label: 'Realtor', section: 'trade' }, { id: 'ven', label: 'Vendor', section: 'relationship' }] }) })
    expect($('[data-picked-count]')!.textContent).toBe('2 selected')
    await click($('[data-pick-tag="mov"]'))
    expect($('[data-picked-count]')!.textContent).toBe('3 selected')
    await click($('[data-clear-tags]'))
    expect(pressed('[data-pick-tag]')).toEqual([])
    expect(sent()).toEqual([])
    await submit('tags')
    expect(sent().map((c) => c.method)).toEqual(['DELETE', 'DELETE'])
  })
  it('the ✕ leaves without saving anything', async () => {
    await open()
    await click($('[data-pick-tag="mov"]')); await click($('[data-tag-dialog] [data-cancel]'))
    expect($('[data-tag-dialog]')).toBeNull()
    expect(sent()).toEqual([])
  })
  it('a tap outside the box does not close it', async () => {
    await open()
    await click($('[data-tag-dialog]'))
    expect($('[data-tag-dialog] [role="dialog"]')).toBeTruthy()
  })
  it('the header shows three tags, then how many more, and names them all on hover', async () => {
    const six = ['Realtor', 'Vendor', 'Mover', 'Designer', 'Cleaner', 'Estate Sale'].map((label, i) => ({ id: `x${i}`, label, icon: null, section: 'trade' }))
    await mount({ sheet: sheetOf({}, { tags: six }) })
    expect($$('[data-sheet-tags] [data-tag]').map((t) => words(t))).toEqual(['Realtor', 'Vendor', 'Mover'])
    expect($('[data-more-tags]')!.textContent).toBe('+3 more')
    expect($('[data-edit="tags"]')!.getAttribute('title')).toBe('Realtor, Vendor, Mover, Designer, Cleaner, Estate Sale')
  })
  it('with three or fewer there is no "more"; with none it says Add tags', async () => {
    await mount()
    expect($('[data-no-tags]')!.textContent).toBe('Add tags')
    expect($('[data-more-tags]')).toBeNull()
  })
})

describe('making a tag from the Network picker', () => {
  const open = async (o: Opts = {}) => { const m = await mount({ lookups: GROUPED, ...o }); await click($('[data-edit="tags"]')); return m }
  // The only way in: type a name nobody has in the one search bar, then tap Create “name”.
  const begin = async (typed = 'Plumber') => { await type('[data-field="tagSearch"]', typed); await click($('[data-new-tag]')) }
  const off = () => ($('[data-create-tag]') as HTMLButtonElement).disabled
  // Pressing Create is the form's submit; a Create that is off is not pressed.
  const press = async () => { if (!off()) await submit('new-tag') }
  const create = async (name: string, group = 'home_property', emojiTyped = '') => {
    await begin(); await type('[data-field="newTag"]', name)
    if (group) await click($(`[data-group="${group}"]`))
    if (emojiTyped) await type('[data-field="newEmoji"]', emojiTyped)
    await press()
  }
  it('Create “name” opens a second screen, and Back returns with nothing made', async () => {
    await open()
    await begin()
    expect($('#td-title')!.textContent).toBe('Create a new tag')
    expect($('[data-form="tags"]')).toBeNull()
    expect($('[data-own-count]')!.textContent).toBe('1 / 10 location tags')
    expect(off()).toBe(true)
    await click($('[data-create-back]'))
    expect($('#td-title')!.textContent).toBe('Tags')
    expect(sent()).toEqual([])
  })
  it('what was typed in search becomes the new tag\'s name', async () => {
    await open()
    await begin(' Plumber ')
    expect(($('[data-field="newTag"]') as HTMLInputElement).value).toBe('Plumber')
    expect($$('[data-group][aria-checked="true"]')).toHaveLength(0) // the group is still asked for
  })
  it('asks which of the eight Network groups it goes in, each with its emoji, with none picked for them', async () => {
    await open(); await begin()
    expect($$('[data-group]').map((b) => b.textContent)).toEqual(['🤝Relationship', '🏡Home & Property', '🎨Design & Staging', '🧽Cleaning', '📦Moving & Hauling', '🌷Senior Living', '💎Valuables', '💼Professional Services'])
    expect($$('[data-group]').map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked')])).toEqual(Array(8).fill(['radio', 'false']))
  })
  it('Create stays off until there is a name AND a group', async () => {
    await open(); await begin()
    expect(off()).toBe(true) // a name (carried from search), no group
    await type('[data-field="newTag"]', '')
    await click($('[data-group="home_property"]'))
    expect(off()).toBe(true) // a group, no name
    await type('[data-field="newTag"]', '   ')
    expect(off()).toBe(true) // spaces are not a name
    await type('[data-field="newTag"]', 'Plumber')
    expect(off()).toBe(false)
    expect($$('[data-group]').filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.group)).toEqual(['home_property'])
  })
  it('Enter with no group picked makes nothing', async () => {
    await open(); await begin()
    await type('[data-field="newTag"]', 'Plumber')
    await submit('new-tag')
    expect(sent()).toEqual([])
    expect($('#td-title')!.textContent).toBe('Create a new tag')
  })
  it('if the server says a group is needed, it says so', async () => {
    await open({ createTag: () => ({ status: 400, json: { error: 'group_required' } }) })
    await create('Plumber')
    expect($('[data-save-error]')!.textContent).toBe('Pick which group this tag goes in.')
    expect($('[data-field="newGroup"]')!.getAttribute('aria-invalid')).toBe('true')
  })
  it("is sent to Bee Hub's own tag list, for the contact's location, made on Network, with its group's emoji when none is typed", async () => {
    await open()
    await create('  Plumber ')
    expect(sent()).toEqual([{ url: '/api/lookups', method: 'POST', body: { category: 'tags', label: 'Plumber', location_id: LOC, made_on: 'network', group: 'home_property', icon: '🏡' } }])
  })
  it('the emoji box keeps one emoji and drops everything else typed; that emoji is the one sent', async () => {
    await open(); await begin()
    expect($('[data-emoji-preview]')!.textContent).toBe('🏷️')
    await type('[data-field="newTag"]', 'Plumber'); await click($('[data-group="cleaning_care"]'))
    expect($('[data-emoji-preview]')!.textContent).toBe('🧽')
    await type('[data-field="newEmoji"]', 'ab🔧🪠 c')
    expect(($('[data-field="newEmoji"]') as HTMLInputElement).value).toBe('🔧')
    expect($('[data-emoji-preview]')!.textContent).toBe('🔧')
    await type('[data-field="newEmoji"]', 'wrench')
    expect(($('[data-field="newEmoji"]') as HTMLInputElement).value).toBe('')
    expect($('[data-emoji-preview]')!.textContent).toBe('🧽')
    await type('[data-field="newEmoji"]', '🔧')
    await press()
    expect(sent()[0].body).toMatchObject({ group: 'cleaning_care', icon: '🔧' })
  })
  it('an emoji can be chosen with a tap: six headings of emoji, one tap picks, a second tap unpicks', async () => {
    await open(); await begin()
    await click($('[data-group="cleaning_care"]'))
    expect($('[data-emoji-grid]')!.getAttribute('role')).toBe('radiogroup')
    expect($$('[data-emoji-grid] p').map((h) => h.textContent)).toEqual(['Popular', 'Home', 'Work & trades', 'People', 'Nature & places', 'Symbols'])
    expect($$('[data-emoji]')).toHaveLength(76)
    expect($$('[data-emoji][aria-checked="true"]')).toHaveLength(0) // none picked for them
    await click($('[data-emoji="🔧"]'))
    expect($$('[data-emoji][aria-checked="true"]').map((b) => b.dataset.emoji)).toEqual(['🔧'])
    expect($('[data-emoji-preview]')!.textContent).toBe('🔧')
    expect(($('[data-field="newEmoji"]') as HTMLInputElement).value).toBe('🔧')
    await click($('[data-emoji="🐝"]')) // another tap moves the choice
    expect($$('[data-emoji][aria-checked="true"]').map((b) => b.dataset.emoji)).toEqual(['🐝'])
    await click($('[data-emoji="🐝"]')) // the same one again: back to the group's own
    expect($$('[data-emoji][aria-checked="true"]')).toHaveLength(0)
    expect($('[data-emoji-preview]')!.textContent).toBe('🧽')
    expect(sent()).toEqual([]) // choosing an emoji saves nothing by itself
  })
  it('the tapped emoji is the one the tag is made with, and the one it shows in the list', async () => {
    await open(); await begin()
    await click($('[data-group="home_property"]')); await click($('[data-emoji="🔧"]'))
    await press()
    expect(sent()).toEqual([{ url: '/api/lookups', method: 'POST', body: { category: 'tags', label: 'Plumber', location_id: LOC, made_on: 'network', group: 'home_property', icon: '🔧' } }])
    expect($$('[data-pick-tag]').filter((b) => words(b) === 'Plumber').map((b) => emoji(b))).toEqual(['🔧'])
    expect($('[data-tag-note]')!.textContent).toBe('🔧 Plumber created and selected.')
  })
  it('typing an emoji replaces a tapped one, and a typed one that is in the grid lights up there', async () => {
    await open(); await begin()
    await click($('[data-emoji="🔧"]'))
    await type('[data-field="newEmoji"]', '🐝')
    expect($$('[data-emoji][aria-checked="true"]').map((b) => b.dataset.emoji)).toEqual(['🐝'])
    await type('[data-field="newEmoji"]', '🪠') // not in the grid: still allowed
    expect($$('[data-emoji][aria-checked="true"]')).toHaveLength(0)
    expect($('[data-emoji-preview]')!.textContent).toBe('🪠')
  })
  it('the new tag appears in its group with its emoji, ticked, and nothing is on the contact until Done', async () => {
    await open()
    await create('Plumber', 'senior_living')
    expect($('#td-title')!.textContent).toBe('Tags')
    expect($$('[data-tag-section="senior_living"] [data-pick-tag]').map((b) => [emoji(b), words(b)])).toEqual([['🌷', 'Plumber'], ['🏷️', 'Senior Living']])
    expect($$('[data-tag-section="professional_services"] [data-pick-tag]').map((b) => words(b))).toEqual(['Garden Club', 'Networking Group'])
    expect(pressed('[data-pick-tag]')).toEqual(['Plumber'])
    expect($('[data-tag-note]')!.textContent).toBe('🌷 Plumber created and selected.')
    expect($('[data-own-count]')!.textContent).toBe('2 / 10 location tags')
    expect($('[data-picked-count]')!.textContent).toBe('1 selected')
    expect(sent().filter((c) => c.url.startsWith('/api/partner-tags'))).toEqual([])
    expect(($('[data-field="tagSearch"]') as HTMLInputElement).value).toBe('') // the search is cleared, so the whole list is back
    expect($('[data-new-tag]')).toBeNull()
    // the next new tag starts clean: its own name, no group, no emoji
    await begin('Painter')
    expect([($('[data-field="newTag"]') as HTMLInputElement).value, ($('[data-field="newEmoji"]') as HTMLInputElement).value, $$('[data-group][aria-checked="true"]').length, $$('[data-emoji][aria-checked="true"]').length]).toEqual(['Painter', '', 0, 0])
    await click($('[data-create-back]'))
    await submit('tags')
    expect(sent().at(-1)).toEqual({ url: '/api/partner-tags', method: 'POST', body: { partner_id: ID, tag_lookup_id: 'made' } })
  })
  it('making the tag does not save the picker: it is still open', async () => {
    await open()
    await create('Plumber', 'cleaning_care')
    expect(sent().map((c) => c.url)).toEqual(['/api/lookups'])
    expect($('[data-form="tags"]')).toBeTruthy()
  })
  it('a name that is already in the list: it says so and Create stays off', async () => {
    await open(); await begin()
    await type('[data-field="newTag"]', ' realtor '); await click($('[data-group="home_property"]'))
    expect($('[data-tag-duplicate]')!.textContent).toBe('A tag with this name already exists.')
    expect(off()).toBe(true)
    await submit('new-tag')
    expect(sent()).toEqual([])
  })
  it('a location already at ten of its own: it says why, and Create “name” is off, by tap and by Enter', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => g(`o${i}`, `Own ${i}`, 'relationship', ['network'], { location_id: LOC }))
    await open({ lookups: [...GROUPED.filter((t) => t.id !== 'own'), ...ten] })
    const said = 'This location already has 10 tags of its own, and the limit is 10. Delete one you no longer use, or ask corporate to add this one to the main list.'
    expect($('[data-own-count]')!.textContent).toBe('10 / 10 location tags')
    expect($('[data-tag-limit]')!.textContent).toBe(said)
    await type('[data-field="tagSearch"]', 'Plumber')
    expect($('[data-new-tag]')!.textContent).toBe('Create “Plumber”')
    expect(($('[data-new-tag]') as HTMLButtonElement).disabled).toBe(true)
    expect($('[data-tag-limit]')!.textContent).toBe(said)
    await enter('[data-field="tagSearch"]')
    expect($('#td-title')!.textContent).toBe('Tags')
    expect($('[data-form="new-tag"]')).toBeNull()
    expect(sent()).toEqual([])
  })
  it('a switched-off own tag does not count toward the ten', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => g(`o${i}`, `Own ${i}`, 'relationship', ['network'], { location_id: LOC }))
    await open({ lookups: [...GROUPED.filter((t) => t.id !== 'own'), ...nine, g('off', 'Old One', 'relationship', ['network'], { location_id: LOC, is_active: false })] })
    expect($('[data-own-count]')!.textContent).toBe('9 / 10 location tags')
    expect($('[data-tag-limit]')).toBeNull()
    await type('[data-field="tagSearch"]', 'Plumber')
    expect(($('[data-new-tag]') as HTMLButtonElement).disabled).toBe(false)
  })
  it('if the server says the limit is reached: said in plain words, nothing made, nothing ticked', async () => {
    await open({ createTag: () => ({ status: 409, json: { error: 'tag_limit', limit: 10, count: 10 } }) })
    await create('Plumber')
    expect($('[data-save-error]')!.textContent).toBe('This location already has 10 tags of its own, and the limit is 10. Delete one you no longer use, or ask corporate to add this one to the main list.')
    expect($('[data-field="newTag"]')!.getAttribute('aria-invalid')).toBe('true')
    await click($('[data-create-back]'))
    expect($('[data-save-error]')).toBeNull()
    expect(pressed('[data-pick-tag]')).toEqual([])
    expect($$('[data-pick-tag]').map((b) => words(b))).not.toContain('Plumber')
  })
  it('a name that is nearly a tag here is ticked instead of made twice', async () => {
    await open({ createTag: () => ({ status: 409, json: { error: 'near_match', verdict: 'use', tag: { id: 'rea', label: 'Realtor' } } }) })
    await create('realtors')
    expect(pressed('[data-pick-tag]')).toEqual(['Realtor'])
    expect($('[data-tag-note]')!.textContent).toBe('“Realtor” is already a tag, so it is ticked for you.')
    expect($$('[data-pick-tag]').filter((b) => words(b) === 'Realtor')).toHaveLength(1)
  })
  it('a name that is a Clients tag is not pulled onto Network: it says so', async () => {
    await open({ createTag: () => ({ status: 409, json: { error: 'near_match', verdict: 'use', tag: { id: 'hot', label: 'Hot Lead' } } }) })
    await create('hot leads')
    expect($('[data-save-error]')!.textContent).toBe('“Hot Lead” is already a tag on another list, so it is not offered here.')
    await click($('[data-create-back]'))
    expect(pressed('[data-pick-tag]')).toEqual([])
  })
  it('if it cannot be made it says nothing was changed', async () => {
    await open({ createTag: () => ({ status: 500, json: { error: 'Failed to create lookup' } }) })
    await create('Plumber')
    expect($('[data-save-error]')!.textContent).toBe('That tag could not be created. Nothing was changed.')
    expect($('#td-title')!.textContent).toBe('Create a new tag')
  })
  it('there is no way to make a tag when the tag list could not be loaded', async () => {
    await mount({ lookupsStatus: 500 }); await click($('[data-edit="tags"]'))
    await type('[data-field="tagSearch"]', 'Plumber')
    expect($('[data-new-tag]')).toBeNull()
    await enter('[data-field="tagSearch"]')
    expect($('[data-form="new-tag"]')).toBeNull()
  })
})
