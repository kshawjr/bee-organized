// lib/network/contact-adds.ts — what each slice 4b add may write.
//
// The rule from slice 4a, applied to three more things on the contact's own
// row: a save writes only what really differs, and refuses rather than
// guesses. These are the pure decisions; the route that carries them out is
// pinned in contact-route.test.ts, and the same route was run against a copy
// of production (see ~/Projects/bee-organized-repair-reports).
import { describe, it, expect } from 'vitest'
import {
  ADD_COLUMNS, ADD_ERROR_WORDS, ADDRESS_MAX, NOTE_MAX, TOUCH_METHODS, TOUCH_OUTCOMES,
  addressFromForm, addressToForm, blankAddress, composeAddress, followUpBody, normalizeAddresses,
  planContactAdds, stable, tagChanges, touchpointBody,
} from './contact-adds'
import { METHODS } from '@/components/hive/TouchpointModal'
import { OUTCOMES } from '@/components/hive/shared/touchOutcome'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CO2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const NOW = new Date('2026-11-15T16:00:00.000Z')
const FULL = { type: 'Business', value: '1 Main St Suite 4, Denver, CO, 80202', street: '1 Main St', apt: 'Suite 4', city: 'Denver', state: 'CO', zip: '80202' }
const LINE = { type: 'Office', value: '9 Elm Rd, Littleton' }
const row = (over: any = {}) => ({
  id: 'p1', location_id: LOC, company_id: null, addresses: [FULL, LINE],
  notes: [{ id: 'n1', text: 'First', ts: '2026-09-20T10:00:00Z', user: 'Kevin' }], ...over,
})
const ctx = (over: any = {}) => ({ author: 'Kevin', now: NOW, company: null, ...over })
const plan = (body: any, r: any = row(), c: any = ctx()) => planContactAdds(r, body, c)

describe('the columns', () => {
  it('are three, each one column on the contact, and nothing else', () => {
    expect(ADD_COLUMNS).toEqual({ addNote: 'notes', addresses: 'addresses', companyId: 'company_id' })
  })
  it('a request that names none of them writes nothing', () => {
    expect(plan({})).toEqual({ ok: true, update: {}, written: [], notes: [] })
    expect(plan({ type: 'vendor', partner_stage: 'Active Partner', changes: { name: { to: 'x' } } })).toEqual({ ok: true, update: {}, written: [], notes: [] })
  })
})

describe('a note', () => {
  it('is appended to the notes already stored, with the time and the author set here', () => {
    const p = plan({ addNote: { text: '  Prefers a text  ' } }) as any
    expect(p.written).toEqual(['notes'])
    expect(p.update.notes).toEqual([
      { id: 'n1', text: 'First', ts: '2026-09-20T10:00:00Z', user: 'Kevin' },
      { id: `n${NOW.getTime()}`, text: 'Prefers a text', ts: '2026-11-15T16:00:00.000Z', user: 'Kevin' },
    ])
  })
  it('keeps every stored note exactly, whatever shape it is', () => {
    const odd = [{ id: 'x', text: 'old', ts: 'Sep 14', user: 'You', extra: 1 }, 'a bare string']
    const p = plan({ addNote: { text: 'new' } }, row({ notes: odd })) as any
    expect(p.update.notes.slice(0, 2)).toEqual(odd)
    expect(p.update.notes).toHaveLength(3)
  })
  it('starts the list when there are no notes, or the column holds something that is not a list', () => {
    for (const notes of [null, undefined, [], 'junk', {}]) expect((plan({ addNote: { text: 'new' } }, row({ notes })) as any).update.notes).toHaveLength(1)
  })
  it('cannot carry its own time, author or id', () => {
    const p = plan({ addNote: { text: 'new', ts: '2020-01-01', user: 'Someone else', id: 'mine' } }) as any
    expect(p.update.notes[1]).toEqual({ id: `n${NOW.getTime()}`, text: 'new', ts: '2026-11-15T16:00:00.000Z', user: 'Kevin' })
  })
  it('with no known author is signed Bee Hub, never "You"', () => {
    expect((plan({ addNote: { text: 'new' } }, row(), ctx({ author: '' })) as any).update.notes[1].user).toBe('Bee Hub')
  })
  it.each([[{ text: '' }, 422], [{ text: '   ' }, 422], [{}, 422], [null, 400], ['words', 400], [['a'], 400]])('refuses %j', (addNote, status) => {
    expect(plan({ addNote })).toMatchObject({ ok: false, status, error: 'note_needs_text' })
  })
  it('refuses one that is too long', () => {
    expect(plan({ addNote: { text: 'x'.repeat(NOTE_MAX + 1) } })).toMatchObject({ ok: false, status: 422, error: 'note_too_long' })
    expect((plan({ addNote: { text: 'x'.repeat(NOTE_MAX) } }) as any).ok).toBe(true)
  })
})

