import { describe, expect, it } from 'vitest'
import {
  NO_FILTERS, anyFilterOn, applyListFilters, contactFromRow, daysSince, dueForFollowUp, groupForList,
  matchesSearch, menuFilterCount, tagsInUse, typeCounts, type ListFilters, type NetworkListRow,
} from './list'
import { maySeeNewNetwork, NEW_NETWORK_ROLES } from './access'
import fixture from './__fixtures__/live-mapping-sql.json'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const TODAY = '2026-11-15'
const TAGS: Record<string, string> = { t1: 'Realtor', t2: 'Vendor', t3: 'Senior Living' }
const ctx = (over: Partial<Parameters<typeof contactFromRow>[1]> = {}) => ({ tagLabel: (id: string) => TAGS[id], nowMs: NOW, ...over })
const row = (over: Partial<NetworkListRow> = {}): NetworkListRow => ({
  id: 'p1', locationId: 'loc-1', locationName: 'Greensboro', name: 'Lisa Snyder', company: 'Compass', title: 'Realtor',
  phone: '(303) 555-0142', email: 'lisa@compass.com', networkTypes: ['partner'], partnerLevel: 'referral',
  partnerStage: 'Reaching Out', tagIds: ['t1'], lastContactedAt: '2026-11-10T12:00:00Z', isCustomer: false, ...over,
})
const make = (over: Partial<NetworkListRow> = {}, c = ctx()) => contactFromRow(row(over), c)
const f = (over: Partial<ListFilters> = {}): ListFilters => ({ ...NO_FILTERS, ...over })

describe('Who may see the new Network', () => {
  it('is super admins only', () => {
    expect(NEW_NETWORK_ROLES).toEqual(['super_admin'])
    expect(maySeeNewNetwork('super_admin')).toBe(true)
  })
  it.each(['admin', 'corporate', 'owner', 'manager', 'lite_user', 'franchise', '', null, undefined, 'SUPER_ADMIN'])('says no to %s', (role) => {
    expect(maySeeNewNetwork(role)).toBe(false)
  })
})

describe('A stored row becomes a contact', () => {
  it('reads the three new columns as they are stored', () => {
    const c = make()
    expect(c.types).toEqual(['partner'])
    expect(c.level).toBe('referral')
    expect(c.stage).toBe('Reaching Out')
  })
  it('keeps both types of a contact who holds two', () => {
    expect(make({ networkTypes: ['vendor', 'partner'] }).types).toEqual(['partner', 'vendor'])
  })
  it('reads a row the backfill never reached as Not sure yet, with no level or stage', () => {
    const c = make({ networkTypes: null, partnerLevel: null, partnerStage: null })
    expect(c.types).toEqual(['unsure'])
    expect(c.level).toBeUndefined()
    expect(c.stage).toBeUndefined()
  })
  it('never shows a level or stage on someone who is not a Referral partner, even if one is stored', () => {
    const c = make({ networkTypes: ['vendor'], partnerLevel: 'power', partnerStage: 'Active Partner' })
    expect(c.level).toBeUndefined()
    expect(c.stage).toBeUndefined()
  })
  it('does not trust a level or stage word that is not one of ours', () => {
    const c = make({ partnerLevel: 'premier', partnerStage: 'Dormant' })
    expect(c.level).toBe('potential')
    expect(c.stage).toBe('New Contact')
  })
  it('carries tag names, A to Z, and leaves out a tag id it cannot name', () => {
    const c = make({ tagIds: ['t2', 'gone', 't1'] })
    expect(c.tags).toEqual(['Realtor', 'Vendor'])
    expect(c.tagIds.slice().sort()).toEqual(['t1', 't2'])
  })
  it('counts whole days since the last logged contact, and says null when nothing is logged', () => {
    expect(make().lastTalkedDays).toBe(5)
    expect(make({ lastContactedAt: null }).lastTalkedDays).toBeNull()
    expect(daysSince('not a date', NOW)).toBeNull()
    expect(daysSince('2026-11-16T12:00:00Z', NOW)).toBe(0)
  })
  it('takes its follow-up date from a reminder and its referral numbers from the real rollup', () => {
    const c = make({}, ctx({ nextFollowUp: '2026-11-12', referral: { count: 3, converted: 2, revenue: 4200 } }))
    expect(c.nextFollowUp).toBe('2026-11-12')
    expect([c.referred, c.converted, c.revenue]).toEqual([3, 2, 4200])
  })
  it('has no referrals and no follow-up when nothing says so', () => {
    const c = make()
    expect([c.referred, c.converted, c.revenue, c.nextFollowUp]).toEqual([0, 0, 0, undefined])
  })
})

