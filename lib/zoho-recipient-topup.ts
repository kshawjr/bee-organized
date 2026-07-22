// lib/zoho-recipient-topup.ts
// ─────────────────────────────────────────────────────────────
// Moving lead-notification recipients OUT of Zoho and INTO Bee Hub.
//
// Shared core for BOTH consumers, so the scope rule and the Zoho→row mapping
// can't drift between them:
//   · scripts/seed-notification-externals.mjs — the one-time, review-first seed
//   · app/api/cron/zoho-recipient-topup/route.ts — the nightly additive top-up
// The seed and the top-up are the SAME operation ("insert the Zoho contacts Bee
// Hub lacks"); the seed is simply its first run. Both are expressed here as
// buildTopUpPlan() + commitTopUpPlan().
//
// WHY THIS EXISTS. resolveLeadRecipients (notification-recipients.ts) prefers
// Bee Hub recipients and only falls back to Zoho when a location has NONE.
// Seeding a location's contacts into lead_notification_externals therefore
// flips it to interface-managed PERMANENTLY — Zoho is never read for it again.
// That is the intent (Zoho is being sunset), but it means the write is a
// one-way door per location, hence the seed's dry-run-by-default review gate.
//
// SCOPE — locations with ZERO owner/manager hub_users, recomputed on EVERY run.
// Deliberately NOT "zero recipients": externals are this job's own output, so
// including them in the predicate would make every location drop out the moment
// it was seeded. Keying on hub_users alone means:
//   · A Zoho-resolving location stays in scope and keeps receiving top-ups.
//   · A location that later gains an owner/manager drops OUT automatically —
//     correct, it is now interface-managed and its list is the owner's to run.
// "Interface user" means exactly what it means to the resolver — the role list
// mirrors RECIPIENT_INTERFACE_ROLES and is test-pinned to it (see below).
//
// ADDITIVE ONLY — never update, never delete. A recipient a human removed in
// the UI must not silently return, and a name/category they edited must not be
// overwritten by Zoho. The only write is an INSERT of an email this location
// does not already have.
//
// DEDUPE — read-then-diff, application-side. We select the location's existing
// emails, lowercase them into a Set, and insert only what's absent. This is the
// PRIMARY guard and is case-insensitive (Zoho and hand-typed UI entries disagree
// on case), so emails are also STORED lowercased (see planLocationRows) to keep
// the stored value equal to the comparison key.
//
// A per-location UNIQUE (location_id, email) index is a DB BACKSTOP (see
// migrations/lead_notification_externals_unique.sql). We deliberately do NOT use
// ON CONFLICT: this code ships BEFORE that migration runs, and an ON CONFLICT
// naming a target index that does not exist yet is a 42P10 — it would break both
// the top-up and the POST route in the pre-migration window. Instead
// commitTopUpPlan treats a 23505 from the backstop as benign (the row already
// exists). Result: identical behavior before and after the index exists.
// ─────────────────────────────────────────────────────────────

// NO RUNTIME IMPORTS — deliberate, and load-bearing. This module is imported
// BOTH by the cron route (through webpack, which resolves anything) and
// directly by scripts/seed-notification-externals.mjs via Node's TS type
// stripping, which resolves neither the '@/…' alias nor TypeScript's
// extensionless relative specifiers. Keeping the runtime import graph empty is
// what lets the seed and the cron share this file instead of forking the logic.
// The type import below is erased before Node ever sees it.
import type { ZohoNotificationContact } from './zoho'

// Mirrors of the resolver's constants. They are NOT imported (see above) —
// lib/beta-zoho-recipient-topup.test.ts asserts they stay identical to
// notification-recipients.ts, so a drift breaks the build rather than silently
// changing who gets seeded.
export const INTERFACE_ROLES = ['owner', 'manager'] as const
export const SEED_CATEGORY = 'all'

// Structural, so the cron can pass the real supabaseService, the script can
// pass its own service-role client, and tests can pass a fake — without any of
// them importing each other's module.
export type SupabaseLike = { from: (table: string) => any }

export type TargetLocation = {
  id: string // locations.id — the UUID that lands in externals.location_id
  name: string | null
  slug: string // locations.location_id — the Zoho Location_ID (e.g. 'loc_seattle')
}

export type PlannedRow = {
  location_id: string
  first_name: string | null
  last_name: string | null
  email: string
  phone: string | null
  category: string
}

