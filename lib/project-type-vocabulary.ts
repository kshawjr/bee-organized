// lib/project-type-vocabulary.ts
// ─────────────────────────────────────────────────────────────
// THE ONE PROJECT-TYPE MATCHING RULE (issue 246 step 2).
//
// Until now there were THREE, and they disagreed:
//
//   assign  lib/lead-assignment.ts canonicalProjectType() — trim +
//           case-insensitive against lookups (active AND inactive), plus the
//           legacy 'moving'/'organizing' aliases.
//   notify  lib/notification-project-types.ts categoryMatchesLead() —
//           sel.types.includes(leadProjectType). Exact, case-sensitive, no
//           trim, no alias.
//   send    lib/resend.ts resolveProjectTypeSenderOverride() —
//           .eq('project_type', projectType). Exact, case-sensitive, in SQL.
//
// Three rules reading one vocabulary is how Bee Hub and the client's inbox
// come to disagree about who owns a job. The rule is now:
//
//   CANONICALIZE AT THE BOUNDARY, THEN MATCH EXACTLY.
//
// Every path resolves a raw leads.project_type to a lookups label ONCE, here,
// and everything downstream compares canonical labels with ===. The notify
// path no longer matches on project type at all (that fusion is what step 2
// ends), so what remains is assign and send — and they now share this module.
//
// This module is the only place that knows about case, whitespace or aliases.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export type VocabularyEntry = { label: string; dripCategory: 'move' | 'general' }

// ── LABEL DRIFT ────────────────────────────────────────────────────────────
// Audited against production 2026-08-15 (n = 7,235 leads, 20 active locations):
//
//   · CASE / WHITESPACE — ZERO instances in production. Every project_type in
//     use either matches a lookups label exactly or matches nothing under any
//     rule. Case-insensitivity here is therefore PREVENTION, not repair: it
//     stops a hand-typed handler row or a future form change from silently
//     failing to match. It changes no current behaviour.
//   · LEGACY LOWERCASE TOKENS — 'organizing' / 'moving' (2 rows, both
//     loc_test). The pre-unification drip-category vocabulary, not labels.
//     Aliased below. This is the ONE place the three old rules visibly
//     disagreed on live data: assign routed these, notify and send did not.
//   · project_type='Client' (53 rows, 13 locations) — not a project type at
//     all; it is what the manual-create path writes. Resolves to null under
//     every rule, old and new, and falls to the location owner. Correct, and
//     deliberately unchanged here.
const LEGACY_PROJECT_TYPE_ALIASES: Record<string, 'move' | 'general'> = {
  moving: 'move',
  organizing: 'general',
}

// The project-type vocabulary, ACTIVE and INACTIVE. Inactive labels are
// included on purpose: a lead captured months ago against a since-retired
// label must still canonicalize to that label rather than reading as drift.
// Nobody can be a HANDLER for an inactive type (the config UI lists active
// only), so such a lead correctly falls through to the location owner.
export async function getProjectTypeVocabulary(): Promise<VocabularyEntry[]> {
  try {
    const res = await supabaseService
      .from('lookups')
      .select('label, attrs, sort_order')
      .eq('category', 'project_types')
      .order('sort_order', { ascending: true })
    return ((res as any)?.data || [])
      .map((r: any) => ({
        label: String(r.label || '').trim(),
        dripCategory: (r?.attrs?.drip_category === 'move' ? 'move' : 'general') as
          | 'move'
          | 'general',
      }))
      .filter((r: VocabularyEntry) => !!r.label)
  } catch {
    return []
  }
}

// Raw leads.project_type → the canonical lookups label, or null.
//
// PURE — the vocabulary is passed in, so this is unit-testable without a DB and
// callers that already hold the vocabulary do not re-fetch it.
export function canonicalProjectType(
  raw: string | null | undefined,
  vocabulary: VocabularyEntry[],
): string | null {
  const s = (raw || '').trim()
  if (!s) return null

  const exact = vocabulary.find((v) => v.label.toLowerCase() === s.toLowerCase())
  if (exact) return exact.label

  const legacy = LEGACY_PROJECT_TYPE_ALIASES[s.toLowerCase()]
  if (legacy) {
    // The first (lowest sort_order) label carrying that drip category — the
    // vocabulary is ordered, so this is the primary label for the family:
    // 'organizing' → "Home or Office Organizing", 'moving' → "Moving/Relocation".
    const fam = vocabulary.find((v) => v.dripCategory === legacy)
    if (fam) return fam.label
  }
  return null
}

// Fetch + canonicalize in one call, for the paths that hold no vocabulary.
// Returns null on any miss, which every caller treats as "falls to the owner /
// base sender" — never an error.
export async function resolveCanonicalProjectType(
  raw: string | null | undefined,
): Promise<string | null> {
  if (!(raw || '').trim()) return null
  const vocabulary = await getProjectTypeVocabulary()
  return canonicalProjectType(raw, vocabulary)
}
