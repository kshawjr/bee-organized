import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EDITABLE_FIELDS, EDITABLE_FIELD_NAMES, WRITABLE_COLUMNS, changesBetween, normalizeBirthday, normalizeField,
  planContactSave, saveErrorWords,
} from './contact-edit'

// A stored row, by column name, as the route reads it.
const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1', location_id: 'loc', deleted_at: null,
  name: 'Lisa Snyder', title: 'Realtor', company: 'Compass', phone: '(303) 555-0142', email: 'lisa@compass.com',
  website: 'compass.com', how_we_met: 'Chamber breakfast', birthday: null, birthday_reminder: false, ...over,
})
const save = (changes: unknown, r = row()) => planContactSave(r, changes)
const written = (changes: unknown, r = row()) => { const p = save(changes, r); if (!p.ok) throw new Error(`refused: ${p.error}`); return p }

describe('what a save may write', () => {
  it('is nine fields plus a person’s first and last name, each one column, and nothing else', () => {
    expect(EDITABLE_FIELDS).toEqual({
      name: 'name', firstName: 'first_name', lastName: 'last_name', title: 'title', company: 'company', phone: 'phone', email: 'email', website: 'website',
      howWeMet: 'how_we_met', birthday: 'birthday', birthdayReminder: 'birthday_reminder',
    })
    expect(WRITABLE_COLUMNS).toEqual(['name', 'first_name', 'last_name', 'title', 'company', 'phone', 'email', 'website', 'how_we_met', 'birthday', 'birthday_reminder', 'updated_at'])
  })
  it('can never reach any other column the table has', () => {
    const snapshot = readFileSync(join(process.cwd(), 'lib/db-columns.snapshot.txt'), 'utf8')
    const all = snapshot.split('\n').find((l) => l.startsWith('partners:'))!.slice('partners:'.length).split(',')
    expect(all).toHaveLength(38)
    const never = all.filter((c) => !WRITABLE_COLUMNS.includes(c))
    expect(never.slice().sort()).toEqual([
      'activity', 'addresses', 'card_image', 'company_id', 'created_at', 'created_by', 'customer_lead_id', 'deleted_at', 'id',
      'is_customer', 'last_contact', 'last_contacted_at', 'location_id', 'met_date', 'network_types', 'next_steps', 'notes',
      'partner_level', 'partner_stage', 'referrals', 'relationship', 'specialties', 'stage', 'tags', 'tier', 'type',
    ])
  })
  it.each([
    'type', 'stage', 'tier', 'networkTypes', 'network_types', 'partnerLevel', 'partner_level', 'partnerStage', 'partner_stage',
    'tags', 'tagIds', 'addresses', 'companyId', 'company_id', 'notes', 'nextSteps', 'relationship', 'specialties',
    'metDate', 'met_date', 'isCustomer', 'customerLeadId', 'location_id', 'deleted_at', 'updated_at', 'id', '__proto__',
  ])('refuses to write %s, and writes nothing else that came with it', (field) => {
    const p = save({ phone: { from: '(303) 555-0142', to: '(720) 555-0199' }, [field]: { to: 'x' } })
    expect(p).toMatchObject({ ok: false, status: 400, error: 'field_not_editable' })
  })
  it('refuses a save with no changes, or one that is not a list of changes', () => {
    for (const bad of [undefined, null, {}, [], 'phone', 7]) expect(save(bad)).toMatchObject({ ok: false, status: 400, error: 'changes_required' })
    expect(save({ phone: '(720) 555-0199' })).toMatchObject({ ok: false, status: 400, error: 'change_needs_to', field: 'phone' })
  })
})

