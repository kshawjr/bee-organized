import { describe, expect, it } from 'vitest'
import { RULED_NOT_SURE_IDS, mapLivePartner, mapLiveStage, summarizeMapping, tierKey } from './live-mapping'
import { PARTNER_LEVELS, PARTNER_STAGES } from './types'

// One test per mapping rule, in Kevin's order (see the header of
// live-mapping.ts). The shapes here are the ones production holds.

describe('Rule 1 — Referral partner', () => {
  it('tier Referral Partner: Referral partner, level Referral Partner', () => {
    const m = mapLivePartner({ tier: 'referral-partner', stage: 'New Contact' })
    expect(m.types).toEqual(['partner'])
    expect(m.level).toBe('referral')
    expect(m.why).toEqual(['Referral partner: tier is Referral Partner'])
    expect(m.flags).toEqual([])
  })
  it('tier Power Partner: Referral partner, level Power Partner', () => {
    const m = mapLivePartner({ tier: 'power-partner', stage: 'Active Partner' })
    expect(m.types).toEqual(['partner'])
    expect(m.level).toBe('power')
  })
  it.each(['Partner', 'Referral', ' referral '])('tagged %s, no tier: Referral partner, level Referral Partner', (tag) => {
    const m = mapLivePartner({ tier: null, stage: 'New Contact', tagLabels: ['Realtor', tag] })
    expect(m.types).toEqual(['partner'])
    expect(m.level).toBe('referral')
    expect(m.why).toEqual(['Referral partner: tagged Partner or Referral'])
  })
  it('has sent a lead, no tier and no tag: Referral partner, level Referral Partner', () => {
    const m = mapLivePartner({ tier: null, stage: 'New Contact', tagLabels: [], hasSentLead: true })
    expect(m.types).toEqual(['partner'])
    expect(m.level).toBe('referral')
    expect(m.why).toEqual(['Referral partner: has sent a lead'])
  })
  it('never produces Potential', () => {
    const levels = [
      mapLivePartner({ tier: 'referral-partner' }), mapLivePartner({ tagLabels: ['Partner'] }), mapLivePartner({ hasSentLead: true }),
    ].map((m) => m.level)
    expect(levels).toEqual(['referral', 'referral', 'referral'])
  })
  it('a Networking Contact who has sent a lead is a Referral partner, and the dropped tier is flagged', () => {
    const m = mapLivePartner({ tier: 'networking-contact', stage: 'New Contact', hasSentLead: true })
    expect(m.types).toEqual(['partner'])
    expect(m.level).toBe('referral')
    expect(m.flags).toEqual(['Tier Networking Contact dropped: another rule decided the type'])
  })
})

describe('Rule 2 — Vendor / Service Provider', () => {
  it('tier Service Provider: Vendor, no level, no stage', () => {
    const m = mapLivePartner({ tier: 'service-provider', stage: 'New Contact' })
    expect(m).toMatchObject({ types: ['vendor'], level: null, stage: null })
    expect(m.why).toEqual(['Vendor / Service Provider: tier is Service Provider'])
  })
  it('tagged Vendor, no tier: Vendor, no level, no stage', () => {
    const m = mapLivePartner({ tier: null, stage: 'New Contact', tagLabels: ['Vendor', 'Handyman'] })
    expect(m).toMatchObject({ types: ['vendor'], level: null, stage: null })
  })
  it('a Networking Contact tagged Vendor is a Vendor', () => {
    expect(mapLivePartner({ tier: 'networking-contact', tagLabels: ['vendor'] }).types).toEqual(['vendor'])
  })
})

describe('Rules 1 and 2 together', () => {
  it('holds both types, with the partner level and stage, and is flagged', () => {
    const m = mapLivePartner({ tier: 'referral-partner', stage: 'Reaching Out', tagLabels: ['Vendor'] })
    expect(m.types).toEqual(['partner', 'vendor'])
    expect(m.level).toBe('referral')
    expect(m.stage).toBe('Reaching Out')
    expect(m.flags).toEqual(['Meets both the Referral partner and the Vendor rule, so holds both types'])
  })
})

describe('Rule 3 — tier Networking Contact', () => {
  it('Not sure yet, no level, no stage', () => {
    const m = mapLivePartner({ tier: 'networking-contact', stage: 'New Contact', tagLabels: ['Networking Group'] })
    expect(m).toMatchObject({ types: ['unsure'], level: null, stage: null })
    expect(m.why).toEqual(['Not sure yet: tier is Networking Contact'])
    expect(m.flags).toEqual([])
  })
})

