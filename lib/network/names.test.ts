// First, last and full names on Network (slice 5, third follow-up, Kevin
// 2026-11-19: universal with Clients). What this pins:
//
//   · the full name is first + " " + last, spaces tidied: Clients' own rule,
//     lib/lead-name.ts composeLeadName, not a copy of it
//   · one name column splits first word / everything after
//     ("Mary Van Der Berg" → Mary / Van Der Berg), as the website form does
//   · an organization's name is never split, by the add flow or a file
//   · a joint name ("Drew & Bill Crowley") typed as one name is not split
//   · a file with First name / Last name columns uses them
//   · the add flow takes First and Last for a person and one name for an
//     organization, and writes all three columns
//   · the duplicate rules still match on the full name
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { contactNames, splitFullName, isJointName } from './names'
import { planImport, planNewContact, NEW_CONTACT_COLUMNS, type ExistingContact } from './contact-create'
import { composeLeadName } from '@/lib/lead-name'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ME = '00000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-11-19T15:00:00Z')
const imp = (csv: string, existing: ExistingContact[] = []) => {
  const p = planImport(csv, { locationId: LOC, userId: ME, tags: [], existing, now: NOW })
  if (!p.ok) throw new Error(`should plan: ${p.reason}`)
  return p
}
const add = (input: any, existing: ExistingContact[] = []) => planNewContact(input, { locationId: LOC, userId: ME, allowedTagIds: [], existing })
const names = (p: ReturnType<typeof imp>) => p.rows.map((r) => [r.row.name, r.row.first_name, r.row.last_name])