describe('saving one field changes only that field', () => {
  it.each([
    ['name', 'Lisa Snyder-Hall', 'name'], ['title', 'Broker', 'title'], ['company', 'Compass Denver', 'company'],
    ['phone', '720-555-0199', 'phone'], ['email', 'lisa@new.example', 'email'], ['website', 'lisa.example', 'website'],
    ['howWeMet', 'BNI breakfast', 'how_we_met'], ['birthday', 'Mar 22', 'birthday'],
  ])('%s: the plan holds that one column', (field, to, column) => {
    // A name is one column only for an organization; a person's is first + last (below).
    const p = written({ [field]: { to } }, field === 'name' ? row({ network_types: ['organization'] }) : row())
    expect(p.written).toEqual([column])
    expect(Object.keys(p.update)).toEqual([column])
  })
  it('never puts updated_at in the plan: the route adds it, and only when something is written', () => {
    expect(written({ title: { to: 'Broker' } }).update).not.toHaveProperty('updated_at')
  })
  it('two fields changed: those two columns, in the list order', () => {
    expect(written({ email: { to: 'new@x.example' }, title: { to: 'Broker' } }).written).toEqual(['title', 'email'])
  })
  it('a form that sends every field but changes one writes one', () => {
    const p = written({
      name: { from: 'Lisa Snyder', to: 'Lisa Snyder' }, title: { from: 'Realtor', to: 'Realtor' }, company: { from: 'Compass', to: 'Compass' },
      phone: { from: '(303) 555-0142', to: '(303) 555-0142' }, email: { from: 'lisa@compass.com', to: 'lisa@compass.com' },
      website: { from: 'compass.com', to: 'compass.example' }, howWeMet: { from: 'Chamber breakfast', to: 'Chamber breakfast' },
      birthday: { from: null, to: null }, birthdayReminder: { from: false, to: false },
    })
    expect(p.update).toEqual({ website: 'compass.example' })
  })
})

describe('a field that already holds the value is not written', () => {
  it.each([
    ['phone', '(303) 555-0142'], ['phone', '303-555-0142'], ['phone', '303.555.0142'], ['email', 'lisa@compass.com'],
    ['email', '  LISA@Compass.com '], ['name', 'Lisa Snyder'], ['name', '  Lisa Snyder  '], ['title', 'Realtor'],
    ['birthday', ''], ['birthday', null], ['birthdayReminder', false],
  ])('%s set to %j: nothing to write', (field, to) => {
    const p = written({ [field]: { to } })
    expect(p.written).toEqual([])
    expect(p.update).toEqual({})
  })
  it('an empty box and nothing stored are the same thing', () => {
    expect(written({ website: { to: '   ' } }, row({ website: null })).written).toEqual([])
    expect(written({ website: { to: '' } }, row({ website: '' })).written).toEqual([])
  })
  it('clearing a field stores nothing, never an empty string', () => {
    expect(written({ website: { to: '  ' } }).update).toEqual({ website: null })
  })
})

describe('changed by someone else in the meantime', () => {
  it('refuses the save and says what it holds now', () => {
    expect(save({ phone: { from: '(303) 555-0000', to: '(720) 555-0199' } }))
      .toEqual({ ok: false, status: 409, error: 'changed_by_someone_else', field: 'phone', current: '(303) 555-0142' })
  })
  it('refuses the WHOLE save: a clean field beside a stale one is not written either', () => {
    const p = save({ title: { from: 'Realtor', to: 'Broker' }, email: { from: 'old@x.example', to: 'new@x.example' } })
    expect(p.ok).toBe(false)
    expect(p).not.toHaveProperty('update')
  })
  it('a field that was empty when opened and is filled now is a conflict too', () => {
    expect(save({ birthday: { from: null, to: 'Mar 22' } }, row({ birthday: 'Jul 4' }))).toMatchObject({ status: 409, current: 'Jul 4' })
  })
  it('with no `from`, the save is judged against what is stored and goes through', () => {
    expect(written({ title: { to: 'Broker' } }).written).toEqual(['title'])
  })
  it('the same value typed differently is not a conflict', () => {
    expect(written({ email: { from: 'LISA@compass.com', to: 'lisa@new.example' } }).written).toEqual(['email'])
  })
})

