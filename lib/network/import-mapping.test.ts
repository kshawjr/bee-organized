// A file that isn't ours (Network slice 5, third follow-up). What this pins:
//
//   · the guess, from the brief's list of headings, case and punctuation
//     ignored, one column per field
//   · an Outlook, a Google Contacts, a Mailchimp (both heading styles) and a
//     LinkedIn export each import: the heading rows are the ones those
//     programs write; the people are made up
//   · several phone or email columns: the fullest is guessed, the others are
//     named, and picking one moves the field
//   · no Phone column: nobody gets a phone, and the screen is told
//   · the rewrite keeps every row in its place, so "Row N" is still the
//     owner's row N
//   · a remembered mapping: the second file from the same program arrives
//     already mapped, even with its columns in another order
//   · what is stored is checked: known fields only, one column per field
import { describe, it, expect } from 'vitest'
import {
  FIELDS, alsoLooksLike, applyMapping, birthdayFromOther, cleanMappingToSave, guessMapping, headerSignature,
  mappingProblems, normHeader, readShape, recallMapping, setColumn, withMapping, MAX_SAVED_MAPPINGS, type Mapping,
} from './import-mapping'
import { planImport } from './contact-create'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = new Date('2026-11-19T15:00:00Z')
const q = (cells: string[]) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')
const csv = (headers: string[], rows: Record<string, string>[]) => [q(headers), ...rows.map((r) => q(headers.map((h) => r[h] ?? '')))].join('\r\n')
const guessed = (text: string) => { const sh = readShape(text)!; const m = guessMapping(sh); return { sh, m, by: Object.fromEntries(m.map((k, i) => [sh.headers[i], k]).filter(([, k]) => k)) } }
const land = (text: string, mapping?: Mapping) => {
  const sh = readShape(text)!
  const p = planImport(applyMapping(sh, mapping ?? guessMapping(sh)), { locationId: LOC, userId: null, tags: [], existing: [], now: NOW })
  if (!p.ok) throw new Error(`should plan: ${p.reason}`)
  return p
}
const brief = (p: ReturnType<typeof land>) => p.rows.map((r) => ({ name: r.row.name, first: r.row.first_name, last: r.row.last_name, email: r.row.email, phone: r.row.phone, company: r.row.company, title: r.row.title }))

// The heading rows as each program writes them.
const OUTLOOK = ['First Name', 'Middle Name', 'Last Name', 'Title', 'Suffix', 'Nickname', 'E-mail Address', 'E-mail 2 Address', 'E-mail 3 Address', 'Home Phone', 'Home Phone 2', 'Business Phone', 'Business Phone 2', 'Mobile Phone', 'Car Phone', 'Other Phone', 'Primary Phone', 'Pager', 'Business Fax', 'Home Fax', 'Job Title', 'Department', 'Company', 'Office Location', 'Business Street', 'Business City', 'Business State', 'Business Postal Code', 'Home Street', 'Home City', 'Home State', 'Home Postal Code', 'Web Page', 'Birthday', 'Anniversary', 'Notes']
const GOOGLE = ['First Name', 'Middle Name', 'Last Name', 'Phonetic First Name', 'Phonetic Middle Name', 'Phonetic Last Name', 'Name Prefix', 'Name Suffix', 'Nickname', 'File As', 'Organization Name', 'Organization Title', 'Organization Department', 'Birthday', 'Notes', 'Photo', 'Labels', 'E-mail 1 - Label', 'E-mail 1 - Value', 'E-mail 2 - Label', 'E-mail 2 - Value', 'Phone 1 - Label', 'Phone 1 - Value', 'Phone 2 - Label', 'Phone 2 - Value', 'Address 1 - Label', 'Address 1 - Formatted']
const MAILCHIMP = ['Email Address', 'First Name', 'Last Name', 'Address', 'Phone Number', 'Birthday', 'MEMBER_RATING', 'OPTIN_TIME', 'OPTIN_IP', 'CONFIRM_TIME', 'CONFIRM_IP', 'LATITUDE', 'LONGITUDE', 'GMTOFF', 'DSTOFF', 'TIMEZONE', 'CC', 'REGION', 'LAST_CHANGED', 'LEID', 'EUID', 'NOTES', 'TAGS']
const MAILCHIMP_MERGE = ['Email Address', 'FNAME', 'LNAME', 'PHONE', 'MEMBER_RATING', 'OPTIN_TIME', 'TAGS']
const LINKEDIN_HEAD = 'Notes:\r\n"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address."\r\n\r\n'
const LINKEDIN = ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On']

