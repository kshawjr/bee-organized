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

// A flat, send-ready recipient (what B2 fans out over).
export type EffectiveRecipient = {
  source: 'user' | 'external'
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

// Effective SEND list (B2 calls this): subscribed interface users + all
// externals, flattened. Unsubscribed users are excluded. Users with no pref
// row default to subscribed / 'all'.
export async function resolveLeadRecipients(
  locationId: string,
): Promise<EffectiveRecipient[]> {
  const { users, externals } = await getManageableRecipients(locationId)
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
