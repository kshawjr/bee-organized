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
  // issue 246 step 2 — the on/off switch interface users always had. Muting an
  // outside address used to mean DELETING the row, which lost the record and
  // guaranteed the nightly Zoho top-up (cron 05:00) put a Zoho-sourced address
  // straight back the next morning. REQUIRED, not optional: making it optional
  // would let every drop point in the chain (the two .select() lists, the two
  // route allowlists) compile clean while silently never carrying the value.
  subscribed: boolean
}

export type ManageableRecipients = {
  users: InterfaceRecipient[]
  externals: ExternalRecipient[]
}

// A flat, send-ready recipient (what B2 fans out over). 'zoho' recipients come
// from a location's Zoho Contacts related list — the fallback for locations
// with no in-interface recipients (see resolveLeadRecipients). 'global_cc'
// recipients come from the tenant-wide oversight list (resolveGlobalCcRecipients)
// and are merged by notifyNewLead AFTER routing — they never flow through
// resolveLeadRecipients.
export type EffectiveRecipient = {
  source: 'user' | 'external' | 'zoho' | 'global_cc'
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
      .select('id, first_name, last_name, email, phone, category, subscribed')
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
    // FORWARD-SAFE: `!== false` rather than `=== true`. If this ever runs
    // against a database where the column is missing (a rolled-back migration,
    // a stale branch DB), undefined reads as SUBSCRIBED — the pre-migration
    // behaviour — rather than silently muting all 50 existing recipients.
    // Defaulting the other way would turn a schema mismatch into a location
    // that stops hearing about its leads and never says so.
    subscribed: (e as any).subscribed !== false,
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

// ── RETIRED IN ISSUE 246 STEP 2 ─────────────────────────────────────────────
//
//   isSplitNotificationsEnabled()      read locations.split_notifications_enabled
//   resolveLeadDripCategory()          resolved a lead's 'move'|'general' family
//   filterRecipientsByProjectType()    filtered the send list by category set
//
// All three existed to serve one idea — that WHO IS TOLD could depend on the
// job type — and that idea is what step 2 removes. Deleted rather than left
// exported-and-unused: an unused resolver is an invitation to wire it back in,
// and 240 step 4 already showed what a live-looking-but-dead code path costs.
//
// The COLUMN survives (Part 3 drops it). Nothing in the notify or assign path
// reads it any more. The only remaining reader in the codebase is
// app/api/admin/system-health/route.ts, which reports on it; that read is
// harmless and goes with the column.

// Full config payload for the New leads section: the manageable recipients and
// the global project-type list. `split_enabled` is GONE from this payload —
// there is no toggle left for the UI to render.
export type NotificationConfig = ManageableRecipients & {
  project_types: string[]
}

export async function getNotificationConfig(
  locationId: string,
): Promise<NotificationConfig> {
  const [recipients, project_types] = await Promise.all([
    getManageableRecipients(locationId),
    getNotificationProjectTypes(),
  ])
  return { ...recipients, project_types }
}

// setSplitNotificationsEnabled() retired with the toggle it wrote (issue 246
// step 2). The column is still there; nothing sets it any more.
//
// filterRecipientsByProjectType() retired with the routing it performed. Its
// TWIN COLLAPSE (one person, one entry, when the Zoho seed put an owner's
// address into lead_notification_externals as well) is NOT lost — that guard
// already exists, and earlier, in resolveBaseLeadRecipients below, which
// suppresses any external sharing an interface user's address keyed on the
// same lowercased email. The collapse in the routing filter was the second of
// two passes; the first one survives and is the one that matters, because it
// also stops a twin from defeating an unsubscribe.

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
// issue 246 step 2 — NO PROJECT-TYPE ROUTING, AND NO FLAG.
//
// This used to read locations.split_notifications_enabled and, when on, filter
// the list by each recipient's category set. Both are gone. "Who is told" is
// now one thing only: a per-person on/off switch (prefs.subscribed for
// interface users, externals.subscribed for outside addresses), already
// applied by resolveBaseLeadRecipients. Job types decide who HANDLES a lead
// (lib/project-type-handlers.ts), never who hears about it.
//
// The `lead` parameter is retained and deliberately unused: every caller
// passes it, the signature is load-bearing across the send path, and removing
// it would be a wider change than this step wants. It is documented as ignored
// rather than quietly dropped.
//
// Verified against production 2026-08-15: this changes who is notified at ZERO
// locations. The flag was true at only loc_scottsdale (0 prefs, 0 claims — the
// filter already resolved to everyone, so it was inert) and loc_test.
export async function resolveLeadRecipients(
  locationId: string,
  _lead?: { project_type?: string | null } | null,
): Promise<EffectiveRecipient[]> {
  return resolveBaseLeadRecipients(locationId)
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
    // An external row that shares an interface user's address (the seeded
    // "twin") is SUPPRESSED here so the user's pref fully governs. Externals
    // have no subscribe flag, so left in, a twin keeps a person on the send
    // list after they unsubscribe or lose access (/api/hub_users/[id]/access
    // flips subscribed=false — the twin would silently defeat it). Keyed on
    // ALL interface users, not just subscribed ones, and case-insensitively —
    // same lowercased-email key as the send-time dedupe and the twin collapse
    // in filterRecipientsByProjectType. A lite_user's address never matches
    // (they aren't in `users`), so an external row carrying a lite_user keeps
    // notifying them.
    const interfaceEmails = new Set(
      users
        .map((u) => u.email?.trim().toLowerCase())
        .filter((e): e is string => !!e),
    )
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
      // issue 246 step 2 — THE MUTE, HONOURED AT SEND TIME.
      //
      // This one line is the whole point of adding the column. Without it the
      // owner flips the switch, the UI shows the address as off, the row says
      // subscribed=false — and the send path, which never asked, keeps mailing
      // them. Nothing errors, nothing logs, and the interface is simply lying.
      // Pinned by lib/beta-new-leads-246b.test.ts ("the SEND path honours a
      // muted external"), which fails if this line is removed.
      if (!e.subscribed) continue
      if (e.email && interfaceEmails.has(e.email.trim().toLowerCase())) continue
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

// Delete any external row that duplicates a hub_user's address at ONE location
// — the cross-table twin cleanup, invoked when a person becomes an interface
// user there (invite accept). Location-scoped: the same address at another
// location is a different list and must survive. Case-insensitive: the
// 2026-07-19 seed predates the lowercased-storage rule, so stored casing can't
// be trusted; rows are matched in code on the lowercased email, then deleted
// by id (an ilike would treat % and _ in an address as wildcards).
//
// ONLY for interface roles (owner/manager). A lite_user is NOT auto-included
// by the resolver, so for them the external row is the only thing carrying
// their notifications — deleting it would silence them, not dedupe them (same
// rule scripts/cleanup-owner-duplicate-externals.mjs enforces). A non-interface
// role is a no-op, not an error.
//
// NON-THROWING by contract: the callers are user-facing actions (accepting an
// invite) where this is bookkeeping — a cleanup failure is logged loudly and
// reported in the result, never propagated. Idempotent: zero matches deletes
// nothing and succeeds.
export async function removeExternalTwinsForHubUser(args: {
  locationId: string
  email: string
  role: string
}): Promise<{ removed: number; skipped?: 'non_interface_role'; error?: string }> {
  const { locationId, role } = args
  const key = args.email?.trim().toLowerCase()
  if (!key) return { removed: 0 }
  if (!(RECIPIENT_INTERFACE_ROLES as readonly string[]).includes(role)) {
    return { removed: 0, skipped: 'non_interface_role' }
  }
  try {
    const { data, error } = await supabaseService
      .from('lead_notification_externals')
      .select('id, email')
      .eq('location_id', locationId)
    if (error) throw new Error(error.message)

    const ids = (data || [])
      .filter((r: any) => typeof r.email === 'string' && r.email.trim().toLowerCase() === key)
      .map((r: any) => r.id)
    if (ids.length === 0) return { removed: 0 }

    const { error: delErr } = await supabaseService
      .from('lead_notification_externals')
      .delete()
      .in('id', ids)
    if (delErr) throw new Error(delErr.message)
    return { removed: ids.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(
      `[notification-recipients] external twin cleanup failed for location ${locationId}: ${message}`,
    )
    return { removed: 0, error: message }
  }
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

// ── Is this LOCATION on Bee Hub? (#91) ──────────────────────────────────────
// The lead notification branches by LOCATION, not by recipient (that was #72's
// mistake — it split per recipient and produced two sends per lead). A location
// with at least one ACTIVE hub_user (is_active = true AND disabled_at IS NULL)
// gets the Bee Hub email — button, branding, the #82 footer. A location with
// NONE gets a clean notification carrying zero Bee Hub references, because its
// recipients (Zoho contacts, hand-added externals) don't use Bee Hub and the
// dead button + "get set up" footer only confused them.
//
// ANY role counts. An active lite_user still means someone at that office holds
// a Bee Hub account and recognizes the product, so the question is "does anyone
// here have access", not "is anyone here an owner/manager". Both columns are
// required: is_active gates the seat, disabled_at gates the reversible offboard
// — a removed user (disabled_at set) is not access, matching how the global CC
// resolver and access-removal treat "active".
//
// FAIL-SOFT to NO-ACCESS: on a read error we return false, so the location gets
// the clean, Bee-Hub-free email. A lookup failure must NOT default to the Bee
// Hub email — that would produce the exact dead-button/"get set up" message
// this branch exists to prevent, aimed at recipients who don't use Bee Hub. The
// worst case on error is a real hub location losing its button for one send;
// the worst case the other way is a non-hub office getting the confusing email,
// which is strictly worse. The miss is logged loudly, and the email sends
// either way — this only ever picks WHICH body, never whether to send.
export async function locationHasActiveHubUser(
  locationId: string,
): Promise<boolean> {
  try {
    // limit(1) — existence check, not a count. PostgREST head:true count is the
    // only aggregate that works here, but we don't even need the number: one
    // active row is enough to answer the question.
    const res = await supabaseService
      .from('hub_users')
      .select('id')
      .eq('location_id', locationId)
      .eq('is_active', true)
      .is('disabled_at', null)
      .limit(1)
    if ((res as any)?.error) {
      console.warn(
        `[notification-recipients] hub-access check failed for location ${locationId} (${(res as any).error.message}) — treating as NOT on Bee Hub`,
      )
      return false
    }
    return ((res.data as any[]) || []).length > 0
  } catch (err: any) {
    console.warn(
      `[notification-recipients] hub-access check threw for location ${locationId} (${err?.message}) — treating as NOT on Bee Hub`,
    )
    return false
  }
}

// ── Global CC (corporate oversight) ─────────────────────────────────────────
// Addresses that receive EVERY lead notification at EVERY live location —
// lead_notification_global_cc (migrations/lead_notification_global_cc.sql,
// HELD until Kevin runs it). Distinct from lead_notification_externals
// (location-keyed): this list is tenant-wide, carries NO category, and is
// IMMUNE to split-notification routing by definition. That immunity is WHY it
// lives here as its own resolver instead of joining resolveBaseLeadRecipients:
// anything in the base list flows through filterRecipientsByProjectType when a
// location's split toggle is ON (and participates in the Zoho-fallback and
// never-drop decisions), exactly where a global observer must not participate.
// notifyNewLead merges this list AFTER resolveLeadRecipients has finished
// routing — and after the notifications_live gate, so a muted location sends
// nothing to anyone, global CC included.
//
// hub_user match: a global CC whose address belongs to an ACTIVE hub_user
// (disabled_at null) gets hub_user_id set. notifyNewLead reads that to hand
// them the with-button variant — they can open the record; an account-less or
// disabled address would only hit a login it can never pass.
//
// FAIL-SOFT BY CONTRACT: any failure — table not yet migrated, read error,
// thrown client — returns []. Losing corporate visibility must never cost a
// location owner their lead alert. Pre-migration this warns once per send;
// the noise disappears the day the DDL runs.
export async function resolveGlobalCcRecipients(): Promise<EffectiveRecipient[]> {
  try {
    const res = await supabaseService
      .from('lead_notification_global_cc')
      .select('email, name, active')
      .eq('active', true)
    if ((res as any)?.error) {
      console.warn(
        `[notification-recipients] global CC read failed (${(res as any).error.message}) — continuing without global CC`,
      )
      return []
    }
    const rows = (res.data || []).filter((r: any) => r.email && String(r.email).trim())
    if (rows.length === 0) return []

    // Active-account match, in JS by lowercased email — hub_users is tiny and
    // a SQL .in() would be case-sensitive. A failed lookup degrades to "treat
    // as account-less" (details, no dead-end button) — never a lost send.
    const hubByEmail = new Map<string, string>()
    try {
      const hub = await supabaseService
        .from('hub_users')
        .select('id, email, disabled_at')
      for (const u of hub.data || []) {
        if (u.email && !u.disabled_at) {
          hubByEmail.set(String(u.email).trim().toLowerCase(), u.id)
        }
      }
    } catch {
      // Swallowed: match failure must not cost the CC their email.
    }

    return rows.map((r: any) => {
      const email = String(r.email).trim()
      return {
        source: 'global_cc' as const,
        hub_user_id: hubByEmail.get(email.toLowerCase()) ?? null,
        name: r.name || email,
        email,
        category: DEFAULT_CATEGORY,
      }
    })
  } catch (err: any) {
    console.warn(
      `[notification-recipients] global CC resolution threw (${err?.message}) — continuing without global CC`,
    )
    return []
  }
}
