// lib/project-type-senders.ts
// ─────────────────────────────────────────────────────────────
// Per-project-type drip SENDER routing — CONFIG-side data access + helpers.
// The SEND-side resolver lives in lib/resend.ts (resolveProjectTypeSenderOverride),
// mirroring the drip send path it plugs into; this module is what the owner
// config UI/API read and write.
//
// MODEL (see migrations/location_project_type_senders.sql):
//   • locations.split_senders_enabled — master toggle. false (default) = the
//     base sender handles every project type.
//   • location_project_type_senders — one row per (location, project_type)
//     assigned to a sender (name+email copied from a picked hub_user, or typed).
//     A sender may own many types; a type maps to at most one sender.
//   • Unassigned types / disabled split → base sender (enforced at send time).
//
// Owner + super_admin/admin only — the API route gates every verb with
// notificationRecipientsManageableServer (same predicate as B1 recipients).
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

// hub_users roles offered as assignable senders — the location's operational
// people, same set B1 auto-lists as notification recipients.
export const SENDER_PICKABLE_ROLES = ['owner', 'manager'] as const

export type SenderIdentity = {
  sender_name: string
  sender_email: string
  sender_reply_to: string | null
  source_user_id: string | null
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
  enabled: boolean
  base_sender_email: string | null
  base_sender_domain: string | null
  project_types: string[]
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
      .select('split_senders_enabled, send_from_email')
      .eq('id', locationId)
      .maybeSingle(),
    supabaseService
      .from('lookups')
      .select('label, sort_order')
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
  const enabled = locRes.data?.split_senders_enabled === true

  const projectTypes = (typesRes.data || []).map((r: any) => r.label).filter(Boolean)

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
    enabled,
    base_sender_email: baseSenderEmail,
    base_sender_domain: emailDomain(baseSenderEmail),
    project_types: projectTypes,
    assignments,
    people,
  }
}

export async function setSplitEnabled(locationId: string, enabled: boolean): Promise<void> {
  const { error } = await supabaseService
    .from('locations')
    .update({ split_senders_enabled: enabled })
    .eq('id', locationId)
  if (error) throw new Error(`set_split_enabled: ${error.message}`)
}

// Assign a sender to a set of project types. Upserts one row per type on the
// (location_id, project_type) unique key, so reassigning a type MOVES it to
// this sender — a type is never on two senders at once (one-per-type). Types
// already owned by this same sender are refreshed. Returns nothing; caller
// re-reads config.
export async function assignSenderToTypes(
  locationId: string,
  sender: SenderIdentity,
  projectTypes: string[],
): Promise<void> {
  if (projectTypes.length === 0) return
  const nowIso = new Date().toISOString()
  const rows = projectTypes.map((pt) => ({
    location_id: locationId,
    project_type: pt,
    sender_name: sender.sender_name,
    sender_email: sender.sender_email,
    sender_reply_to: sender.sender_reply_to ?? null,
    source_user_id: sender.source_user_id ?? null,
    updated_at: nowIso,
  }))
  const { error } = await supabaseService
    .from('location_project_type_senders')
    .upsert(rows, { onConflict: 'location_id,project_type' })
  if (error) throw new Error(`assign_sender: ${error.message}`)
}

// Remove the assignment(s) for the given project types → they fall back to the
// base sender.
export async function unassignTypes(
  locationId: string,
  projectTypes: string[],
): Promise<void> {
  if (projectTypes.length === 0) return
  const { error } = await supabaseService
    .from('location_project_type_senders')
    .delete()
    .eq('location_id', locationId)
    .in('project_type', projectTypes)
  if (error) throw new Error(`unassign_types: ${error.message}`)
}
