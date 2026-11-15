import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EXPORT_COLUMNS, IMPORT_COLUMNS, SAMPLE_CSV, contactsToCsv, guardCell, parseCsv, rowsToContacts, unguardCell,
} from './csv'
import { sampleContact } from './testing'

const read = (csv: string) => rowsToContacts(parseCsv(csv), 't')
const one = (csv: string) => read(csv)[0]!

describe('Reading a CSV file', () => {
  it('splits rows and honours quoted commas, quotes and line breaks', () => {
    expect(parseCsv('Name,Company\n"Lee, Marcus","The ""Best"" Movers"\n"Two\nLines",x')).toEqual([
      ['Name', 'Company'], ['Lee, Marcus', 'The "Best" Movers'], ['Two\nLines', 'x'],
    ])
  })
  it('reads Windows line endings and a byte-order mark, and drops blank rows', () => {
    expect(parseCsv('﻿Name,Phone\r\nAnn,3035550142\r\n\r\n , \r\n')).toEqual([['Name', 'Phone'], ['Ann', '3035550142']])
  })
})

describe('Contact import', () => {
  it('imports every sample row with cleaned phone and email', () => {
    const rows = read(SAMPLE_CSV)
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.contact && r.problems.length === 0 && r.warnings.length === 0)).toBe(true)
    expect(rows[0]?.contact?.phone).toBe('(303) 555-0142')
    expect(rows[0]?.contact?.email).toBe('dana@keystonerealty.com')
    expect(rows[2]?.contact?.phone).toBe('(303) 555-0110')
  })
  it('reads more than one type per row, into the standard order', () => {
    const rows = read(SAMPLE_CSV)
    expect(rows[1]?.contact?.types).toEqual(['partner', 'vendor'])
    expect(rows[2]?.contact?.types).toEqual(['nurture'])
    expect(rows[3]?.contact?.types).toEqual(['partner', 'organization'])
  })
  it('reads level and stage for Referral partners', () => {
    const rows = read(SAMPLE_CSV)
    expect([rows[0]?.contact?.level, rows[0]?.contact?.stage]).toEqual(['power', 'Active Partner'])
    expect([rows[3]?.contact?.level, rows[3]?.contact?.stage]).toEqual(['referral', 'Reaching Out'])
  })
  it('skips rows without a name or with a phone that is not a number', () => {
    const rows = read('Name,Phone\n,3035550142\nAnn,12')
    expect(rows.map((r) => r.problems)).toEqual([['Missing name'], ["Phone isn't a number we can read"]])
    expect(rows.every((r) => !r.contact)).toBe(true)
  })
  it('skips a row whose email looks wrong', () => {
    expect(one('Name,Email\nAnn,ann@nowhere').problems).toEqual(['Email looks wrong'])
  })
  it('counts lines from the header, so the owner can find the row', () => {
    expect(read('Name\nAnn\nBob').map((r) => r.line)).toEqual([2, 3])
  })
  it('starts a new Referral partner with no level or stage at Potential and New Contact', () => {
    const r = one('Name,Type\nAnn,partner')
    expect(r.contact?.level).toBe('potential')
    expect(r.contact?.stage).toBe('New Contact')
  })
  it('reads a row with no type as Not sure yet', () => {
    expect(one('Name\nAnn').contact?.types).toEqual(['unsure'])
  })
  it.each([
    ['Referral Partner', 'partner'], ['Service Provider', 'vendor'], ['trade', 'vendor'],
    ['prospect', 'nurture'], ['Organisation', 'organization'], ['company', 'organization'], ['Not sure yet', 'unsure'],
  ])('reads the type word “%s” as %s', (typed, type) => {
    expect(one(`Name,Type\nAnn,${typed}`).contact?.types).toEqual([type])
  })
  it('imports a row that says client as Not sure yet, and says so', () => {
    const r = one('Name,Type\nAnn,client')
    expect(r.contact?.types).toEqual(['unsure'])
    expect(r.warnings).toEqual(["Type “client” isn't one we use, so it was left out"])
  })
  it('keeps the known type when a row names a known and an unknown one', () => {
    const r = one('Name,Type\nAnn,client;vendor')
    expect(r.contact?.types).toEqual(['vendor'])
    expect(r.warnings).toHaveLength(1)
  })
  it('gives no level or stage to anyone who is not a Referral partner, and says so', () => {
    const r = one('Name,Type,Partner level,Stage\nAnn,vendor,power,Active Partner')
    expect(r.contact?.level).toBeUndefined()
    expect(r.contact?.stage).toBeUndefined()
    expect(r.warnings).toEqual([
      'Partner level left out: only a Referral partner has one',
      'Stage left out: only a Referral partner has one',
    ])
  })
  it.each(['network', 'premier', 'Networking Contact'])('does not accept the retired level “%s”', (level) => {
    const r = one(`Name,Type,Partner level\nAnn,partner,${level}`)
    expect(r.contact?.level).toBe('potential')
    expect(r.warnings).toEqual([`Partner level “${level}” isn't one we use, so they start as Potential`])
  })
  it.each(['Introduced', 'First meeting', 'Building trust', 'Referring'])('does not accept the design stage “%s”', (stage) => {
    const r = one(`Name,Type,Stage\nAnn,partner,${stage}`)
    expect(r.contact?.stage).toBe('New Contact')
    expect(r.warnings).toEqual([`Stage “${stage}” isn't one we use, so they start at New Contact`])
  })
  it('reads the two live stage names that were renamed', () => {
    expect(one('Name,Type,Stage\nAnn,partner,Dormant').contact?.stage).toBe('Gone quiet')
    expect(one('Name,Type,Stage\nAnn,partner,building').contact?.stage).toBe('Building the Relationship')
  })
  it("still reads the design sample's Record column, as the Organization type", () => {
    expect(one('Name,Type,Record\nSummit,partner,company').contact?.types).toEqual(['partner', 'organization'])
  })
  it('leaves a birthday off an organization, and says so', () => {
    const r = one('Name,Type,Birthday\nSummit,organization,Mar 22')
    expect(r.contact?.birthday).toBeUndefined()
    expect(r.warnings).toEqual(['Birthday left out: an organization has none'])
  })
  it('keeps the tags as the words in the file', () => {
    expect(one('Name,Tags\nAnn,Realtor; Downsizing|Friend').contact?.tags).toEqual(['Realtor', 'Downsizing', 'Friend'])
  })
})

