// lib/notification-recipients.ts
// ─────────────────────────────────────────────────────────────
// Lead Notification Recipients — data shapes, category constants, and the
// resolver B2 (lead-email fan-out) will call to get the effective recipient
// list for a location.
//
// Two kinds of recipient, both carrying a category preference:
//   1. INTERFACE USERS — hub_users at the location (owner, managers, …).
//      AUTO-INCLUDED by default. A row in lead_notification_prefs is written
//      ONLY when the owner changes something (category or unsubscribe); its
//      ABSENCE means the default (subscribed, category 'all'). So a new
//      manager is notified with zero setup, and unsubscribing a terminated
//      manager is a single persisted row. Name/email are read LIVE from
//      hub_users here — never copied — so they stay correct if a user renames.
//   2. EXTERNAL RECIPIENTS — non-users added by hand (lead_notification_
//      externals). Stored directly with their own name/email/phone/category.
//
// Category options: 'all' (DEFAULT) | 'moving' | 'organizing'.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { getZohoLocationNotificationContacts } from './zoho'
import { categoryMatchesLead, isSpecificSelection } from './notification-project-types'

// Legacy single-value categories (B1). Retained for the API's backward-compat
// validation and for tests; the unified UI now writes a project-type SET (or
// 'all') into the same free-text category field — see notification-project-
// types.ts. A recipient's stored category is therefore a plain string, not a
// closed enum.
export const RECIPIENT_CATEGORIES = ['all', 'moving', 'organizing'] as const
export type RecipientCategory = (typeof RECIPIENT_CATEGORIES)[number]
export const DEFAULT_CATEGORY = 'all'

export function isRecipientCategory(v: unknown): v is RecipientCategory {
  return typeof v === 'string' && (RECIPIENT_CATEGORIES as readonly string[]).includes(v)
}

// Which hub_users roles are auto-included as interface recipients. Owner +
// manager are the location's operational team who act on leads; lite_user
// (read-only viewer) and elevated corporate accounts are not location leads
// and are not auto-notified.
export const RECIPIENT_INTERFACE_ROLES = ['owner', 'manager'] as const

export type InterfaceRecipient = {
  type: 'user'
  hub_user_id: string
  name: string
  email: string
  role: string
  // Free-text project-type routing: 'all' | JSON array of project-type labels
  // | legacy 'moving'/'organizing'. See notification-project-types.ts.
  category: string
  subscribed: boolean
}

export type ExternalRecipient = {
  type: 'external'
  id: string
  first_name: string | null
  last_name: string | null
  name: string
  email: string
  phone: string | null
  category: string
}

export type ManageableRecipients = {
  users: InterfaceRecipient[]
  externals: ExternalRecipient[]
}

// A flat, send-ready recipient (what B2 fans out over). 'zoho' recipients come
// from a location's Zoho Contacts related list — the fallback for locations
// with no in-interface recipients (see resolveLeadRecipients).
export type EffectiveRecipient = {
  source: 'user' | 'external' | 'zoho'
  hub_user_id: string | null
  name: string
  email: string
  category: string
}

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim()
}

// Merged list for the MANAGEMENT UI/API: every interface user (with their
// effective category + subscribed flag, defaults applied) plus every external.
// Does NOT filter out unsubscribed users — the UI needs to show them so they
// can be re-subscribed. Reads names/emails live from hub_users.
export async function getManageableRecipients(
  locationId: string,
): Promise<ManageableRecipients> {
  const [usersRes, prefsRes, extRes] = await Promise.all([
    supabaseService
      .from('hub_users')
      .select('id, full_name, first_name, last_name, email, role, location_id')
      .eq('location_id', locationId)
      .in('role', RECIPIENT_INTERFACE_ROLES as unknown as string[])
      .order('role', { ascending: true })
      .order('full_name', { ascending: true }),
    supabaseService
      .from('lead_notification_prefs')
      .select('hub_user_id, category, subscribed')
      .eq('location_id', locationId),
    supabaseService
      .from('lead_notification_externals')
      .select('id, first_name, last_name, email, phone, category')
      .eq('location_id', locationId)
      .order('created_at', { ascending: true }),
  ])

  const prefByUser = new Map<string, { category: string; subscribed: boolean }>()
  for (const p of prefsRes.data || []) {
    prefByUser.set(p.hub_user_id, { category: p.category, subscribed: p.subscribed })
  }

  const users: InterfaceRecipient[] = (usersRes.data || []).map((u) => {
    const pref = prefByUser.get(u.id)
    // Pass the stored category through verbatim (widened to a project-type set
    // in the unified section); only absence/empty falls back to the default.
    const category = pref?.category ? String(pref.category) : DEFAULT_CATEGORY
    const subscribed = pref ? pref.subscribed : true
    return {
      type: 'user',
      hub_user_id: u.id,
      name: u.full_name || fullName(u.first_name, u.last_name) || u.email,
      email: u.email,
      role: u.role,
      category,
      subscribed,
    }
  })

  const externals: ExternalRecipient[] = (extRes.data || []).map((e) => ({
    type: 'external',
    id: e.id,
    first_name: e.first_name,
    last_name: e.last_name,
    name: fullName(e.first_name, e.last_name) || e.email,
    email: e.email,
    phone: e.phone,
    category: e.category ? String(e.category) : DEFAULT_CATEGORY,
  }))

  return { users, externals }
}