describe('addresses', () => {
  it('sent back exactly as stored: nothing to write', () => {
    expect(plan({ addresses: { from: [FULL, LINE], to: [FULL, LINE] } })).toEqual({ ok: true, update: {}, written: [], notes: [] })
  })
  it('the same entries with their keys in another order are still the same', () => {
    const shuffled = { zip: '80202', state: 'CO', city: 'Denver', apt: 'Suite 4', street: '1 Main St', value: FULL.value, type: 'Business' }
    expect((plan({ addresses: { from: [shuffled, LINE], to: [shuffled, LINE] } }) as any).written).toEqual([])
  })
  it('one entry changed: that entry is rebuilt, the other is the stored one untouched', () => {
    const p = plan({ addresses: { from: [FULL, LINE], to: [{ type: 'Business', street: '2 Oak Ave', apt: '', city: 'Denver', state: 'CO', zip: '80203' }, LINE] } }) as any
    expect(p.written).toEqual(['addresses'])
    expect(p.update.addresses[0]).toEqual({ type: 'Business', value: '2 Oak Ave, Denver, CO, 80203', street: '2 Oak Ave', apt: '', city: 'Denver', state: 'CO', zip: '80203' })
    expect(p.update.addresses[1]).toBe(LINE)
  })
  it('the one-line value is built the way the add form builds it', () => {
    expect(composeAddress({ street: '1 Main St', apt: 'Suite 4', city: 'Denver', state: 'CO', zip: '80202' })).toBe('1 Main St Suite 4, Denver, CO, 80202')
    expect(composeAddress({ street: '', apt: '', city: 'Denver', state: '', zip: '' })).toBe('Denver')
  })
  it('an older one-line address stays a one-line address', () => {
    const p = plan({ addresses: { from: [FULL, LINE], to: [FULL, { type: 'Home', value: ' 12 Pine Ct ' }] } }) as any
    expect(p.update.addresses[1]).toEqual({ type: 'Home', value: '12 Pine Ct' })
  })
  it('a new address is added after the stored ones, which are not rewritten', () => {
    const p = plan({ addresses: { from: [FULL, LINE], to: [FULL, LINE, { type: 'Home', street: '5 Lake Dr', apt: '', city: 'Golden', state: 'CO', zip: '' }] } }) as any
    expect(p.update.addresses[0]).toBe(FULL)
    expect(p.update.addresses[1]).toBe(LINE)
    expect(p.update.addresses[2]).toEqual({ type: 'Home', value: '5 Lake Dr, Golden, CO', street: '5 Lake Dr', apt: '', city: 'Golden', state: 'CO', zip: '' })
  })
  it('an empty block is no address: adding one and typing nothing writes nothing', () => {
    expect((plan({ addresses: { from: [FULL, LINE], to: [FULL, LINE, { type: 'Business', street: '', apt: '', city: '', state: '', zip: '' }] } }) as any).written).toEqual([])
    expect((plan({ addresses: { from: [], to: [{ type: 'Business', value: '  ' }] } }, row({ addresses: [] })) as any).written).toEqual([])
  })
  it('removing one writes the list without it; removing all writes an empty list', () => {
    expect((plan({ addresses: { from: [FULL, LINE], to: [LINE] } }) as any).update.addresses).toEqual([LINE])
    expect((plan({ addresses: { from: [FULL, LINE], to: [] } }) as any).update.addresses).toEqual([])
  })
  it('a contact with no addresses column value starts from an empty list', () => {
    const p = plan({ addresses: { from: [], to: [{ type: 'Office', street: '1 A St', apt: '', city: '', state: '', zip: '' }] } }, row({ addresses: null })) as any
    expect(p.update.addresses).toEqual([{ type: 'Office', value: '1 A St', street: '1 A St', apt: '', city: '', state: '', zip: '' }])
  })
  it('changed by someone else since the form opened: refused, and told what is stored', () => {
    const p = plan({ addresses: { from: [FULL], to: [FULL, { type: 'Home', value: 'x' }] } })
    expect(p).toMatchObject({ ok: false, status: 409, error: 'changed_by_someone_else', field: 'addresses', current: [FULL, LINE] })
  })
  it.each([
    ['not a list', { a: 1 }, 'addresses_must_be_a_list'],
    ['an entry that is not an address', ['1 Main St'], 'address_unreadable'],
    ['a key no address has', [{ type: 'Home', value: 'x', partner_stage: 'Active Partner' }], 'address_unreadable'],
    ['a line that is too long', [{ type: 'Home', value: 'x'.repeat(201) }], 'address_too_long'],
    ['a full address with only a zip', [{ type: 'Home', street: '', apt: '', city: '', state: '', zip: '80202' }], 'address_needs_street_or_city'],
    ['more than five', Array.from({ length: ADDRESS_MAX + 1 }, (_, i) => ({ type: 'Home', value: `n${i}` })), 'too_many_addresses'],
  ])('refuses %s', (_n, to, error) => {
    expect(plan({ addresses: { from: [FULL, LINE], to } })).toMatchObject({ ok: false, status: 422, error, field: 'addresses' })
  })
  it('needs a "to"', () => {
    expect(plan({ addresses: [FULL] })).toMatchObject({ ok: false, status: 400, error: 'change_needs_to' })
    expect(plan({ addresses: null })).toMatchObject({ ok: false, status: 400 })
  })
  it('normalizeAddresses keeps a stored entry as the very same object', () => {
    const out = normalizeAddresses([FULL, LINE], [{ ...LINE }, { ...FULL }]) as any
    expect(out.value[0]).toBe(LINE)
    expect(out.value[1]).toBe(FULL)
  })
})

