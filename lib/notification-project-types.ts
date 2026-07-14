// lib/notification-project-types.ts
// ─────────────────────────────────────────────────────────────
// New-lead NOTIFICATION routing by project type — the encode / decode / match
// layer for the recipient "category" field.
//
// HISTORY. B1 stored a single category per recipient: 'all' | 'moving' |
// 'organizing'. The unified "New lead emails" section replaces that single
// value with a SET of project-type labels (the global lookups list,
// category='project_types'), so an owner can notify specific people for
// specific project types. We DID NOT migrate the column — category stays a
// free-text field; we just widen how it is written/read:
//
//   • 'all'                 → notify for ALL leads (the default; also what an
//                             absent pref row means).
//   • '["Moving","Estate"]' → JSON array of project-type LABELS — notify only
//                             for leads whose project_type is in the set.
//   • legacy 'moving'       → still resolves: notify for leads whose drip
//     legacy 'organizing'     category is 'move' / 'general' respectively. Kept
//                             so pre-existing rows behave sanely with zero
//                             migration.
//
// A comma-separated fallback is also parsed defensively, but we always WRITE
// the JSON-array form (or 'all').
//
// This module is pure (no DB) except nothing — matching a lead needs the lead's
// drip category, which the caller resolves and passes in.
// ─────────────────────────────────────────────────────────────

export const ALL_LEADS = 'all'

export type CategorySelection =
  | { kind: 'all' }
  | { kind: 'legacy-move' } // legacy 'moving'
  | { kind: 'legacy-general' } // legacy 'organizing'
  | { kind: 'types'; types: string[] }

// Decode a stored category field into a normalized selection. null / '' / 'all'
// all mean "all leads". Legacy single values are recognized. Otherwise we try
// JSON array first, then a comma-separated list; an empty/garbage set collapses
// back to 'all' (never "nobody" — a recipient row exists to be notified).
export function parseCategory(raw: string | null | undefined): CategorySelection {
  if (raw == null) return { kind: 'all' }
  const s = String(raw).trim()
  if (s === '' || s === 'all') return { kind: 'all' }
  if (s === 'moving') return { kind: 'legacy-move' }
  if (s === 'organizing') return { kind: 'legacy-general' }

  let types: string[] | null = null
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) {
        types = arr.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      }
    } catch {
      /* fall through to CSV */
    }
  }
  if (types == null) {
    types = s.split(',').map((t) => t.trim()).filter(Boolean)
  }
  return types.length ? { kind: 'types', types } : { kind: 'all' }
}

// Serialize a UI selection back to the stored string. all-leads → 'all';
// otherwise the JSON-array form. An empty type set is treated as 'all' so we
// never persist a "notify for nothing" recipient.
export function serializeCategory(sel: { all?: boolean; types?: string[] }): string {
  if (sel.all) return ALL_LEADS
  const types = (sel.types || []).map((t) => t.trim()).filter(Boolean)
  if (types.length === 0) return ALL_LEADS
  // stable order so equal sets serialize identically (idempotent writes)
  return JSON.stringify(Array.from(new Set(types)).sort())
}

// Is this a specific, type-restricted selection? 'all' and the legacy values
// are cross-cutting (they don't "claim" a single label out of the
// everything-else bucket); only an explicit type set does.
export function isSpecificSelection(raw: string | null | undefined): boolean {
  return parseCategory(raw).kind === 'types'
}

// The explicit project-type labels this selection claims (empty for
// all/legacy). Used by the UI + send filter to compute the everything-else
// bucket (types no recipient specifically claims).
export function selectedTypes(raw: string | null | undefined): string[] {
  const sel = parseCategory(raw)
  return sel.kind === 'types' ? sel.types : []
}

// Does a recipient with this stored category match a lead of the given project
// type / drip category? 'all' matches everything; a type set matches on the
// exact project_type label; legacy values match on drip category.
export function categoryMatchesLead(
  raw: string | null | undefined,
  leadProjectType: string | null | undefined,
  leadDripCategory: 'move' | 'general',
): boolean {
  const sel = parseCategory(raw)
  switch (sel.kind) {
    case 'all':
      return true
    case 'legacy-move':
      return leadDripCategory === 'move'
    case 'legacy-general':
      return leadDripCategory === 'general'
    case 'types':
      return !!leadProjectType && sel.types.includes(leadProjectType)
  }
}
