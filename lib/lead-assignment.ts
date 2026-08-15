// lib/lead-assignment.ts
// ─────────────────────────────────────────────────────────────
// WHO OWNS AN INCOMING LEAD — resolution + the write.
//
// THE RULE (Kevin, 2026-08-15 — issue 246 step 2). Assignment now reads the
// HANDLER table and nothing else:
//
//   1. The lead's project_type canonicalizes to a lookups label, and that
//      location has a HANDLER for it → that person. One person per type,
//      single-select, by construction (the table's UNIQUE).
//   2. No handler for the type, no usable project_type, or a project_type that
//      canonicalizes to nothing → the LOCATION OWNER.
//   3. NEVER NOBODY. If both tiers come up empty the resolver says so loudly
//      (console.error + basis 'none') rather than returning a silent blank.
//
// WHAT CHANGED, AND WHY IT IS SIMPLER. The old rule read the NOTIFICATION
// config: a person was assigned a type if their lead_notification_prefs
// category set named it, gated by locations.split_notifications_enabled. That
// fused two unrelated questions — "who hears about this" and "who does this" —
// into one field, and produced the asymmetry the old comment had to spend a
// paragraph excusing ('all' notifies you about everything but does not make
// you an assignee). Both are gone. Job types decide who HANDLES; a per-person
// switch decides who is TOLD; neither reads the other.
//
// NO FLAG. split_notifications_enabled is not read here any more. "No handler
// row" is the off state, and it is expressed per type instead of per location.
//
// MULTI-ASSIGN moved, it did not disappear. The old rule could return several
// hub_user ids when several people claimed a type. A type now has exactly one
// handler, so this resolver returns at most one. Several people can still be
// assigned to a LEAD — that is what the lead_assignees junction is for, and it
// is set ON THE LEAD via the masthead picker, not inferred from config.
//
// EXTERNAL recipients (outside email addresses) are still never assigned:
// they have no hub_users row, and as of migrations/new_lead_handlers.sql a
// handler must be a person (source_user_id NOT NULL), so an external cannot be
// one. A disabled or deactivated handler is treated as absent — see
// lib/project-type-handlers.ts — so their types fall to rule 2 rather than
// being assigned to someone who has been offboarded.
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
import { getLocationHandlers } from './project-type-handlers'
import {
  canonicalProjectType,
  getProjectTypeVocabulary,
} from './project-type-vocabulary'

// Re-exported so the many existing importers of canonicalProjectType from this
// module keep working; the implementation moved to project-type-vocabulary.ts
// so the SEND path can share the one rule without importing the assignment
// chain. See that module's header.
export { canonicalProjectType }

// How an assignment was decided. Mirrors lead_assignees.assigned_via.
export type AssignmentBasis = 'project_type' | 'location_owner' | 'none'

export type ResolvedAssignment = {
  hubUserIds: string[]
  basis: AssignmentBasis
  // Retained for callers/telemetry that read it. Since issue 246 step 2 there
  // is no per-location split flag: this reports whether the location has ANY
  // handler rows at all, which is the nearest true statement.
  splitEnabled: boolean
  // The lead's project_type after canonicalization (see canonicalProjectType).
  // null when the lead carries none, or carries a value that is not a known
  // project-type label.
  resolvedProjectType: string | null
  // TRUE when the lead HAD a project_type but it could not be resolved to a
  // known lookups label — the drift case. Not an error (we fall back to the
  // owner, which is correct), but the caller logs it so drift is visible
  // instead of silently degrading.
  projectTypeUnrecognized: boolean
  // Kept at [] — externals can no longer claim a type at all (a handler must
  // be a person). Retained so the shape does not change under callers.
  externalClaimants: string[]
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
    // Rule 3 — never nobody, and never silently. A location with no resolvable
    // owner is a data problem someone has to see.
    console.error(
      `[lead-assignment] location ${locationUuid} resolved to ZERO assignees — no project-type handler and no primary owner`,
    )
    return { ...partial, hubUserIds: [], basis: 'none' }
  }

  // ONE MATCHING RULE: canonicalize the raw project_type to a lookups label
  // here, at the boundary, then match exactly. The handler map is keyed on the
  // lowercased label and the DB's ..._loc_type_ci_idx guarantees no two handler
  // rows differ only in case, so the match downstream is unambiguous.
  const [vocabulary, handlers] = await Promise.all([
    getProjectTypeVocabulary(),
    getLocationHandlers(locationUuid),
  ])
  const resolvedProjectType = canonicalProjectType(args.projectType, vocabulary)
  const hadRawType = !!(args.projectType || '').trim()

  const partial = {
    // No flag any more — report whether this location configures handlers at
    // all, which is the nearest true thing this field can say.
    splitEnabled: handlers.size > 0,
    resolvedProjectType,
    projectTypeUnrecognized: hadRawType && !resolvedProjectType,
    externalClaimants: [] as string[],
  }

  // Rule 2 (first half) — no usable project type → the owner.
  if (!resolvedProjectType) return ownerFallback(partial)

  // Rule 1 — the handler for this type, if there is one and they are usable.
  const handler = handlers.get(resolvedProjectType.trim().toLowerCase())
  if (handler) {
    return { ...partial, hubUserIds: [handler.hub_user_id], basis: 'project_type' }
  }

  // Rule 2 (second half) — a real type with nobody handling it → the owner.
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

// issue 150 — resolve + persist a lead's assignees AT SEND TIME, EMPTY-ONLY.
//
// Send-to-Jobber runs on a bare lead: the engagement does not exist yet (the
// Jobber webhook founds it ~11s AFTER the send), so there is no engagement to
// read assignees off. The assignee is a fact about the LEAD, so decide it here,
// from the lead's own junction, using the SAME resolver intake (assignIncomingLead)
// and founding (seedEngagementAssigneesFromLead, issue 149) use — never a second
// resolver.
//
// EMPTY-ONLY, ALWAYS: if lead_assignees already has rows (an intake resolution
// or a manual masthead pick), we resolve NOTHING and leave them untouched. Only
// a lead that has never been resolved gets a decision here.
//
// WHY PERSIST (not just resolve-in-memory): the decision is recorded once. When
// the webhook founds the engagement ~11s later, issue 149's seed copies THIS set
// forward verbatim instead of re-resolving against a config that could have
// changed between the two moments — which would let Jobber and Bee Hub disagree
// about who owns the work. writeLeadAssignment is fail-soft (see its note); a
// missing migration or a failed write never throws out to the send.
export async function resolveAndPersistLeadAssigneesIfEmpty(args: {
  leadId: string
  locationUuid: string
  projectType: string | null
}): Promise<void> {
  const existing = await getLeadAssigneeIds(args.leadId)
  if (existing.length > 0) return // populated → use as-is, resolve nothing
  const resolved = await resolveLeadAssignees({
    locationUuid: args.locationUuid,
    projectType: args.projectType,
  })
  if (resolved.projectTypeUnrecognized) {
    console.warn(
      `[lead-assignment] lead ${args.leadId} project_type ${JSON.stringify(args.projectType)} is not a known project-type label — send-time assignment fell back to the location owner`,
    )
  }
  await writeLeadAssignment({ leadId: args.leadId, resolved })
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
