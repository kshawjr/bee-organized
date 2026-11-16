// @vitest-environment node
//
// TAG GROUPS (Kevin's rulings, 2026-11-15). One master tag list, used by
// Clients, Nurture and Network. Tags sit in groups; each screen shows only its
// own. This file pins the rules (lib/tags.ts) and the data change that puts
// the existing tags into their groups (migrations/tag_groups_and_cleanup.sql).
//
//   A) the nine groups, and which screens show each
//   B) a tag's group and screens come from its settings box
//   C) the list for one screen: only its groups, in order; a tag the record
//      already carries from another list stays in view to be unticked
//   D) before the data change runs, nothing moves: every tag shows where it
//      always did
//   E) a location's new tag: lands in the group for where it was made
//   F) the SQL: data only, guarded, every group it writes is a real group
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TAG_GROUPS, TAG_LIMIT_PER_LOCATION, GROUP_FOR_NEW_TAG, tagGroup, tagShowsOn, groupTags, newTagPlacement, tagLimitWords, tagReview, sectionTags,
} from './tags'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tag = (id: string, label: string, attrs: any, over: any = {}) => ({ id, label, sort_order: 0, attrs, location_id: null, ...over })
// The list as it stands AFTER the data change (a sample of every group).
const AFTER = [
  tag('hot', 'Hot Lead', { section: 'relationship', group: 'client_status', shows_on: ['clients'] }, { sort_order: 1010 }),
  tag('vip', 'VIP', { section: 'relationship', group: 'client_status', shows_on: ['clients'] }, { sort_order: 1020 }),
  tag('dnb', 'DO NOT BOOK', { section: 'relationship', group: 'client_status', shows_on: ['clients'] }, { sort_order: 1080 }),
  tag('ref', 'Referral', { section: 'relationship', group: 'relationship', shows_on: ['clients', 'network'] }, { sort_order: 1030 }),
  tag('par', 'Partner', { section: 'relationship', group: 'relationship', shows_on: ['network'] }, { sort_order: 3010 }),
  tag('ven', 'Vendor', { section: 'relationship', group: 'relationship', shows_on: ['network'] }, { sort_order: 3020 }),
  tag('rea', 'Realtor', { section: 'trade', group: 'home_property', shows_on: ['network'] }),
  tag('gc', 'General Contractor', { section: 'trade', group: 'home_property', shows_on: ['network'] }),
  tag('des', 'Designer', { section: 'trade', group: 'design_staging', shows_on: ['network'] }),
  tag('cle', 'Cleaner', { section: 'trade', group: 'cleaning_care', shows_on: ['network'] }),
  tag('mov', 'Mover', { section: 'trade', group: 'moving_hauling', shows_on: ['network'] }),
  tag('sen', 'Senior Living', { section: 'trade', group: 'senior_living', shows_on: ['network'] }),
  tag('est', 'Estate Sale', { section: 'trade', group: 'valuables_specialty', shows_on: ['network'] }),
  tag('net', 'Networking Group', { section: 'trade', group: 'professional_services', shows_on: ['network'] }),
  tag('app', 'Applicant', { section: 'trade', group: 'professional_services', shows_on: ['network'] }, { location_id: LOC }),
]
const labels = (sections: any[]) => sections.map((s) => [s.label, s.rows.map((r: any) => r.label)])

describe('A) the nine groups', () => {
  it('are the nine Kevin approved, in this order', () => {
    expect(TAG_GROUPS.map((g) => g.label)).toEqual(['Client status', 'Relationship', 'Home & property', 'Design & staging', 'Cleaning', 'Moving & hauling', 'Senior living', 'Valuables', 'Professional services'])
  })
  it('Client status shows on Clients (and so Nurture); every other group shows on Network', () => {
    expect(TAG_GROUPS.filter((g) => (g.screens as readonly string[]).includes('clients')).map((g) => g.key)).toEqual(['client_status'])
    expect(TAG_GROUPS.filter((g) => (g.screens as readonly string[]).includes('network')).map((g) => g.key)).toEqual(TAG_GROUPS.slice(1).map((g) => g.key))
  })
  it('the trade groups keep the keys the trades have carried since the tag merge', () => {
    expect(TAG_GROUPS.slice(2).map((g) => g.key)).toEqual(['home_property', 'design_staging', 'cleaning_care', 'moving_hauling', 'senior_living', 'valuables_specialty', 'professional_services'])
  })
})