describe('Rule 4 — everything else is Not sure yet', () => {
  it.each(['Realtor', 'Senior Living', 'Designer', 'Mover', 'Handyman', 'Electrician', 'Networking Group'])(
    'a trade tag alone (%s) is never used to guess a type', (tag) => {
      expect(mapLivePartner({ tier: null, stage: 'New Contact', tagLabels: [tag] })).toMatchObject({ types: ['unsure'], level: null, stage: null })
    })
  it('came from a client record, no tier and no tag', () => {
    expect(mapLivePartner({ tier: null, stage: 'New Contact', tagLabels: [], hasSentLead: false }).types).toEqual(['unsure'])
  })
  it('typed in bare, with nothing at all', () => {
    const m = mapLivePartner({})
    expect(m).toMatchObject({ types: ['unsure'], level: null, stage: null, flags: [] })
    expect(m.why).toEqual(['Not sure yet: no tier, tag or sent lead says what they are'])
  })
  it('does not read "Partner" out of a longer tag name', () => {
    expect(mapLivePartner({ tagLabels: ['Partner Yoga Studio', 'Referral Network'] }).types).toEqual(['unsure'])
  })
  it('a tier that is not one of the four live tiers decides nothing and is flagged', () => {
    const m = mapLivePartner({ tier: 'Gold' })
    expect(m.types).toEqual(['unsure'])
    expect(m.flags).toEqual(['Tier “Gold” is not one of the four live tiers and was not used'])
  })
})

describe('Rule 5 — the stage carries across for Referral partners only', () => {
  it.each([
    ['New Contact', 'New Contact'],
    ['Reaching Out', 'Reaching Out'],
    ['Building the Relationship', 'Building the Relationship'],
    ['Building', 'Building the Relationship'],
    ['Active Partner', 'Active Partner'],
    ['Dormant', 'Gone quiet'],
  ])('live “%s” becomes “%s”', (live, ours) => {
    const m = mapLivePartner({ tier: 'referral-partner', stage: live })
    expect(m.stage).toBe(ours)
    expect(m.flags).toEqual([])
  })
  it('a Referral partner with no live stage starts at New Contact, flagged', () => {
    const m = mapLivePartner({ tier: 'referral-partner', stage: null })
    expect(m.stage).toBe('New Contact')
    expect(m.flags).toEqual(['No live stage, so they start at New Contact'])
  })
  it('a Referral partner in the retired live stage Customer starts at New Contact, flagged', () => {
    const m = mapLivePartner({ hasSentLead: true, stage: 'Customer' })
    expect(m.stage).toBe('New Contact')
    expect(m.flags).toEqual(['Live stage “Customer” is not one of the five, so they start at New Contact'])
  })
  it.each([
    [{ tier: 'service-provider' }], [{ tier: 'networking-contact' }], [{ tier: null }], [{ tagLabels: ['Vendor'] }],
  ])('every other type drops its stage: %j', (facts) => {
    expect(mapLivePartner({ ...facts, stage: 'Active Partner' }).stage).toBeNull()
  })
  it('dropping the default New Contact is silent; dropping a stage someone chose is flagged', () => {
    expect(mapLivePartner({ tier: null, stage: 'New Contact' }).flags).toEqual([])
    expect(mapLivePartner({ tier: null, stage: 'Reaching Out' }).flags)
      .toEqual(['Live stage “Reaching Out” dropped: only a Referral partner has a stage'])
  })
  it('only ever returns one of the five stages and one of the three levels', () => {
    const everyTier = ['referral-partner', 'power-partner', 'service-provider', 'networking-contact', null, 'Gold']
    const everyStage = ['New Contact', 'Reaching Out', 'Building', 'Active Partner', 'Dormant', 'Customer', null, 'nonsense']
    for (const tier of everyTier) for (const stage of everyStage) for (const hasSentLead of [true, false]) {
      const m = mapLivePartner({ tier, stage, hasSentLead })
      if (m.stage !== null) expect(PARTNER_STAGES).toContain(m.stage)
      if (m.level !== null) expect(PARTNER_LEVELS).toContain(m.level)
      expect(m.types.includes('partner')).toBe(m.level !== null && m.stage !== null)
      expect(m.types as string[]).not.toContain('client')
      expect(m.types as string[]).not.toContain('nurture')
      expect(m.types as string[]).not.toContain('organization')
    }
  })
})

