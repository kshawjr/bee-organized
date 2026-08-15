// lib/project-type-senders.ts
// ─────────────────────────────────────────────────────────────
// Per-project-type drip SENDER routing — CONFIG-side data access + helpers.
// The SEND-side resolver lives in lib/resend.ts (resolveProjectTypeSenderOverride),
// mirroring the drip send path it plugs into; this module is what the owner
// config UI/API read and write.
//
// MODEL (see migrations/location_project_type_senders.sql):
//   • location_project_type_senders — one row per (location, project_type),
//     assigned to a HANDLER: a person on the location's team, name+email copied
//     from their hub_users row. One person may hold many types; a type maps to
//     at most one person.
//   • NO MASTER FLAG. locations.split_senders_enabled was retired in issue 246
//     step 2 and is read by nothing — "no row for this type" IS the off state,
//     said per type. A type with no row falls back to the base sender, enforced
//     at send time. The column itself survives until Part 3 drops it.
//
// Owner + super_admin/admin only — the API route gates every verb with
// notificationRecipientsManageableServer (same predicate as B1 recipients).
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import {
  canonicalProjectType,
  getProjectTypeVocabulary,
} from './project-type-vocabulary'

// hub_users roles offered as assignable senders — the location's operational
// people, same set B1 auto-lists as notification recipients.
export const SENDER_PICKABLE_ROLES = ['owner', 'manager'] as const

export type SenderIdentity = {
  sender_name: string
  sender_email: string
  sender_reply_to: string | null
  // issue 246 step 2 — NOT NULL, matching the column. A handler is a person:
  // you can send AS a typed address, but you cannot assign a lead to one.
  // Narrowing this from `string | null` is deliberate — it turns every caller
  // that used to pass null into a compile error rather than a runtime 23502.
  source_user_id: string
}

export type ProjectTypeAssignment = SenderIdentity & {
  id: string
  project_type: string
  domain_warning: boolean
}

export type SenderPerson = {
  id: string
  name: string
  email: string
  role: string
  domain_warning: boolean
}

export type SenderConfig = {
  base_sender_email: string | null
  base_sender_domain: string | null
  // Active project types with their drip family, so the config UI can group
  // them Organizing / Moving without a second lookups round-trip.
  project_types: string[]
  project_type_groups: Array<{ label: string; drip_category: 'move' | 'general' }>
  assignments: ProjectTypeAssignment[]
  people: SenderPerson[]
}

// ── Verified-domain heuristic ────────────────────────────────────────────────
// There is NO hardcoded sending domain in this app — a location's base
// send_from_email is prefilled from the owner's own profile email and is
// whatever domain the owner verified with Resend. So the deliverable domain is
// per-location: the base sender's domain. A picked sender whose email is on a
// DIFFERENT domain than the base sender likely isn't verified and won't
// deliver — we WARN (never hard-block; the owner may have verified more than
// one domain). Same-domain (or no base to compare against) → no warning.
export function emailDomain(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email.slice(at + 1).trim().toLowerCase() || null
}

export function senderDomainWarning(
  email: string | null | undefined,
  baseSenderEmail: string | null | undefined,
): boolean {
  const d = emailDomain(email)
  const base = emailDomain(baseSenderEmail)
  if (!d || !base) return false // can't compare → don't cry wolf
  return d !== base
}

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim()
}

