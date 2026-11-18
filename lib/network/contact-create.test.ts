// lib/network/contact-create.ts — the rules for adding contacts, by hand and
// from a file (Network & Nurture, slice 5). What this pins:
//
//   · A ROW THAT CANNOT BE READ IS SKIPPED AND NAMED (line and reason), and
//     every other row is still planned, wherever the bad row sits (Kevin's
//     correction, 2026-11-18). Saving all-or-nothing is the routes' job.
//   · every planned row goes to the location handed in, whatever the file says
//   · Kevin's ruling 1: a tag word that matches no Network tag here is left
//     off and NAMED, once; the contact still comes in; no tag is ever made
//   · Kevin's ruling 2: an email already on a live contact here skips the row
//     and names that contact BY NAME; case and spaces do not matter
//   · a row with no email always comes in
//   · the add flow refuses a tag that is not on this location's Network list
//   · the add flow refuses an email already on a live contact here, naming
//     who, case-insensitively on both sides, unless addAnyway is true; no
//     email is never a duplicate; Interest becomes the first note
//
// What the routes do with these plans (write all or nothing, at that location
// only) is pinned in lib/network/import-route.test.ts.
import { describe, it, expect } from 'vitest'
import { IMPORT_MAX_ROWS, networkTagsFor, planImport, planNewContact, looksBinary, findDuplicate, type TagDef } from './contact-create'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ME = '00000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-11-17T15:00:00Z')

const TAGS: TagDef[] = [
  { id: 't-realtor', label: 'Realtor', category: 'tags', location_id: null, is_active: true, attrs: { group: 'home_property', shows_on: ['network'] } },
  { id: 't-mover', label: 'Mover', category: 'tags', location_id: null, is_active: true, attrs: { group: 'moving_hauling', shows_on: ['network'] } },
  { id: 't-vip', label: 'VIP', category: 'tags', location_id: null, is_active: true, attrs: { group: 'client_status', shows_on: ['clients'] } },
  { id: 't-off', label: 'Jeweler', category: 'tags', location_id: null, is_active: false, attrs: { group: 'valuables_specialty', shows_on: ['network'] } },
  { id: 't-own', label: 'Applicant', category: 'tags', location_id: LOC, is_active: true, attrs: { group: 'professional_services', shows_on: ['network'] } },
  { id: 't-theirs', label: 'Oak & Key', category: 'tags', location_id: OTHER, is_active: true, attrs: { group: 'home_property', shows_on: ['network'] } },
]
const EXISTING = [
  { id: 'p-dana', name: 'Dana Whitfield', email: 'Dana@KeystoneRealty.com ' },
  { id: 'p-noemail', name: 'No Email Person', email: null },
]
const plan = (csv: string, over: any = {}) => planImport(csv, { locationId: LOC, userId: ME, tags: TAGS, existing: EXISTING, now: NOW, ...over })
const file = (...rows: string[]) => ['Name,Type,Email,Phone,Tags,Birthday,Location', ...rows].join('\n')

describe('a row that cannot be read is skipped and named; the rest come in', () => {
  for (const [where, rows, bad, good] of [
    ['last', ['Ann One,partner,ann@x.co,,,,', 'Ben Two,vendor,,,,,', 'Cat Three,,not-an-email,,,,'], 4, ['Ann One', 'Ben Two']],
    ['first', [',partner,ann@x.co,,,,', 'Ben Two,vendor,,,,,'], 2, ['Ben Two']],
    ['middle', ['Ann One,partner,ann@x.co,,,,', 'Ben Two,vendor,,,,31 Feb,', 'Cat Three,,,,,,'], 3, ['Ann One', 'Cat Three']],
  ] as const) {
    it(`a bad ${where} row: every other row is planned, and the bad one is named by line`, () => {
      const p = plan(file(...rows))
      if (!p.ok) throw new Error('should plan')
      expect(p.rows.map((r) => r.row.name)).toEqual(good)
      expect(p.unreadable.map((u) => u.line)).toEqual([bad])
      expect(p.unreadable[0]!.problems.length).toBeGreaterThan(0)
    })
  }

  it('says which line and why, for EVERY bad row, none dropped', () => {
    const p = plan(file('Ann One,partner,ann@x.co,,,,', ',vendor,,,,,', 'Cat Three,,cat@,,,,', 'Dee Four,,,banana,,,', 'Eve Five,,,,,Smarch 3,'))
    if (!p.ok) throw new Error('should plan')
    expect(p.rows.map((r) => r.line)).toEqual([2])
    expect(p.unreadable.map((x) => [x.line, x.name, x.problems.join('; ')])).toEqual([
      [3, '', 'Missing name'],
      [4, 'Cat Three', 'Email looks wrong'],
      [5, 'Dee Four', "Phone isn't a number we can read"],
      [6, 'Eve Five', 'Birthday “Smarch 3” isn’t a month and day like Mar 22'],
    ])
  })

  it('a field too long for the table is a reason to skip, not a cut', () => {
    const p = plan(file(`${'x'.repeat(201)},,,,,,`, 'Ann One,,,,,,'))
    if (!p.ok) throw new Error('should plan')
    expect(p.unreadable[0]!.problems).toEqual(['Name is longer than 200 characters'])
    expect(p.rows.map((r) => r.row.name)).toEqual(['Ann One'])
  })

  it('an unreadable row does not claim its email: a later good row with it still comes in', () => {
    const p = plan(file('Ann One,,ann@x.co,banana,,,', 'Ann Fixed,,ann@x.co,,,,'))
    if (!p.ok) throw new Error('should plan')
    expect(p.rows.map((r) => r.row.name)).toEqual(['Ann Fixed'])
    expect(p.skipped).toEqual([])
  })

  it('a file whose every row is unreadable plans nothing to write, and names them all', () => {
    const p = plan(file(',partner,,,,,', 'Bo,,bo@,,,,'))
    if (!p.ok) throw new Error('should plan')
    expect(p.rows).toEqual([])
    expect(p.unreadable.map((u) => u.line)).toEqual([2, 3])
  })
})