describe('Rule 6 — four contacts Kevin ruled are not Referral partners', () => {
  it('holds exactly four ids', () => {
    expect(RULED_NOT_SURE_IDS).toHaveLength(4)
    expect(new Set(RULED_NOT_SURE_IDS).size).toBe(4)
    for (const id of RULED_NOT_SURE_IDS) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
  it.each([...RULED_NOT_SURE_IDS])('%s is Not sure yet although a lead points at it', (id) => {
    const m = mapLivePartner({ id, tier: null, stage: 'New Contact', tagLabels: [], hasSentLead: true })
    expect(m).toMatchObject({ types: ['unsure'], level: null, stage: null })
    expect(m.why).toEqual(['Not sure yet: Kevin ruled this contact is not a Referral partner'])
    expect(m.flags).toEqual(['Ruled Not sure yet; the rules alone would have read: has sent a lead'])
  })
  it('stays Not sure yet whatever tier, tag or lead it is given', () => {
    const m = mapLivePartner({ id: RULED_NOT_SURE_IDS[0], tier: 'power-partner', stage: 'Active Partner', tagLabels: ['Partner', 'Vendor'], hasSentLead: true })
    expect(m).toMatchObject({ types: ['unsure'], level: null, stage: null })
    expect(m.flags).toEqual([
      'Ruled Not sure yet; the rules alone would have read: tier is Power Partner, tagged Partner or Referral, has sent a lead, tagged Vendor',
      'Live stage “Active Partner” dropped: only a Referral partner has a stage',
    ])
  })
  it('reads the id whatever its case', () => {
    expect(mapLivePartner({ id: ` ${RULED_NOT_SURE_IDS[1]!.toUpperCase()} `, hasSentLead: true }).types).toEqual(['unsure'])
  })
  it('touches nobody else: the same facts under any other id are a Referral partner', () => {
    const facts = { tier: null, stage: 'New Contact', tagLabels: [], hasSentLead: true }
    expect(mapLivePartner({ ...facts, id: '11111111-2222-4333-8444-555555555555' }).types).toEqual(['partner'])
    expect(mapLivePartner(facts).types).toEqual(['partner'])
  })
})

describe('Reading what is stored', () => {
  it('reads a tier by its key or its label, any case', () => {
    expect(tierKey('Referral Partner')).toBe('referral-partner')
    expect(tierKey(' POWER_partner ')).toBe('power-partner')
    expect(tierKey(null)).toBe('')
    expect(mapLivePartner({ tier: 'Service Provider' }).types).toEqual(['vendor'])
  })
  it('reads a stage whatever its case or spacing', () => {
    expect(mapLiveStage('  active   partner ')).toBe('Active Partner')
    expect(mapLiveStage('DORMANT')).toBe('Gone quiet')
    expect(mapLiveStage('')).toBeNull()
    expect(mapLiveStage('Referring')).toBeNull()
  })
  it('the live type column is not an input: the same facts map the same whatever it says', () => {
    const facts = { tier: 'referral-partner', stage: 'New Contact' }
    expect(mapLivePartner({ ...facts, type: 'contact' } as never)).toEqual(mapLivePartner(facts))
  })
})

describe('Counting a batch for the dry-run report', () => {
  it('counts each bucket once, and a both-types contact under Referral partner', () => {
    expect(summarizeMapping([
      { tier: 'referral-partner', stage: 'New Contact' },
      { tier: 'power-partner', stage: 'Active Partner' },
      { tier: 'referral-partner', stage: 'New Contact', tagLabels: ['Vendor'] },
      { tier: 'service-provider', stage: 'New Contact' },
      { tier: 'networking-contact', stage: 'New Contact' },
      { tier: null, stage: 'New Contact', tagLabels: ['Realtor'] },
      { tier: null, stage: null, hasSentLead: true },
    ])).toEqual({
      total: 7, referralPartner: 4, referralAndVendor: 1, vendorOnly: 1, notSure: 2, powerPartner: 1, ruledNotSure: 0, flagged: 2,
    })
  })
  it('counts a ruled contact as Not sure yet, and says how many were ruled', () => {
    const s = summarizeMapping([{ id: RULED_NOT_SURE_IDS[2], hasSentLead: true }, { hasSentLead: true }])
    expect(s).toMatchObject({ total: 2, referralPartner: 1, notSure: 1, ruledNotSure: 1 })
  })
  it('every contact lands in exactly one of Referral partner, Vendor only, or Not sure yet', () => {
    const s = summarizeMapping([{}, { tier: 'service-provider' }, { hasSentLead: true }, { tagLabels: ['Vendor', 'Partner'] }])
    expect(s.referralPartner + s.vendorOnly + s.notSure).toBe(s.total)
  })
})