describe('Search: name, company, email and phone', () => {
  const c = make()
  it.each([['lisa', 'name'], ['SNYDER', 'name, any case'], ['compass', 'company'], ['lisa@compass', 'email'], ['  compass  ', 'with spaces round it']])('finds “%s” (%s)', (q) => {
    expect(matchesSearch(c, q)).toBe(true)
  })
  it.each(['303', '555-0142', '(303) 555', '3035550142', '303.555.0142'])('finds the phone typed as “%s”', (q) => {
    expect(matchesSearch(c, q)).toBe(true)
  })
  it('does not find a number that is not in the phone', () => {
    expect(matchesSearch(c, '720')).toBe(false)
  })
  it('does not match a phone on one or two digits', () => {
    expect(matchesSearch(c, '55')).toBe(false)
  })
  it('searches a number inside a name as words, not as a phone', () => {
    expect(matchesSearch(make({ name: 'Studio 5550', phone: null }), 'studio 5550')).toBe(true)
    expect(matchesSearch(c, 'studio 5550')).toBe(false)
  })
  it('does not search the job title or the tags', () => {
    expect(matchesSearch(make({ title: 'Stager', company: null }), 'stager')).toBe(false)
  })
  it('an empty box matches everyone', () => {
    expect(matchesSearch(c, '   ')).toBe(true)
  })
})

describe('Needs follow-up uses reminders only', () => {
  it('a reminder due today or earlier needs follow-up', () => {
    expect(dueForFollowUp({ nextFollowUp: '2026-11-15' }, TODAY)).toBe(true)
    expect(dueForFollowUp({ nextFollowUp: '2026-11-01' }, TODAY)).toBe(true)
  })
  it('a reminder for a later day does not, yet', () => {
    expect(dueForFollowUp({ nextFollowUp: '2026-11-16' }, TODAY)).toBe(false)
  })
  it('no reminder means no follow-up, however long it has been quiet', () => {
    expect(dueForFollowUp({ nextFollowUp: undefined }, TODAY)).toBe(false)
    const never = make({ lastContactedAt: null })
    const longAgo = make({ lastContactedAt: '2026-01-01T00:00:00Z' })
    expect(applyListFilters([never, longAgo], f({ followUp: true }), TODAY)).toEqual([])
  })
})

describe('Filters', () => {
  const partner = make({ id: 'a', name: 'Ann Partner' })
  const power = make({ id: 'b', name: 'Bo Power', partnerLevel: 'power', partnerStage: 'Active Partner', tagIds: [] })
  const both = make({ id: 'c', name: 'Cy Both', networkTypes: ['partner', 'vendor'], partnerStage: 'New Contact', tagIds: ['t2'] })
  const vendor = make({ id: 'd', name: 'Di Vendor', networkTypes: ['vendor'], partnerLevel: null, partnerStage: null, tagIds: ['t2', 't3'] })
  const unsure = make({ id: 'e', name: 'Ed Unsure', networkTypes: ['unsure'], partnerLevel: null, partnerStage: null, tagIds: [] })
  const due = make({ id: 'g', name: 'Gil Due', networkTypes: ['unsure'], partnerLevel: null, partnerStage: null, tagIds: [] }, ctx({ nextFollowUp: '2026-11-10' }))
  const all = [partner, power, both, vendor, unsure, due]
  const ids = (list: { id: string }[]) => list.map((c) => c.id)

  it('with nothing on, lists everyone', () => {
    expect(ids(applyListFilters(all, NO_FILTERS, TODAY))).toEqual(['a', 'b', 'c', 'd', 'e', 'g'])
    expect(anyFilterOn(NO_FILTERS)).toBe(false)
  })
  it('by type: a contact with two types is found under either', () => {
    expect(ids(applyListFilters(all, f({ type: 'partner' }), TODAY))).toEqual(['a', 'b', 'c'])
    expect(ids(applyListFilters(all, f({ type: 'vendor' }), TODAY))).toEqual(['c', 'd'])
    expect(ids(applyListFilters(all, f({ type: 'unsure' }), TODAY))).toEqual(['e', 'g'])
    expect(applyListFilters(all, f({ type: 'nurture' }), TODAY)).toEqual([])
  })
  it('by partner level: only Referral partners at one of the picked levels', () => {
    expect(ids(applyListFilters(all, f({ levels: ['power'] }), TODAY))).toEqual(['b'])
    expect(ids(applyListFilters(all, f({ levels: ['referral', 'power'] }), TODAY))).toEqual(['a', 'b', 'c'])
    expect(applyListFilters(all, f({ levels: ['potential'] }), TODAY)).toEqual([])
  })
  it('by partner stage: only Referral partners in one of the picked stages', () => {
    expect(ids(applyListFilters(all, f({ stages: ['Reaching Out'] }), TODAY))).toEqual(['a'])
    expect(ids(applyListFilters(all, f({ stages: ['New Contact', 'Active Partner'] }), TODAY))).toEqual(['b', 'c'])
  })
  it('by tag: anyone carrying any of the picked tags', () => {
    expect(ids(applyListFilters(all, f({ tagIds: ['t2'] }), TODAY))).toEqual(['c', 'd'])
    expect(ids(applyListFilters(all, f({ tagIds: ['t1', 't3'] }), TODAY))).toEqual(['a', 'd'])
  })
  it('by Needs follow-up', () => {
    expect(ids(applyListFilters(all, f({ followUp: true }), TODAY))).toEqual(['g'])
  })
  it('filters narrow together', () => {
    expect(ids(applyListFilters(all, f({ type: 'vendor', tagIds: ['t3'] }), TODAY))).toEqual(['d'])
    expect(ids(applyListFilters(all, f({ type: 'partner', q: 'cy' }), TODAY))).toEqual(['c'])
    expect(applyListFilters(all, f({ type: 'unsure', levels: ['referral'] }), TODAY)).toEqual([])
  })
  it('counts what is on in the Filters menu, and knows when anything narrows the list', () => {
    const on = f({ levels: ['power', 'referral'], stages: ['Gone quiet'], followUp: true })
    expect(menuFilterCount(on)).toBe(4)
    expect(anyFilterOn(on)).toBe(true)
    expect(menuFilterCount(f({ type: 'vendor', tagIds: ['t1'], q: 'x' }))).toBe(0)
    expect(anyFilterOn(f({ q: ' x ' }))).toBe(true)
    expect(anyFilterOn(f({ tagIds: ['t1'] }))).toBe(true)
  })
  it('counts each type pill, a two-type contact under both', () => {
    expect(typeCounts(all)).toEqual({ all: 6, partner: 3, vendor: 2, nurture: 0, organization: 0, unsure: 2 })
  })
  it('lists the tags in use with how many carry each, by name', () => {
    expect(tagsInUse(all, (id) => TAGS[id])).toEqual([
      { id: 't1', label: 'Realtor', count: 1 }, { id: 't3', label: 'Senior Living', count: 1 }, { id: 't2', label: 'Vendor', count: 2 },
    ])
  })
  it('groups by type in the type order, A to Z inside, a two-type contact in both', () => {
    const groups = groupForList(all, NO_FILTERS)
    // Not sure yet first (Kevin, 2026-11-19)
    expect(groups.map((g) => g.type)).toEqual(['unsure', 'partner', 'vendor', 'nurture', 'organization'])
    expect(ids(groups[1]!.contacts)).toEqual(['a', 'b', 'c'])
    expect(ids(groups[2]!.contacts)).toEqual(['c', 'd'])
    expect(groups[3]!.contacts).toEqual([])
  })
  it('shows one group when one type is picked, so a two-type contact is listed once', () => {
    const groups = groupForList(applyListFilters(all, f({ type: 'vendor' }), TODAY), f({ type: 'vendor' }))
    expect(groups.map((g) => g.type)).toEqual(['vendor'])
    expect(ids(groups[0]!.contacts)).toEqual(['c', 'd'])
  })
  it('flattens to one A to Z list when searching, filtering by tag, or asking for Needs follow-up', () => {
    expect(groupForList(all, f({ q: 'a' })).map((g) => g.type)).toEqual([null])
    expect(groupForList(all, f({ tagIds: ['t2'] })).map((g) => g.type)).toEqual([null])
    expect(groupForList(all, f({ followUp: true })).map((g) => g.type)).toEqual([null])
    expect(ids(groupForList([unsure, partner], f({ q: 'x' }))[0]!.contacts)).toEqual(['a', 'e'])
  })
})