describe('a row is named by the row the owner sees in the spreadsheet', () => {
  it('blank rows (dropped by the reader) do not shift the numbers after them', () => {
    const p = plan(['Name,Type,Email,Phone,Tags,Birthday,Location', 'Ann One,,,,,,', '', ',,,,,,', 'Bo,,bo@,,,,', 'Cy,,cy@x.co,,,,', 'Cy Again,,cy@x.co,,,,'].join('\n'))
    if (!p.ok) throw new Error('should plan')
    expect(p.unreadable.map((u) => [u.line, u.name])).toEqual([[5, 'Bo']])
    expect(p.rows.map((r) => r.line)).toEqual([2, 6])
    expect(p.skipped.map((s) => [s.line, s.matched.line])).toEqual([[7, 6]])
  })
  it('a quoted cell with a line break inside stays one row; CRLF files count the same', () => {
    const p = plan(['Name,Type,Email,Phone,Tags,Birthday,Location', '"Ann\nOne",,,,,,', '', 'Bo,,bo@,,,,'].join('\r\n'))
    if (!p.ok) throw new Error('should plan')
    expect(p.unreadable.map((u) => u.line)).toEqual([4])
  })
})

describe('every row goes to the location handed in', () => {
  it('whatever a Location column in the file says', () => {
    const p = plan(file('Ann One,partner,ann@x.co,,,,Greensboro', 'Ben Two,vendor,,,,,Seattle'))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.rows.map((r) => r.row.location_id)).toEqual([LOC, LOC])
    expect(p.rows.every((r) => r.row.created_by === ME)).toBe(true)
  })
})

describe('Kevin’s ruling 1: a tag word that matches nothing', () => {
  it('the contact still comes in, the tag is left off, and the word is named once', () => {
    const p = plan(file('Ann One,partner,ann@x.co,,Realtor;Downsizing,,', 'Ben Two,vendor,,,downsizing;Garage;Movers,,', 'Cat Three,,,,DOWNSIZING,,'))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.rows.map((r) => r.row.name)).toEqual(['Ann One', 'Ben Two', 'Cat Three'])
    expect(p.unmatchedTags).toEqual(['Downsizing', 'Garage'])
    // "Movers" is the Mover tag (the tag list's own near-match key)
    expect(p.rows.map((r) => r.tagIds)).toEqual([['t-realtor'], ['t-mover'], []])
  })

  it('only this location’s Network tags match: a Clients tag, a switched-off tag and another location’s own tag do not', () => {
    const p = plan(file('Ann One,,,,VIP;Jeweler;Oak & Key;Applicant,,'))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.rows[0]!.tagIds).toEqual(['t-own'])
    expect(p.unmatchedTags).toEqual(['VIP', 'Jeweler', 'Oak & Key'])
    expect(networkTagsFor(TAGS, LOC).map((t) => t.id)).toEqual(['t-realtor', 't-mover', 't-own'])
  })

  it('a plan never holds a new tag: every tag id is one that already exists', () => {
    const p = plan(file('Ann One,,,,Brand New Tag;Realtor,,'))
    if (!p.ok) throw new Error('should plan')
    expect(p.rows.flatMap((r) => r.tagIds).every((id) => TAGS.some((t) => t.id === id))).toBe(true)
  })
})