describe("B) a tag's group and screens come from its settings box", () => {
  it('reads the group from attrs.group, and only a real group counts', () => {
    expect(tagGroup(AFTER[0])).toBe('client_status')
    expect(tagGroup(tag('x', 'X', { group: 'made_up' }))).toBeNull()
    expect(tagGroup(tag('x', 'X', {}))).toBeNull()
    expect(tagGroup(null)).toBeNull()
  })
  it('shows_on decides the screens: Referral is on both', () => {
    const ref = AFTER.find((t) => t.id === 'ref')!
    expect([tagShowsOn(ref, 'clients'), tagShowsOn(ref, 'network')]).toEqual([true, true])
    expect([tagShowsOn(AFTER[0], 'clients'), tagShowsOn(AFTER[0], 'network')]).toEqual([true, false])
    expect([tagShowsOn(AFTER[6], 'clients'), tagShowsOn(AFTER[6], 'network')]).toEqual([false, true])
  })
  it('with a group but no shows_on, the group decides', () => {
    expect([tagShowsOn(tag('x', 'X', { group: 'home_property' }), 'clients'), tagShowsOn(tag('x', 'X', { group: 'home_property' }), 'network')]).toEqual([false, true])
    expect(tagShowsOn(tag('x', 'X', { group: 'client_status' }), 'network')).toBe(false)
  })
})

describe('C) the list for one screen', () => {
  it('Clients: Client status in list order, then Relationship holding only Referral. No trade is offered', () => {
    expect(labels(groupTags(AFTER, 'clients'))).toEqual([['Client status', ['Hot Lead', 'VIP', 'DO NOT BOOK']], ['Relationship', ['Referral']]])
  })
  it('Network: Relationship, then the seven trade groups, each A to Z. No client status', () => {
    expect(labels(groupTags(AFTER, 'network'))).toEqual([
      ['Relationship', ['Referral', 'Partner', 'Vendor']],
      ['Home & property', ['General Contractor', 'Realtor']],
      ['Design & staging', ['Designer']], ['Cleaning', ['Cleaner']], ['Moving & hauling', ['Mover']], ['Senior living', ['Senior Living']], ['Valuables', ['Estate Sale']],
      ['Professional services', ['Applicant', 'Networking Group']],
    ])
  })
  it("a location's own tag sits in its group with the rest, not in a section of its own", () => {
    const s = groupTags(AFTER, 'network', "Seattle's own")
    expect(s.map((x) => x.key)).not.toContain('own')
    expect(s.at(-1)!.rows.map((r) => r.label)).toContain('Applicant')
  })
  it('a group with nothing in it is left out', () => {
    expect(groupTags(AFTER.filter((t) => t.id !== 'des'), 'network').map((s) => s.label)).not.toContain('Design & staging')
  })
  it('a tag the record already carries from another list is kept in view, last, and only for that record', () => {
    const s = groupTags(AFTER, 'clients', null, ['rea', 'des'])
    expect(labels(s).at(-1)).toEqual(['Also on this record', ['Designer', 'Realtor']])
    expect(labels(groupTags(AFTER, 'clients', null, [])).map((x) => x[0])).not.toContain('Also on this record')
    // ...and a kept id that belongs on this screen anyway is not listed twice
    expect(groupTags(AFTER, 'clients', null, ['hot']).flatMap((x) => x.rows).filter((r) => r.id === 'hot')).toHaveLength(1)
  })
})

describe('D) before the data change runs, nothing moves', () => {
  // The list as production holds it today: relationship tags have no group.
  const BEFORE = [
    tag('hot', 'Hot Lead', { section: 'relationship' }, { sort_order: 1010 }), tag('ven', 'Vendor', { section: 'relationship' }, { sort_order: 3020 }),
    tag('lead', 'Lead', { section: 'relationship' }, { location_id: LOC }), tag('new', 'No Section', {}),
  ]
  it('a tag with no group shows on every screen', () => {
    for (const t of BEFORE) expect([tagShowsOn(t, 'clients'), tagShowsOn(t, 'network')]).toEqual([true, true])
  })
  it('and sits where the two-section list put it: Relationship, Trade, then the location\'s own', () => {
    expect(labels(groupTags(BEFORE, 'clients', "Portland's own"))).toEqual(labels(sectionTags(BEFORE, "Portland's own")))
    expect(labels(groupTags(BEFORE, 'network', "Portland's own"))).toEqual([['Relationship', ['Hot Lead', 'Vendor']], ['Trade', ['No Section']], ["Portland's own", ['Lead']]])
  })
  it('half done (trades already carry their group, as they do today): Clients stops offering trades at once', () => {
    const today = [...BEFORE, tag('rea', 'Realtor', { section: 'trade', group: 'home_property' })]
    expect(groupTags(today, 'clients').flatMap((s) => s.rows.map((r) => r.label))).not.toContain('Realtor')
    expect(groupTags(today, 'network').find((s) => s.key === 'home_property')!.rows.map((r) => r.label)).toEqual(['Realtor'])
  })
})

