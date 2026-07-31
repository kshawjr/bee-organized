// lib/lead-suppression.ts
// ─────────────────────────────────────────────────────────────
// ONE definition of "this lead is suppressed from active working surfaces."
//
// A lead is suppressed when it is JUNK (is_junk — not a real prospect) or
// ARCHIVED (archived_at — a real Jobber client the owner archived, #122). Both
// hide from the ACTIVE surfaces (the engagement board, the Inbox, and the
// active working lists) but are NEVER deleted and stay reachable elsewhere:
//   • junk    → the Recycle Bin (leads .eq('is_junk', true))
//   • archived → Search (deliberately NOT filtered) + the client's own record
// and both are LEFT untouched in historical / financial rollups (won counts,
// revenue, closed lists, admin metrics) — archiving a client must never
// retroactively reshape last month's numbers.
//
// Why a shared module: the SQL predicate `.not('is_junk','is',true)` was
// hand-rolled at ~10 sites, with tests asserting the literal string — the exact
// copy-must-match-copy pattern that caused the #89 / #119 badge-vs-list drift.
// The lead-side filter (applyLeadActiveFilter) and the engagement-side drop
// (fetchSuppressedLeadIds / isLeadSuppressed) now share this one source so
// junk and archived can never diverge between the two surfaces.
//
// NOTE: applyLeadActiveFilter / fetchSuppressedLeadIds reference archived_at,
// which requires migrations/leads_archived_at.sql. A filter against a missing
// column errors 42703 — that migration is a hard prerequisite for shipping any
// caller of these helpers.

import type { SupabaseClient } from '@supabase/supabase-js'

export type SuppressibleLead = {
  is_junk?: boolean | null
  archived_at?: string | null
}

// In-memory predicate — for surfaces that already hold the lead row and decide
// membership client/server-side rather than at the query.
export function isLeadSuppressed(lead: SuppressibleLead | null | undefined): boolean {
  if (!lead) return false
  return lead.is_junk === true || lead.archived_at != null
}

// Query-builder helper for LEADS-table reads on ACTIVE surfaces (Inbox, the
// active working lists, the counts that mirror them). Excludes junk
// (is_junk IS NOT TRUE — matches both false and NULL, the Jobber-import case)
// and archived (archived_at IS NULL). This REPLACES the hand-rolled
// `.not('is_junk','is',true)` at those sites so archived_at has exactly one home.
//
// Chainable: returns the same builder, so callers keep composing .order()/.range().
// Typed loosely because PostgREST's builder generics don't survive a pass-through.
export function applyLeadActiveFilter<Q extends { not: (...a: any[]) => Q; is: (...a: any[]) => Q }>(q: Q): Q {
  return q.not('is_junk', 'is', true).is('archived_at', null)
}

// The set of suppressed lead ids for a scope. ENGAGEMENT surfaces carry no copy
// of lead status (the engagements row has only client_id), so an active-board
// read must drop engagements whose client_id is in this set. Optional
// locationUuid scopes it to one location; omit for the 'all' tenant view.
//
// Only ever asks "which leads are suppressed" (a small set — junk + archived),
// backed by leads_archived_at_idx. Paginated for safety.
export async function fetchSuppressedLeadIds(
  sb: SupabaseClient,
  opts: { locationUuid?: string | null } = {},
): Promise<Set<string>> {
  const ids = new Set<string>()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    let q = sb
      .from('leads')
      .select('id')
      // is_junk IS TRUE  OR  archived_at IS NOT NULL
      .or('is_junk.is.true,archived_at.not.is.null')
      .range(from, from + PAGE - 1)
    if (opts.locationUuid) q = q.eq('location_uuid', opts.locationUuid)
    const { data, error } = await q
    if (error) throw new Error(`fetchSuppressedLeadIds: ${error.message}`)
    for (const r of data || []) ids.add(r.id)
    if ((data || []).length < PAGE) break
  }
  return ids
}
