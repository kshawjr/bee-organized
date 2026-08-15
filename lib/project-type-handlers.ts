// lib/project-type-handlers.ts
// ─────────────────────────────────────────────────────────────
// WHO HANDLES A JOB TYPE (issue 246 step 2).
//
// THE MODEL (Kevin, 2026-08-15). Two independent things, previously fused into
// lead_notification_prefs.category and gated by two split_* flags:
//
//   WHO HANDLES A JOB TYPE — one person per type, single-select. Their name
//     goes on that type's client emails AND a new lead of that type is
//     assigned to them. No row for a type, or a lead matching no type, means
//     the location owner. Several people can be assigned to one LEAD, but that
//     is a fact about the lead and is set on the lead, not here.
//
//   WHO IS TOLD ABOUT A NEW LEAD — per person, on/off. Nothing to do with job
//     types. See lib/notification-recipients.ts.
//
// ONE TABLE, ON PURPOSE. Handlers live in location_project_type_senders — the
// table that already routed the sender. Under this model the sender and the
// assignee are the SAME person for a type, so a second table would be two
// things that must never disagree, with nothing to keep them in step. The
// table keeps its old (now too-narrow) name until the Part 3 cleanup, where
// the rename can land in the same commit as its readers.
//
// NO FLAG. `locations.split_senders_enabled` and
// `locations.split_notifications_enabled` are no longer read by any handler,
// notify or assign path. "No handler row for this type" IS the off state — a
// per-location boolean was only ever a second way to say the same thing, and
// having both meant a location could hold handler rows that silently did
// nothing (which is exactly what loc_kc's four rows did for notifications).
// The columns still exist; Part 3 drops them.
//
// A HANDLER IS A PERSON. source_user_id is NOT NULL as of
// migrations/new_lead_handlers.sql: you can send AS a typed address but you
// cannot assign a lead to one. A handler whose account is disabled or
// deactivated is treated as ABSENT (the type falls to the owner) — the FK's
// ON DELETE CASCADE only covers hard deletes, and offboarding here is soft.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import {
  canonicalProjectType,
  getProjectTypeVocabulary,
  type VocabularyEntry,
} from './project-type-vocabulary'

export type ProjectTypeHandler = {
  project_type: string
  hub_user_id: string
  name: string
  email: string
  reply_to: string | null
}

// Every handler row at a location, keyed by canonical project-type label.
//
// ACTIVE HANDLERS ONLY. A row whose hub_user is disabled (disabled_at set) or
// deactivated (is_active false) is dropped here, so the type falls through to
// the location owner rather than assigning work to someone who has been
// offboarded — and rather than sending client email as them.
//
// FAIL-SOFT: any read error returns an empty map, i.e. "no handlers", i.e.
// everything goes to the owner and the base sender. A config read must never
// cost a lead its assignment or a drip its send.
export async function getLocationHandlers(
  locationId: string,
): Promise<Map<string, ProjectTypeHandler>> {
  const out = new Map<string, ProjectTypeHandler>()
  if (!locationId) return out
  try {
    const { data, error } = await supabaseService
      .from('location_project_type_senders')
      .select('project_type, sender_name, sender_email, sender_reply_to, source_user_id')
      .eq('location_id', locationId)
    if (error || !data || data.length === 0) return out

    const ids = Array.from(
      new Set(data.map((r: any) => r.source_user_id).filter(Boolean)),
    ) as string[]
    if (ids.length === 0) return out

    const { data: users } = await supabaseService
      .from('hub_users')
      .select('id, is_active, disabled_at')
      .in('id', ids)
    const usable = new Set(
      (users || [])
        .filter((u: any) => u.is_active !== false && !u.disabled_at)
        .map((u: any) => u.id),
    )

    for (const r of data as any[]) {
      if (!r.source_user_id || !usable.has(r.source_user_id)) continue
      const key = String(r.project_type || '').trim()
      if (!key) continue
      out.set(key.toLowerCase(), {
        project_type: key,
        hub_user_id: r.source_user_id,
        name: r.sender_name,
        email: r.sender_email,
        reply_to: r.sender_reply_to ?? null,
      })
    }
    return out
  } catch {
    return out
  }
}

// The handler for ONE canonical project type at a location, or null.
//
// Keyed on the lowercased label — the canonicalizer has already resolved the
// lead's raw value to a lookups label, and the DB's
// location_project_type_senders_loc_type_ci_idx guarantees a location cannot
// hold two rows differing only in case, so this lookup is unambiguous. That is
// the "canonicalize at the boundary, then match exactly" rule: the ONE
// case-fold lives here and in the canonicalizer, nowhere else.
export async function getHandlerForType(
  locationId: string,
  canonicalLabel: string | null,
): Promise<ProjectTypeHandler | null> {
  if (!canonicalLabel) return null
  const handlers = await getLocationHandlers(locationId)
  return handlers.get(canonicalLabel.trim().toLowerCase()) ?? null
}

// Resolve a RAW leads.project_type straight to its handler, doing the
// canonicalization on the way. The entry point for the send path, which holds
// a raw value and no vocabulary.
export async function resolveHandlerForRawType(
  locationId: string,
  rawProjectType: string | null | undefined,
  vocabulary?: VocabularyEntry[],
): Promise<ProjectTypeHandler | null> {
  if (!(rawProjectType || '').trim()) return null
  const vocab = vocabulary ?? (await getProjectTypeVocabulary())
  const label = canonicalProjectType(rawProjectType, vocab)
  return getHandlerForType(locationId, label)
}