describe('Kevin’s ruling 2: an email already here', () => {
  it('skips the row and names the existing contact by name, whatever the case and spaces', () => {
    const p = plan(file('Dana W,partner,  DANA@keystonerealty.com ,,Realtor,,', 'New Person,,new@x.co,,,,'))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.rows.map((r) => r.row.name)).toEqual(['New Person'])
    expect(p.skipped).toEqual([{ line: 2, name: 'Dana W', email: 'dana@keystonerealty.com', matched: { id: 'p-dana', name: 'Dana Whitfield', line: null } }])
  })

  it('the same email twice in one file: the first comes in, the second is skipped naming the first by line', () => {
    const p = plan(file('Ann One,,ann@x.co,,,,', 'Ann Again,,ANN@x.co,,,,'))
    if (!p.ok) throw new Error('should plan')
    expect(p.rows.map((r) => r.row.name)).toEqual(['Ann One'])
    expect(p.skipped[0]!.matched).toEqual({ id: null, name: 'Ann One', line: 2 })
  })

  it('a contact at another location is not here: only the list handed in is checked', () => {
    // The route hands in this location's live contacts only (contact-reads.ts).
    const p = plan(file('Dana W,,dana@keystonerealty.com,,,,'), { existing: [] })
    if (!p.ok) throw new Error('should plan')
    expect(p.rows).toHaveLength(1)
    expect(p.skipped).toEqual([])
  })
})

describe('a row with no email', () => {
  it('always comes in, even beside a stored contact with no email, and two of them are not duplicates', () => {
    const p = plan(file('No Email Person,,,,,,', 'Another Blank,,,2065550100,,,', 'Another Blank,,,,,,'))
    if (!p.ok) throw new Error('should plan')
    expect(p.rows.map((r) => [r.row.name, r.row.email])).toEqual([['No Email Person', null], ['Another Blank', null], ['Another Blank', null]])
    expect(p.skipped).toEqual([])
  })
})

describe('what a planned row holds', () => {
  it('types, a tidied phone kept as a note, a birthday read, and level/stage only when the file names them', () => {
    const csv = ['Name,Type,Phone,Birthday,Partner level,Stage,Interest',
      'Ann One,partner,303-555-0142 or 303-555-0143,mar 22,power,Active Partner,',
      'Ben Two,partner,,,,,',
      'Cat Three,nurture,,,power,,Garage'].join('\n')
    const p = plan(csv)
    if (!p.ok) throw new Error('should plan')
    const [a, b, c] = p.rows.map((r) => r.row)
    expect([a!.network_types, a!.phone, a!.birthday, a!.partner_level, a!.partner_stage]).toEqual([['partner'], '(303) 555-0142', 'Mar 22', 'power', 'Active Partner'])
    expect(a!.notes.map((n) => n.text)).toEqual(['Phone as imported: 303-555-0142 or 303-555-0143'])
    expect([b!.partner_level, b!.partner_stage]).toEqual([null, null])
    // not a Referral partner: no level, whatever the file says
    expect([c!.network_types, c!.partner_level]).toEqual([['nurture'], null])
    expect(c!.notes.map((n) => n.text)).toEqual(['Interest, from the import: Garage'])
  })
})

describe('files that are not contacts', () => {
  it('a spreadsheet saved as .xlsx, a PDF, a file with no Name column, too many rows', () => {
    expect(plan('PK\u0003\u0004xl/workbook.xml').reason).toBe('not_csv')
    expect(plan('%PDF-1.7 ...').reason).toBe('not_csv')
    expect(plan('Email,Phone\na@b.co,1').reason).toBe('no_name_column')
    expect(plan('Name\n').reason).toBe('no_rows')
    expect(plan(['Name', ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `P ${i}`)].join('\n')).reason).toBe('too_many_rows')
    expect(looksBinary('Name,Email\nAnn,a@b.co')).toBe(false)
  })
})