describe('the guess', () => {
  it('reads the brief’s list, case and punctuation ignored', () => {
    const want: Record<string, string> = {
      'First Name': 'firstName', 'given name': 'firstName', FNAME: 'firstName', first: 'firstName',
      'Last Name': 'lastName', Surname: 'lastName', 'Family Name': 'lastName', LNAME: 'lastName', last: 'lastName',
      'Full Name': 'name', 'Contact Name': 'name', 'Display Name': 'name', Name: 'name',
      'E-mail Address': 'email', 'Email Address': 'email', 'E-mail 1 - Value': 'email', 'Primary Email': 'email',
      'Business Phone': 'phone', 'Mobile Phone': 'phone', 'Home Phone': 'phone', 'Phone 1 - Value': 'phone', Telephone: 'phone',
      'Organization Name': 'company', 'Company Name': 'company', 'Account Name': 'company', Employer: 'company',
      Position: 'title', Title: 'title', 'Job Title': 'title', Role: 'title',
    }
    for (const [heading, key] of Object.entries(want)) {
      const sh = readShape(`${q([heading])}\nx`)!
      expect([heading, guessMapping(sh)[0]]).toEqual([heading, key])
    }
    expect(normHeader('E-mail 1 - Value')).toBe('email1value')
  })

  it('one column per field: the first known heading wins, the rest stay Ignore', () => {
    const { by } = guessed('Name,Full Name,Email\nA,A,a@x.co')
    expect(by).toEqual({ Name: 'name', Email: 'email' })
  })

  it('Outlook: "Job Title" is the job; Outlook’s "Title" (Mr / Mrs) is not', () => {
    const { by } = guessed(csv(OUTLOOK, [{ 'First Name': 'Ann', Title: 'Mrs.', 'Job Title': 'Realtor' }]))
    expect(by['Job Title']).toBe('title')
    expect(by.Title).toBeUndefined()
  })

  it('headings that match nothing: everything Ignore, and the screen is told', () => {
    const { m } = guessed('Col A,Col B\nx,y')
    expect(m).toEqual([null, null])
    expect(mappingProblems(m)).toMatchObject({ noName: true, nothingKnown: true })
  })
})