describe('the company link', () => {
  const company = (over: any = {}) => ({ id: CO, location_id: LOC, deleted_at: null, ...over })
  it('links to a company from the companies table at the same location', () => {
    expect(plan({ companyId: { from: null, to: CO } }, row(), ctx({ company: company() }))).toEqual({ ok: true, update: { company_id: CO }, written: ['company_id'], notes: [] })
  })
  it('unlinks with null or an empty box', () => {
    for (const to of [null, '', '  ']) expect((plan({ companyId: { from: CO, to } }, row({ company_id: CO })) as any).update).toEqual({ company_id: null })
  })
  it('the link it already has: nothing to write', () => {
    expect((plan({ companyId: { from: CO, to: CO } }, row({ company_id: CO }), ctx({ company: company() })) as any).written).toEqual([])
    expect((plan({ companyId: { from: null, to: null } }) as any).written).toEqual([])
  })
  it('never writes the company TEXT, and cannot be given a name to match', () => {
    const p = plan({ companyId: { from: null, to: 'Compass' } }, row({ company: 'Compass' }), ctx({ company: company() }))
    expect(p).toMatchObject({ ok: false, status: 422, error: 'company_not_found' })
    const ok = plan({ companyId: { from: null, to: CO } }, row({ company: 'Something else' }), ctx({ company: company() })) as any
    expect(Object.keys(ok.update)).toEqual(['company_id'])
  })
  it.each([
    ['no such company', null, 'company_not_found'],
    ['a deleted company', { id: CO, location_id: LOC, deleted_at: '2026-10-01T00:00:00Z' }, 'company_not_found'],
    ['a company looked up under a different id', { id: CO2, location_id: LOC, deleted_at: null }, 'company_not_found'],
    ["another location's company", { id: CO, location_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deleted_at: null }, 'company_other_location'],
  ])('refuses %s', (_n, co, error) => {
    expect(plan({ companyId: { from: null, to: CO } }, row(), ctx({ company: co }))).toMatchObject({ ok: false, status: 422, error, field: 'companyId' })
  })
  it('changed by someone else since the form opened: refused', () => {
    expect(plan({ companyId: { from: null, to: CO } }, row({ company_id: CO2 }), ctx({ company: company() }))).toMatchObject({ ok: false, status: 409, error: 'changed_by_someone_else', current: CO2 })
  })
})

