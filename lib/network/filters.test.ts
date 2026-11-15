import { describe, expect, it } from 'vitest'
import {
  birthdayThisMonth, contactSecondaryDetails, daysUntilBirthday, giftEarned, needsFollowUp, sortContacts,
} from './filters'
import { sampleContact } from './testing'

const base = sampleContact()
const nov15 = new Date(2026, 10, 15)

describe('Needs follow-up', () => {
  it('includes due and overdue dates', () => {
    expect(needsFollowUp({ ...base, nextFollowUp: '2026-11-14' }, '2026-11-14')).toBe(true)
    expect(needsFollowUp({ ...base, nextFollowUp: '2026-11-13' }, '2026-11-14')).toBe(true)
  })
  it('does not include a future scheduled follow-up even when contact is cold', () => {
    expect(needsFollowUp({ ...base, lastTalkedDays: 90, nextFollowUp: '2026-11-15' }, '2026-11-14')).toBe(false)
  })
  it('includes quiet or never-contacted relationships without a scheduled date', () => {
    expect(needsFollowUp({ ...base, nextFollowUp: undefined, lastTalkedDays: 60 }, '2026-11-14')).toBe(true)
    expect(needsFollowUp({ ...base, nextFollowUp: undefined, lastTalkedDays: null }, '2026-11-14')).toBe(true)
    expect(needsFollowUp({ ...base, nextFollowUp: undefined, lastTalkedDays: 59 }, '2026-11-14')).toBe(false)
  })
})

describe('Contact details', () => {
  it('keeps company context without repeating the role already shown as a tag', () => {
    expect(contactSecondaryDetails({ ...base, tags: ['Realtor'], role: 'realtor', company: 'Compass' })).toEqual(['Compass'])
  })
  it('shows how many people an organization has', () => {
    const org = sampleContact({ name: 'Summit Senior Living', types: ['organization'], role: undefined, company: undefined })
    expect(contactSecondaryDetails({ ...org, people: 2 })).toEqual(['2 people'])
    expect(contactSecondaryDetails({ ...org, people: 1 })).toEqual(['1 person'])
  })
  it('never shows a people count on a person', () => {
    expect(contactSecondaryDetails({ ...base, role: undefined, company: undefined, people: 4 })).toEqual([])
  })
})

describe('Birthdays', () => {
  it('counts days to the next birthday, wrapping to next year', () => {
    expect(daysUntilBirthday({ birthday: 'Nov 21' }, nov15)).toBe(6)
    expect(daysUntilBirthday({ birthday: 'Nov 15' }, nov15)).toBe(0)
    expect(daysUntilBirthday({ birthday: 'Nov 14' }, nov15)).toBe(364)
    expect(daysUntilBirthday({ birthday: undefined }, nov15)).toBe(null)
  })
  it('does not guess at a birthday it cannot read', () => {
    expect(daysUntilBirthday({ birthday: '11/21' }, nov15)).toBe(null)
    expect(daysUntilBirthday({ birthday: 'Smarch 4' }, nov15)).toBe(null)
  })
  it('matches birthdays in the current month only', () => {
    expect(birthdayThisMonth({ birthday: 'Nov 2' }, nov15)).toBe(true)
    expect(birthdayThisMonth({ birthday: 'Dec 3' }, nov15)).toBe(false)
  })
})

describe('Gift earned', () => {
  it('needs 3 or more referrals', () => {
    expect(giftEarned({ referred: 2 })).toBe(false)
    expect(giftEarned({ referred: 3 })).toBe(true)
  })
})

describe('Sorting', () => {
  const ids = (list: { id: string }[]) => list.map((p) => p.id)
  it('recently contacted puts the freshest first and never-contacted last', () => {
    const list = [{ ...base, id: 'a', lastTalkedDays: null }, { ...base, id: 'b', lastTalkedDays: 30 }, { ...base, id: 'c', lastTalkedDays: 2 }]
    expect(ids(sortContacts(list, 'recent', nov15))).toEqual(['c', 'b', 'a'])
  })
  it('gone quiet puts never-contacted first, then the longest silence', () => {
    const list = [{ ...base, id: 'a', lastTalkedDays: 2 }, { ...base, id: 'b', lastTalkedDays: null }, { ...base, id: 'c', lastTalkedDays: 30 }]
    expect(ids(sortContacts(list, 'quiet', nov15))).toEqual(['b', 'c', 'a'])
  })
  it('most referrals first, revenue breaking a tie', () => {
    const list = [{ ...base, id: 'a', referred: 1 }, { ...base, id: 'b', referred: 3, revenue: 100 }, { ...base, id: 'c', referred: 3, revenue: 900 }]
    expect(ids(sortContacts(list, 'referrals', nov15))).toEqual(['c', 'b', 'a'])
  })
  it('next birthday first, no birthday last', () => {
    const list = [{ ...base, id: 'a', birthday: undefined }, { ...base, id: 'b', birthday: 'Dec 3' }, { ...base, id: 'c', birthday: 'Nov 21' }]
    expect(ids(sortContacts(list, 'birthday', nov15))).toEqual(['c', 'b', 'a'])
  })
  it('A to Z by name, and never reorders the list it was given', () => {
    const list = [{ ...base, id: 'a', name: 'Zed' }, { ...base, id: 'b', name: 'Amy' }]
    expect(ids(sortContacts(list, 'az', nov15))).toEqual(['b', 'a'])
    expect(ids(list)).toEqual(['a', 'b'])
  })
})