describe('the split and the join', () => {
  it('one name: first word, then everything after', () => {
    expect(splitFullName('Mary Van Der Berg')).toEqual({ first_name: 'Mary', last_name: 'Van Der Berg' })
    expect(splitFullName('  Dana   Whitfield ')).toEqual({ first_name: 'Dana', last_name: 'Whitfield' })
    expect(splitFullName('Cher')).toEqual({ first_name: 'Cher', last_name: null })
    expect(splitFullName('')).toEqual({ first_name: null, last_name: null })
  })

  it('a joint name is not split', () => {
    for (const n of ['Drew & Bill Crowley', 'Pat and Sam Lee', 'Jo + Al Ray', 'Kim/Lee Park']) {
      expect(isJointName(n)).toBe(true)
      expect(splitFullName(n)).toEqual({ first_name: null, last_name: null })
      expect(contactNames({ name: n, isOrg: false })).toEqual({ name: n, first_name: null, last_name: null })
    }
    // "and" inside a word is not a joint name
    expect(isJointName('Sandy Anderson')).toBe(false)
  })

  it('first and last make the full name exactly as Clients does (composeLeadName)', () => {
    for (const [f, l] of [['Dana', 'Whitfield'], ['  Mary ', ' Van  Der Berg'], ['Cher', ''], ['', 'Okafor'], ['Drew & Bill', 'Crowley']]) {
      const c = contactNames({ first: f, last: l, isOrg: false })
      expect(c.name).toBe(composeLeadName({ first_name: f, last_name: l }))
    }
    expect(contactNames({ first: '  Mary ', last: ' Van  Der Berg', isOrg: false })).toEqual({ name: 'Mary Van Der Berg', first_name: 'Mary', last_name: 'Van Der Berg' })
  })

  it('first and last win over a Name given beside them', () => {
    expect(contactNames({ first: 'Dana', last: 'Whit', name: 'Something Else', isOrg: false })).toEqual({ name: 'Dana Whit', first_name: 'Dana', last_name: 'Whit' })
  })

  it('an organization is never split, and never carries a first or last name', () => {
    expect(contactNames({ name: 'Northside Chamber of Commerce', isOrg: true })).toEqual({ name: 'Northside Chamber of Commerce', first_name: null, last_name: null })
    expect(contactNames({ name: 'Keystone Realty', isOrg: true })).toEqual({ name: 'Keystone Realty', first_name: null, last_name: null })
    // a file that only had first/last columns for an organization: joined, still not split
    expect(contactNames({ first: 'Keystone', last: 'Realty', isOrg: true })).toEqual({ name: 'Keystone Realty', first_name: null, last_name: null })
  })

  it('the rule is lib/lead-name.ts itself, not a copy', () => {
    const src = readFileSync(new URL('./names.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/import \{ composeLeadName, normalizeNamePart \} from '@\/lib\/lead-name'/)
  })
})

describe('an import, in either shape', () => {
  it('a one-column Name file splits first word / rest', () => {
    const p = imp(['Name,Type', 'Mary Van Der Berg,partner', 'Dana Whitfield,vendor', 'Cher,nurture'].join('\n'))
    expect(names(p)).toEqual([['Mary Van Der Berg', 'Mary', 'Van Der Berg'], ['Dana Whitfield', 'Dana', 'Whitfield'], ['Cher', 'Cher', null]])
  })

  it('a file with First name and Last name columns uses them and sets the full name', () => {
    const p = imp(['First name,Last name,Email', 'Mary Anne,Smith,ma@x.co', 'Lou,,lou@x.co', ',Okafor,ok@x.co'].join('\n'))
    expect(names(p)).toEqual([['Mary Anne Smith', 'Mary Anne', 'Smith'], ['Lou', 'Lou', null], ['Okafor', null, 'Okafor']])
  })

  it('a row with neither is skipped and named as missing a name', () => {
    const p = imp(['First name,Last name,Email', ',,nobody@x.co', 'Ann,One,ann@x.co'].join('\n'))
    expect(p.unreadable).toEqual([{ line: 2, name: '', problems: ['Missing name'] }])
  })

  it('an organization’s name is never split, from either shape', () => {
    const p = imp(['Name,Type,First name,Last name', 'Northside Chamber of Commerce,organization,,', 'Keystone Realty,organization,,', ',organization,Summit,Living'].join('\n'))
    expect(names(p)).toEqual([['Northside Chamber of Commerce', null, null], ['Keystone Realty', null, null], ['Summit Living', null, null]])
  })

  it('a joint name in one column comes in whole, first and last blank', () => {
    expect(names(imp(['Name', 'Drew & Bill Crowley'].join('\n')))).toEqual([['Drew & Bill Crowley', null, null]])
  })

  it('a file with only First name / Last name headings is a usable file', () => {
    expect(planImport('First name,Last name\nAnn,One', { locationId: LOC, userId: ME, tags: [], existing: [], now: NOW }).ok).toBe(true)
    expect(planImport('Email\nann@x.co', { locationId: LOC, userId: ME, tags: [], existing: [], now: NOW })).toMatchObject({ ok: false, reason: 'no_name_column' })
  })

  it('first_name and last_name are written, and nothing else new', () => {
    expect(NEW_CONTACT_COLUMNS).toContain('first_name')
    expect(NEW_CONTACT_COLUMNS).toContain('last_name')
    expect(NEW_CONTACT_COLUMNS).toHaveLength(17)
  })

  it('the duplicate rules still match on the full name, whichever shape the file was', () => {
    const here: ExistingContact[] = [{ id: 'p-mary', name: 'Mary Van Der Berg', email: null, phone: null }, { id: 'p-pat', name: 'Pat Phone', email: null, phone: '(303) 555-0142' }]
    const p = imp(['First name,Last name,Phone', 'mary,van der  berg,', 'Pat,Phone,303.555.0142', 'Pat,Phone,'].join('\n'), here)
    expect(p.skipped.map((s) => [s.line, s.rule, s.matched.id])).toEqual([[2, 'name_only', 'p-mary'], [3, 'name_phone', 'p-pat']])
    expect(p.rows.map((r) => r.row.name)).toEqual(['Pat Phone'])
  })
})

describe('the add flow', () => {
  it('a person: First and Last make all three columns', () => {
    const p = add({ firstName: ' Mary ', lastName: 'Van Der Berg', types: ['partner'] })
    if (!p.ok) throw new Error(p.error)
    expect([p.row.name, p.row.first_name, p.row.last_name]).toEqual(['Mary Van Der Berg', 'Mary', 'Van Der Berg'])
  })

  it('a joint name typed in the two boxes stays as typed', () => {
    const p = add({ firstName: 'Drew & Bill', lastName: 'Crowley', types: ['unsure'] })
    if (!p.ok) throw new Error(p.error)
    expect([p.row.name, p.row.first_name, p.row.last_name]).toEqual(['Drew & Bill Crowley', 'Drew & Bill', 'Crowley'])
  })

  it('an organization: one name, never split, no first or last (even if they were sent)', () => {
    const p = add({ name: 'Northside Chamber of Commerce', firstName: 'X', lastName: 'Y', types: ['organization'] })
    if (!p.ok) throw new Error(p.error)
    expect([p.row.name, p.row.first_name, p.row.last_name]).toEqual(['Northside Chamber of Commerce', null, null])
  })

  it('a person with no first or last name is refused, at the First box', () => {
    expect(add({ firstName: ' ', lastName: '', types: ['partner'] })).toMatchObject({ ok: false, error: 'person_name_required', field: 'firstName' })
    expect(add({ name: '', types: ['organization'] })).toMatchObject({ ok: false, error: 'name_required', field: 'name' })
  })

  it('a bare name for a person (an older caller) is split first word / rest', () => {
    const p = add({ name: 'Mary Van Der Berg', types: ['vendor'] })
    if (!p.ok) throw new Error(p.error)
    expect([p.row.first_name, p.row.last_name]).toEqual(['Mary', 'Van Der Berg'])
  })

  it('the duplicate rules see the full name made from First and Last', () => {
    const here: ExistingContact[] = [{ id: 'p-pat', name: 'Pat Phone', email: null, phone: '(303) 555-0142' }]
    expect(add({ firstName: 'pat', lastName: 'phone', phone: '303 555 0142', types: ['vendor'] }, here)).toMatchObject({ ok: false, error: 'name_and_phone_already_here', matched: { id: 'p-pat' } })
    // a stray full name sent beside First and Last is not what is checked (or stored)
    expect(add({ name: 'Someone Else', firstName: 'pat', lastName: 'phone', phone: '303 555 0142', types: ['vendor'] }, here)).toMatchObject({ ok: false, error: 'name_and_phone_already_here' })
    const p = add({ name: 'Someone Else', firstName: 'Pat', lastName: 'Phone', types: ['vendor'] })
    if (!p.ok) throw new Error(p.error)
    expect(p.row.name).toBe('Pat Phone')
  })
})