describe('what a typed value becomes', () => {
  it('a phone is stored in the one Bee Hub shape', () => {
    expect(normalizeField('phone', '720.555.0199')).toEqual({ ok: true, value: '(720) 555-0199' })
    expect(normalizeField('phone', '401-247-1926 x202')).toEqual({ ok: true, value: '(401) 247-1926 ext. 202' })
    expect(normalizeField('phone', '+82 10 1234 5678')).toEqual({ ok: true, value: '+82 10 1234 5678' })
  })
  it('two numbers, or words with the number, are refused rather than split across two places', () => {
    expect(normalizeField('phone', '407-393-5901 & 407-392-1931')).toEqual({ ok: false, error: 'one_phone_number_only' })
    expect(normalizeField('phone', '407-393-5901 (cell)')).toEqual({ ok: false, error: 'one_phone_number_only' })
    expect(normalizeField('phone', 'call me')).toEqual({ ok: false, error: 'phone_unreadable' })
  })
  it('an email is lowercased and must look like one', () => {
    expect(normalizeField('email', ' Ann@Acme.COM ')).toEqual({ ok: true, value: 'ann@acme.com' })
    expect(normalizeField('email', 'ann@acme')).toEqual({ ok: false, error: 'email_looks_wrong' })
  })
  it('a name is required', () => {
    expect(normalizeField('name', '   ')).toEqual({ ok: false, error: 'name_required' })
    expect(save({ name: { to: '' } })).toMatchObject({ ok: false, status: 422, error: 'name_required', field: 'name' })
  })
  it('a birthday is a month and a day that exists, with no year', () => {
    expect(normalizeBirthday('mar 22')).toEqual({ ok: true, value: 'Mar 22' })
    expect(normalizeBirthday('February 29')).toEqual({ ok: true, value: 'Feb 29' })
    expect(normalizeBirthday('Apr 31')).toEqual({ ok: false, error: 'birthday_unreadable' })
    expect(normalizeBirthday('Mar 22 1980')).toEqual({ ok: false, error: 'birthday_unreadable' })
    expect(normalizeBirthday('3/22')).toEqual({ ok: false, error: 'birthday_unreadable' })
    expect(normalizeBirthday('')).toEqual({ ok: true, value: null })
  })
  it('every birthday it accepts is one the table accepts', () => {
    const tableRule = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01])$/
    for (const typed of ['jan 1', 'Feb 29', 'DEC 31', 'sept 9', 'Oct. 10']) {
      const n = normalizeBirthday(typed)
      expect(n.ok && tableRule.test(String(n.value)), typed).toBe(true)
    }
  })
  it('has plain words for every refusal', () => {
    for (const e of ['name_required', 'email_looks_wrong', 'phone_unreadable', 'one_phone_number_only', 'birthday_unreadable', 'reminder_needs_a_birthday', 'changed_by_someone_else', 'field_not_editable']) {
      expect(saveErrorWords(e)).not.toContain('could not be saved')
    }
    expect(saveErrorWords('something_new')).toBe('That could not be saved. Nothing was changed.')
  })
})

describe('a birthday reminder needs a birthday', () => {
  it('a reminder with no birthday is refused', () => {
    expect(save({ birthdayReminder: { to: true } })).toMatchObject({ ok: false, status: 422, error: 'reminder_needs_a_birthday' })
  })
  it('a birthday and its reminder can be set together', () => {
    expect(written({ birthday: { to: 'Mar 22' }, birthdayReminder: { to: true } }).update).toEqual({ birthday: 'Mar 22', birthday_reminder: true })
  })
  it('removing a birthday that has a reminder turns the reminder off too, and says so', () => {
    const p = written({ birthday: { to: '' } }, row({ birthday: 'Mar 22', birthday_reminder: true }))
    expect(p.update).toEqual({ birthday: null, birthday_reminder: false })
    expect(p.notes).toEqual(['The birthday reminder was turned off because the birthday was removed.'])
  })
  it('removing a birthday with no reminder writes the birthday alone', () => {
    expect(written({ birthday: { to: '' } }, row({ birthday: 'Mar 22' })).update).toEqual({ birthday: null })
  })
})

