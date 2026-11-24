// @vitest-environment node
//
// The two routes that WRITE under Kevin's tag rulings (2026-11-15), against an
// in-memory stand-in for the database (lib/testing/memory-db.ts):
//
//   A) POST /api/lookups — a location's new tag lands in the group for the
//      screen it was made on, and a location may have ten of its own
//   B) POST /api/tags/review — corporate's review of a location's own tag:
//      reviewed-keep-local, merge into another tag, delete
//
// What these routes write was also run against a Postgres copy of production:
// ~/Projects/bee-organized-repair-reports/2026-11-15/tag-cleanup/.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeMemoryDb, type MemoryDb } from './testing/memory-db'

const h = vi.hoisted(() => ({ db: null as any, hubUser: null as any }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.db.from(t), rpc: (fn: string, a: any) => h.db.client.rpc(fn, a) } }))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => {}),
  getHubUser: vi.fn(async () => h.hubUser),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))

import { POST as createLookup } from '@/app/api/lookups/route'
import { POST as review } from '@/app/api/tags/review/route'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const CORP = id(1), CORP_OFF = id(2), OWN = id(3), OWN2 = id(4), ELSEWHERE = id(5)
const post = (handler: any, body: any) => handler({ json: async () => body } as any).then(async (r: any) => ({ status: r.status, body: await r.json() }))
const db = (): MemoryDb => h.db
const as = (role: string, location_id: string | null = null) => { h.hubUser = { id: 'u-1', role, location_id } }
const ownTags = (n: number, active = true) => Array.from({ length: n }, (_, i) => ({ id: id(100 + i), category: 'tags', label: `Own ${i}`, location_id: LOC, is_active: active, attrs: {}, sort_order: 4000 + i }))

beforeEach(() => {
  h.db = makeMemoryDb({
    locations: [{ id: LOC, name: 'Portland', lifecycle_status: 'active', subscription_status: 'active' }, { id: OTHER, name: 'Seattle' }],
    lookups: [
      { id: CORP, category: 'tags', label: 'Networking Group', icon: '🤝', location_id: null, is_active: true, attrs: { section: 'trade', group: 'professional_services' }, sort_order: 2350 },
      { id: CORP_OFF, category: 'tags', label: 'Housekeeper', location_id: null, is_active: false, attrs: {}, sort_order: 2130 },
      { id: OWN, category: 'tags', label: 'Business Networking Group', location_id: LOC, is_active: true, attrs: { section: 'trade', created_by_user: 'u-9' }, sort_order: 4010 },
      { id: OWN2, category: 'tags', label: 'Chamber', location_id: LOC, is_active: true, attrs: {}, sort_order: 4020 },
      { id: ELSEWHERE, category: 'tags', label: 'Garden Club', location_id: OTHER, is_active: true, attrs: {}, sort_order: 4030 },
    ],
    lead_tags: [{ lead_id: 'c1', tag_lookup_id: OWN, added_at: '2026-01-01T00:00:00Z', added_by: 'u-9' }, { lead_id: 'c2', tag_lookup_id: OWN, added_at: '2026-01-02T00:00:00Z', added_by: null }, { lead_id: 'c2', tag_lookup_id: CORP, added_at: '2025-06-01T00:00:00Z', added_by: 'u-3' }],
    partner_tags: [{ partner_id: 'p1', tag_lookup_id: OWN, added_at: '2026-02-01T00:00:00Z', added_by: 'u-9' }, { partner_id: 'p9', tag_lookup_id: CORP, added_at: '2025-01-01T00:00:00Z', added_by: null }],
    tag_deletions: [], feedback_items: [],
  })
  // The database's own delete: refuses while anyone carries the tag, else copies it to tag_deletions and removes it.
  db().rpc.delete_tag_if_unused = ({ p_id, p_by }, d) => {
    const row = d.tables.lookups.find((r) => r.id === p_id)
    if (!row) return ['not_found']
    const b: string[] = [...(row._blockers || [])]
    const c = d.tables.lead_tags.filter((r) => r.tag_lookup_id === p_id).length, n = d.tables.partner_tags.filter((r) => r.tag_lookup_id === p_id).length
    if (c) b.push(`clients:${c}`); if (n) b.push(`network:${n}`)
    if (b.length) return b
    d.tables.tag_deletions.push({ id: `del-${d.tables.tag_deletions.length + 1}`, tag_id: row.id, label: row.label, location_id: row.location_id, deleted_by: p_by, deleted_at: new Date().toISOString(), tag_row: { ...row } })
    d.tables.lookups = d.tables.lookups.filter((r) => r.id !== p_id)
    return []
  }
})
const created = () => db().tables.lookups.at(-1)
// A tag made on Network must name its group; these tests pick Home & Property unless they say otherwise.
const make = (over: any = {}) => post(createLookup, { category: 'tags', label: 'Plumber', location_id: LOC, ...(over.made_on === 'network' && !('group' in over) ? { group: 'home_property' } : {}), ...over })