export type LocationPlan = {
  location: TargetLocation
  rows: PlannedRow[] // what we'd insert
  already: number // Zoho contacts Bee Hub already has (skipped)
  unusable: number // opted out / no email (skipped)
  error: string | null // Zoho fetch failed — this location is untouched
}

export type TopUpPlan = {
  locations: LocationPlan[]
  rows: PlannedRow[] // flattened, in insert order
}

export type TopUpDeps = {
  supabase: SupabaseLike
  fetchZohoContacts: (slug: string) => Promise<ZohoNotificationContact[]>
}

// ── Scope ──────────────────────────────────────────────────────────────────
// A location is in scope iff it has a Zoho slug AND no owner/manager hub_user.
// hub_users.location_id is TEXT holding the location UUID string, so it
// compares directly against locations.id (no cast — see
// migrations/lead_notification_recipients.sql).
export function selectTargetLocations(
  locations: Array<{ id: string; name?: string | null; location_id?: string | null }>,
  interfaceUsers: Array<{ location_id: string | null }>,
): TargetLocation[] {
  const managed = new Set(
    interfaceUsers.map((u) => u.location_id).filter((v): v is string => !!v),
  )
  const out: TargetLocation[] = []
  for (const l of locations) {
    const slug = typeof l.location_id === 'string' ? l.location_id.trim() : ''
    // No slug = no Zoho Location to read; nothing to seed from.
    if (!slug) continue
    if (managed.has(l.id)) continue
    out.push({ id: l.id, name: l.name ?? null, slug })
  }
  return out
}

// ── Zoho contact → planned row ─────────────────────────────────────────────
// Skips a contact that is opted out or has no email (an external row has no
// opt-out concept — every row is unconditionally a recipient — so an opted-out
// contact must never become one), and skips any email the location already has.
//
// Phone is NOT fetched by the notification-contact selection, so it lands null;
// only 3 of 71 live contacts carry one and the field is optional in the UI.
export function planLocationRows(
  locationUuid: string,
  contacts: ZohoNotificationContact[],
  existingEmails: readonly string[],
): { rows: PlannedRow[]; already: number; unusable: number } {
  const seen = new Set<string>()
  for (const e of existingEmails) {
    if (typeof e === 'string' && e.trim()) seen.add(e.trim().toLowerCase())
  }

  const rows: PlannedRow[] = []
  let already = 0
  let unusable = 0

  for (const c of contacts) {
    const email = typeof c.email === 'string' ? c.email.trim() : ''
    if (!email || c.opted_out) {
      unusable++
      continue
    }
    const key = email.toLowerCase()
    // Covers both "Bee Hub already has it" and a duplicate inside this batch —
    // the latter shouldn't happen (the Zoho client dedupes per location) but
    // this is the invariant the no-unique-constraint table depends on us to
    // hold, so it's enforced here rather than assumed.
    if (seen.has(key)) {
      already++
      continue
    }
    seen.add(key)

    // Zoho's Last_Name is a REQUIRED field, and for ~2/3 of these contacts
    // whoever created the record satisfied it by pasting the email in — so
    // Last_Name is literally 'valerie@beeorganized.com'. Storing that would put
    // an address in a name column that the owner then sees and edits in the UI.
    // Dropping it is display-neutral: the UI renders
    // `fullName(first,last) || email`, so a nulled-out name shows the same
    // address it shows today via the Zoho fallback.
    const nameless = (v: string | null) =>
      v && v.trim().toLowerCase() !== key ? v : null
    let first = nameless(c.first_name)
    const last = nameless(c.last_name)
    // Some contacts carry only a Full_Name. Keep it rather than lose the name —
    // subject to the same guard (the Zoho client falls back to `name = email`).
    if (!first && !last && c.name && c.name.trim().toLowerCase() !== key) {
      first = c.name
    }

    rows.push({
      location_id: locationUuid,
      first_name: first,
      last_name: last,
      // Stored lowercased — matches the dedup key above and the per-location
      // (location_id, email) backstop, so a case-variant can't slip past either.
      email: key,
      phone: null,
      category: SEED_CATEGORY,
    })
  }

  return { rows, already, unusable }
}