describe("the screen's half: name only what changed", () => {
  const loaded = { name: 'Lisa Snyder', title: 'Realtor', company: 'Compass', phone: '(303) 555-0142', email: 'lisa@compass.com', website: null, howWeMet: 'Chamber breakfast', birthday: null, birthdayReminder: false }
  it('a form nobody touched names nothing', () => {
    expect(changesBetween(loaded, { ...loaded })).toEqual({})
    expect(changesBetween(loaded, { ...loaded, website: '', birthday: '' })).toEqual({})
  })
  it('one field edited names that field, with what it said before', () => {
    expect(changesBetween(loaded, { ...loaded, phone: '720-555-0199' })).toEqual({ phone: { from: '(303) 555-0142', to: '720-555-0199' } })
  })
  it('a field cleared is named, going to nothing', () => {
    expect(changesBetween(loaded, { ...loaded, title: '' })).toEqual({ title: { from: 'Realtor', to: null } })
  })
  it('a field the form does not hold is never named', () => {
    expect(changesBetween(loaded, { phone: '720-555-0199' })).toEqual({ phone: { from: '(303) 555-0142', to: '720-555-0199' } })
    expect(Object.keys(changesBetween(loaded, { name: 'New Name' }))).toEqual(['name'])
  })
  it('only ever names editable fields', () => {
    const named = Object.keys(changesBetween(loaded, { ...loaded, name: 'x', addresses: [{ value: 'y' }], networkTypes: ['partner'] } as never))
    expect(named).toEqual(['name'])
    for (const n of named) expect(EDITABLE_FIELD_NAMES).toContain(n)
  })
})

describe('names: first, last and full name move together (2026-11-19)', () => {
  const person = (over: Record<string, unknown> = {}) => row({ first_name: 'Lisa', last_name: 'Snyder', network_types: ['partner'], ...over })
  const org = row({ name: 'Northside Chamber', first_name: null, last_name: null, network_types: ['organization'] })

  it('renaming a person writes first, last and the full name together', () => {
    const p = written({ lastName: { from: 'Snyder', to: 'Snyder-Hall' } }, person())
    expect(p.update).toEqual({ name: 'Lisa Snyder-Hall', last_name: 'Snyder-Hall' })
    expect(p.written.sort()).toEqual(['last_name', 'name'])
  })

  it('both boxes changed: all three columns, the full name tidied the Clients way', () => {
    expect(written({ firstName: { to: '  Mary ' }, lastName: { to: 'Van  Der Berg' } }, person()).update)
      .toEqual({ name: 'Mary Van Der Berg', first_name: 'Mary', last_name: 'Van Der Berg' })
  })

  it('the full name is tidied the Clients way, even around a part stored with a double space', () => {
    expect(written({ lastName: { from: 'Snyder', to: 'Hall' } }, person({ first_name: 'Mary  Anne', name: 'Mary  Anne Snyder' })).update.name).toBe('Mary Anne Hall')
  })

  it('a name not split yet: filling both boxes splits it, and the full name follows', () => {
    const p = written({ firstName: { from: null, to: 'Mary Lou' }, lastName: { from: null, to: 'Geoghagen' } }, person({ name: 'Mary Lou Geoghagen', first_name: null, last_name: null }))
    expect(p.update).toEqual({ first_name: 'Mary Lou', last_name: 'Geoghagen' }) // the full name already reads that way
  })

  it('a person’s bare name cannot be changed on its own: it would leave first and last stale', () => {
    expect(save({ name: { from: 'Lisa Snyder', to: 'Lisa Hall' } }, person())).toMatchObject({ ok: false, status: 422, error: 'name_is_set_from_first_and_last' })
    // re-sending the same name is not a change, so it is not refused
    expect(written({ name: { to: 'Lisa Snyder' } }, person()).written).toEqual([])
  })

  it('a person needs a first or last name', () => {
    expect(save({ firstName: { to: '' }, lastName: { to: ' ' } }, person())).toMatchObject({ ok: false, status: 422, error: 'person_name_required', field: 'firstName' })
  })

  it('an organization keeps one name, and refuses a first or last name', () => {
    expect(written({ name: { to: 'Northside Chamber of Commerce' } }, org).update).toEqual({ name: 'Northside Chamber of Commerce' })
    expect(save({ firstName: { to: 'North' } }, org)).toMatchObject({ ok: false, status: 422, error: 'organization_has_one_name' })
  })

  it('someone else changed the last name meanwhile: nothing is written', () => {
    expect(save({ lastName: { from: 'Smith', to: 'Hall' } }, person())).toMatchObject({ ok: false, status: 409, error: 'changed_by_someone_else', field: 'lastName' })
  })

  it('the screen names first and last when they change, never the full name for a person', () => {
    const loaded = { firstName: 'Lisa', lastName: 'Snyder', title: 'Realtor' }
    expect(changesBetween(loaded, { firstName: 'Lisa', lastName: 'Hall', title: 'Realtor' })).toEqual({ lastName: { from: 'Snyder', to: 'Hall' } })
  })
})