describe('real exports, as their programs write them', () => {
  it('an Outlook export imports: first/last, the fullest phone, Job Title, Company, Outlook’s birthday', () => {
    const text = csv(OUTLOOK, [
      { 'First Name': 'Dana', 'Last Name': 'Whitfield', Title: 'Ms.', 'E-mail Address': 'Dana@Keystone.com', 'Mobile Phone': '(303) 555-0142', 'Job Title': 'Realtor', Company: 'Keystone Realty', Birthday: '3/22/1985' },
      { 'First Name': 'Marcus', 'Last Name': 'Lee', 'Business Phone': '720-555-0199', 'Mobile Phone': '720.555.0100', Company: 'Lee Moving Co', Birthday: '0/0/00' },
      { 'First Name': 'Priya', 'Last Name': 'Shah', 'E-mail Address': 'priya@x.co', 'Mobile Phone': '303 555 0110' },
    ])
    const { by } = guessed(text)
    expect(by).toMatchObject({ 'First Name': 'firstName', 'Last Name': 'lastName', 'E-mail Address': 'email', 'Mobile Phone': 'phone', 'Job Title': 'title', Company: 'company', Birthday: 'birthday' })
    const p = land(text)
    expect(p.unreadable).toEqual([])
    expect(brief(p)).toEqual([
      { name: 'Dana Whitfield', first: 'Dana', last: 'Whitfield', email: 'dana@keystone.com', phone: '(303) 555-0142', company: 'Keystone Realty', title: 'Realtor' },
      { name: 'Marcus Lee', first: 'Marcus', last: 'Lee', email: null, phone: '(720) 555-0100', company: 'Lee Moving Co', title: null },
      { name: 'Priya Shah', first: 'Priya', last: 'Shah', email: 'priya@x.co', phone: '(303) 555-0110', company: null, title: null },
    ])
    expect(p.rows.map((r) => r.row.birthday)).toEqual(['Mar 22', null, null])
  })

  it('a Google Contacts export imports: E-mail 1 - Value, Phone 1 - Value, Organization Name and Title, Google’s birthday', () => {
    const text = csv(GOOGLE, [
      { 'First Name': 'Lou', 'Last Name': 'Okafor', 'Organization Name': 'Summit Senior Living', 'Organization Title': 'Director', Birthday: '1979-07-04', 'E-mail 1 - Label': '* Work', 'E-mail 1 - Value': 'lou@summit.org', 'Phone 1 - Label': 'Mobile', 'Phone 1 - Value': '+1 720-555-0123' },
      { 'First Name': 'Mary', 'Middle Name': 'Anne', 'Last Name': 'Van Der Berg', Birthday: '--12-01', 'Phone 1 - Value': '(206) 555-0177' },
    ])
    const { by } = guessed(text)
    expect(by).toMatchObject({ 'Organization Name': 'company', 'Organization Title': 'title', 'E-mail 1 - Value': 'email', 'Phone 1 - Value': 'phone', Birthday: 'birthday' })
    expect(by['E-mail 1 - Label']).toBeUndefined()
    const p = land(text)
    expect(brief(p)).toEqual([
      { name: 'Lou Okafor', first: 'Lou', last: 'Okafor', email: 'lou@summit.org', phone: '(720) 555-0123', company: 'Summit Senior Living', title: 'Director' },
      { name: 'Mary Van Der Berg', first: 'Mary', last: 'Van Der Berg', email: null, phone: '(206) 555-0177', company: null, title: null },
    ])
    expect(p.rows.map((r) => r.row.birthday)).toEqual(['Jul 4', 'Dec 1'])
  })

  it('a Mailchimp export imports, in both of its heading styles', () => {
    const a = land(csv(MAILCHIMP, [{ 'Email Address': 'jo@x.co', 'First Name': 'Jo', 'Last Name': 'Park', 'Phone Number': '3035550199', Birthday: '03/22', MEMBER_RATING: '2' }]))
    expect(brief(a)).toEqual([{ name: 'Jo Park', first: 'Jo', last: 'Park', email: 'jo@x.co', phone: '(303) 555-0199', company: null, title: null }])
    expect(a.rows[0]!.row.birthday).toBe('Mar 22')
    const b = land(csv(MAILCHIMP_MERGE, [{ 'Email Address': 'al@x.co', FNAME: 'Al', LNAME: 'Ray', PHONE: '206 555 0101' }]))
    expect(brief(b)).toEqual([{ name: 'Al Ray', first: 'Al', last: 'Ray', email: 'al@x.co', phone: '(206) 555-0101', company: null, title: null }])
  })

  it('a LinkedIn export imports, with its notes paragraph above the headings, and keeps its row numbers', () => {
    const text = LINKEDIN_HEAD + csv(LINKEDIN, [
      { 'First Name': 'Sam', 'Last Name': 'Vance', URL: 'https://www.linkedin.com/in/sam', 'Email Address': '', Company: 'Vance Design', Position: 'Owner', 'Connected On': '04 Mar 2025' },
      { 'First Name': 'Bad', 'Last Name': 'Mail', 'Email Address': 'not-an-email', Company: 'X' },
    ])
    const sh = readShape(text)!
    expect(sh.headers).toEqual(LINKEDIN)
    expect(sh.headerAt).toBe(3)
    const p = land(text)
    expect(brief(p)).toEqual([{ name: 'Sam Vance', first: 'Sam', last: 'Vance', email: null, phone: null, company: 'Vance Design', title: 'Owner' }])
    // the owner's row 6 (Notes, the paragraph, a blank, the headings, Sam, then this)
    expect(p.unreadable.map((u) => [u.line, u.name])).toEqual([[6, 'Bad Mail']])
  })
})

