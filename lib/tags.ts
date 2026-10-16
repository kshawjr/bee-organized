// lib/tags.ts
// ─────────────────────────────────────────────────────────────
// THE one tag list (tag merge, 2026-10-15).
//
// Before the merge there were three tag vocabularies in `lookups` —
// client_tags (clients), partner_tags (Network people) and
// partner_specialties (Network people, stored as slugs on
// partners.specialties). Kevin's ruling: they are one idea with three
// names, so there is ONE list, shared by clients and Network people, in
// lookups category 'tags'. Links stay where they were: lead_tags for
// clients, partner_tags for Network people. partners.specialties is
// retired (copied into partner_tags by migrations/tag_merge_1_copy.sql,
// read and written by nothing after this change, NOT dropped).
//
// Run order (the deploy window is safe because every reader here asks for
// TAG_CATEGORIES, which matches the rows before AND after the rename):
//   1. migrations/tag_merge_1_copy.sql      specialties → partner_tags
//   2. push this code
//   3. migrations/tag_merge_1_copy.sql      again — picks up any specialty
//                                           the old code wrote in between
//   4. migrations/tag_merge_2_one_list.sql  the three categories → 'tags'
// Once step 4 has run, LEGACY_TAG_CATEGORIES match no rows and can go.
//
// Who adds a tag: corporate only (Configure tab). Owners pick; they
// never create — see app/api/lookups/route.ts.
// ─────────────────────────────────────────────────────────────

export const TAG_CATEGORY = 'tags'

export const LEGACY_TAG_CATEGORIES = ['client_tags', 'partner_tags', 'partner_specialties'] as const

export const TAG_CATEGORIES: string[] = [TAG_CATEGORY, ...LEGACY_TAG_CATEGORIES]

export function isTagCategory(category: unknown): boolean {
  return typeof category === 'string' && TAG_CATEGORIES.includes(category)
}

// Can this lookup row be applied as a tag to a record at recordLocation?
// Returns an error code, or null when it may. A tag is corporate
// (location_id null) or owned by the RECORD's location — a different
// location's tag never applies, whoever the caller is.
export function tagApplyError(
  def: { category?: string | null; location_id?: string | null } | null | undefined,
  recordLocation: string | null | undefined
): string | null {
  if (!def) return 'tag_lookup_not_found'
  if (!isTagCategory(def.category)) return 'tag_lookup_wrong_category'
  if (def.location_id && def.location_id !== recordLocation) return 'tag_lookup_wrong_location'
  return null
}

// Clean a caller-supplied list of tag ids: strings only, de-duplicated,
// capped (the same 8 the old specialty picker allowed per person).
export const MAX_TAGS_PER_CREATE = 8
export function cleanTagIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || !v.trim() || out.includes(v)) continue
    out.push(v)
    if (out.length >= MAX_TAGS_PER_CREATE) break
  }
  return out
}

// ── Sections (2026-10-15, Kevin) ─────────────────────────────
// Every place a tag is PICKED shows the one list in two sections:
//   relationship — what the person is to you (Hot Lead, VIP, Vendor…),
//                  in the list's own order (sort_order)
//   trade        — what they do (Realtor, Mover…), alphabetical
// A tag's section is DATA, not a list of names: lookups.attrs.section,
// written by migrations/tag_sections.sql for the existing tags and chosen
// on the Configure tab for a new one. A tag with NO section (or an
// unrecognised one) shows under Trade — it never vanishes from a picker.
export const TAG_SECTIONS = [
  { key: 'relationship', label: 'Relationship', hint: 'What they are to you' },
  { key: 'trade', label: 'Trade', hint: 'What they do' },
] as const
export type TagSectionKey = (typeof TAG_SECTIONS)[number]['key']

export function tagSection(tag: { attrs?: any; section?: any } | null | undefined): TagSectionKey {
  const s = tag?.section ?? tag?.attrs?.section
  return s === 'relationship' ? 'relationship' : 'trade'
}

// Split tag rows into the two sections, each ordered its own way; a
// section with no rows is left out. Rows are lookups-shaped
// ({ label, sort_order?, attrs? }) or the list shape ({ label, section }).
export function sectionTags<T extends { label: string; sort_order?: number | null }>(rows: T[]) {
  const bySort = (a: T, b: T) =>
    ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || a.label.localeCompare(b.label)
  const byLabel = (a: T, b: T) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  return TAG_SECTIONS
    .map((s) => ({
      key: s.key,
      label: s.label,
      hint: s.hint,
      rows: rows.filter((r) => tagSection(r as any) === s.key).sort(s.key === 'relationship' ? bySort : byLabel),
    }))
    .filter((s) => s.rows.length > 0)
}
