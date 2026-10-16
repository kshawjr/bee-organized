// @vitest-environment node
//
// Tag merge (2026-10-15) — ONE tag list for clients and Network people
// (lib/tags.ts). The pins:
//   A) which lookups count as a tag, and where a tag may be applied
//   B) attachPartnerTags — the create-time link writer: rejects what the
//      per-tag route would reject, writes the rest, never throws a valid
//      tag away because of an invalid one
//   C) the person shape — tags are partner_tags links (tagIds), the retired
//      specialties and dead tags columns are neither read nor written
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { defs: [] as any[], upserts: [] as any[], upsertError: null as any }
  return { state }
})
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const b: any = {}
      b.select = () => b
      b.in = () => Promise.resolve({ data: h.state.defs, error: null })
      b.upsert = (rows: any[]) => { h.state.upserts.push({ table, rows }); return Promise.resolve({ error: h.state.upsertError }) }
      return b
    },
  },
}))

import { TAG_CATEGORIES, isTagCategory, tagApplyError, cleanTagIds, MAX_TAGS_PER_CREATE } from '@/lib/tags'
import { attachPartnerTags } from '@/lib/partner-tag-writes'
import { mapPartnerRow, partnerPatchToRow, PARTNER_COLS } from '@/lib/crm'
import { PARTNER_PATCH_FIELDS, computePartnerPatch } from '@/lib/partner-writes'
import { companiesWithMatchingPeople } from '@/components/hive/shared/networkGroups'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

beforeEach(() => {
  h.state.defs = []
  h.state.upserts = []
  h.state.upsertError = null
})

describe('A) the one list', () => {
  it("is 'tags' plus the three pre-merge categories, and nothing else", () => {
    expect(TAG_CATEGORIES).toEqual(['tags', 'client_tags', 'partner_tags', 'partner_specialties'])
    expect(isTagCategory('partner_specialties')).toBe(true)
    expect(isTagCategory('project_types')).toBe(false)
    expect(isTagCategory(undefined)).toBe(false)
  })

  it('a tag applies when corporate or owned by the record’s own location', () => {
    expect(tagApplyError({ category: 'tags', location_id: null }, LOC)).toBeNull()
    expect(tagApplyError({ category: 'client_tags', location_id: LOC }, LOC)).toBeNull()
    expect(tagApplyError({ category: 'tags', location_id: OTHER }, LOC)).toBe('tag_lookup_wrong_location')
    expect(tagApplyError({ category: 'lead_sources', location_id: null }, LOC)).toBe('tag_lookup_wrong_category')
    expect(tagApplyError(null, LOC)).toBe('tag_lookup_not_found')
  })

  it('cleanTagIds keeps strings, drops repeats, caps at 8', () => {
    expect(cleanTagIds(['a', 'a', '', 3, null, 'b'])).toEqual(['a', 'b'])
    expect(cleanTagIds('a')).toEqual([])
    expect(cleanTagIds(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS_PER_CREATE)
  })
})

describe('B) attachPartnerTags', () => {
  it('writes the valid ids, reports the rest, one upsert', async () => {
    h.state.defs = [
      { id: 't-ok', category: 'tags', location_id: null },
      { id: 't-own', category: 'partner_specialties', location_id: LOC },
      { id: 't-foreign', category: 'tags', location_id: OTHER },
      { id: 't-source', category: 'lead_sources', location_id: null },
    ]
    const r = await attachPartnerTags('p1', LOC, ['t-ok', 't-own', 't-foreign', 't-source', 't-missing'], 'u1')
    expect(r.applied).toEqual(['t-ok', 't-own'])
    expect(r.rejected).toEqual([
      { id: 't-foreign', error: 'tag_lookup_wrong_location' },
      { id: 't-source', error: 'tag_lookup_wrong_category' },
      { id: 't-missing', error: 'tag_lookup_not_found' },
    ])
    expect(h.state.upserts).toEqual([{ table: 'partner_tags', rows: [
      { partner_id: 'p1', tag_lookup_id: 't-ok', added_by: 'u1' },
      { partner_id: 'p1', tag_lookup_id: 't-own', added_by: 'u1' },
    ] }])
  })

  it('nothing picked → no reads, no writes', async () => {
    expect(await attachPartnerTags('p1', LOC, [], 'u1')).toEqual({ applied: [], rejected: [] })
    expect(h.state.upserts).toHaveLength(0)
  })

  it('a failed write throws (the caller reports it; the person stays created)', async () => {
    h.state.defs = [{ id: 't-ok', category: 'tags', location_id: null }]
    h.state.upsertError = { message: 'boom' }
    await expect(attachPartnerTags('p1', LOC, ['t-ok'], 'u1')).rejects.toThrow('partner_tags write failed: boom')
  })
})

describe('C) the person shape', () => {
  it('reads tags from the partner_tags embed, never the retired columns', () => {
    expect(PARTNER_COLS).toContain('partner_tags(tag_lookup_id)')
    expect(PARTNER_COLS).not.toMatch(/\bspecialties\b/)
    expect(PARTNER_COLS).not.toMatch(/(^|[ ,])tags,/)
    const row: any = mapPartnerRow({ id: 'p1', name: 'K', specialties: ['real-estate'], tags: ['x'], partner_tags: [{ tag_lookup_id: 't1' }, { tag_lookup_id: 't2' }] })
    expect(row.tagIds).toEqual(['t1', 't2'])
    expect(row).not.toHaveProperty('specialties')
    expect(row).not.toHaveProperty('tags')
    expect((mapPartnerRow({ id: 'p2', name: 'J' }) as any).tagIds).toEqual([])
  })

  it('a save never writes specialties, tags or tagIds to the partners row', () => {
    expect(partnerPatchToRow({ name: 'K', specialties: ['real-estate'], tags: ['x'], tagIds: ['t1'] })).toEqual({ name: 'K' })
    expect(PARTNER_PATCH_FIELDS).not.toContain('tagIds' as any)
    // A tag change on the record is state-only — no PATCH goes out for it.
    expect(computePartnerPatch({ id: 'p1', tagIds: ['t1'] }, { id: 'p1', tagIds: ['t1', 't2'] })).toEqual({})
  })
})

describe('D) companies under a filter are judged by their people', () => {
  const companies = [{ id: 'co1', name: 'Meridian' }, { id: 'co2', name: 'Oak' }, { id: 'co3', name: 'Empty' }]
  it('a company shows when any of its people passed the filter', () => {
    expect(companiesWithMatchingPeople(companies, [{ companyId: 'co1' }, { companyId: 'co1' }, { companyId: null }]).map(c => c.id)).toEqual(['co1'])
  })
  it('no matching people → no companies', () => {
    expect(companiesWithMatchingPeople(companies, [])).toEqual([])
  })
})
