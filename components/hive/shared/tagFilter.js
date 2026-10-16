// components/hive/shared/tagFilter.js
// ─────────────────────────────────────────────────────────────
// PURE module (zero imports) — the tag filter's brains, shared by every
// screen that lists people (Network, Everyone; Inbox and Engagements next).
// Lifted out of shared/networkGroups so no screen forks its own copy.
//
// A row is anything with `tagIds` — lookups ids from the tag links
// (partner_tags for Network people via lib/crm, lead_tags for clients via
// lib/people-mapper).
// ─────────────────────────────────────────────────────────────

// ANY-of: picking Realtor and Senior Living shows rows that are either.
// Empty pick → every row passes.
export function matchesTags(row, picked = []) {
  if (!picked.length) return true
  const mine = row?.tagIds || []
  return picked.some((id) => mine.includes(id))
}

// The filter's options: only tags some row in view actually carries, with
// counts — the list an owner can act on. Each keeps its section and
// sort_order so TagFilterSection can split them into Relationship / Trade
// the same way the picker does (lib/tags.ts sectionTags).
// tags: [{ id, label, icon, section, sort_order }] (the one list).
export function tagOptionsInUse(tags = [], rows = []) {
  const counts = new Map()
  for (const r of rows) for (const id of r?.tagIds || []) counts.set(id, (counts.get(id) || 0) + 1)
  return tags
    .filter((t) => counts.has(t.id))
    .map((t) => ({ id: t.id, label: t.label, icon: t.icon || null, section: t.section ?? null, sort_order: t.sort_order ?? 0, location_id: t.location_id ?? null, ownerName: t.ownerName ?? null, count: counts.get(t.id) }))
}

// The main search box, tag half: does any of this row's tags have a name
// containing the typed text? Typing "realtor" finds people TAGGED Realtor,
// not just names containing it. needle: already trimmed + lower-cased.
// tagById: Map(id → { label }). Returns the matched tag, or null.
export function matchesTagSearch(row, needle, tagById) {
  if (!needle || !tagById) return null
  for (const id of row?.tagIds || []) {
    const t = tagById.get(id)
    if (t && (t.label || '').toLowerCase().includes(needle)) return t
  }
  return null
}