describe("Phones follow Bee Hub's one phone rule", () => {
  it('keeps the first of two numbers and saves the whole cell as a note', () => {
    const r = one('Name,Phone\nAnn,407-393-5901 & 407-392-1931')
    expect(r.contact?.phone).toBe('(407) 393-5901')
    expect(r.contact?.notes?.[0]?.text).toBe('Phone as imported: 407-393-5901 & 407-392-1931')
    expect(r.warnings).toEqual(['Phone kept as (407) 393-5901; the rest of that cell was saved as a note'])
  })
  it('keeps an extension', () => {
    expect(one('Name,Phone\nAnn,401-247-1926 x202').contact?.phone).toBe('(401) 247-1926 ext. 202')
  })
  it('leaves a foreign number exactly as typed', () => {
    const r = one('Name,Phone\nAnn,+82 10 1234 5678')
    expect(r.contact?.phone).toBe('+82 10 1234 5678')
    expect(r.problems).toEqual([])
  })
  it('imports a row with no phone at all', () => {
    const r = one('Name,Phone\nAnn,')
    expect(r.contact?.phone).toBeUndefined()
    expect(r.problems).toEqual([])
  })
})

describe('Contact export', () => {
  it('writes the import columns first, then the read-only extras', () => {
    expect(EXPORT_COLUMNS.slice(0, IMPORT_COLUMNS.length)).toEqual(IMPORT_COLUMNS.map((c) => c.key))
    expect(contactsToCsv([]).split('\n')).toEqual([EXPORT_COLUMNS.join(',')])
  })
  it('exported contacts import back the same', () => {
    const contacts = read(SAMPLE_CSV).map((r) => r.contact!)
    const again = read(contactsToCsv(contacts)).map((r) => r.contact!)
    const facts = (c: (typeof contacts)[number]) => [c.name, c.types, c.level, c.stage, c.phone, c.email, c.tags, c.birthday, c.interest, c.howMet]
    expect(again.map(facts)).toEqual(contacts.map(facts))
  })
  it('writes no level or stage for a contact who is not a Referral partner, even if one is stored', () => {
    const csv = contactsToCsv([sampleContact({ types: ['vendor'], level: 'power', stage: 'Active Partner' })])
    const [head, row] = parseCsv(csv)
    expect(row![head!.indexOf('Partner level')]).toBe('')
    expect(row![head!.indexOf('Stage')]).toBe('')
  })
  it('quotes a name with a comma or a quote in it', () => {
    const csv = contactsToCsv([sampleContact({ name: 'Lee, "Mac" Marcus' })])
    expect(csv.split('\n')[1]).toMatch(/^"Lee, ""Mac"" Marcus",/)
    expect(parseCsv(csv)[1]![0]).toBe('Lee, "Mac" Marcus')
  })
})

describe('Spreadsheet formulas', () => {
  it.each(['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)'])('writes %s as plain text, not a formula', (danger) => {
    expect(guardCell(danger)).toBe(`'${danger}`)
    const csv = contactsToCsv([sampleContact({ company: danger })])
    const [head, row] = parseCsv(csv)
    expect(row![head!.indexOf('Company')]).toBe(`'${danger}`)
  })
  it('leaves ordinary cells alone', () => {
    expect(guardCell('(303) 555-0142')).toBe('(303) 555-0142')
    expect(guardCell("O'Brien")).toBe("O'Brien")
    expect(unguardCell("'Tis the season")).toBe("'Tis the season")
  })
  it('brings a guarded cell back in as it was typed', () => {
    const exported = contactsToCsv([sampleContact({ company: '=Equals Design', phone: '+82 10 1234 5678' })])
    const back = one(exported).contact
    expect(back?.company).toBe('=Equals Design')
    expect(back?.phone).toBe('+82 10 1234 5678')
  })
})

describe('No spreadsheet package', () => {
  it('reads CSV with no import of xlsx or any other package', () => {
    const source = readFileSync(new URL('./csv.ts', import.meta.url), 'utf8')
    const imports = Array.from(source.matchAll(/from '([^']+)'/g)).map((m) => m[1])
    expect(imports).toEqual(['@/lib/phone', './types'])
  })
})