describe("A) a location's new tag", () => {
  it('made on Network: it goes in the group the owner picked, and shows on Network', async () => {
    as('owner', LOC)
    const r = await make({ made_on: 'network', group: 'home_property' })
    expect(r.status).toBe(200)
    expect(created().attrs).toMatchObject({ group: 'home_property', shows_on: ['network'], section: 'trade', made_on: 'network', created_by_user: 'u-1' })
    expect(created()).toMatchObject({ label: 'Plumber', location_id: LOC, category: 'tags' })
  })
  it.each(['relationship', 'home_property', 'design_staging', 'cleaning_care', 'moving_hauling', 'senior_living', 'valuables_specialty', 'professional_services'])('made on Network, picked %s: that is the group it gets', async (group) => {
    as('owner', LOC)
    expect((await make({ made_on: 'network', group })).status).toBe(200)
    expect(created().attrs).toMatchObject({ group, shows_on: ['network'], section: group === 'relationship' ? 'relationship' : 'trade' })
  })
  it.each([[undefined], [''], ['client_status'], ['made_up']])('made on Network with group %j: refused, the eight are named, and nothing is read or written', async (group) => {
    as('owner', LOC)
    const r = await make({ made_on: 'network', group })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'group_required', allowed: ['relationship', 'home_property', 'design_staging', 'cleaning_care', 'moving_hauling', 'senior_living', 'valuables_specialty', 'professional_services'] })
    expect(db().calls).toEqual([])
  })
  it('made on Network with an emoji: stored as sent', async () => {
    as('owner', LOC)
    expect((await make({ made_on: 'network', icon: '🏡' })).status).toBe(200)
    expect(created().icon).toBe('🏡')
  })
  it.each(['🏡 home', 'home', '🏡🔧'])('made on Network with %j as its emoji: refused, nothing read or written', async (icon) => {
    as('owner', LOC)
    const r = await make({ made_on: 'network', icon })
    expect([r.status, r.body]).toEqual([400, { error: 'icon_not_allowed' }])
    expect(db().calls).toEqual([])
  })
  it('made on Clients with an emoji that is not on the grid: still refused', async () => {
    as('owner', LOC)
    const r = await make({ label: 'Snowbird', made_on: 'clients', icon: '🏡' })
    expect([r.status, r.body]).toEqual([400, { error: 'icon_not_allowed' }])
    expect(db().calls).toEqual([])
  })
  it('made on Clients: a group sent along is not used', async () => {
    as('owner', LOC)
    await make({ label: 'Snowbird', made_on: 'clients', group: 'home_property' })
    expect(created().attrs).toMatchObject({ group: 'client_status', shows_on: ['clients'] })
  })
  it('made on Clients: Client Status, shows on Clients', async () => {
    as('manager', LOC)
    await make({ label: 'Snowbird', made_on: 'clients' })
    expect(created().attrs).toMatchObject({ group: 'client_status', shows_on: ['clients'], section: 'relationship', made_on: 'clients' })
  })
  it('with no screen named (an older caller) it is treated as Clients', async () => {
    as('owner', LOC)
    await make({ label: 'Snowbird' })
    expect(created().attrs).toMatchObject({ group: 'client_status', shows_on: ['clients'] })
  })
  it('the server decides the group: one sent by the screen is not used', async () => {
    as('owner', LOC)
    await make({ made_on: 'network', group: 'senior_living', attrs: { group: 'client_status', shows_on: ['clients', 'network'] } })
    expect(created().attrs).toMatchObject({ group: 'senior_living', shows_on: ['network'] })
  })
  it('a corporate tag (no location) is not placed by this rule and is not limited', async () => {
    as('super_admin')
    const r = await post(createLookup, { category: 'tags', label: 'Plumber', attrs: { section: 'trade' } })
    expect(r.status).toBe(200)
    expect(created().location_id ?? null).toBeNull()
    expect(created().attrs).toEqual({ section: 'trade' })
  })

  // FL-75 slice 3 (2026-11-23, Kevin): the limit is 15 (was 10 until 2026-11-23).
  describe('the limit of 15', () => {
    it('the fifteenth is created; the sixteenth is refused and nothing is written', async () => {
      as('owner', LOC)
      db().tables.lookups.push(...ownTags(12)) // 2 already + 12 = 14
      expect((await make({ label: 'Fifteenth', made_on: 'network' })).status).toBe(200)
      created().is_active = true // the real table switches a new row on by default; this stand-in has no defaults
      const before = db().tables.lookups.length
      const r = await make({ label: 'Sixteenth', made_on: 'network' })
      expect(r.status).toBe(409)
      expect(r.body).toEqual({ error: 'tag_limit', limit: 15, count: 15 })
      expect(db().tables.lookups.length).toBe(before)
      expect(db().writes().filter((w) => w.table === 'lookups')).toHaveLength(1)
    })
    it('counts only this location, and only tags of its own that are switched on', async () => {
      as('owner', LOC)
      db().tables.lookups.push(...ownTags(12), ...ownTags(20, false).map((t, i) => ({ ...t, id: id(300 + i), label: `Removed ${i}` })), ...ownTags(20).map((t, i) => ({ ...t, id: id(400 + i), label: `Theirs ${i}`, location_id: OTHER })))
      expect((await make({ label: 'Fifteenth', made_on: 'clients' })).status).toBe(200)
    })
    it('corporate tags never count: 48 corporate tags switched on and 14 of its own, the fifteenth is still made', async () => {
      as('owner', LOC)
      const corporate = Array.from({ length: 48 }, (_, i) => ({ id: id(500 + i), category: 'tags', label: `Corporate ${i}`, location_id: null, is_active: true, attrs: {}, sort_order: 100 + i }))
      db().tables.lookups.push(...corporate, ...ownTags(12)) // 2 already + 12 = 14 own
      expect((await make({ label: 'Fifteenth', made_on: 'network' })).status).toBe(200)
    })
    it('holds for corporate creating on a location\'s behalf too', async () => {
      as('super_admin')
      db().tables.lookups.push(...ownTags(13))
      expect((await make({ label: 'Sixteenth', made_on: 'network' })).body.error).toBe('tag_limit')
    })
    it('a name that already exists is answered first, so nobody is told "limit" for a tag they can simply use', async () => {
      as('owner', LOC)
      db().tables.lookups.push(...ownTags(8))
      const r = await make({ label: 'networking groups', made_on: 'network' })
      expect(r.status).toBe(409)
      expect(r.body).toMatchObject({ error: 'near_match', verdict: 'use', tag: { id: CORP } })
    })
  })
})

