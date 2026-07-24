// lib/lead-assignment.ts
// ─────────────────────────────────────────────────────────────
// WHO OWNS AN INCOMING LEAD — resolution + the write.
//
// THE RULE (Kevin, 2026-07-24). Deliberately NOT the same rule as the
// notification fan-out, even though it reads the same config:
//
//   1. locations.split_notifications_enabled OFF → the LOCATION OWNER.
//      Several notification recipients does NOT mean several assignees. A
//      location that hasn't split by project type has one owner of the work.
//   2. split ON → whoever SPECIFICALLY claims the lead's project type, i.e.
//      carries that project-type label in their notification category set.
//      MULTI-ASSIGN: if several people claim it, all of them are assigned.
//   3. split ON but nobody claims the type → the LOCATION OWNER.
//   4. EXTERNAL recipients (lead_notification_externals — outside email
//      addresses) are notified exactly as today and are NEVER assigned. They
//      have no hub_users row, so there is nothing to assign. A type claimed
//      ONLY by externals therefore falls to rule 3.
//   5. NEVER NOBODY. If every tier comes up empty the resolver says so loudly
//      (console.error + basis 'none') rather than returning a silent blank.
//
// Note the asymmetry with lib/notification-recipients.ts on purpose: an 'all'
// recipient is notified about everything but is NOT thereby "configured to
// receive that project type", so 'all' does not make someone an assignee. It
// only ever falls through to the owner tier — which, at 8 of 9 active
// locations today, is the same person anyway.
//
// WHERE THE RESULT LANDS — see writeLeadAssignment(). Two places, deliberately:
// the lead_assignees junction (the plural truth) and leads.assigned_to (the
// first assignee, so nothing that still reads the legacy singular column
// regresses). The junction write is FAIL-SOFT: if migrations/lead_assignees.sql
// has not been run yet, the insert errors, we record a warning, and the
// assigned_to write still happens. That means the blank-assignment fix lands
// the moment this ships; multi-assign lights up when the migration does.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { getPrimaryOwnerForLocation } from './owner-resolution'
import {
  getManageableRecipients,
  isSplitNotificationsEnabled,
} from './notification-recipients'
import { isSpecificSelection, selectedTypes } from './notification-project-types'

// How an assignment was decided. Mirrors lead_assignees.assigned_via.
export type AssignmentBasis = 'project_type' | 'location_owner' | 'none'

export type ResolvedAssignment = {
  hubUserIds: string[]
  basis: AssignmentBasis
  // Was the location splitting notifications by project type at all?
  splitEnabled: boolean
  // The lead's project_type after canonicalization (see canonicalProjectType).
  // null when the lead carries none, or carries a value that is not a known
  // project-type label.
  resolvedProjectType: string | null
  // TRUE when the lead HAD a project_type but it could not be resolved to a
  // known lookups label — the drift case. Not an error (we fall back to the
  // owner, which is correct), but the caller logs it so drift is visible
  // instead of silently degrading. See the LABEL DRIFT note below.
  projectTypeUnrecognized: boolean
  // Type-claiming recipients that could NOT be assigned because they are
  // external email addresses with no hub_users row. Diagnostic only.
  externalClaimants: string[]
}

// ── LABEL DRIFT ────────────────────────────────────────────────────────────
// Matching a claim is EXACT-LABEL against the global lookups list
// (category='project_types'), so a lead whose project_type does not equal a
// label can never match a claim and silently falls to the owner. Two real
// shapes of drift exist in prod (audited 2026-07-23, n=7,235 leads):
//
//   · CASE / WHITESPACE — handled: matching is trim + case-insensitive against
//     the live lookups list, ACTIVE and INACTIVE alike. Inactive labels
//     (Garage, Kitchen + Pantry, Move-In Organization, …) still resolve to
//     themselves; they simply won't be claimed by anyone, so they land on the
//     owner, which is right.
//   · LEGACY LOWERCASE TOKENS — 'organizing' / 'moving' (2 rows). These are the
//     pre-unification drip-category vocabulary, not labels, and they predate
//     the project-type pills. Aliased below to the labels carrying the matching
//     attrs.drip_category. Without the alias, a loc_test 'organizing' lead
//     would miss the one real project-type claim in production.
//
// Anything else (e.g. project_type='Client', 16 rows written by the manual
// create path) resolves to null → owner. That is the correct outcome, and
// projectTypeUnrecognized makes it visible rather than silent.
const LEGACY_PROJECT_TYPE_ALIASES: Record<string, 'move' | 'general'> = {
  moving: 'move',
  organizing: 'general',
}

