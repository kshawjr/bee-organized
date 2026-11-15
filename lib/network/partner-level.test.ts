import { describe, expect, it } from 'vitest'
import { LEVEL_CHOICES, confirmPartnerLevel, levelLabel, levelShort } from './partner-level'
import { sampleContact } from './testing'

const contact = sampleContact({ types: ['partner'], level: 'referral' })

describe('Partner level picker', () => {
  it('offers the three levels, lowest first', () => {
    expect(LEVEL_CHOICES.map((c) => c.label)).toEqual(['Potential', 'Referral Partner', 'Power Partner'])
  })
  it('has a short and a full name for each', () => {
    expect(levelShort('potential')).toBe('Potential')
    expect(levelLabel('power')).toBe('Power Partner')
  })
})

describe('Partner level confirmation', () => {
  it.each(['power', 'potential'] as const)('keeps Referral Partner until %s is confirmed, draft note included', (level) => {
    expect(confirmPartnerLevel(contact, level, 'Discussed partnership', false)).toBe(contact)
  })
  it.each(['referral', 'power'] as const)('saves %s only on confirmation, with a timestamped note and history', (level) => {
    const previous = sampleContact({ types: ['partner'], level: 'potential' })
    const result = confirmPartnerLevel(previous, level, '  Agreed together  ', true, '2026-11-14T19:04:00.000Z')
    expect(result.level).toBe(level)
    expect(result.notes?.[0]).toMatchObject({ text: 'Agreed together', at: '2026-11-14T19:04:00.000Z' })
    expect(result.history?.[0]).toMatchObject({ kind: 'partner', when: '2026-11-14T19:04:00.000Z' })
  })
  it('names the new level in History and on the note', () => {
    const result = confirmPartnerLevel(contact, 'power', 'Sent five this year', true, '2026-11-14T19:04:00.000Z')
    expect(result.history?.[0]?.text).toBe('Level set to Power Partner')
    expect(result.notes?.[0]?.title).toBe('Changed to Power Partner')
  })
  it('allows confirmation without a note', () => {
    const result = confirmPartnerLevel(contact, 'power', '   ', true, '2026-11-14T19:04:00.000Z')
    expect(result.level).toBe('power')
    expect(result.notes).toEqual([])
  })
  it('does not change a contact who is not a Referral partner', () => {
    const vendor = sampleContact({ types: ['vendor'], level: undefined })
    expect(confirmPartnerLevel(vendor, 'power', '', true)).toBe(vendor)
  })
  it('does not repeat the level they already have', () => {
    expect(confirmPartnerLevel(contact, 'referral', '', true)).toBe(contact)
  })
  it('reads a partner with no level as Potential, so confirming Potential changes nothing', () => {
    const unset = sampleContact({ types: ['partner'], level: undefined })
    expect(confirmPartnerLevel(unset, 'potential', '', true)).toBe(unset)
  })
})