describe("B) corporate's review of a location's own tag", () => {
  const act = (body: any) => post(review, body)
  const links = (tagId: string) => ({ clients: db().tables.lead_tags.filter((r) => r.tag_lookup_id === tagId).map((r) => r.lead_id).sort(), network: db().tables.partner_tags.filter((r) => r.tag_lookup_id === tagId).map((r) => r.partner_id).sort() })

  it.each([['owner', LOC], ['manager', LOC], ['lite_user', LOC]])('%s: refused, nothing read or written', async (role, loc) => {
    as(role, loc)
    for (const body of [{ id: OWN, action: 'keep_local' }, { id: OWN, action: 'merge', into: CORP }, { id: OWN, action: 'delete' }]) expect((await act(body)).status).toBe(403)
    expect(db().calls).toEqual([])
  })
  it('only a location\'s own tag can be reviewed; the main list is not touched here', async () => {
    as('super_admin')
    expect((await act({ id: CORP, action: 'delete' })).body.error).toBe('not_a_location_tag')
    expect((await act({ id: OWN, action: 'rename' })).body.error).toBe('invalid_action')
    expect((await act({ id: 'nope', action: 'delete' })).status).toBe(400)
    expect(db().writes()).toEqual([])
  })

  it('reviewed, keep local: marks the tag in its settings box and changes nothing else', async () => {
    as('admin')
    const before = JSON.parse(JSON.stringify(db().tables))
    const r = await act({ id: OWN, action: 'keep_local' })
    expect(r.status).toBe(200)
    const t = db().tables.lookups.find((x) => x.id === OWN)
    expect(t.attrs.review).toMatchObject({ decision: 'keep_local', by: 'u-1' })
    expect(t.attrs).toMatchObject({ section: 'trade', created_by_user: 'u-9' })
    expect(t).toMatchObject({ is_active: true, label: 'Business Networking Group', location_id: LOC })
    expect(db().tables.lead_tags).toEqual(before.lead_tags); expect(db().tables.partner_tags).toEqual(before.partner_tags)
    expect(db().writes().map((w) => `${w.table}/${w.op}`)).toEqual(['lookups/update'])
  })

  describe('merge', () => {
    it('the preview says exactly who is affected and changes nothing', async () => {
      as('super_admin')
      const r = await act({ id: OWN, action: 'merge', into: CORP, dryRun: true })
      expect(r.body).toEqual({ dryRun: true, plan: { action: 'merge', tag: { id: OWN, label: 'Business Networking Group' }, into: { id: CORP, label: 'Networking Group' }, clients: 2, network: 1, alreadyHave: { clients: 1, network: 0 } } })
      expect(db().writes()).toEqual([])
    })
    it('everyone who carried it carries the target instead, and the tag is deleted with a record of who', async () => {
      as('super_admin')
      const r = await act({ id: OWN, action: 'merge', into: CORP })
      expect(r.status).toBe(200)
      expect(links(CORP)).toEqual({ clients: ['c1', 'c2'], network: ['p1', 'p9'] })
      expect(links(OWN)).toEqual({ clients: [], network: [] })
      expect(db().tables.lookups.find((x) => x.id === OWN)).toBeUndefined()
      expect(r.body.receipt).toBe('2 clients and 1 Network contact now carry “Networking Group” in place of “Business Networking Group”. “Business Networking Group” is deleted.')
      const audit = db().tables.tag_deletions[0]
      expect(audit).toMatchObject({ tag_id: OWN, label: 'Business Networking Group', deleted_by: 'u-1' })
      expect(audit.tag_row._review).toMatchObject({ action: 'merge', into: { id: CORP, label: 'Networking Group' } })
      expect(audit.tag_row._review.clients.map((c: any) => c.lead_id)).toEqual(['c1', 'c2'])
      expect(audit.tag_row._review.network.map((c: any) => c.partner_id)).toEqual(['p1'])
    })
    it('someone who already had the target keeps their own link to it, date and all', async () => {
      as('super_admin')
      await act({ id: OWN, action: 'merge', into: CORP })
      expect(db().tables.lead_tags.filter((r) => r.lead_id === 'c2' && r.tag_lookup_id === CORP)).toEqual([{ lead_id: 'c2', tag_lookup_id: CORP, added_at: '2025-06-01T00:00:00Z', added_by: 'u-3' }])
      // ...and a moved link keeps the day it was first tagged.
      expect(db().tables.lead_tags.find((r) => r.lead_id === 'c1' && r.tag_lookup_id === CORP)).toMatchObject({ added_at: '2026-01-01T00:00:00Z', added_by: 'u-9' })
    })
    it('nobody else\'s tags move, and no other tag is touched', async () => {
      as('super_admin')
      await act({ id: OWN, action: 'merge', into: CORP })
      expect(db().tables.lookups.map((x) => x.id).sort()).toEqual([CORP, CORP_OFF, OWN2, ELSEWHERE].sort())
      expect(db().writes().map((w) => `${w.table}/${w.op}`)).toEqual(['lead_tags/upsert', 'partner_tags/upsert', 'lead_tags/delete', 'partner_tags/delete', 'rpc:delete_tag_if_unused/rpc', 'tag_deletions/update'])
    })
    it('into the same location\'s own tag is allowed', async () => {
      as('super_admin')
      expect((await act({ id: OWN, action: 'merge', into: OWN2 })).status).toBe(200)
      expect(links(OWN2).clients).toEqual(['c1', 'c2'])
    })
    it.each([
      ['itself', OWN, 'into_required'], ['nothing', undefined, 'into_required'], ['a tag that is switched off', CORP_OFF, 'into_not_found'],
      ["another location's own tag", ELSEWHERE, 'into_wrong_location'], ['a tag that does not exist', id(999), 'into_not_found'],
    ])('into %s is refused and nothing is written', async (_n, into, error) => {
      as('super_admin')
      expect((await act({ id: OWN, action: 'merge', into })).body.error).toBe(error)
      expect(db().writes()).toEqual([])
    })
    it('if the database refuses the delete, the tag is switched off and says what it was merged into; nobody carries it', async () => {
      as('super_admin')
      db().tables.lookups.find((x) => x.id === OWN)._blockers = ['promotion']
      const r = await act({ id: OWN, action: 'merge', into: CORP })
      expect(r.body.deleted).toBe(false)
      const t = db().tables.lookups.find((x) => x.id === OWN)
      expect(t).toMatchObject({ is_active: false })
      expect(t.attrs).toMatchObject({ merged_into: CORP, review: { decision: 'merge' } })
      expect(links(OWN)).toEqual({ clients: [], network: [] })
      expect(r.body.receipt).toContain('is switched off rather than deleted')
    })
  })

  describe('delete', () => {
    it('the preview says how many people lose it and changes nothing', async () => {
      as('super_admin')
      const r = await act({ id: OWN, action: 'delete', dryRun: true })
      expect(r.body.plan).toMatchObject({ action: 'delete', into: null, clients: 2, network: 1 })
      expect(db().writes()).toEqual([])
    })
    it('takes it off everyone, deletes it, and keeps a record of who carried it', async () => {
      as('super_admin')
      const r = await act({ id: OWN, action: 'delete' })
      expect(r.body.receipt).toBe('“Business Networking Group” was taken off 2 clients and 1 Network contact. “Business Networking Group” is deleted.')
      expect(links(OWN)).toEqual({ clients: [], network: [] })
      expect(db().tables.lookups.find((x) => x.id === OWN)).toBeUndefined()
      expect(db().tables.tag_deletions[0].tag_row._review).toMatchObject({ action: 'delete', into: null })
      // No one was given another tag, and no other link moved.
      expect(links(CORP)).toEqual({ clients: ['c2'], network: ['p9'] })
    })
  })
})
