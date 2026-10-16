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
  // A location's own tags — always LAST, after the shared vocabulary, so an
  // owner reaches for a corporate tag before inventing one. Its label is the
  // location's name when known ("Southeast Nashville's own").
  { key: 'own', label: 'Your own', hint: 'Only your location sees these' },
] as const
export type TagSectionKey = (typeof TAG_SECTIONS)[number]['key']

export function tagSection(tag: { attrs?: any; section?: any; location_id?: any } | null | undefined): TagSectionKey {
  // Owned by a location → that location's own section, whatever its stored
  // section says (DO NOT BOOK and Lead keep 'relationship' in their data; it
  // is simply not read).
  if (tag?.location_id) return 'own'
  const s = tag?.section ?? tag?.attrs?.section
  return s === 'relationship' ? 'relationship' : 'trade'
}

// Split tag rows into the two sections, each ordered its own way; a
// section with no rows is left out. Rows are lookups-shaped
// ({ label, sort_order?, attrs? }) or the list shape ({ label, section }).
// ownLabel: the own section's heading, e.g. "Southeast Nashville's own".
export function sectionTags<T extends { label: string; sort_order?: number | null }>(rows: T[], ownLabel: string | null = null) {
  const bySort = (a: T, b: T) =>
    ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || a.label.localeCompare(b.label)
  const byLabel = (a: T, b: T) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  return TAG_SECTIONS
    .map((s) => ({
      key: s.key,
      label: s.key === 'own' && ownLabel ? ownLabel : s.label,
      hint: s.hint,
      // Relationship keeps list order; Trade and a location's own go A–Z.
      rows: rows.filter((r) => tagSection(r as any) === s.key).sort(s.key === 'relationship' ? bySort : byLabel),
    }))
    .filter((s) => s.rows.length > 0)
}

// ── Location tags + the near-match guard (2026-10-16, Kevin) ─────────────────
// A location may create its own tags again — but a near-duplicate of a tag
// that already exists is the fragmentation the merge just cleaned up, so
// every create AND rename is checked against a normalised key:
//   lower-case · spaces, hyphens, slashes, '&' and other punctuation removed
//   · the last word singular ("Realtors" → realtor, "Agencies" → agency,
//   "Boxes" → box). Deliberately NO spelling-distance matching: "Mover" and
//   "Moved" are different words.
// Checked against every corporate tag (switched on OR off) and the
// location's own tags. Not against other locations' tags — they can't see
// them; corporate's Location tags panel groups those by the same key.
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.length > 4 && /(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1)
  return word
}
export function tagKey(label: string | null | undefined): string {
  const words = String(label || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (!words.length) return ''
  words[words.length - 1] = singular(words[words.length - 1])
  return words.join('')
}

export type NearTagCandidate = { id: string; label: string; icon?: string | null; location_id?: string | null; is_active?: boolean; key?: string | null; attrs?: any }
export type NearTagVerdict =
  | { kind: 'none' }
  | { kind: 'use'; tag: NearTagCandidate }            // an active tag they can apply instead → no create
  | { kind: 'restore'; tag: NearTagCandidate }        // their OWN switched-off tag → restore it → no create
  | { kind: 'retired'; tag: NearTagCandidate }        // a switched-off CORPORATE tag → say so, file a request, STILL allow create

// What a new (or renamed) label collides with, for a location. candidates:
// corporate tags (any state) + that location's own tags (any state).
// ignoreId: the tag being renamed. An active match always wins over a
// retired one.
// A tag matches on its NAME or on its stored CODE (attrs.key — every
// former specialty has one): "real estate" is nowhere near the name
// "Realtor", but Realtor's code is real-estate (Kevin's own test tag got
// through on name-only matching, 2026-10-16).
export function nearTagVerdict(label: string, candidates: NearTagCandidate[], ignoreId: string | null = null): NearTagVerdict {
  const key = tagKey(label)
  if (!key) return { kind: 'none' }
  const codeOf = (c: NearTagCandidate) => c.key ?? c.attrs?.key ?? null
  const hits = candidates.filter((c) => c.id !== ignoreId && (tagKey(c.label) === key || (!!codeOf(c) && tagKey(codeOf(c)) === key)))
  const active = hits.find((c) => c.is_active !== false)
  if (active) return { kind: 'use', tag: active }
  const ownOff = hits.find((c) => c.location_id && c.is_active === false)
  if (ownOff) return { kind: 'restore', tag: ownOff }
  const corpOff = hits.find((c) => !c.location_id && c.is_active === false)
  if (corpOff) return { kind: 'retired', tag: corpOff }
  return { kind: 'none' }
}

// ── The icons a location may give its own tags (2026-10-16, Kevin) ───────────
// A curated grid, not a free emoji field — 54 locations with an open field
// would put things on client records nobody wants there. None of these is an
// icon a live corporate tag uses, so a location's tag never passes for a
// corporate one. Enforced by the server on create and on change; corporate
// keeps its free icon field on the Configure tab.
export const TAG_ICON_CHOICES = [
  '✅', '❗', '❓', '⏳', '🔔', '📅',   // flags
  '👪', '🐾', '♿', '🎓', '🧓', '🌎',   // people and needs
  '🛠️', '🪴', '🚗', '🧺', '🗄️', '📚', // work
  '💰', '🎁', '💬', '📞', '📍', '🌱',  // business
] as const
// '' / null = no icon. Anything else must be on the grid.
export function isAllowedTagIcon(icon: unknown): boolean {
  if (icon == null || icon === '') return true
  return typeof icon === 'string' && (TAG_ICON_CHOICES as readonly string[]).includes(icon.trim())
}

// ── Why a tag can't be deleted, in plain words (2026-10-16) ─────────────────
// blockers: what tag_delete_blockers() returns (migrations/tag_delete.sql).
export function describeTagBlockers(blockers: string[] | null | undefined): string | null {
  if (!blockers || blockers.length === 0) return null
  const people = (k: string) => Number((blockers.find(b => b.startsWith(k + ':')) || '').split(':')[1] || 0)
  const clients = people('clients'), network = people('network')
  if (clients || network) {
    const n = clients + network
    return `${n} ${n === 1 ? 'person carries' : 'people carry'} it — take it off them first, or Remove it to hide it.`
  }
  if (blockers.includes('corporate_merged')) return 'Kept on purpose: it’s how owners are told corporate retired it, and how their requests reach you.'
  if (blockers.includes('corporate_active')) return 'Switch it off first.'
  if (blockers.includes('tag_merge_log') || blockers.includes('relationship_tag_log') || blockers.includes('promotion')) {
    return 'A past change to the tag list can still be undone, and that undo needs this tag.'
  }
  return 'It can’t be deleted.'
}