describe("E) a location's new tag", () => {
  it('made on Clients lands in Client status and shows on Clients', () => {
    expect(newTagPlacement('clients')).toEqual({ group: 'client_status', shows_on: ['clients'], section: 'relationship', made_on: 'clients' })
  })
  it('made on Network lands in Professional services and shows on Network', () => {
    expect(newTagPlacement('network')).toEqual({ group: 'professional_services', shows_on: ['network'], section: 'trade', made_on: 'network' })
    expect(GROUP_FOR_NEW_TAG).toEqual({ clients: 'client_status', network: 'professional_services' })
  })
  it('anything else is treated as Clients, never as a group of its own', () => {
    for (const odd of [undefined, null, 'nurture', 'home_property', 5]) expect(newTagPlacement(odd).group).toBe('client_status')
  })
  it('the limit is ten, and the words say what to do about it', () => {
    expect(TAG_LIMIT_PER_LOCATION).toBe(10)
    expect(tagLimitWords(10)).toBe('This location already has 10 tags of its own, and the limit is 10. Delete one you no longer use, or ask corporate to add this one to the main list.')
  })
  it('the review mark is read from the settings box', () => {
    expect(tagReview({ attrs: { review: { decision: 'keep_local', at: '2026-11-15T00:00:00Z', by: 'u' } } })).toEqual({ decision: 'keep_local', at: '2026-11-15T00:00:00Z', by: 'u' })
    expect(tagReview({ attrs: {} })).toBeNull()
  })
})

describe('F) the SQL that puts the existing tags into groups', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), 'migrations', f), 'utf8')
  const code = (s: string) => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
  const RUN = read('tag_groups_and_cleanup.sql'); const UNDO = read('tag_groups_and_cleanup_undo.sql'); const CHECK = read('tag_groups_and_cleanup_check.sql')
  it.each([['the change', RUN], ['the undo', UNDO], ['the check', CHECK]])('%s changes no table, column, rule or function', (_n, sql) => {
    expect(code(sql)).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|GRANT)\b/i)
  })
  it('the check only reads', () => {
    expect(code(CHECK)).not.toMatch(/\b(INSERT|UPDATE|DELETE|DO \$\$|PERFORM)\b/i)
  })
  it('the change is ONE block, so it does all of it or none of it', () => {
    expect(code(RUN).match(/DO \$\$/g)).toHaveLength(1)
    expect(code(RUN).trimStart().startsWith('DO $$')).toBe(true)
  })
  it('every group it writes is one of the nine, and every "shows on" is a real screen', () => {
    const rows = Array.from(RUN.matchAll(/^\s+\('[0-9a-f-]{36}'::uuid, '((?:[^']|'')+)', '([a-z_]+)', '(\[[^\]]*\])'::jsonb\)/gm))
    expect(rows.length).toBe(48)
    const keys: readonly string[] = TAG_GROUPS.map((g) => g.key)
    for (const [, label, group, shows] of rows) {
      expect(keys, label).toContain(group)
      for (const s of JSON.parse(shows!)) expect(['clients', 'network'], label).toContain(s)
    }
    // The rulings, by name.
    const of = (name: string) => rows.filter((r) => r[1] === name).map((r) => [r[2], r[3]])
    expect(of('Hot Lead')).toEqual([['client_status', '["clients"]']])
    expect(of('Referral')).toEqual([['relationship', '["clients","network"]']])
    expect(of('Vendor')).toEqual([['relationship', '["network"]']])
    expect(of('Home Remodel')).toEqual([['home_property', '["network"]']])
    expect(of('Senior Living')).toEqual([['senior_living', '["network"]']])
    expect(of('Assisted Living')).toEqual([['senior_living', '["network"]']])
    expect(of('Applicant')).toEqual([['professional_services', '["network"]']])
  })
  it('it stops, changing nothing, if a tag or who carries it has moved since the dry run', () => {
    expect(RUN.match(/RAISE EXCEPTION 'STOPPED, nothing changed/g)!.length).toBeGreaterThanOrEqual(20)
  })
  it('every delete goes through the database\'s own delete, which keeps a whole copy', () => {
    expect(code(RUN)).not.toMatch(/DELETE FROM lookups/i)
    expect(code(RUN).match(/delete_tag_if_unused\(/g)).toHaveLength(4)
  })
  it('Builder is switched off and points at General Contractor; it is not deleted', () => {
    expect(RUN).toContain("UPDATE lookups SET is_active = false, attrs = attrs || jsonb_build_object('merged_into', gc::text), updated_at = now() WHERE id = builder;")
  })
  it('the Oak & Key client gets a note saying exactly that, and is not added to Network', () => {
    expect(RUN).toContain("SELECT id, location_uuid, 'buzz', 'Oak & Key', NULL, 'Bee Hub' FROM leads WHERE id = oak_client;")
    expect(code(RUN)).not.toMatch(/INSERT INTO partners/i)
  })
  it('nothing in it touches a client, a Network contact or a location row itself', () => {
    expect(code(RUN)).not.toMatch(/(UPDATE|DELETE FROM|INSERT INTO)\s+(leads|partners|locations)\b/i)
  })
  it('the undo puts back the four tags, every link and every settings box', () => {
    expect(UNDO).toContain('jsonb_populate_recordset(NULL::lookups')
    expect(UNDO).toContain('INSERT INTO lead_tags (lead_id, tag_lookup_id, added_at, added_by) VALUES')
    expect(UNDO).toContain('INSERT INTO partner_tags (partner_id, tag_lookup_id, added_at, added_by) VALUES')
    expect(UNDO).toContain('UPDATE lookups l SET attrs = v.attrs, is_active = v.is_active, updated_at = v.updated_at')
  })
})