// The project-type vocabulary, ACTIVE and INACTIVE. Inactive labels are
// included on purpose: a lead captured months ago against a since-retired label
// must still canonicalize to that label rather than reading as drift.
async function getProjectTypeVocabulary(): Promise<
  Array<{ label: string; dripCategory: 'move' | 'general' }>
> {
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
      .filter((r: { label: string }) => !!r.label)
  } catch {
    return []
  }
}

// Raw leads.project_type → the canonical lookups label, or null.
export function canonicalProjectType(
  raw: string | null | undefined,
  vocabulary: Array<{ label: string; dripCategory: 'move' | 'general' }>,
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

// Resolve WHO should be assigned. Pure read — writes nothing.
export async function resolveLeadAssignees(args: {
  locationUuid: string
  projectType: string | null
}): Promise<ResolvedAssignment> {
  const { locationUuid } = args

  const ownerFallback = async (
    partial: Omit<ResolvedAssignment, 'hubUserIds' | 'basis'>,
  ): Promise<ResolvedAssignment> => {
    const owner = await getPrimaryOwnerForLocation(locationUuid)
    if (owner?.id) {
      return { ...partial, hubUserIds: [owner.id], basis: 'location_owner' }
    }
    // Rule 5 — never nobody, and never silently. A location with no resolvable
    // owner is a data problem someone has to see.
    console.error(
      `[lead-assignment] location ${locationUuid} resolved to ZERO assignees — no project-type claim and no primary owner`,
    )
    return { ...partial, hubUserIds: [], basis: 'none' }
  }

  const splitEnabled = await isSplitNotificationsEnabled(locationUuid)

  // Rule 1 — split off. The owner owns the work, full stop. Deliberately does
  // NOT read the recipient list: several notification recipients is not several
  // assignees.
  if (!splitEnabled) {
    return ownerFallback({
      splitEnabled: false,
      resolvedProjectType: null,
      projectTypeUnrecognized: false,
      externalClaimants: [],
    })
  }

  const vocabulary = await getProjectTypeVocabulary()
  const resolvedProjectType = canonicalProjectType(args.projectType, vocabulary)
  const hadRawType = !!(args.projectType || '').trim()
  const projectTypeUnrecognized = hadRawType && !resolvedProjectType

  const partial = {
    splitEnabled: true,
    resolvedProjectType,
    projectTypeUnrecognized,
    externalClaimants: [] as string[],
  }

  // No usable project type → nothing can be claimed → rule 3.
  if (!resolvedProjectType) return ownerFallback(partial)

  const { users, externals } = await getManageableRecipients(locationUuid)

  const claims = (category: string | null | undefined) =>
    isSpecificSelection(category) &&
    selectedTypes(category).some(
      (t) => t.trim().toLowerCase() === resolvedProjectType.toLowerCase(),
    )

  // Rule 4 (diagnostic half) — externals that claim this type but cannot be
  // assigned. They are still notified by the notification path; recorded here
  // only so the caller can explain WHY the owner got it.
  partial.externalClaimants = externals.filter((e) => claims(e.category)).map((e) => e.email)

  // Rule 2 — hub_users specifically claiming this type. An UNSUBSCRIBED user is
  // excluded: the owner has explicitly cut them off from this location's lead
  // flow, so handing them the work would contradict that.
  const claimants = users.filter((u) => u.subscribed && claims(u.category))

  if (claimants.length > 0) {
    return {
      ...partial,
      hubUserIds: claimants.map((u) => u.hub_user_id),
      basis: 'project_type',
    }
  }

  // Rule 3 — split on, nobody (assignable) claims it.
  return ownerFallback(partial)
}

export type AssignmentWriteResult = {
  hubUserIds: string[]
  basis: AssignmentBasis
  // Did the junction write land? false when migrations/lead_assignees.sql has
  // not been applied yet (or the write failed) — assigned_to still got written.
  junctionWritten: boolean
  warnings: string[]
}

// Persist a resolved assignment. NON-FATAL throughout — every caller has
// already committed the lead row, and losing a lead is worse than losing an
// assignment.
//
// `replace` (default false) governs the junction only: false = additive
// (idempotent upsert, existing rows untouched), true = the given set becomes
// the exact set. The API route that backs the in-app picker passes true; the
// intake path leaves it false because it only ever runs on a lead with no
// assignees at all.
// `assignedVia` overrides what lands in lead_assignees.assigned_via. Callers
// that took the assignment from a human rather than from resolveLeadAssignees
// pass 'manual'; otherwise it follows the resolution basis. ('none' can never
// reach the column — there are no ids to write when the basis is 'none'.)
export async function writeLeadAssignment(args: {
  leadId: string
  resolved: ResolvedAssignment
  replace?: boolean
  assignedVia?: 'project_type' | 'location_owner' | 'manual'
}): Promise<AssignmentWriteResult> {
  const { leadId, resolved } = args
  const warnings: string[] = []
  const assignedVia: string =
    args.assignedVia ?? (resolved.basis === 'none' ? 'manual' : resolved.basis)

  let junctionWritten = false
  try {
    if (args.replace) {
      const del = await supabaseService.from('lead_assignees').delete().eq('lead_id', leadId)
      if ((del as any)?.error) throw new Error((del as any).error.message)
    }
    if (resolved.hubUserIds.length > 0) {
      const { error } = await supabaseService.from('lead_assignees').upsert(
        resolved.hubUserIds.map((hub_user_id) => ({
          lead_id: leadId,
          hub_user_id,
          assigned_via: assignedVia,
        })),
        { onConflict: 'lead_id,hub_user_id', ignoreDuplicates: true },
      )
      if (error) throw new Error(error.message)
    }
    junctionWritten = true
  } catch (err: any) {
    // Overwhelmingly the "migration not applied yet" case. Warn, don't fail —
    // the assigned_to write below still fixes the blank.
    console.error(
      `[lead-assignment] lead_assignees write failed for lead ${leadId} (migration applied?) — ${err?.message || err}`,
    )
    warnings.push(`lead_assignees_write_failed: ${err?.message || String(err)}`)
  }

  // Legacy singular column. Written so nothing that still reads it regresses —
  // NOT a second source of truth, and no new reader is pointed at it.
  if (resolved.hubUserIds.length > 0) {
    try {
      const { error } = await supabaseService
        .from('leads')
        .update({ assigned_to: resolved.hubUserIds[0] })
        .eq('id', leadId)
      if (error) throw new Error(error.message)
    } catch (err: any) {
      console.error(
        `[lead-assignment] leads.assigned_to write failed for lead ${leadId} — ${err?.message || err}`,
      )
      warnings.push(`assigned_to_write_failed: ${err?.message || String(err)}`)
    }
  }

  return { hubUserIds: resolved.hubUserIds, basis: resolved.basis, junctionWritten, warnings }
}

// Resolve + write in one call. The intake path's entry point.
export async function assignIncomingLead(args: {
  leadId: string
  locationUuid: string
  projectType: string | null
}): Promise<AssignmentWriteResult & { resolved: ResolvedAssignment }> {
  const resolved = await resolveLeadAssignees({
    locationUuid: args.locationUuid,
    projectType: args.projectType,
  })
  if (resolved.projectTypeUnrecognized) {
    console.warn(
      `[lead-assignment] lead ${args.leadId} project_type ${JSON.stringify(args.projectType)} is not a known project-type label — assignment fell back to the location owner`,
    )
  }
  const written = await writeLeadAssignment({ leadId: args.leadId, resolved })
  return { ...written, resolved }
}

// Current assignees for a lead (junction → hub_user ids), oldest first so
// "primary" is stable = the first person assigned. Returns [] if the table is
// not there yet.
export async function getLeadAssigneeIds(leadId: string): Promise<string[]> {
  try {
    const { data, error } = await supabaseService
      .from('lead_assignees')
      .select('hub_user_id, created_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: true })
    if (error) return []
    return (data || []).map((r: any) => r.hub_user_id)
  } catch {
    return []
  }
}
