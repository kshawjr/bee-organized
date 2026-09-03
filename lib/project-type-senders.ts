// lib/project-type-senders.ts
// ─────────────────────────────────────────────────────────────
// Per-project-type drip SENDER routing — CONFIG-side data access + helpers.
// The SEND-side resolver lives in lib/resend.ts (resolveProjectTypeSenderOverride),
// mirroring the drip send path it plugs into; this module is what the owner
// config UI/API read and write.
//
// MODEL (see migrations/location_project_type_senders.sql):
//   • location_project_type_senders — one row per (location, project_type).
//     A row says TWO INDEPENDENT THINGS (issue 296):
//
//       WHO HANDLES IT   source_user_id. A person on the location's team.
//                        Drives the lead assignment. NOT NULL, always.
//       WHAT IT SENDS AS sender_is_custom + sender_name/_email/_reply_to.
//                        Either that person's own identity (custom=false, the
//                        default) or a hand-typed name and address such as a
//                        shared mailbox (custom=true), with its own reply-to.
//
//     One person may hold many types; a type maps to at most one person.
//   • NO MASTER FLAG. locations.split_senders_enabled was retired in issue 246
//     step 2 and is read by nothing — "no row for this type" IS the off state,
//     said per type. A type with no row falls back to the base sender, enforced
//     at send time. The column itself survives until Part 3 drops it.
//
// TWO FACTS, TWO WRITERS (issue 296). setHandlerForTypes changes WHO HANDLES;
// setSenderIdentityForType changes WHAT IT SENDS AS. Neither can clobber the
// other's columns. This is not tidiness — the single combined writer this
// replaced is exactly why sender_reply_to had a column, a validator and a
// persist path but no non-null row in production for its entire life: every
// save rewrote the whole row from a payload that never carried it. A write
// path that owns two independent facts will eventually erase one of them.
//
// Owner + super_admin/admin only — the API route gates every verb with
// notificationRecipientsManageableServer (same predicate as B1 recipients).
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { getLocationHandlers } from './project-type-handlers'
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
  // issue 296 — is sender_name/_email a hand-typed identity (true) or the
  // handler's own, snapshotted from hub_users (false)? REQUIRED, not optional,
  // for the same reason source_user_id below was narrowed in step 2: an
  // optional field is silently droppable at every call site, and this one
  // decides what address a client sees. `?` here would be a bug waiting.
  sender_is_custom: boolean
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
  // issue 303 — is this row's handler still a live person?
  //
  // The table says what a type is SET to; the send path says what it will DO,
  // and they disagree on exactly one axis. lib/project-type-handlers.ts drops a
  // PERSON-MODE row whose handler has been offboarded, so that type quietly
  // falls to the location's base sender — while the row itself still sits here
  // reading "Carol Kern". A reader that only wants to render the config can
  // ignore this; a reader that claims to say what a sequence SENDS AS cannot.
  //
  // A typed row is unaffected by its handler's liveness (a shared mailbox does
  // not stop existing when someone leaves), so this is false-but-harmless there
  // and consumers must branch on sender_is_custom first.
  handler_active: boolean
}

// The person half of a row — WHO HANDLES IT. Name/email are what a person-mode
// row snapshots; they are NOT read when the row is in typed mode.
export type HandlerPerson = {
  source_user_id: string
  name: string
  email: string
}