// The global project-type label list (lookups, category='project_types'),
// shared by every location. Used by the unified section's per-type assignment
// UI. Falls back to [] if the lookups read fails — the basic notify list stays
// fully functional without it.
export async function getNotificationProjectTypes(): Promise<string[]> {
  try {
    const res = await supabaseService
      .from('lookups')
      .select('label, sort_order')
      .eq('category', 'project_types')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    return (res.data || []).map((r: any) => r.label).filter(Boolean)
  } catch {
    return []
  }
}

// Forward-safe read of the per-location notify split toggle. Returns false if
// the column doesn't exist yet (migration not run) or the read errors, so the
// section degrades to basic (notify-everyone) behavior with no error. Uses
// array access (not .single()) to stay defensive.
export async function isSplitNotificationsEnabled(locationId: string): Promise<boolean> {
  try {
    const res = await supabaseService
      .from('locations')
      .select('split_notifications_enabled')
      .eq('id', locationId)
    if ((res as any)?.error) return false
    const row = (res.data || [])[0] as any
    return row?.split_notifications_enabled === true
  } catch {
    return false
  }
}

// Mirror of resolveDripCategory (lib/stage-emails.ts) — inlined here to keep the
// notification send path off the heavy stage-emails/drip-send import chain and
// fully mockable via supabaseService. project_type label → 'move' | 'general';
// defaults to 'general' when the label isn't found. Only consulted to resolve
// LEGACY 'moving'/'organizing' recipients against a lead.
async function resolveLeadDripCategory(
  projectType: string | null,
): Promise<'move' | 'general'> {
  if (!projectType) return 'general'
  try {
    const res = await supabaseService
      .from('lookups')
      .select('attrs')
      .eq('category', 'project_types')
      .eq('label', projectType)
      .eq('is_active', true)
    const row = (res.data || [])[0] as any
    return row?.attrs?.drip_category === 'move' ? 'move' : 'general'
  } catch {
    return 'general'
  }
}

// Full config payload for the unified section's PART 1 (notifications): the
// manageable recipients, the global project-type list, and the current split
// toggle state.
export type NotificationConfig = ManageableRecipients & {
  project_types: string[]
  split_enabled: boolean
}

export async function getNotificationConfig(
  locationId: string,
): Promise<NotificationConfig> {
  const [recipients, project_types, split_enabled] = await Promise.all([
    getManageableRecipients(locationId),
    getNotificationProjectTypes(),
    isSplitNotificationsEnabled(locationId),
  ])
  return { ...recipients, project_types, split_enabled }
}

// Persist the per-location notify split toggle.
export async function setSplitNotificationsEnabled(
  locationId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabaseService
    .from('locations')
    .update({ split_notifications_enabled: enabled })
    .eq('id', locationId)
  if (error) throw new Error(`set_split_notifications: ${error.message}`)
}

// PART 1 send-time routing. Given the base send list (already subscribed-
// filtered) and the lead, return who should actually be notified when the
// split toggle is ON:
//
//   • A recipient matches if their project-type set includes the lead's type,
//     OR they are 'all' (legacy 'moving'/'organizing' match on drip category).
//   • "Everything else → whole team": if NO recipient SPECIFICALLY claims this
//     lead's type, the type is unassigned and the WHOLE team (all subscribed
//     interface users) is notified — plus any cross-cutting 'all' recipients.
//   • NEVER-DROP: if the filter would notify nobody, fall back to the whole
//     team; if there are no interface users at all, fall back to the full base
//     list. A lead notification must never silently reach no one.
export function filterRecipientsByProjectType(
  base: EffectiveRecipient[],
  leadProjectType: string | null,
  leadDripCategory: 'move' | 'general',
): EffectiveRecipient[] {
  // TWIN COLLAPSE — one person, one entry, BEFORE any routing decision. The
  // Zoho seed/top-up put owner emails into lead_notification_externals that
  // also belong to a hub_user at the location, so `base` can carry the same
  // person twice: once as source 'user' (with the category the owner actually
  // configured) and once as source 'external' (seeded category 'all'). Left
  // in, the 'all' twin matches EVERY lead — so a person whose hub_user row
  // claims specific types could never be routed away from anything, defeating
  // the split. Collapse by lowercased email; the hub_user entry WINS over the
  // external (a real app user and their configured preference outrank a seeded
  // address). Rows with no email are kept as-is — they can't collide.
  const at = new Map<string, number>()
  const people: EffectiveRecipient[] = []
  for (const r of base) {
    const key = r.email?.trim().toLowerCase()
    if (!key) {
      people.push(r)
      continue
    }
    const i = at.get(key)
    if (i === undefined) {
      at.set(key, people.length)
      people.push(r)
    } else if (people[i].source !== 'user' && r.source === 'user') {
      people[i] = r
    }
  }

  const matched = people.filter((r) =>
    categoryMatchesLead(r.category, leadProjectType, leadDripCategory),
  )
  // The type is "claimed" iff a SPECIFIC (type-set) recipient matched it.
  const claimed = matched.some((r) => isSpecificSelection(r.category))
  const team = people.filter((r) => r.source === 'user')

  let result: EffectiveRecipient[]
  if (claimed) {
    result = matched
  } else {
    // Unassigned type → everything-else bucket → whole team ∪ cross-cutting.
    const seen = new Set(matched.map((r) => r.email))
    result = [...matched]
    for (const u of team) {
      if (!seen.has(u.email)) {
        seen.add(u.email)
        result.push(u)
      }
    }
  }

  // NEVER-DROP backstop.
  if (result.length === 0) result = team.length ? team : people
  return result
}