describe('several at once', () => {
  it('writes each column that changed and no other', () => {
    const p = plan({ addNote: { text: 'new' }, addresses: { from: [FULL, LINE], to: [FULL, LINE] }, companyId: { from: null, to: CO } }, row(), ctx({ company: { id: CO, location_id: LOC, deleted_at: null } })) as any
    expect(p.written).toEqual(['notes', 'company_id'])
  })
  it('one refusal refuses the lot', () => {
    expect(plan({ addNote: { text: 'new' }, companyId: { from: null, to: CO } })).toMatchObject({ ok: false, error: 'company_not_found' })
  })
})

describe("the screen's half", () => {
  it('tags: only what changed is linked or unlinked', () => {
    expect(tagChanges(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({ add: ['d'], remove: ['a'] })
    expect(tagChanges(['a', 'b'], ['b', 'a'])).toEqual({ add: [], remove: [] })
    expect(tagChanges([], ['a', 'a'])).toEqual({ add: ['a'], remove: [] })
  })
  it('a touchpoint is posted exactly as the old record posted it', () => {
    expect(touchpointBody('p1', { method: 'call', status: 'reached', notes: ' Spring listings ' })).toEqual({ partner_id: 'p1', kind: 'reach_out', method: 'call', label: 'Reach-out', status: 'reached', notes: 'Spring listings' })
    expect(touchpointBody('p1', { method: 'in_person', status: null, notes: '' })).toEqual({ partner_id: 'p1', kind: 'reach_out', method: 'in_person', label: 'Reach-out', status: null, notes: null })
  })
  it("the touchpoint types and outcomes are Bee Hub's own, value for value", () => {
    expect(TOUCH_METHODS.map((m) => [m.value, m.label])).toEqual(METHODS.map((m: any) => [m.value, m.label]))
    expect(TOUCH_OUTCOMES).toEqual(OUTCOMES)
  })
  it('a follow-up is a reminder request: the contact, a day and a note, and nothing more', () => {
    expect(followUpBody('p1', { dueOn: '2026-11-20', note: ' Coffee ' })).toEqual({ ok: true, body: { partner_id: 'p1', due_on: '2026-11-20', note: 'Coffee' } })
  })
  it.each([
    [{ dueOn: '', note: 'x' }, 'follow_up_needs_a_date', 'dueOn'],
    [{ dueOn: '2026-02-30', note: 'x' }, 'follow_up_needs_a_date', 'dueOn'],
    [{ dueOn: '2026-11-20', note: '  ' }, 'follow_up_needs_a_note', 'note'],
    [{ dueOn: '2026-11-20', note: 'x'.repeat(501) }, 'follow_up_note_too_long', 'note'],
  ])('a follow-up %j is refused before anything is sent', (form, error, field) => {
    expect(followUpBody('p1', form)).toEqual({ ok: false, error, field })
  })
  it('an address nobody touched goes back as the stored object itself', () => {
    expect(addressFromForm(addressToForm(FULL))).toBe(FULL)
    expect(addressFromForm(addressToForm(LINE))).toBe(LINE)
  })
  it('an address that was edited goes back as its boxes', () => {
    expect(addressFromForm({ ...addressToForm(FULL), city: 'Golden' })).toEqual({ type: 'Business', street: '1 Main St', apt: 'Suite 4', city: 'Golden', state: 'CO', zip: '80202' })
    expect(addressFromForm({ ...addressToForm(LINE), value: '10 Elm Rd' })).toEqual({ type: 'Office', value: '10 Elm Rd' })
  })
  it('a new address block is a full address, empty', () => {
    expect(addressFromForm(blankAddress())).toEqual({ type: 'Business', street: '', apt: '', city: '', state: '', zip: '' })
    expect(blankAddress()).toMatchObject({ full: true, type: 'Business', street: '', city: '' })
  })
  it('stable() reads the same whatever the key order', () => {
    expect(stable({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stable({ a: [{ c: 3, d: 2 }], b: 1 }))
    expect(stable(undefined)).toBe('null')
  })
  it('every refusal has plain words', () => {
    for (const code of ['note_needs_text', 'note_too_long', 'address_needs_street_or_city', 'too_many_addresses', 'company_not_found', 'company_other_location', 'follow_up_needs_a_date', 'follow_up_needs_a_note']) {
      expect(ADD_ERROR_WORDS[code], code).toMatch(/^[A-Z].*\.$/)
    }
  })
})