// Full config payload for the owner UI: toggle, base sender, the global project
// type list, current assignments, and the assignable people (with per-item
// domain warnings). Reads name/email live from hub_users for the picker.
export async function getSenderConfig(locationId: string): Promise<SenderConfig> {
  const [locRes, typesRes, assignRes, peopleRes] = await Promise.all([
    supabaseService
      .from('locations')
      // split_senders_enabled is NO LONGER READ (issue 246 step 2) — "no
      // handler row" is the off state. The column survives until Part 3.
      .select('send_from_email')
      .eq('id', locationId)
      .maybeSingle(),
    supabaseService
      .from('lookups')
      .select('label, sort_order, attrs')
      .eq('category', 'project_types')
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    supabaseService
      .from('location_project_type_senders')
      .select('id, project_type, sender_name, sender_email, sender_reply_to, source_user_id')
      .eq('location_id', locationId),
    supabaseService
      .from('hub_users')
      .select('id, full_name, first_name, last_name, email, role, location_id')
      .eq('location_id', locationId)
      .in('role', SENDER_PICKABLE_ROLES as unknown as string[])
      .order('full_name', { ascending: true }),
  ])

  const baseSenderEmail = (locRes.data?.send_from_email as string | null) ?? null

  const projectTypeGroups = (typesRes.data || [])
    .map((r: any) => ({
      label: String(r.label || '').trim(),
      drip_category: (r?.attrs?.drip_category === 'move' ? 'move' : 'general') as
        | 'move'
        | 'general',
    }))
    .filter((r: { label: string }) => !!r.label)
  const projectTypes = projectTypeGroups.map((r: { label: string }) => r.label)

  const assignments: ProjectTypeAssignment[] = (assignRes.data || []).map((a: any) => ({
    id: a.id,
    project_type: a.project_type,
    sender_name: a.sender_name,
    sender_email: a.sender_email,
    sender_reply_to: a.sender_reply_to ?? null,
    source_user_id: a.source_user_id ?? null,
    domain_warning: senderDomainWarning(a.sender_email, baseSenderEmail),
  }))

  const people: SenderPerson[] = (peopleRes.data || []).map((u: any) => ({
    id: u.id,
    name: u.full_name || fullName(u.first_name, u.last_name) || u.email,
    email: u.email,
    role: u.role,
    domain_warning: senderDomainWarning(u.email, baseSenderEmail),
  }))

  return {
    base_sender_email: baseSenderEmail,
    base_sender_domain: emailDomain(baseSenderEmail),
    project_types: projectTypes,
    project_type_groups: projectTypeGroups,
    assignments,
    people,
  }
}

// setSplitEnabled() retired with the flag it wrote (issue 246 step 2). Nothing
// sets locations.split_senders_enabled any more; Part 3 drops the column.

// Assign a HANDLER to a set of project types. Upserts one row per type on the
// (location_id, project_type) unique key, so reassigning a type MOVES it to
// this person — a type is never on two handlers at once (one-per-type). Types
// already owned by this same person are refreshed. Returns nothing; caller
// re-reads config.
//
// CANONICALIZES ON WRITE (issue 246 step 2). Labels are stored exactly as
// lookups spells them, so the read side never has to guess. This is the write
// half of "canonicalize at the boundary, then match exactly" — with it, the
// DB's ..._loc_type_ci_idx should never actually fire, and if it ever does
// (23505) that is a real bug surfacing loudly rather than two case-variant
// handler rows quietly coexisting. A label that resolves to nothing is
// REJECTED rather than stored: an unmatchable handler row is a control the
// owner sets and that then does nothing.
export async function assignSenderToTypes(
  locationId: string,
  sender: SenderIdentity,
  projectTypes: string[],
): Promise<void> {
  if (projectTypes.length === 0) return
  if (!sender.source_user_id) {
    throw new Error('assign_sender: a handler must be a person (source_user_id required)')
  }

  const vocabulary = await getProjectTypeVocabulary()
  const canonical: string[] = []
  for (const pt of projectTypes) {
    const label = canonicalProjectType(pt, vocabulary)
    if (!label) throw new Error(`assign_sender: unknown project type ${JSON.stringify(pt)}`)
    canonical.push(label)
  }

  const nowIso = new Date().toISOString()
  const rows = Array.from(new Set(canonical)).map((pt) => ({
    location_id: locationId,
    project_type: pt,
    sender_name: sender.sender_name,
    sender_email: sender.sender_email,
    sender_reply_to: sender.sender_reply_to ?? null,
    source_user_id: sender.source_user_id,
    updated_at: nowIso,
  }))
  const { error } = await supabaseService
    .from('location_project_type_senders')
    .upsert(rows, { onConflict: 'location_id,project_type' })
  if (error) throw new Error(`assign_sender: ${error.message}`)
}

// Remove the handler(s) for the given project types → those types fall back to
// the location owner (assignment) and the base sender (email identity).
//
// Canonicalizes before deleting for the same reason the write does: a caller
// passing 'moving/relocation' must delete the 'Moving/Relocation' row, not
// silently match nothing and leave the handler in place while the UI shows it
// cleared. An unknown label deletes nothing, which is already correct.
export async function unassignTypes(
  locationId: string,
  projectTypes: string[],
): Promise<void> {
  if (projectTypes.length === 0) return
  const vocabulary = await getProjectTypeVocabulary()
  const canonical = projectTypes
    .map((pt) => canonicalProjectType(pt, vocabulary) ?? pt)
  const { error } = await supabaseService
    .from('location_project_type_senders')
    .delete()
    .eq('location_id', locationId)
    .in('project_type', Array.from(new Set(canonical)))
  if (error) throw new Error(`unassign_types: ${error.message}`)
}