// Effective SEND list (B2 calls this). PRECEDENCE:
//   1. If the location has ANY in-interface recipients (owner/manager hub_users
//      or externals — B1 tables), use those: subscribed users + all externals,
//      flattened. Zoho is NOT consulted. An all-unsubscribed interface location
//      returns [] deliberately (the owner turned everyone off) — we do NOT
//      resurrect Zoho contacts behind their back.
//   2. ELSE (a non-interface location — no hub_users at all) fall back to the
//      location's Zoho Contacts related list, so B2's send transparently
//      reaches the ~non-interface locations too.
//
// FAIL LOUD: a Zoho fetch failure, or a location that resolves to zero
// recipients, is logged with the location id — a location must never SILENTLY
// receive no notification.
export async function resolveLeadRecipients(
  locationId: string,
  lead?: { project_type?: string | null } | null,
): Promise<EffectiveRecipient[]> {
  const base = await resolveBaseLeadRecipients(locationId)

  // PART 1 project-type routing is applied ONLY when the split toggle is ON and
  // we were given a lead to route on. Otherwise behavior is unchanged: every
  // subscribed recipient is returned (B1/B2 semantics). The toggle read is
  // forward-safe — a missing column reads false → basic behavior.
  if (!lead) return base
  const splitOn = await isSplitNotificationsEnabled(locationId)
  if (!splitOn) return base

  const projectType = lead.project_type?.trim() || null
  const dripCategory = await resolveLeadDripCategory(projectType)
  return filterRecipientsByProjectType(base, projectType, dripCategory)
}

// The unfiltered send list: subscribed interface users + all externals, or the
// Zoho fallback for non-interface locations. This is the B1/B2 resolver, split
// out so resolveLeadRecipients can optionally layer PART 1 routing on top.
async function resolveBaseLeadRecipients(
  locationId: string,
): Promise<EffectiveRecipient[]> {
  const { users, externals } = await getManageableRecipients(locationId)

  // A location is "interface-managed" if it has any owner/manager user or any
  // external configured — regardless of their subscribe state.
  const isInterfaceLocation = users.length > 0 || externals.length > 0

  if (isInterfaceLocation) {
    const out: EffectiveRecipient[] = []
    for (const u of users) {
      if (!u.subscribed) continue
      out.push({
        source: 'user',
        hub_user_id: u.hub_user_id,
        name: u.name,
        email: u.email,
        category: u.category,
      })
    }
    for (const e of externals) {
      out.push({
        source: 'external',
        hub_user_id: null,
        name: e.name,
        email: e.email,
        category: e.category,
      })
    }
    return out
  }

  // No in-interface recipients — resolve from Zoho.
  return resolveZohoRecipients(locationId)
}

// Fallback resolver: a non-interface location's notification contacts live in
// Zoho as the Location's related Contacts. Maps the Supabase location UUID to
// its Zoho Location_ID slug, fetches the contacts, and returns them as
// send-ready recipients (category defaults to 'all' — Zoho carries no per-
// contact category). Opted-out contacts are excluded.
async function resolveZohoRecipients(
  locationId: string,
): Promise<EffectiveRecipient[]> {
  const locRes = await supabaseService
    .from('locations')
    .select('location_id')
    .eq('id', locationId)
  const slug = (locRes.data || [])[0]?.location_id as string | undefined

  if (!slug) {
    console.error(
      `[notification-recipients] location ${locationId} has no in-interface recipients and no Zoho Location_ID mapping — resolved to ZERO recipients`,
    )
    return []
  }

  let contacts
  try {
    contacts = await getZohoLocationNotificationContacts(slug)
  } catch (err: any) {
    // Loud, visible signal — do NOT silently drop the location's notifications.
    console.error(
      `[notification-recipients] Zoho notification-contacts fetch FAILED for location ${locationId} (${slug}): ${err?.message} — resolved to ZERO recipients`,
    )
    return []
  }

  const out: EffectiveRecipient[] = []
  for (const c of contacts) {
    if (c.opted_out || !c.email) continue
    out.push({
      source: 'zoho',
      hub_user_id: null,
      name: c.name,
      email: c.email,
      category: DEFAULT_CATEGORY,
    })
  }

  if (out.length === 0) {
    console.error(
      `[notification-recipients] location ${locationId} (${slug}) resolved to ZERO notification recipients from Zoho (no contacts, or all opted out)`,
    )
  }
  return out
}