// The identity half of a row — WHAT IT SENDS AS. A discriminated union with no
// default branch, so a caller must state which mode it means. `custom: false`
// carries no address on purpose: person mode re-derives the identity from
// hub_users rather than trusting a caller to have the right copy.
export type SenderIdentityInput =
  | { sender_is_custom: false }
  | {
      sender_is_custom: true
      sender_name: string
      sender_email: string
      sender_reply_to: string | null
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
      .select('id, project_type, sender_name, sender_email, sender_reply_to, sender_is_custom, source_user_id')
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

  // WHOSE NAME WOULD ACTUALLY GO ON THE MAIL (issue 303). This ASKS THE SEND
  // PATH rather than re-deriving liveness from hub_users here. Re-deriving it
  // would put a second "is this person still with us" rule over one question,
  // which is the precise shape of the three-disagreeing-matching-rules bug that
  // lib/project-type-vocabulary.ts exists to have ended — and this rule is
  // fiddlier than it looks (is_active false OR disabled_at set, and a typed row
  // survives its handler while a person-mode row does not).
  //
  // getLocationHandlers is fail-soft: a read error yields an empty map, so every
  // person-mode row reads as inactive and the UI says those types fall back to
  // the base sender. That is the same answer the SEND path would give from the
  // same failure, which is the direction an honest report should lean.
  const liveHandlers = await getLocationHandlers(locationId)

  const assignments: ProjectTypeAssignment[] = (assignRes.data || []).map((a: any) => {
    const resolved = liveHandlers.get(String(a.project_type || '').trim().toLowerCase())
    return {
      id: a.id,
      project_type: a.project_type,
      sender_name: a.sender_name,
      sender_email: a.sender_email,
      sender_reply_to: a.sender_reply_to ?? null,
      sender_is_custom: a.sender_is_custom === true,
      source_user_id: a.source_user_id ?? null,
      domain_warning: senderDomainWarning(a.sender_email, baseSenderEmail),
      // A person-mode row is ABSENT from the map when its handler is gone; a
      // typed row is present with hub_user_id nulled. One rule covers both.
      handler_active: !!resolved && resolved.hub_user_id !== null,
    }
  })

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

// Canonicalize a caller's labels to lookups spelling, rejecting unknowns.
//
// CANONICALIZES ON WRITE (issue 246 step 2). Labels are stored exactly as
// lookups spells them, so the read side never has to guess. This is the write
// half of "canonicalize at the boundary, then match exactly" — with it, the
// DB's ..._loc_type_ci_idx should never actually fire, and if it ever does
// (23505) that is a real bug surfacing loudly rather than two case-variant
// handler rows quietly coexisting. A label that resolves to nothing is
// REJECTED rather than stored: an unmatchable handler row is a control the
// owner sets and that then does nothing.
async function canonicalizeOrThrow(op: string, projectTypes: string[]): Promise<string[]> {
  const vocabulary = await getProjectTypeVocabulary()
  const canonical: string[] = []
  for (const pt of projectTypes) {
    const label = canonicalProjectType(pt, vocabulary)
    if (!label) throw new Error(`${op}: unknown project type ${JSON.stringify(pt)}`)
    canonical.push(label)
  }
  return Array.from(new Set(canonical))
}

// A person who may be picked as a handler at this location, or null if they
// may not be. Resolves their CURRENT name and email from hub_users.
//
// The route used to take sender_name/sender_email straight off the request and
// store them (issue 296 stops that). Person mode means "send as the handler",
// so the identity has exactly one truthful source; letting the client supply it
// meant a stale copy could be persisted, and meant an authenticated owner could
// POST any address at all as any person's identity. Reading it here removes
// both. Typed mode is where an arbitrary address is a legitimate answer, and it
// says so.
export async function getPickableHandler(
  locationId: string,
  userId: string,
): Promise<HandlerPerson | null> {
  if (!locationId || !userId) return null
  const { data, error } = await supabaseService
    .from('hub_users')
    .select('id, full_name, first_name, last_name, email, role, location_id')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return null
  const u = data as any
  if (u.location_id !== locationId) return null
  if (!(SENDER_PICKABLE_ROLES as readonly string[]).includes(u.role)) return null
  if (!u.email) return null
  return {
    source_user_id: u.id,
    name: u.full_name || fullName(u.first_name, u.last_name) || u.email,
    email: u.email,
  }
}

// ── WRITER 1 of 2 · WHO HANDLES IT ──────────────────────────────────────────
//
// Assign a HANDLER to a set of project types. Upserts one row per type on the
// (location_id, project_type) unique key, so reassigning a type MOVES it to
// this person — a type is never on two handlers at once (one-per-type). Types
// already owned by this same person are refreshed. Returns nothing; caller
// re-reads config.
//
// THIS FUNCTION DOES NOT DECIDE WHAT A TYPE SENDS AS (issue 296). A type
// already sending as a typed address keeps sending as it when its handler
// changes — those are independent facts, and re-picking a handler is not a
// statement about the From line. Concretely: KC's Moving/Relocation sends as
// moving@beeorganized-kc.com; moving it from Carol to Lynette must not silently
// put it back to a personal address.
//
// THE SILENT WIPE, AND WHY THE FIX LIVES HERE. PostgREST's upsert REPLACES the
// conflicting row — every column absent from the payload takes its DEFAULT, not
// its previous value. The old combined writer always wrote
// `sender_reply_to: sender.sender_reply_to ?? null` from a payload the UI never
// populated, so every save wrote null. That is why the column had a validator,
// a persist path and a send-path reader, and still zero non-null rows in
// production. So this reads the existing rows FIRST and carries a typed
// identity forward verbatim. Doing it server-side rather than asking callers to
// round-trip the identity is deliberate: the caller that forgets is exactly the
// caller that caused the original bug, and components/BeeHub.jsx is not
// type-checked (tsconfig includes only .ts/.tsx), so nothing would catch it.
export async function setHandlerForTypes(
  locationId: string,
  handler: HandlerPerson,
  projectTypes: string[],
): Promise<void> {
  if (projectTypes.length === 0) return
  if (!handler.source_user_id) {
    throw new Error('set_handler: a handler must be a person (source_user_id required)')
  }
  const canonical = await canonicalizeOrThrow('set_handler', projectTypes)

  // What each of these types currently sends as. Only typed identities need
  // carrying — a person-mode row re-snapshots the (possibly new) handler, which
  // is the whole meaning of person mode.
  const { data: existing, error: readErr } = await supabaseService
    .from('location_project_type_senders')
    .select('project_type, sender_name, sender_email, sender_reply_to, sender_is_custom')
    .eq('location_id', locationId)
    .in('project_type', canonical)
  if (readErr) throw new Error(`set_handler: ${readErr.message}`)

  const keepCustom = new Map<string, any>()
  for (const r of (existing || []) as any[]) {
    if (r.sender_is_custom === true) {
      keepCustom.set(String(r.project_type || '').trim().toLowerCase(), r)
    }
  }

  const nowIso = new Date().toISOString()
  const rows = canonical.map((pt) => {
    const kept = keepCustom.get(pt.trim().toLowerCase())
    return {
      location_id: locationId,
      project_type: pt,
      source_user_id: handler.source_user_id,
      sender_name: kept ? kept.sender_name : handler.name,
      sender_email: kept ? kept.sender_email : handler.email,
      sender_reply_to: kept ? (kept.sender_reply_to ?? null) : null,
      sender_is_custom: !!kept,
      updated_at: nowIso,
    }
  })
  const { error } = await supabaseService
    .from('location_project_type_senders')
    .upsert(rows, { onConflict: 'location_id,project_type' })
  if (error) throw new Error(`set_handler: ${error.message}`)
}

// ── WRITER 2 of 2 · WHAT IT SENDS AS ────────────────────────────────────────
//
// Set ONE type's sending identity, leaving its handler alone. The mirror of
// setHandlerForTypes: that one never touches these columns, this one never
// touches source_user_id.
//
// REQUIRES AN EXISTING ROW. A typed sender is stored ON the handler row, and
// source_user_id is NOT NULL, so a type parked on "The location owner" has no
// row to put one in and sends from the location's base sender. Rejected loudly
// rather than silently creating a row with an invented handler.
//
// custom:false RE-DERIVES the identity from hub_users rather than taking it
// from the caller. Person mode means "send as the handler", and the only
// truthful source for that is the handler's own row — a caller-supplied copy
// could be stale, and the whole point of the mode is that it tracks the person.
export async function setSenderIdentityForType(
  locationId: string,
  projectType: string,
  identity: SenderIdentityInput,
): Promise<void> {
  const [canonical] = await canonicalizeOrThrow('set_sender_identity', [projectType])

  const { data: row, error: readErr } = await supabaseService
    .from('location_project_type_senders')
    .select('id, source_user_id')
    .eq('location_id', locationId)
    .eq('project_type', canonical)
    .maybeSingle()
  if (readErr) throw new Error(`set_sender_identity: ${readErr.message}`)
  if (!row) {
    throw new Error(
      `set_sender_identity: no handler for ${JSON.stringify(canonical)} — pick who handles it first`,
    )
  }

  let patch: Record<string, unknown>
  if (identity.sender_is_custom) {
    patch = {
      sender_is_custom: true,
      sender_name: identity.sender_name,
      sender_email: identity.sender_email,
      sender_reply_to: identity.sender_reply_to ?? null,
    }
  } else {
    const { data: person, error: personErr } = await supabaseService
      .from('hub_users')
      .select('full_name, first_name, last_name, email')
      .eq('id', (row as any).source_user_id)
      .maybeSingle()
    if (personErr) throw new Error(`set_sender_identity: ${personErr.message}`)
    if (!person) {
      throw new Error('set_sender_identity: the handler for this type no longer exists')
    }
    const p = person as any
    patch = {
      sender_is_custom: false,
      sender_name: p.full_name || fullName(p.first_name, p.last_name) || p.email,
      sender_email: p.email,
      // Person mode stores no reply-to of its own. NULL here does NOT mean
      // "the location default" any more (2026-09-03): lib/resend.ts resolves a
      // blank person-mode reply-to to the person's own sender_email at send
      // time, so replies come back to whoever the email went out as. The
      // location default is only the fallback for a TYPED row left blank.
      sender_reply_to: null,
    }
  }

  const { error } = await supabaseService
    .from('location_project_type_senders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', (row as any).id)
  if (error) throw new Error(`set_sender_identity: ${error.message}`)
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
