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

export const RECIPIENT_CATEGORIES = ['all', 'moving', 'organizing'] as const
export type RecipientCategory = (typeof RECIPIENT_CATEGORIES)[number]
export const DEFAULT_CATEGORY: RecipientCategory = 'all'

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
  category: RecipientCategory
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
  category: RecipientCategory
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
  category: RecipientCategory
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
    const category = pref && isRecipientCategory(pref.category) ? pref.category : DEFAULT_CATEGORY
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
    category: isRecipientCategory(e.category) ? e.category : DEFAULT_CATEGORY,
  }))

  return { users, externals }
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
