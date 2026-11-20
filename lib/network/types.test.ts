import { describe, expect, it } from 'vitest'
import {
  LEVEL_META, NET_TYPES, PARTNER_LEVELS, PARTNER_STAGES, TYPE_META,
  contactTypes, hasType, isCold, isNetworkContact, isNurtureContact, isOrganization,
  normalizeTypes, partnerLevel, partnerStage, talkedLabel, withTypes,
} from './types'
import { sampleContact } from './testing'

describe("Kevin's rulings, word for word", () => {
  it('has exactly five types, in his order, with his labels: Not sure yet FIRST (2026-11-19, the biggest group)', () => {
    expect(NET_TYPES).toEqual(['unsure', 'partner', 'vendor', 'nurture', 'organization'])
    expect(NET_TYPES.map((t) => TYPE_META[t].label)).toEqual([
      'Not sure yet', 'Referral partner', 'Vendor / Service Provider', 'Nurture', 'Organization',
    ])
  })
  it('has no Client type', () => {
    expect(NET_TYPES as readonly string[]).not.toContain('client')
    expect(Object.values(TYPE_META).map((m) => m.label.toLowerCase())).not.toContain('client')
  })
  it('spells Organization with a Z', () => {
    expect(TYPE_META.organization.label).toBe('Organization')
  })
  it('has exactly three partner levels, in order', () => {
    expect(PARTNER_LEVELS.map((l) => LEVEL_META[l].label)).toEqual(['Potential', 'Referral Partner', 'Power Partner'])
  })
  it('has none of the retired levels', () => {
    const labels = Object.values(LEVEL_META).map((m) => m.label).join(' | ')
    expect(labels).not.toMatch(/Network Partner|Premier|Networking Contact/)
  })
  it('has exactly five partner stages, in order', () => {
    expect(PARTNER_STAGES).toEqual(['New Contact', 'Reaching Out', 'Building the Relationship', 'Active Partner', 'Gone quiet'])
  })
})

describe('Holding more than one type', () => {
  it('keeps every type a contact holds, in the standard order', () => {
    expect(normalizeTypes(['organization', 'vendor', 'partner'])).toEqual(['partner', 'vendor', 'organization'])
  })
  it('drops repeats and anything that is not one of the five', () => {
    expect(normalizeTypes(['vendor', 'vendor', 'client', 'prospect', 42, null])).toEqual(['vendor'])
  })
  it('reads an empty or missing list as Not sure yet', () => {
    expect(normalizeTypes([])).toEqual(['unsure'])
    expect(normalizeTypes(null)).toEqual(['unsure'])
    expect(normalizeTypes(['client'])).toEqual(['unsure'])
  })
  it('drops Not sure yet once anything else is decided', () => {
    expect(normalizeTypes(['unsure', 'vendor'])).toEqual(['vendor'])
    expect(normalizeTypes(['unsure', 'organization'])).toEqual(['organization'])
  })
  it('keeps a contact who is a partner and a vendor in both', () => {
    const c = sampleContact({ types: ['vendor', 'partner'] })
    expect(contactTypes(c)).toEqual(['partner', 'vendor'])
    expect(hasType(c, 'partner')).toBe(true)
    expect(hasType(c, 'vendor')).toBe(true)
    expect(hasType(c, 'nurture')).toBe(false)
  })
})

describe('Which tab a contact shows on', () => {
  it('keeps a contact who is only Nurture out of Network', () => {
    const c = sampleContact({ types: ['nurture'] })
    expect(isNetworkContact(c)).toBe(false)
    expect(isNurtureContact(c)).toBe(true)
  })
  it('shows partners, vendors, organizations and not-sure-yets in Network', () => {
    for (const t of ['partner', 'vendor', 'organization', 'unsure'] as const) {
      expect(isNetworkContact(sampleContact({ types: [t] }))).toBe(true)
      expect(isNurtureContact(sampleContact({ types: [t] }))).toBe(false)
    }
  })
  it('shows a Nurture contact who is also a vendor on both tabs', () => {
    const c = sampleContact({ types: ['nurture', 'vendor'] })
    expect(isNetworkContact(c)).toBe(true)
    expect(isNurtureContact(c)).toBe(true)
  })
  it('knows an organization from a person by its type', () => {
    expect(isOrganization(sampleContact({ types: ['organization', 'partner'] }))).toBe(true)
    expect(isOrganization(sampleContact({ types: ['partner'] }))).toBe(false)
  })
})

describe('Level and stage belong to Referral partners only', () => {
  it('gives a Referral partner their level and stage', () => {
    const c = sampleContact({ types: ['partner'], level: 'power', stage: 'Reaching Out' })
    expect(partnerLevel(c)).toBe('power')
    expect(partnerStage(c)).toBe('Reaching Out')
  })
  it('starts a Referral partner with nothing set at Potential and New Contact', () => {
    const c = sampleContact({ types: ['partner'], level: undefined, stage: undefined })
    expect(partnerLevel(c)).toBe('potential')
    expect(partnerStage(c)).toBe('New Contact')
  })
  it.each(['vendor', 'nurture', 'organization', 'unsure'] as const)('gives a %s no level and no stage, even if one is stored', (t) => {
    const c = sampleContact({ types: [t], level: 'power', stage: 'Active Partner' })
    expect(partnerLevel(c)).toBeNull()
    expect(partnerStage(c)).toBeNull()
  })
  it('treats a stored level or stage that is not ours as unset', () => {
    const c = sampleContact({ types: ['partner'], level: 'premier' as never, stage: 'Referring' as never })
    expect(partnerLevel(c)).toBe('potential')
    expect(partnerStage(c)).toBe('New Contact')
  })
  it('clears level and stage when a contact stops being a Referral partner', () => {
    const next = withTypes(sampleContact({ types: ['partner', 'vendor'], level: 'power', stage: 'Active Partner' }), ['vendor'])
    expect(next.types).toEqual(['vendor'])
    expect(next.level).toBeUndefined()
    expect(next.stage).toBeUndefined()
  })
  it('starts level and stage when a contact becomes a Referral partner', () => {
    const next = withTypes(sampleContact({ types: ['unsure'], level: undefined, stage: undefined }), ['partner'])
    expect(next.level).toBe('potential')
    expect(next.stage).toBe('New Contact')
  })
  it('keeps the level and stage of a partner who gains a second type', () => {
    const next = withTypes(sampleContact({ types: ['partner'], level: 'power', stage: 'Gone quiet' }), ['partner', 'organization'])
    expect(next.types).toEqual(['partner', 'organization'])
    expect(next.level).toBe('power')
    expect(next.stage).toBe('Gone quiet')
  })
})

describe('Quiet relationships', () => {
  it('is cold at 60 days or when nothing has been logged', () => {
    expect(isCold({ lastTalkedDays: 59 })).toBe(false)
    expect(isCold({ lastTalkedDays: 60 })).toBe(true)
    expect(isCold({ lastTalkedDays: null })).toBe(true)
  })
  it('says how long it has been in plain words', () => {
    expect(talkedLabel(null)).toBe("Haven't talked yet")
    expect(talkedLabel(0)).toBe('Talked today')
    expect(talkedLabel(12)).toBe('Talked 12d ago')
    expect(talkedLabel(90)).toBe('3 mo since you talked')
  })
})