describe("Production's 263 live contacts, as the backfill stored them", () => {
  // The slice 2 fixture holds every shape of contact in production with the
  // type, level and stage the SQL gave it (no names, no ids). Those answers
  // are what is now stored, so they are fed in here as stored values.
  const rows: NetworkListRow[] = fixture.shapes.flatMap((s, i) => Array.from({ length: s.live }, (_, n) => ({
    id: `s${i}-${n}`, locationId: 'loc', name: `Contact ${i}-${n}`, networkTypes: s.types, partnerLevel: s.level, partnerStage: s.stage_out, tagIds: [],
  })))
  const contacts = rows.map((r) => contactFromRow(r, ctx()))

  it('is 263 contacts', () => {
    expect(contacts).toHaveLength(263)
  })
  it('counts 51 Referral partners, 197 Not sure yet, and 21 Vendors: 15 who are only that, 6 who are also partners', () => {
    const n = typeCounts(contacts)
    expect([n.all, n.partner, n.unsure, n.vendor, n.nurture, n.organization]).toEqual([263, 51, 197, 21, 0, 0])
    expect(contacts.filter((c) => c.types.join() === 'vendor')).toHaveLength(15)
    expect(contacts.filter((c) => c.types.join() === 'partner,vendor')).toHaveLength(6)
  })
  it('every Referral partner is at level Referral Partner; 50 at New Contact and 1 at Reaching Out', () => {
    expect(applyListFilters(contacts, f({ levels: ['referral'] }), TODAY)).toHaveLength(51)
    expect(applyListFilters(contacts, f({ levels: ['power', 'potential'] }), TODAY)).toHaveLength(0)
    expect(applyListFilters(contacts, f({ stages: ['New Contact'] }), TODAY)).toHaveLength(50)
    expect(applyListFilters(contacts, f({ stages: ['Reaching Out'] }), TODAY)).toHaveLength(1)
  })
})