// ── Plan ───────────────────────────────────────────────────────────────────
// Reads scope + existing state, then fans out to Zoho. Writes NOTHING — both
// the dry run and the commit path build the same plan, so what Kevin reviews is
// exactly what gets inserted.
//
// A Zoho failure for one location is recorded on that location and the run
// continues: one dead slug must not deny every other location its recipients.
// Zoho is called SEQUENTIALLY — ~2 GETs per location, which measured clean
// across all 50 locations with no throttling, and a nightly job has no reason
// to hammer the API.
export async function buildTopUpPlan(deps: TopUpDeps): Promise<TopUpPlan> {
  const { supabase, fetchZohoContacts } = deps

  const locRes = await supabase.from('locations').select('id, name, location_id')
  if (locRes.error) throw new Error(`locations read failed: ${locRes.error.message}`)

  const userRes = await supabase
    .from('hub_users')
    .select('location_id, role')
    .in('role', INTERFACE_ROLES as unknown as string[])
  if (userRes.error) throw new Error(`hub_users read failed: ${userRes.error.message}`)

  const targets = selectTargetLocations(locRes.data || [], userRes.data || [])
  if (targets.length === 0) return { locations: [], rows: [] }

  // One read for every target's existing emails, then grouped in memory —
  // cheaper and more consistent than a per-location round trip.
  const extRes = await supabase
    .from('lead_notification_externals')
    .select('location_id, email')
    .in(
      'location_id',
      targets.map((t) => t.id),
    )
  if (extRes.error) {
    throw new Error(`externals read failed: ${extRes.error.message}`)
  }
  const existingByLoc = new Map<string, string[]>()
  for (const row of extRes.data || []) {
    const list = existingByLoc.get(row.location_id) || []
    list.push(row.email)
    existingByLoc.set(row.location_id, list)
  }

  const locations: LocationPlan[] = []
  for (const location of targets) {
    let contacts: ZohoNotificationContact[]
    try {
      contacts = await fetchZohoContacts(location.slug)
    } catch (err: any) {
      console.error(
        `[zoho-recipient-topup] Zoho fetch FAILED for ${location.slug} — location skipped, no rows written: ${err?.message}`,
      )
      locations.push({
        location,
        rows: [],
        already: 0,
        unusable: 0,
        error: err?.message || 'zoho_fetch_failed',
      })
      continue
    }
    const { rows, already, unusable } = planLocationRows(
      location.id,
      contacts,
      existingByLoc.get(location.id) || [],
    )
    locations.push({ location, rows, already, unusable, error: null })
  }

  return { locations, rows: locations.flatMap((l) => l.rows) }
}

// ── Commit ─────────────────────────────────────────────────────────────────
// Inserts the planned rows. Per-location inserts (not one bulk insert) so a
// single bad row can't take the whole run down with it, and so a failure is
// attributable to a location in the logs.
export async function commitTopUpPlan(
  deps: Pick<TopUpDeps, 'supabase'>,
  plan: TopUpPlan,
): Promise<{ inserted: number; errors: Array<{ slug: string; reason: string }> }> {
  const errors: Array<{ slug: string; reason: string }> = []
  let inserted = 0

  for (const lp of plan.locations) {
    if (lp.rows.length === 0) continue
    const { error } = await deps.supabase
      .from('lead_notification_externals')
      .insert(lp.rows)
    if (!error) {
      inserted += lp.rows.length
      continue
    }
    // The read-then-diff above already excluded every email the location has, so
    // a conflict here means the (location_id, email) BACKSTOP caught a row that
    // appeared between the plan read and this write (a concurrent UI add, or an
    // overlapping run). Anything else is a real failure — report and move on.
    if ((error as any).code !== '23505') {
      console.error(
        `[zoho-recipient-topup] insert FAILED for ${lp.location.slug}: ${error.message}`,
      )
      errors.push({ slug: lp.location.slug, reason: error.message })
      continue
    }
    // Salvage the batch row-by-row so one raced duplicate can't drop the
    // location's genuinely-new recipients; a 23505 per row is benign (that
    // recipient already exists — nothing to add).
    for (const row of lp.rows) {
      const { error: rowErr } = await deps.supabase
        .from('lead_notification_externals')
        .insert(row)
      if (!rowErr) {
        inserted += 1
        continue
      }
      if ((rowErr as any).code === '23505') continue
      console.error(
        `[zoho-recipient-topup] insert FAILED for ${lp.location.slug}: ${rowErr.message}`,
      )
      errors.push({ slug: lp.location.slug, reason: rowErr.message })
    }
  }

  return { inserted, errors }
}