describe('several phone or email columns', () => {
  const text = csv(['Name', 'Home Phone', 'Business Phone', 'Mobile Phone', 'Email'], [
    { Name: 'A One', 'Home Phone': '303 555 0001', 'Mobile Phone': '303 555 0101' },
    { Name: 'B Two', 'Mobile Phone': '303 555 0102', 'Business Phone': '303 555 0202' },
    { Name: 'C Three', 'Mobile Phone': '303 555 0103' },
  ])

  it('the fullest is guessed, and the others are named as other phone columns', () => {
    const { sh, m } = guessed(text)
    // (Email has nothing in it here: it is still guessed, and the screen leaves empty columns out)
    expect(m).toEqual(['name', null, null, 'phone', 'email'])
    expect(alsoLooksLike(sh, m, 'phone').map((i) => sh.headers[i])).toEqual(['Home Phone', 'Business Phone'])
  })

  it('the FULLEST wins even when its heading is lower on the known list (Home Phone over Mobile Phone)', () => {
    const t = csv(['Name', 'Mobile Phone', 'Home Phone', 'E-mail Address', 'Email'], [
      { Name: 'A', 'Mobile Phone': '1', 'Home Phone': '2', Email: 'a@x.co' }, { Name: 'B', 'Home Phone': '3', Email: 'b@x.co' }, { Name: 'C', 'Home Phone': '4', 'E-mail Address': 'c@x.co', Email: 'c2@x.co' },
    ])
    expect(guessed(t).by).toMatchObject({ 'Home Phone': 'phone', Email: 'email' })
    expect(guessed(t).by['Mobile Phone']).toBeUndefined()
  })

  it('picking another column as Phone moves Phone there; the first goes back to Ignore', () => {
    const { m } = guessed(text)
    const moved = setColumn(m, 1, 'phone')
    expect(moved).toEqual(['name', 'phone', null, null, 'email'])
    expect(land(text, moved).rows.map((r) => r.row.phone)).toEqual(['(303) 555-0001', null, null])
  })

  it('picking none: nobody gets a phone, the screen is told, and the contacts still come in', () => {
    const none = setColumn(guessed(text).m, 3, null)
    expect(mappingProblems(none)).toMatchObject({ noPhone: true, noName: false })
    const p = land(text, none)
    expect(p.rows.map((r) => [r.row.name, r.row.phone])).toEqual([['A One', null], ['B Two', null], ['C Three', null]])
  })
})

describe('the rewrite', () => {
  it('keeps every row in its place, blank ones and quoted line breaks included', () => {
    const text = 'Full Name,E-mail Address,Junk\r\nAnn One,ann@x.co,z\r\n\r\n"Bo\r\nTwo",bad@,z\r\n,,only-junk\r\nCy Three,cy@x.co,z'
    const sh = readShape(text)!
    const out = applyMapping(sh, guessMapping(sh))
    expect(out.split('\n')[0]).toBe('Name,Email')
    const p = planImport(out, { locationId: LOC, userId: null, tags: [], existing: [], now: NOW })
    if (!p.ok) throw new Error('should plan')
    // rows: 1 headings, 2 Ann, 3 blank, 4 "Bo / Two" (one row, two lines), 5 junk only, 6 Cy
    expect(p.rows.map((r) => [r.line, r.row.name])).toEqual([[2, 'Ann One'], [6, 'Cy Three']])
    expect(p.unreadable.map((u) => u.line)).toEqual([4])
  })

  it('an organization’s name from a one-name file is never split', () => {
    const p = land('Display Name,Type\nNorthside Chamber of Commerce,organization\nMary Van Der Berg,partner')
    expect(p.rows.map((r) => [r.row.name, r.row.first_name, r.row.last_name])).toEqual([
      ['Northside Chamber of Commerce', null, null], ['Mary Van Der Berg', 'Mary', 'Van Der Berg'],
    ])
  })

  it('a heading that is the same word twice maps by column, not by name', () => {
    const sh = readShape('Name,Phone,Phone\nAnn One,,303 555 0142')!
    // the empty one is left; the one with a number in it is Phone
    expect(guessMapping(sh)).toEqual(['name', null, 'phone'])
  })

  it('birthdays from other programs become Bee Hub’s month and day; an unknown shape is left as typed', () => {
    expect(['03/22', '3/22/1985', '1985-03-22', '--03-22', '0/0/00', '', '13/40', 'Mar 22', 'spring'].map(birthdayFromOther))
      .toEqual(['Mar 22', 'Mar 22', 'Mar 22', 'Mar 22', '', '', '13/40', 'Mar 22', 'spring'])
  })
})

