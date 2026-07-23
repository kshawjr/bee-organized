// lib/hub-scope.ts
//
// Fix 2 / Phase 1 — the server-side location scope for the Hub page load.
//
// THE PROBLEM. The location picker was a CLIENT-SIDE array filter: locFilter
// lived only in React state, so the server never learned which location an
// elevated user had selected and shipped the ENTIRE tenant on every page load
// (7,028 leads / 19,361 child rows / 6,065 engagements / 12.3 MB). A franchise
// user at the same location got 0.6 MB. MAX_LEADS=10,000 was ~3,000 leads away,
// and past it leads are dropped SILENTLY — no error, just quietly wrong counts.
//
// THE FIX. A cookie carries the selection to the server. This module is the
// single home for the three things that must not drift:
//   1. the cookie's name + shape,
//   2. who is allowed to use it (elevated only — franchise users keep their
//      hard hubUser.location_id fence and IGNORE the cookie entirely), and
//   3. WHICH COLUMN AND WHICH VALUE FORM each child table is filtered on.
//
// PURE, zero-import module (§8.5). No supabase, no next/headers, no env — so it
// is testable directly and safe to import from anywhere. The DB validation that
// turns a cookie string into a real location lives in the caller (_hub-page.tsx),
// which owns the db handle.
//
// ── THE CRITICAL PROPERTY ────────────────────────────────────────────────────
// When the cookie is absent, malformed, forged, or 'all', EVERY consumer of this
// module must produce exactly today's behavior. Phase 1 is a strict superset:
// it adds a scoped path and changes nothing about the unscoped one. That is what
// makes it revertible by clearing one cookie.

export const SCOPE_COOKIE_NAME = 'bee_scope_loc'

// 'all' is the explicit opt-out, and also the fallback for every rejection path
// (absent, malformed, forged, unknown location). It means "today's behavior".
export const SCOPE_ALL = 'all'

// One year. The scope is a workspace preference, not a security boundary — the
// server re-validates the value against the locations table on every single
// request, so a stale or hand-edited cookie can only ever degrade to 'all'.
export const SCOPE_COOKIE_MAX_AGE = 31536000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

// The document.cookie string the client writes when the picker changes scope.
// Deliberately NOT HttpOnly: the picker sets it client-side, and it carries no
// authority — the server treats it as a hint and re-validates it every time.
// SameSite=Lax so a cross-site navigation can't silently retarget someone's
// scope. Kept here so the client's write and the server's read can never
// disagree about the name.
export function scopeCookieString(value: string): string {
  const v = isUuid(value) ? value : SCOPE_ALL
  return `${SCOPE_COOKIE_NAME}=${v}; path=/; max-age=${SCOPE_COOKIE_MAX_AGE}; samesite=lax`
}

// Normalize a raw cookie value to either a UUID or SCOPE_ALL. Everything that
// isn't a well-formed UUID — absent, '', 'all', 'undefined', an injection
// attempt, a slug — collapses to SCOPE_ALL. This runs BEFORE the DB check; it
// exists so a forged value can never reach a query as a filter.
export function normalizeScopeCookie(raw: string | null | undefined): string {
  if (!raw) return SCOPE_ALL
  const trimmed = raw.trim()
  return isUuid(trimmed) ? trimmed : SCOPE_ALL
}

export type HubScope = {
  // The location uuid every `location_uuid` filter uses, or null for "no
  // filter" (= today's behavior). Non-elevated users always land here with
  // their own hubUser.location_id, exactly as before.
  locationUuid: string | null
  // The location SLUG (locations.location_id, e.g. 'loc_kc'). Only ever set
  // for an elevated scoped load — it is what the child tables below are
  // filtered on. See CHILD_LOCATION_SCOPE for why both forms are needed.
  locationSlug: string | null
  // How this scope was arrived at. Purely for logging/assertions; nothing
  // branches on it in a query.
  source: 'own-location' | 'cookie' | 'all'
}