describe('the add flow', () => {
  const ctx = { locationId: LOC, userId: ME, allowedTagIds: networkTagsFor(TAGS, LOC).map((t) => t.id) }
  it('reads each field the way the sheet saves it, and lands at the location handed in', () => {
    const p = planNewContact({ name: '  Ann One ', types: ['partner', 'vendor'], email: ' Ann@X.co ', phone: '3035550142', birthday: 'jul 4', birthdayReminder: true, tagIds: ['t-realtor'] }, ctx)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.row).toMatchObject({ location_id: LOC, name: 'Ann One', email: 'ann@x.co', phone: '(303) 555-0142', birthday: 'Jul 4', birthday_reminder: true, network_types: ['partner', 'vendor'], partner_level: null, partner_stage: null, created_by: ME })
    expect(p.tagIds).toEqual(['t-realtor'])
  })
  it('refuses: no type, no name, two phone numbers, a reminder with no birthday, an organization birthday', () => {
    expect(planNewContact({ name: 'A', types: [] }, ctx)).toMatchObject({ ok: false, error: 'types_required' })
    expect(planNewContact({ name: ' ', types: ['vendor'] }, ctx)).toMatchObject({ ok: false, error: 'name_required' })
    expect(planNewContact({ name: 'A', types: ['vendor'], phone: '303 555 0142 / 303 555 0143' }, ctx)).toMatchObject({ ok: false, error: 'one_phone_number_only' })
    expect(planNewContact({ name: 'A', types: ['vendor'], birthdayReminder: true }, ctx)).toMatchObject({ ok: false, error: 'reminder_needs_a_birthday' })
    expect(planNewContact({ name: 'A', types: ['organization'], birthday: 'Mar 3' }, ctx)).toMatchObject({ ok: false, error: 'organization_has_no_birthday' })
  })
  it('refuses a tag that is not on this location’s Network list: a Clients tag or another location’s', () => {
    expect(planNewContact({ name: 'A', types: ['vendor'], tagIds: ['t-vip'] }, ctx)).toMatchObject({ ok: false, error: 'tag_not_on_network_here' })
    expect(planNewContact({ name: 'A', types: ['vendor'], tagIds: ['t-theirs'] }, ctx)).toMatchObject({ ok: false, error: 'tag_not_on_network_here' })
  })
})

describe('the add flow: a duplicate email at this location', () => {
  const base = { name: 'Blaire Brimer', types: ['partner'] }
  const ctx = { locationId: LOC, userId: ME, allowedTagIds: [], existing: EXISTING, now: NOW, author: 'Kevin' }

  it('is refused, naming who, whatever the case and spaces ON BOTH SIDES', () => {
    // stored "Dana@KeystoneRealty.com " (capitals and a trailing space), typed in another case
    const p = planNewContact({ ...base, email: '  dana@KEYSTONErealty.COM' }, ctx)
    expect(p).toEqual({ ok: false, error: 'email_already_here', field: 'email', matched: { id: 'p-dana', name: 'Dana Whitfield' } })
  })

  it('goes in when addAnyway is true, and only then', () => {
    expect(planNewContact({ ...base, email: 'dana@keystonerealty.com', addAnyway: false }, ctx).ok).toBe(false)
    expect(planNewContact({ ...base, email: 'dana@keystonerealty.com', addAnyway: 'yes' }, ctx).ok).toBe(false)
    const p = planNewContact({ ...base, email: 'dana@keystonerealty.com', addAnyway: true }, ctx)
    expect(p.ok).toBe(true)
  })

  it('no email is never a duplicate, even with a stored contact that has none', () => {
    expect(planNewContact({ ...base, email: '' }, ctx).ok).toBe(true)
    expect(planNewContact({ ...base }, ctx).ok).toBe(true)
    expect(findDuplicate('', EXISTING)).toBeNull()
    expect(findDuplicate('   ', [{ id: 'x', name: 'Blank', email: '  ' }])).toBeNull()
  })

  it('a different email goes in', () => {
    expect(planNewContact({ ...base, email: 'blaire@x.co' }, ctx).ok).toBe(true)
  })
})

describe('the add flow: Interest', () => {
  const ctx = { locationId: LOC, userId: ME, allowedTagIds: [], existing: [], now: NOW, author: 'Kevin' }
  it('becomes the first note, signed and timed', () => {
    const p = planNewContact({ name: 'Ann', types: ['nurture'], interest: '  Garage in spring ' }, ctx)
    if (!p.ok) throw new Error('should plan')
    expect(p.row.notes).toEqual([{ id: `n${NOW.getTime()}`, text: 'Interest: Garage in spring', ts: NOW.toISOString(), user: 'Kevin' }])
  })
  it('blank: no note; too long: refused', () => {
    const p = planNewContact({ name: 'Ann', types: ['nurture'], interest: '  ' }, ctx)
    if (!p.ok) throw new Error('should plan')
    expect(p.row.notes).toEqual([])
    expect(planNewContact({ name: 'Ann', types: ['nurture'], interest: 'x'.repeat(501) }, ctx)).toMatchObject({ ok: false, error: 'interest_too_long' })
  })
})