describe('remembering a mapping, per location', () => {
  const H = ['Contact', 'Mail', 'Cell', 'Org']
  const mine: Mapping = ['name', 'email', 'phone', 'company']

  it('the second file from the same program arrives already mapped, even reordered', () => {
    const toSave = cleanMappingToSave({ headers: H, fields: mine })!
    const saved = withMapping({}, toSave.signature, toSave.mapping, NOW)
    expect(recallMapping(saved, H)).toEqual(mine)
    expect(recallMapping(saved, ['Org', 'Cell', 'Mail', 'Contact'])).toEqual(['company', 'phone', 'email', 'name'])
    expect(headerSignature(['org', ' CELL', 'Mail', 'contact'])).toBe(toSave.signature)
  })

  it('a file with other columns is not mapped from it', () => {
    const toSave = cleanMappingToSave({ headers: H, fields: mine })!
    const saved = withMapping({}, toSave.signature, toSave.mapping, NOW)
    expect(recallMapping(saved, [...H, 'Extra'])).toBeNull()
    expect(recallMapping(saved, ['Contact', 'Mail', 'Cell'])).toBeNull()
    expect(recallMapping(null, H)).toBeNull()
  })

  it('a corrected guess is what is remembered, not the guess', () => {
    const sh = readShape(csv(['Name', 'Home Phone', 'Mobile Phone'], [{ Name: 'A', 'Mobile Phone': '1' }]))!
    const corrected = setColumn(guessMapping(sh), 1, 'phone')
    const toSave = cleanMappingToSave({ headers: sh.headers, fields: corrected })!
    expect(recallMapping(withMapping({}, toSave.signature, toSave.mapping, NOW), sh.headers)).toEqual(['name', 'phone', null])
  })

  it('only known fields, one column each, are stored; anything else is refused', () => {
    expect(cleanMappingToSave({ headers: ['A', 'B'], fields: ['name', 'name'] })).toBeNull()
    expect(cleanMappingToSave({ headers: ['A'], fields: ['password'] })).toBeNull()
    expect(cleanMappingToSave({ headers: ['A', 'B'], fields: ['name'] })).toBeNull()
    expect(cleanMappingToSave({ headers: [{}], fields: [null] })).toBeNull()
    expect(cleanMappingToSave(null)).toBeNull()
    expect(cleanMappingToSave({ headers: ['A', 'B'], fields: ['name', null] })).not.toBeNull()
  })

  it(`keeps the newest ${MAX_SAVED_MAPPINGS} per location`, () => {
    let saved = {}
    for (let i = 0; i < MAX_SAVED_MAPPINGS + 5; i++) {
      const s = cleanMappingToSave({ headers: [`Col ${i}`], fields: ['name'] })!
      saved = withMapping(saved, s.signature, s.mapping, new Date(NOW.getTime() + i * 1000))
    }
    expect(Object.keys(saved)).toHaveLength(MAX_SAVED_MAPPINGS)
    expect(recallMapping(saved, ['Col 0'])).toBeNull()
    expect(recallMapping(saved, [`Col ${MAX_SAVED_MAPPINGS + 4}`])).toEqual(['name'])
  })

  it('the dropdown offers every field the importer reads', () => {
    expect(FIELDS.map((f) => f.heading)).toEqual(['First name', 'Last name', 'Name', 'Email', 'Phone', 'Company', 'Job title', 'Type', 'Tags', 'Birthday', 'Partner level', 'Stage', 'Interest', 'How met'])
  })
})