// Resolve the effective scope for a request.
//
// `validated` is the caller's DB lookup result for the cookie's uuid — null when
// the cookie was absent/'all'/forged, or named a location that does not exist.
// Passing null is always safe: it degrades to today's unscoped behavior.
//
// The non-elevated branch is deliberately expressed as the SAME condition the
// pre-Phase-1 code used (`!isElevated && hubUser.location_id`). A franchise user
// never consults the cookie, so they cannot escape their own location by
// setting one, and their load is byte-identical to before.
export function resolveHubScope(args: {
  isElevated: boolean
  hubUserLocationId: string | null | undefined
  validated: { id: string; slug: string | null } | null
}): HubScope {
  const { isElevated, hubUserLocationId, validated } = args

  if (!isElevated) {
    // Franchise/manager/lite: hard-fenced to their own location, cookie ignored.
    // location_id NULL (rare, and true for Kevin's own super_admin row) keeps
    // the historical "no filter" behavior rather than inventing a scope.
    return hubUserLocationId
      ? { locationUuid: hubUserLocationId, locationSlug: null, source: 'own-location' }
      : { locationUuid: null, locationSlug: null, source: 'all' }
  }

  if (validated && isUuid(validated.id)) {
    return { locationUuid: validated.id, locationSlug: validated.slug ?? null, source: 'cookie' }
  }

  // Elevated, no usable selection → 'all' → today's behavior, unchanged.
  return { locationUuid: null, locationSlug: null, source: 'all' }
}

// ── THE CHILD-TABLE LOCATION VOCABULARY ──────────────────────────────────────
//
// ⚠️ TWO VOCABULARIES. THIS IS THE MOST DANGEROUS TABLE IN THE FILE.
//
// The child tables do NOT agree on how they name a location:
//
//   quotes / jobs / invoices / assessments / service_requests
//       → column `location_id`,   value = the SLUG  ('loc_kc')
//   touchpoints / lead_notes
//       → column `location_uuid`, value = the UUID  ('80ffb75d-…')
//
// Passing a UUID to a slug column (or vice versa) returns ZERO ROWS WITH NO
// ERROR. PostgREST does not type-check the comparison, `{ data }` destructuring
// swallows nothing because there IS no error, and the page renders every card
// with empty children. Nothing logs. That failure is invisible in review, in
// staging, and in prod until someone notices a client's quotes are missing.
//
// Hence: the vocabulary is DATA, declared once here, and childLocationFilter()
// is the ONLY way to build the filter. lib/beta-hub-scope.test.ts asserts the
// exact column AND value form for every table, and asserts through the real
// fetcher that the recorded `.eq()` carries the right one — a swap fails the
// suite rather than shipping.
//
// Verified against prod 2026-07-22: all 19,361 child rows carry a non-null
// location that agrees exactly with their lead's location (0 nulls, 0
// mismatches, 0 orphans), so a location-filtered read returns precisely the
// same set as the lead-id-filtered read it replaces.
export type ChildLocationForm = 'slug' | 'uuid'

export const CHILD_LOCATION_SCOPE: Record<string, { column: string; form: ChildLocationForm } | null> = {
  // ── SLUG tables — column is `location_id`, value is 'loc_kc'-shaped ──
  quotes:           { column: 'location_id',   form: 'slug' },
  jobs:             { column: 'location_id',   form: 'slug' },
  invoices:         { column: 'location_id',   form: 'slug' },
  assessments:      { column: 'location_id',   form: 'slug' },
  service_requests: { column: 'location_id',   form: 'slug' },

  // ── UUID tables — column is `location_uuid`, value is a uuid ──
  touchpoints:      { column: 'location_uuid', form: 'uuid' },
  lead_notes:       { column: 'location_uuid', form: 'uuid' },

  // ── No location column at all ──
  // Both are empty tenant-wide (0 rows, verified 2026-07-22). `null` routes
  // them to the whole-table read fenced by the caller's lead-id set — which is
  // exactly what the elevated path already does for them today, and stays
  // correct however many rows they grow, because the lead-id fence is what
  // scopes them (not a location column they don't have).
  lead_contacts: null,
  lead_tags:     null,
}

// Build the `.eq(column, value)` pair for a child table, or null when the table
// has no location column (→ caller falls back to the lead-id-fenced read).
//
// Returns null rather than throwing for an UNKNOWN table too: a new child table
// added to _hub-page without an entry here degrades to the lead-id-fenced read,
// which is correct-but-slower. Correct-by-default beats fast-and-wrong.
export function childLocationFilter(
  table: string,
  location: { uuid: string; slug: string | null },
): { column: string; value: string } | null {
  const spec = CHILD_LOCATION_SCOPE[table]
  if (!spec) return null
  if (spec.form === 'slug') {
    // No slug (the location row lacks location_id) → do NOT fall back to the
    // uuid. That would query a slug column with a uuid and match nothing while
    // reporting success. Fall back to the lead-id-fenced read instead.
    if (!location.slug) return null
    return { column: spec.column, value: location.slug }
  }
  return { column: spec.column, value: location.uuid }
}
