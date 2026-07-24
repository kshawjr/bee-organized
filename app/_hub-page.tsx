// app/_hub-page.tsx
//
// Shared server component for all top-level Hub routes.
// Loads auth, user profile, locations, seats, leads, lookups, etc.,
// then renders <BeeHub> with the right initialRoute and optionally a
// pre-selected lead id (for /clients/[id] deep links).
//
// Used by: /, /clients, /clients/[id], /contacts, /hive, /reports,
// /settings, /admin. Each route just calls <HubPage initialRoute="..." />.

import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { requireAuth, getHubUser } from '@/lib/auth'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { PARTNER_COLS, COMPANY_COLS, mapPartnerRow, mapCompanyRow } from '@/lib/crm'
import {
  SCOPE_COOKIE_NAME,
  readScopePreference,
  resolveHubScope,
  isElevatedPickedScope,
  pickDefaultScopeLocation,
  childLocationFilter,
  isUuid,
  ACTIVE_LIFECYCLE,
  LOC_OTHER_SLUG,
  TRANSFER_QUEUE_MAX,
  transferQueueSource,
} from '@/lib/hub-scope'
import { buildAllOverview } from '@/lib/hub-all-overview'
import BeeHub from '@/components/BeeHub'

function mapRole(dbRole: string | null | undefined): {
  role: string
  franchiseRole: string
} {
  switch (dbRole) {
    case 'super_admin':
      return { role: 'super_admin', franchiseRole: 'owner' }
    case 'admin':
      return { role: 'corporate', franchiseRole: 'owner' }
    case 'owner':
      return { role: 'franchise', franchiseRole: 'owner' }
    case 'manager':
      // Manager is a real franchise role — keep role='franchise' so the whole
      // franchise UI (role==='franchise' gates) lights up, and distinguish via
      // franchiseRole='manager'. NOT collapsed to 'viewer' like lite_user: the
      // manager gets leads + CRM + feedback, just not owner-only config.
      return { role: 'franchise', franchiseRole: 'manager' }
    case 'lite_user':
      return { role: 'franchise', franchiseRole: 'viewer' }
    default:
      return { role: 'franchise', franchiseRole: 'owner' }
  }
}

function fmtJoined(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getMonth()]} ${d.getFullYear()}`
  } catch {
    return ''
  }
}

function initialsFrom(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function mapTier(dbRole: string | null | undefined): string {
  switch (dbRole) {
    case 'super_admin':
      return 'corporate'
    case 'admin':
      return 'manager'
    case 'owner':
      return 'owner'
    case 'manager':
      // Real Hive Manager seat — maps to the 'manager' tier key, which renders
      // as the 'Hive Manager' label via FRANCHISE_ROLES. Don't collapse to
      // 'readonly' (that's the genuine read-only Honey Watcher tier).
      return 'manager'
    case 'lite_user':
      return 'readonly'
    default:
      return 'readonly'
  }
}

// ── Child-table fetch ────────────────────────────────────────────────────
// Two paths, same rows. Exported for lib/beta-hub-child-rows.test.ts, which
// pins that the two produce identical grouped output.
//
//  chunked — 200 lead ids per `.in()`, each chunk paginated. Keeps the GET
//    query string bounded (1000+ UUIDs in a URL could fail outright, with the
//    error silently dropped by `{ data }` destructuring, leaving every lead
//    with empty joins) and dodges PostgREST's row cap. For a location-scoped
//    caller this is ~9 requests / ~120ms — still the path they take.
//
//  bulk — for the UNSCOPED (elevated) caller, `ids` is every non-junk lead in
//    the tenant: 7,028 leads = 36 chunks × 9 tables = 324 sequential round
//    trips. Each individual query is fast (~100ms) — the cost was purely the
//    round-trip count. lead_contacts burned 275 of those round trips to fetch
//    zero rows. Unscoped means "the whole table" anyway, so read it straight
//    through in 1000-row pages instead: 324 → 25 requests, and the stage drops
//    from 7.4–21.0s to 1.2–1.6s (measured A/B against prod, three runs).
//
// The bulk read also sees child rows belonging to junk/bin leads (which are
// excluded from `ids`), so every page is filtered back to the caller's id set
// before it lands. That filter is LOAD-BEARING, not hygiene — two consumers
// downstream iterate these raw arrays instead of looking up by lead id, so
// extra rows would change their output:
//   • `tagLookupIds` maps over every lead_tags row, widening the `lookups`
//     fetch (which is a single un-paginated `.in()`, so widening it risks the
//     1000-row cap).
//   • `byEngagement()` maps over quotes/jobs/invoices/assessments/
//     service_requests and keys by engagement_id — a junked lead's rows would
//     attach themselves to a live open engagement's board card.
// Filtering per page also caps retained memory at exactly what the chunked
// path held: one 1000-row page transient, the same rows kept.
//
//  locationScoped — for an ELEVATED caller who has PICKED a location (Fix 2
//    Phase 1). Neither of the paths above fits: chunked would issue
//    ceil(3306/200)=17 chunks × 9 tables for Kansas City — WORSE than the
//    unscoped bulk read it replaces — and bulk would read every other
//    location's rows to throw them away. Instead each child table is filtered
//    on ITS OWN location column, so one location's rows come back directly:
//    ≤2 pages per table for the largest location in the tenant.
//    ⚠️ WHICH column and WHICH value form differs per table and a mismatch
//    fails SILENTLY — see CHILD_LOCATION_SCOPE in lib/hub-scope.ts. The filter
//    is never hand-written here; childLocationFilter() is the only source.
//    Tables with no location column (lead_contacts, lead_tags) fall through to
//    `bulk`, whose lead-id fence scopes them correctly regardless.
//
// Ordering survives the switch: all three paths sort by (orderCol, ...keyCols)
// with keyCols unique, so the sort is a total order and a global ordering
// restricted to one lead's rows is precisely that lead's chunked ordering.
// keyCols is 'id' everywhere except lead_tags (composite PK, no id column).
const CHILD_CHUNK = 200
// PostgREST caps a response at 1000 rows no matter how wide a range is asked
// for (verified against prod: range(0,4999) returns 1000). PAGE must therefore
// be 1000 — any larger and a full page would read as short and terminate the
// loop early, silently truncating.
const CHILD_PAGE = 1000
// Runaway guard only, not a data policy: 500 pages is 500k child rows, ~25×
// the current tenant. Hitting it logs loudly rather than truncating quietly.
const CHILD_MAX_PAGES = 500

export type ChildScopeLocation = { uuid: string; slug: string | null }

export function createChildRowFetcher(
  db: any,
  opts: { unscoped: boolean; location?: ChildScopeLocation | null },
) {
  const applyOrder = (q: any, orderCol: string | undefined, ascending: boolean, keyCols: string[]) => {
    if (orderCol) q = q.order(orderCol, { ascending })
    for (const col of keyCols) q = q.order(col, { ascending: true })
    return q
  }

  const chunked = async (
    table: string,
    ids: string[],
    orderCol: string | undefined,
    ascending: boolean,
    keyCols: string[],
  ): Promise<any[]> => {
    const rows: any[] = []
    for (let i = 0; i < ids.length; i += CHILD_CHUNK) {
      const chunk = ids.slice(i, i + CHILD_CHUNK)
      for (let from = 0; ; from += CHILD_PAGE) {
        let q = applyOrder(db.from(table).select('*').in('lead_id', chunk), orderCol, ascending, keyCols)
        q = q.range(from, from + CHILD_PAGE - 1)
        const { data, error } = await q
        if (error) {
          console.error(
            `[hub-page] ${table} child fetch FAILED (chunk ${i / CHILD_CHUNK + 1}/${Math.ceil(ids.length / CHILD_CHUNK)}, offset ${from}): ${error.message} — leads in this chunk render without ${table} data`
          )
          break
        }
        rows.push(...(data || []))
        if ((data || []).length < CHILD_PAGE) break
      }
    }
    return rows
  }

  const bulk = async (
    table: string,
    ids: string[],
    orderCol: string | undefined,
    ascending: boolean,
    keyCols: string[],
  ): Promise<any[]> => {
    const want = new Set(ids)
    const rows: any[] = []
    for (let page = 0; page < CHILD_MAX_PAGES; page++) {
      const from = page * CHILD_PAGE
      let q = applyOrder(db.from(table).select('*'), orderCol, ascending, keyCols)
      q = q.range(from, from + CHILD_PAGE - 1)
      const { data, error } = await q
      if (error) {
        // A bulk error would blank the table for EVERY lead, where a chunk
        // error only blanks that chunk. Fall back rather than degrade wider.
        console.error(
          `[hub-page] ${table} bulk fetch FAILED (offset ${from}): ${error.message} — retrying on the chunked path`
        )
        return chunked(table, ids, orderCol, ascending, keyCols)
      }
      for (const r of data || []) if (want.has(r.lead_id)) rows.push(r)
      if ((data || []).length < CHILD_PAGE) return rows
    }
    console.error(
      `[hub-page] ${table} bulk fetch hit the ${CHILD_MAX_PAGES}-page ceiling — ${table} data is TRUNCATED`
    )
    return rows
  }

  // Elevated + a picked location. Filter the table on its own location column
  // instead of on the caller's lead ids. The lead-id fence still applies to
  // every page for the same reason `bulk` applies it: the location's junked/bin
  // leads are excluded from `ids` but their child rows carry the same location
  // and would otherwise ride in — and two consumers downstream (byEngagement,
  // tagLookupIds) iterate these raw arrays rather than looking up by lead id.
  const locationScoped = async (
    table: string,
    ids: string[],
    orderCol: string | undefined,
    ascending: boolean,
    keyCols: string[],
    filter: { column: string; value: string },
  ): Promise<any[]> => {
    const want = new Set(ids)
    const rows: any[] = []
    for (let page = 0; page < CHILD_MAX_PAGES; page++) {
      const from = page * CHILD_PAGE
      let q = applyOrder(
        db.from(table).select('*').eq(filter.column, filter.value),
        orderCol, ascending, keyCols,
      )
      q = q.range(from, from + CHILD_PAGE - 1)
      const { data, error } = await q
      if (error) {
        // Same reasoning as bulk's fallback: a failure here would blank the
        // table for every lead in the scope, where the chunked path degrades
        // one chunk at a time. Fall back rather than degrade wider.
        console.error(
          `[hub-page] ${table} location-scoped fetch FAILED (${filter.column}=${filter.value}, offset ${from}): ${error.message} — retrying on the chunked path`
        )
        return chunked(table, ids, orderCol, ascending, keyCols)
      }
      for (const r of data || []) if (want.has(r.lead_id)) rows.push(r)
      if ((data || []).length < CHILD_PAGE) return rows
    }
    console.error(
      `[hub-page] ${table} location-scoped fetch hit the ${CHILD_MAX_PAGES}-page ceiling — ${table} data is TRUNCATED`
    )
    return rows
  }

  return (
    table: string,
    ids: string[],
    orderCol?: string,
    ascending = false,
    keyCols: string[] = ['id'],
  ): Promise<any[]> => {
    const loc = opts.location
    if (loc) {
      const filter = childLocationFilter(table, loc)
      // A table with a location column reads it directly. One without
      // (lead_contacts / lead_tags) reads straight through and is fenced by
      // lead id — exactly what the unscoped elevated path already does for
      // them, and correct however many rows they grow.
      return filter
        ? locationScoped(table, ids, orderCol, ascending, keyCols, filter)
        : bulk(table, ids, orderCol, ascending, keyCols)
    }
    // Below one chunk there is nothing to win — the chunked path is already a
    // single request, and bulk would read the whole table to find those rows.
    return opts.unscoped && ids.length > CHILD_CHUNK
      ? bulk(table, ids, orderCol, ascending, keyCols)
      : chunked(table, ids, orderCol, ascending, keyCols)
  }
}

function buildLocationUser(row: any) {
  const name = row.full_name || row.email
  return {
    id: row.id,
    name,
    initials: initialsFrom(name),
    email: row.email,
    locationId: row.location_id,
    role: row.location_id ? mapTier(row.role) : 'corporate',
    displayCategory:
      row.location_id ? 'franchise' :
      row.role === 'super_admin' ? 'development' :
      'corporate',
    status: row.disabled_at ? 'removed' : 'active',
    // Reversible "Remove access" flag (hub_users.disabled_at). When set, the
    // Team UI shows a "Removed" state + "Restore login" instead of the normal
    // controls, and middleware.ts (Layer 1) locks the user out.
    disabled: !!row.disabled_at,
    joined: fmtJoined(row.created_at),
    // jobber_user_id gates assignment to Jobber jobs/assessments. Null
    // means the user is hidden from the assignment multi-select; the
    // owner can manually link from Settings → Team.
    jobberUserId: row.jobber_user_id || null,
  }
}

export default async function HubPage({
  initialRoute,
  initialSelectedLeadId,
  initialSelectedEngagementId,
  notFoundToast = false,
}: {
  initialRoute?: string
  initialSelectedLeadId?: string
  initialSelectedEngagementId?: string
  notFoundToast?: boolean
} = {}) {
  // Where a logged-OUT visitor was actually headed, so login can send them
  // back (e.g. a /clients/<leadId> deep-link from a lead notification email
  // → login → land on the lead, not home). A /clients/[id] route carries the
  // lead id (+ optional ?e=<engagementId>); other Hub routes fall back to the
  // tab. requireAuth sanitizes it (same-origin relative only) before it
  // becomes ?next=… (safeNextPath permits the query string).
  const returnTo = initialSelectedLeadId
    ? `/clients/${initialSelectedLeadId}${initialSelectedEngagementId ? `?e=${initialSelectedEngagementId}` : ''}`
    : initialRoute && initialRoute !== 'home'
      ? `/${initialRoute}`
      : null
  const authUser = await requireAuth(returnTo)
  const hubUser = await getHubUser()

  if (!hubUser) {
    return (
      <div
        style={{
          padding: '4rem 1.25rem',
          textAlign: 'center',
          fontFamily: '"DM Sans", system-ui, sans-serif',
          maxWidth: '480px',
          margin: '0 auto',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🐝</div>
        <h1
          style={{
            fontFamily: 'Georgia, serif',
            color: '#1a2e2b',
            fontSize: '24px',
            marginBottom: '12px',
          }}
        >
          Account not set up yet
        </h1>
        <p style={{ color: '#4a5e5a', fontSize: '14px', lineHeight: 1.6 }}>
          You&apos;re signed in as <strong>{authUser.email}</strong> but
          don&apos;t have a Bee Hub profile yet. Reach out to your franchise
          admin to be added to your location.
        </p>
      </div>
    )
  }

  const { role, franchiseRole } = mapRole(hubUser.role)
  const isElevated = role === 'super_admin' || role === 'corporate'

  // ── Server-side location scope (Fix 2, Phase 1) ────────────────────────────
  // The picker writes `bee_scope_loc` client-side; this reads it back so the
  // QUERIES below can be narrowed instead of shipping the whole tenant and
  // filtering in the browser.
  //
  // The cookie is a HINT, never an authority. It is user-controlled, so:
  //   • readScopePreference collapses anything that isn't a well-formed uuid
  //     or the literal 'all' sentinel (absent, '', a slug, an injection
  //     attempt) to "no preference" before it can reach a query;
  //   • a surviving uuid is then looked up in `locations` — an unknown or
  //     deleted id yields null;
  //   • the lookup is skipped ENTIRELY for non-elevated users, and
  //     resolveHubScope ignores `validated` for them regardless, so a franchise
  //     user who hand-sets the cookie still cannot escape their own location.
  const scopeCookieRaw = (await cookies()).get(SCOPE_COOKIE_NAME)?.value
  const scopePref = readScopePreference(scopeCookieRaw)
  let scopeValidated: { id: string; slug: string | null } | null = null
  if (isElevated && scopePref.kind === 'location') {
    const { data: scopeRow, error: scopeErr } = await supabaseService
      .from('locations')
      .select('id, location_id')
      .eq('id', scopePref.uuid)
      .maybeSingle()
    if (scopeErr) {
      // Never fail the page over a scope hint.
      console.error(`[hub-page] scope validation failed for ${scopePref.uuid}: ${scopeErr.message}`)
    } else if (scopeRow) {
      scopeValidated = { id: (scopeRow as any).id, slug: (scopeRow as any).location_id ?? null }
    } else {
      console.warn(`[hub-page] scope cookie named an unknown location (${scopePref.uuid}) for ${hubUser.email} — falling back to the default location`)
    }
  }

  // ── First-login default (Fix 2, Phase 3) ───────────────────────────────────
  // Phases 1–2 only paid off once a location was MANUALLY picked; a fresh
  // elevated login still loaded the whole tenant. This picks a real location
  // instead — the largest ACTIVE one.
  //
  // ⚠️ 'All Locations' MUST REMAIN REACHABLE, and this is the edge that would
  // break it. The picker writes the literal 'all' sentinel when the user
  // chooses All Locations; if that were treated as "no preference" the default
  // would immediately override the choice and the option would be
  // unselectable. Hence `scopePref.kind === 'unset'` — an EXPLICIT 'all' is a
  // preference and is honored, only an absent/unparseable cookie is not.
  //
  // Cost: one locations read plus one bounded, PARALLEL head:true count per
  // active location (8 today; 650ms measured end to end). It runs only when
  // there is no usable preference — and the client's reconcile effect writes
  // the cookie immediately after this render, so in practice it is once per
  // browser, not once per page load. A browser that cannot persist cookies
  // pays it every load, which is still far cheaper than the whole tenant.
  //
  // Any failure — no active locations, every count zero, a query error —
  // returns null and the scope degrades to 'all', i.e. today's behavior.
  //
  // `kind !== 'all'` rather than `kind === 'unset'`: a cookie naming a location
  // that no longer exists ALSO wants the default. That user had picked a
  // location; the honest recovery is another real one, not the full-tenant
  // load they were never asking for. Only an EXPLICIT All Locations is exempt.
  let scopeFallback: { id: string; slug: string | null } | null = null
  const wantsDefault = isElevated && !scopeValidated && scopePref.kind !== 'all'
  if (wantsDefault) {
    const { data: activeLocs, error: activeErr } = await supabaseService
      .from('locations')
      .select('id, location_id, name')
      // lifecycle_status, NOT is_active — the latter is true for 12 rows
      // including loc_other (verified 2026-07-23).
      .eq('lifecycle_status', ACTIVE_LIFECYCLE)
      .neq('location_id', LOC_OTHER_SLUG)

    if (activeErr) {
      console.error(`[hub-page] default-scope location list failed: ${activeErr.message} — falling back to all-locations`)
    } else if (activeLocs && activeLocs.length > 0) {
      const counted = await Promise.all(
        (activeLocs as any[]).map(async (l) => {
          const { count, error } = await supabaseService
            .from('leads')
            .select('id', { count: 'exact', head: true })
            .eq('location_uuid', l.id)
            // Mirrors the main leads query, so "largest" means largest by the
            // rows this page would actually load.
            .not('is_junk', 'is', true)
          if (error) console.error(`[hub-page] default-scope count failed for ${l.location_id}: ${error.message}`)
          return { id: l.id, slug: l.location_id ?? null, leadCount: count ?? 0 }
        })
      )
      scopeFallback = pickDefaultScopeLocation(counted)
      if (!scopeFallback) {
        console.warn('[hub-page] no usable default location (no active location has leads) — falling back to all-locations')
      }
    } else {
      console.warn('[hub-page] no active locations to default into — falling back to all-locations')
    }
  }

  // The scope in force BEFORE any deep-link override — cookie first, then the
  // first-login default.
  //
  // ⚠️ ORDER IS LOAD-BEARING. The deep-link check below only runs when this is
  // set, so the default must be resolved FIRST. Resolve it after, and a cold
  // load of /clients/<a lead at another location> would skip the override,
  // apply the default, fail to find the lead, and bounce to notfound — exactly
  // the bug Phase 2 fixed, reintroduced for every first-time deep link.
  const scope0LocationUuid = isElevated ? (scopeValidated?.id ?? scopeFallback?.id ?? null) : null

  // ── Deep-link scope override (Fix 2, Phase 2) ──────────────────────────────
  // /clients/<id> names ONE record — almost always from a lead-notification
  // email. Before Phase 2, if that lead sat outside the cookie's scope the page
  // loaded without it and the guard further down bounced the user to
  // /clients?notfound=1 — a "not found" toast on a lead that plainly exists.
  // Phase 1 created that gap and Phase 3 (a real location as the DEFAULT) would
  // make it the common case, so it is closed here.
  //
  // Resolved BEFORE the queries run, not after: discovering the miss at the
  // guard would mean re-running the entire page load. One indexed lookup up
  // front instead lets the whole page render around the right lead in a single
  // pass — leads, children, engagements, bin, contacts, all at the lead's own
  // location.
  //
  // Only consulted when a scope is actually active. On 'all' the lead is
  // already loaded, so the query would be pure waste.
  //
  // `is_junk IS NOT TRUE` mirrors the main leads query exactly: a junked lead
  // lives in the bin, not initialPeople, so switching scope for one would move
  // the user's whole page and STILL bounce them. Matching the filter keeps
  // junked deep links behaving exactly as they do today.
  let deepLinkScope: { id: string; slug: string | null } | null = null
  if (isElevated && scope0LocationUuid && initialSelectedLeadId && isUuid(initialSelectedLeadId)) {
    const { data: leadRow, error: leadErr } = await supabaseService
      .from('leads')
      // leads carries BOTH forms and they are consistent tenant-wide (verified
      // 2026-07-22: 0 rows where slug(location_uuid) !== location_id), so this
      // one row yields the uuid AND the slug the child tables need — no second
      // lookup, and no chance of pairing a uuid with another location's slug.
      .select('id, location_uuid, location_id')
      .eq('id', initialSelectedLeadId)
      .not('is_junk', 'is', true)
      .maybeSingle()
    if (leadErr) {
      // Never fail the page over a deep-link hint — fall through to the
      // cookie's scope and let the existing guard decide.
      console.error(`[hub-page] deep-link lookup failed for ${initialSelectedLeadId}: ${leadErr.message}`)
    } else if (leadRow?.location_uuid && leadRow.location_uuid !== scope0LocationUuid) {
      deepLinkScope = { id: (leadRow as any).location_uuid, slug: (leadRow as any).location_id ?? null }
      console.log(
        `[hub-page] deep-link ${initialSelectedLeadId} lives at ${deepLinkScope.slug || deepLinkScope.id}, outside the selected scope — switching scope to load it`
      )
    }
  }

  const scope = resolveHubScope({
    isElevated,
    hubUserLocationId: hubUser.location_id,
    validated: scopeValidated,
    deepLink: deepLinkScope,
    fallback: scopeFallback,
  })

  // THE single filter value every `location_uuid` query below uses. For a
  // non-elevated user this is exactly `hubUser.location_id` — the same value
  // the old `if (!isElevated && hubUser.location_id)` guard applied — so their
  // load is unchanged. For an elevated user it is their picked location, or
  // null (no filter) when they are on 'all'.
  const scopeLocationUuid = scope.locationUuid

  // Child tables are filtered on their OWN location column, which needs BOTH
  // the uuid and the slug (two vocabularies — see lib/hub-scope.ts). Only an
  // elevated scope that names ONE location takes that path — 'cookie' (the
  // switcher), 'deep-link' (Phase 2) or 'default' (Phase 3), all of which
  // carry a slug. Everyone else keeps the lead-id paths they use today, so
  // `childScopeLocation` stays null for them.
  //
  // isElevatedPickedScope() is the single gate: a source missing from it would
  // still filter leads to one location but fall back to chunking that
  // location's lead ids 200 at a time — slower than the whole-tenant read.
  const childScopeLocation =
    isElevatedPickedScope(scope) && scope.locationUuid
      ? { uuid: scope.locationUuid, slug: scope.locationSlug }
      : null

  // The client's locFilter MUST agree with what the server actually shipped.
  // If the server scopes to location A and the client still filters on 'all'
  // it merely renders the scoped set (harmless), but if it filters on
  // location B it filters a scoped array down to EMPTY.
  //
  // Derived from `scope`, so it follows every source for free — including the
  // Phase 3 default, which is the one nobody explicitly asked for and would
  // therefore be easiest to forget. It is also what makes the default VISIBLE:
  // the sidebar's location label and the picker's checkmark both read
  // locFilter, so a first login lands showing the location it chose rather
  // than silently hiding the other 53.
  const initialLocFilter = isElevated
    ? (scope.locationUuid || 'all')
    : hubUser.location_id || 'all'

  console.log(
    `[hub-page] scope=${scope.source}${scope.locationUuid ? ` loc=${scope.locationUuid}${scope.locationSlug ? `/${scope.locationSlug}` : ''}` : ''} elevated=${isElevated} user=${hubUser.email}`
  )

  const supabase = await createServerSupabaseClient()

  let profileFields: { first_name: string | null; last_name: string | null; phone: string | null } = {
    first_name: null,
    last_name: null,
    phone: null,
  }
  {
    const { data: profileRow } = await supabaseService
      .from('hub_users')
      .select('first_name, last_name, phone')
      .eq('id', hubUser.id)
      .maybeSingle()
    if (profileRow) profileFields = profileRow as any
  }

  // The caller's own booking link ({{owner_booking_link}} tier 1), read
  // SEPARATELY on purpose: hub_users.booking_link does not exist until
  // migrations/hub_users_booking_link.sql runs, and folding it into the
  // select above would error that query and silently lose the name/phone
  // prefill. Column absent → null → the Settings row just shows "Not set".
  let bookingLink: string | null = null
  {
    const { data: linkRow } = await supabaseService
      .from('hub_users')
      .select('booking_link')
      .eq('id', hubUser.id)
      .maybeSingle()
    bookingLink = ((linkRow as any)?.booking_link as string | null) ?? null
  }

  // Order by slot only. The editor writes `slot` as a single global sequence
  // (array index across all chapters), so slot alone reflects the user's
  // arranged order. Sorting by chapter first would force chapters into
  // alphabetical order on reload and discard manual reordering.
  const { data: slidesData } = await supabase
    .from('guide_slides')
    .select('*')
    .order('slot', { ascending: true })

  const initialGuideSlides = (slidesData || []).map((row: any) => {
    let screenshots: string[] = []
    if (Array.isArray(row.screenshots) && row.screenshots.length > 0) {
      screenshots = row.screenshots
    } else if (row.screenshot_url) {
      screenshots = [row.screenshot_url]
    }
    return {
      icon: row.icon,
      chapter: row.chapter,
      color: row.color,
      title: row.title,
      body: row.body || '',
      bullets: row.bullets || [],
      screenshot: screenshots[0] || null,
      screenshots,
    }
  })

  const { data: tierPricesRaw } = await supabaseService
    .from('tier_prices')
    .select('id, display_name, price_annual, description, sort_order, updated_at')
    .order('sort_order', { ascending: true })

  const initialTierPrices = tierPricesRaw || []

  // Order by slot only — same global-sequence reasoning as guide_slides above.
  const { data: manualSlidesRaw } = await supabaseService
    .from('manual_slides')
    .select('*')
    .order('slot', { ascending: true })

  const initialManualSlides = (manualSlidesRaw || []).map((row: any) => {
    let screenshots: string[] = []
    if (Array.isArray(row.screenshots) && row.screenshots.length > 0) {
      screenshots = row.screenshots
    } else if (row.screenshot_url) {
      screenshots = [row.screenshot_url]
    }
    return {
      icon: row.icon,
      chapter: row.chapter,
      color: row.color,
      title: row.title,
      body: row.body || '',
      bullets: row.bullets || [],
      screenshot: screenshots[0] || null,
      screenshots,
      video_url: row.video_url || null,
    }
  })

  let currentSubscription: any = null
  let currentLocation: any = null
  if (hubUser.location_id) {
    const { data: locRow, error: subErr } = await supabase
      .from('locations')
      .select(
        // NOTE: slack_bot_token is intentionally NOT selected — display fields
        // only (slack_connected / slack_team_name / slack_channel_name). The
        // token is server-read-only (lib/slack-bot + intake route).
        'id, name, subscription_status, subscription_plan, payment_source, paid_through_date, deferred_until, billing_notes, jobber_account_id, jobber_account_name, jobber_initial_import_completed_at, jobber_team_roster, jobber_team_roster_synced_at, last_sync_status, token_expiry, onboarding_state, default_drip_path, default_move_drip_path, address, city, state, zip, phone, email, timezone, sender_name, send_from_email, reply_to_email, reviews_link, calendar_link, rate_per_hour, activated_at, lifecycle_status, slack_connected, slack_team_name, slack_channel_name'
      )
      .eq('id', hubUser.location_id)
      .single()

    if (subErr) console.error('[hub-page] currentSubscription error:', subErr.message)

    // slack_invite_url is added by a STOP-gated migration that may not have run
    // yet. Fetch it separately + error-tolerantly so a missing column can NEVER
    // break the location context — a failed select simply yields null and the
    // SlackCard renders an empty invite field.
    let currentSlackInviteUrl: string | null = null
    {
      const { data: inviteRow, error: inviteErr } = await supabase
        .from('locations')
        .select('slack_invite_url')
        .eq('id', hubUser.location_id)
        .maybeSingle()
      if (!inviteErr && inviteRow) {
        currentSlackInviteUrl = (inviteRow as any).slack_invite_url || null
      }
    }

    if (locRow) {
      currentSubscription = {
        subscription_status: locRow.subscription_status || 'deferred',
        subscription_plan: locRow.subscription_plan || null,
        payment_source: locRow.payment_source || 'none',
        paid_through_date: locRow.paid_through_date || null,
        deferred_until: locRow.deferred_until || null,
        billing_notes: locRow.billing_notes || null,
      }
      currentLocation = {
        id: locRow.id,
        name: locRow.name,
        jobber_connected: !!locRow.jobber_account_id,
        jobber_account_id: locRow.jobber_account_id || null,
        jobber_account_name: locRow.jobber_account_name || null,
        jobber_initial_import_completed_at: locRow.jobber_initial_import_completed_at || null,
        jobber_team_roster: Array.isArray(locRow.jobber_team_roster) ? locRow.jobber_team_roster : [],
        jobber_team_roster_synced_at: locRow.jobber_team_roster_synced_at || null,
        last_sync_status: locRow.last_sync_status || null,
        token_expiry: locRow.token_expiry || null,
        // Slack display fields (token never leaves the server).
        slack_connected: !!locRow.slack_connected,
        slack_team_name: locRow.slack_team_name || null,
        slack_channel_name: locRow.slack_channel_name || null,
        slack_invite_url: currentSlackInviteUrl,
        payment_source: locRow.payment_source || 'none',
        subscription_status: locRow.subscription_status || 'deferred',
        subscription_plan: locRow.subscription_plan || null,
        paid_through_date: locRow.paid_through_date || null,
        lifecycle_status: locRow.lifecycle_status || 'onboarding',
        onboarding_state: locRow.onboarding_state || {},
        default_drip_path: locRow.default_drip_path || null,
        default_move_drip_path: locRow.default_move_drip_path || null,
        address: locRow.address || '',
        city: locRow.city || '',
        state: locRow.state || '',
        zip: locRow.zip || '',
        phone: locRow.phone || '',
        email: locRow.email || '',
        timezone: locRow.timezone || '',
        sender_name: locRow.sender_name || '',
        send_from_email: locRow.send_from_email || '',
        reply_to_email: locRow.reply_to_email || '',
        reviews_link: locRow.reviews_link || '',
        calendar_link: locRow.calendar_link || '',
        rate_per_hour: locRow.rate_per_hour || '',
        activated_at: locRow.activated_at || null,
      }
    }
  }

  // Seats + pending invites power Settings → Team & Billing. Franchise users
  // read their own location (currentLocation). Elevated users have NO
  // currentLocation (location_id NULL by design) — before the scope fix their
  // seats were always [], so the merged section showed "No seats yet" for a
  // live location. Now an elevated PICKED scope (switcher/deep-link/default)
  // reads the scoped location's rows; 'all' keeps [] — there is no single
  // location to bill against.
  const seatsLocationId =
    currentLocation?.id ||
    (isElevated && isElevatedPickedScope(scope) ? scope.locationUuid : null)
  let initialSeats: any[] = []
  let initialPendingInvites: any[] = []
  if (seatsLocationId) {
    const { data: seatsRaw, error: seatsErr } = await supabaseService
      .from('subscription_seats')
      .select(
        'id, location_id, tier, user_id, status, is_primary, added_at, removed_at, prorated_cost, added_by, notes, scheduled_removal_at'
      )
      .eq('location_id', seatsLocationId)
      .eq('status', 'active')
      .order('added_at', { ascending: true })

    if (seatsErr) console.error('[hub-page] seats fetch error:', seatsErr.message)
    initialSeats = seatsRaw || []

    const { data: pendingRaw, error: pendingErr } = await supabaseService
      .from('pending_invites')
      .select('id, location_id, email, full_name, role, tier, invite_expires_at, accepted_at, created_at')
      .eq('location_id', seatsLocationId)
      .is('accepted_at', null)
      .order('created_at', { ascending: true })

    if (pendingErr) console.error('[hub-page] pending_invites fetch error:', pendingErr.message)
    initialPendingInvites = pendingRaw || []
  }

  let initialLocations: any[] | null = null
  let initialUsers: any[] | null = null
  if (isElevated) {
    const { data: locs, error: locsErr } = await supabaseService
      .from('locations')
      .select(
        // slack_bot_token intentionally omitted — display fields only.
        'id, name, address, city, state, zip, phone, email, timezone, reviews_link, calendar_link, rate_per_hour, sender_name, send_from_email, reply_to_email, lifecycle_status, subscription_status, subscription_plan, payment_source, paid_through_date, billing_notes, jobber_account_id, jobber_account_name, jobber_initial_import_completed_at, jobber_team_roster, jobber_team_roster_synced_at, last_sync_status, token_expiry, created_at, onboarding_state, default_drip_path, default_move_drip_path, activated_at, corporate_sponsorship_started_at, corporate_sponsorship_ends_at, slack_connected, slack_team_name, slack_channel_name'
      )
      .order('name', { ascending: true })

    if (locsErr) {
      console.error('[hub-page] locations fetch error:', locsErr.message)
    } else {
      console.log(`[hub-page] Fetched ${locs?.length ?? 0} locations for ${hubUser.email}`)
    }

    // slack_invite_url is STOP-gated (may not be migrated yet), so it is fetched
    // in a separate error-tolerant query and merged by id. A failed select just
    // leaves the map empty — the SlackCard renders an empty invite field.
    const slackInviteById: Record<string, string> = {}
    {
      const { data: inviteRows, error: inviteErr } = await supabaseService
        .from('locations')
        .select('id, slack_invite_url')
      if (!inviteErr && Array.isArray(inviteRows)) {
        for (const r of inviteRows as any[]) {
          if (r?.slack_invite_url) slackInviteById[r.id] = r.slack_invite_url
        }
      }
    }

    const { data: allUsers, error: usersErr } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email, location_id, role, created_at, jobber_user_id, disabled_at')
      .order('full_name', { ascending: true })
      .limit(500)

    if (usersErr) console.error('[hub-page] hub_users fetch error:', usersErr.message)

    // Phase 2: owner seats carry the is_primary designation. Map each claimed
    // owner seat's user_id → is_primary so the location list can mark the
    // primary owner. Owners predating the seat model have no seat row; they
    // fall back to "first owner = primary" below (mirrors the resolver).
    const { data: ownerSeatRows, error: ownerSeatsErr } = await supabaseService
      .from('subscription_seats')
      .select('user_id, location_id, is_primary')
      .eq('tier', 'owner')
      .eq('status', 'active')
      .not('user_id', 'is', null)
    if (ownerSeatsErr) console.error('[hub-page] owner seats fetch error:', ownerSeatsErr.message)
    const primaryByUserId: Record<string, boolean> = {}
    ;(ownerSeatRows || []).forEach((s: any) => {
      if (s.user_id) primaryByUserId[s.user_id] = !!s.is_primary
    })

    // ownersByLoc now holds the full owner roster per location (up to 2),
    // each marked with is_primary, plus a resolved `primary` and display
    // `name` (primary's name, falling back to the first owner). `name` keeps
    // the legacy `location.owner` string consumers working unchanged.
    const ownersByLoc: Record<
      string,
      { owners: any[]; primary: any | null; count: number; name: string | null }
    > = {}
    const userCountByLoc: Record<string, number> = {}
    ;(allUsers || []).forEach((u: any) => {
      if (!u.location_id) return
      userCountByLoc[u.location_id] = (userCountByLoc[u.location_id] || 0) + 1
      if (u.role === 'owner') {
        if (!ownersByLoc[u.location_id]) {
          ownersByLoc[u.location_id] = { owners: [], primary: null, count: 0, name: null }
        }
        const entry = ownersByLoc[u.location_id]
        entry.owners.push({
          id: u.id,
          name: u.full_name || u.email,
          email: u.email,
          is_primary: !!primaryByUserId[u.id],
        })
        entry.count = entry.owners.length
      }
    })
    Object.values(ownersByLoc).forEach((entry) => {
      entry.primary = entry.owners.find((o: any) => o.is_primary) || entry.owners[0] || null
      entry.name = entry.primary?.name || null
    })

    initialUsers = (allUsers || []).map(buildLocationUser)

    initialLocations = (locs || []).map((row: any) => {
      const lifecycle = row.lifecycle_status || 'onboarding'
      const subStatus = row.subscription_status || 'deferred'
      // lifecycle_status drives onboarding vs active; subscription_status only
      // overrides for billing UI (past_due, inactive) once the location is
      // past launch. Corp-sponsored locations stay subscription_status=
      // 'deferred' through their sponsorship window (March 2027) and must
      // still register as 'active' once lifecycle_status flips.
      const crmStatus =
        lifecycle === 'onboarding'            ? 'onboarding'
        : subStatus === 'past_due'            ? 'pastdue'
        : lifecycle === 'paused'              ? 'inactive'
        : subStatus === 'inactive'            ? 'inactive'
        :                                       'active'

      return {
        id: row.id,
        // Slug (locations.location_id, e.g. 'loc_portland') — matches
        // route.ts's locSlug and every child-table write. SettingsScreen's
        // selectedLoc branch prefers this over the UUID so the import
        // button POSTs the same slug the rest of the codebase uses.
        locationId: row.location_id,
        name: row.name,
        state: row.state || '',
        owner: ownersByLoc[row.id]?.name || null,
        owners: ownersByLoc[row.id]?.owners || [],
        primaryOwner: ownersByLoc[row.id]?.primary || null,
        ownerCount: ownersByLoc[row.id]?.count || 0,
        crmStatus,
        lifecycle_status: lifecycle,
        subscription_status: subStatus,
        subscription_plan: row.subscription_plan || null,
        payment_source: row.payment_source || 'none',
        paid_through_date: row.paid_through_date || null,
        billing_notes: row.billing_notes || null,
        // DB stores address parts separately; combine for display (matches the
        // franchise-owner path in SettingsScreen's currentLocationCtx branch).
        address: (() => {
          const cityStateZip = [row.city, [row.state, row.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
          return [row.address, cityStateZip].filter(Boolean).join(', ')
        })(),
        phone: row.phone || '',
        website: '',
        reviewsLink: row.reviews_link || '',
        bookingLink: row.calendar_link || '',
        ratePerHour: row.rate_per_hour || '',
        email: row.email || '',
        timezone: row.timezone || '',
        sendFromName: row.sender_name || '',
        sendFromEmail: row.send_from_email || '',
        replyToEmail: row.reply_to_email || '',
        path: '',
        jobberConnected: !!row.jobber_account_id,
        jobberAccountId: row.jobber_account_id || null,
        jobberAccountName: row.jobber_account_name || null,
        jobberInitialImportCompletedAt: row.jobber_initial_import_completed_at || null,
        jobberTeamRoster: Array.isArray(row.jobber_team_roster) ? row.jobber_team_roster : [],
        jobberTeamRosterSyncedAt: row.jobber_team_roster_synced_at || null,
        // Slack display fields (token never leaves the server).
        slackConnected: !!row.slack_connected,
        slackTeamName: row.slack_team_name || null,
        slackChannelName: row.slack_channel_name || null,
        slackInviteUrl: slackInviteById[row.id] || null,
        last_sync_status: row.last_sync_status || null,
        // Token expiry (epoch-ms) feeds deriveJobberStatus so the settings badge
        // reads reconnect_required for a dead-token location, not a false green.
        token_expiry: row.token_expiry || null,
        leads: 0,
        revenue: 0,
        collected: 0,
        userCount: userCountByLoc[row.id] || 0,
        joinedDate: fmtJoined(row.created_at),
        onboarding_state: row.onboarding_state || {},
        default_drip_path: row.default_drip_path || null,
        default_move_drip_path: row.default_move_drip_path || null,
        activated_at: row.activated_at || null,
        corporate_sponsorship_started_at: row.corporate_sponsorship_started_at || null,
        corporate_sponsorship_ends_at: row.corporate_sponsorship_ends_at || null,
      }
    })
  } else if (hubUser.location_id) {
    const { data: locUsers, error: locUsersErr } = await supabase
      .from('hub_users')
      .select('id, full_name, email, location_id, role, created_at, jobber_user_id, disabled_at')
      .eq('location_id', hubUser.location_id)
      .order('full_name', { ascending: true })

    if (locUsersErr) console.error('[hub-page] location users fetch error:', locUsersErr.message)

    initialUsers = (locUsers || []).map(buildLocationUser)
  }

  let initialPeople: any[] = []
  let initialBinPeople: any[] = []
  // HIVE Phase 1 step 4: open engagements for the new board (dual-read —
  // additive prop; every leads/stage read below is untouched). The closed
  // count feeds the List lens's 'Closed · N' chip — count only, the
  // ~1,400 terminal rows never ship in the page payload (they page in
  // lazily via GET /api/engagements?closed=1).
  let initialEngagements: any[] = []
  let initialEngagementsClosedCount = 0
  let initialEngagementsClosedWonCount = 0

  // ── 'All Locations' is an OVERVIEW, not a data scope (Fix 2, Phase 4) ──────
  // Phases 1–3 made scoped loads fast and left 'all' as the only slow path:
  // 7,028 leads + 19,361 child rows + 6,065 engagements = 28.57 MB, the closest
  // thing on this page to Vercel's 25s ceiling — all of it loaded so the
  // BROWSER could reduce it to five headline numbers.
  //
  // On 'all' the people graph is no longer loaded at all. The server reduces
  // and ships numbers (lib/hub-all-overview.ts), and the ENGAGEMENT board still
  // ships in full because it is genuinely bounded: 292 open engagements across
  // the whole tenant, 397 KB with their children and client names. That is the
  // dividing line for every surface — engagements and counts work on 'all';
  // anything that enumerates PEOPLE asks for a location.
  //
  // Elevated only. A franchise user with a null location_id also has no scope
  // uuid, and must keep the unscoped path they have always had.
  const overviewOnly = isElevated && !scopeLocationUuid
  let initialAllOverview: any = null
  // Set when the leads load hits MAX_LEADS. Shipped to the client so the
  // shortfall is stated on screen rather than inferred from a log.
  let leadsTruncated = false

  if (!overviewOnly) {
    // Paginated load — a single .limit(1000) silently truncated locations
    // with >1000 leads (Portland: 1616), so the client-side "Active" count
    // and every derived stat ran over an incomplete set. Same short-page
    // loop as the alreadyWritten fix in the import route (3099875).
    // MAX_LEADS is a payload safety ceiling for the elevated all-locations
    // view — hitting it is the trigger point for moving these stats to
    // server-side counts instead of shipping every row to the client.
    const PAGE = 1000
    // Lowered from 10,000 in Phase 4. It now only ever guards ONE location —
    // 'all' no longer loads leads at all — and the largest is Kansas City at
    // 3,306, so 5,000 is ~1.5x headroom on the real worst case instead of a
    // number chosen when this guarded the whole tenant.
    const MAX_LEADS = 5000
    let leadsRaw: any[] | null = []
    let leadsError: { message: string } | null = null
    for (let from = 0; from < MAX_LEADS; from += PAGE) {
      let q = supabaseService
        .from('leads')
        // "not junk" = false OR NULL. Jobber-imported leads leave is_junk
        // unset (NULL), and `.eq('is_junk', false)` does NOT match NULL in
        // Postgres — those leads loaded nowhere (not here, not the bin which
        // is is_junk=true) and were invisible app-wide. `is_junk IS NOT TRUE`
        // matches false and NULL, still excluding genuinely junked leads.
        .select('*')
        .not('is_junk', 'is', true)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)

      if (scopeLocationUuid) {
        q = q.eq('location_uuid', scopeLocationUuid)
      }

      const { data: pageRows, error: pageErr } = await q
      if (pageErr) { leadsError = pageErr; leadsRaw = null; break }
      leadsRaw.push(...(pageRows || []))
      if ((pageRows || []).length < PAGE) break
      if (from + PAGE >= MAX_LEADS) {
        // VISIBLE, not whispered. A truncated load that only reaches Vercel's
        // logs is the exact silent-failure mode this whole effort is retiring:
        // the page renders, the counts are simply wrong, and nobody is told.
        // The flag rides to the client and Home renders a banner.
        leadsTruncated = true
        console.warn(
          `[hub-page] leads load hit the ${MAX_LEADS}-row ceiling for ${hubUser.email} — counts on this page are UNDER-COUNTED; the user has been shown a truncation notice`
        )
      }
    }

    if (leadsError) {
      console.error('[hub-page] leads fetch error:', leadsError.message)
    } else if (leadsRaw && leadsRaw.length > 0) {
      const leadIds = leadsRaw.map((l: any) => l.id)

      // Child-table fetch — see createChildRowFetcher above for the three
      // paths. Both flags below must mirror the leads query's own filter
      // EXACTLY, or the child read scopes differently than the leads it is
      // joining to:
      //   • `unscoped` — true only when the leads query ran with NO location
      //     filter, because only then is leadIds the whole tenant and the bulk
      //     whole-table read equivalent by construction. `scopeLocationUuid`
      //     IS that filter, so deriving it from the same value keeps the two
      //     tied together; they cannot drift the way two hand-written copies
      //     of the condition could.
      //   • `location` — set only for an ELEVATED picked location, which is
      //     the one case where a location-column filter is both available and
      //     cheaper than chunking by lead id. A franchise user keeps the
      //     chunked path they use today, untouched.
      const childRowsUnscoped = !scopeLocationUuid
      const fetchChildRows = createChildRowFetcher(supabaseService, {
        unscoped: childRowsUnscoped,
        location: childScopeLocation,
      })

      const [
        leadNotesRaw,
        touchpointsRaw,
        leadContactsRaw,
        leadTagsRaw,
        assessmentsRaw,
        serviceRequestsRaw,
        quotesRaw,
        jobsRaw,
        invoicesRaw,
        leadAssigneesRaw,
      ] = await Promise.all([
        fetchChildRows('lead_notes', leadIds, 'created_at'),
        fetchChildRows('touchpoints', leadIds, 'occurred_at'),
        fetchChildRows('lead_contacts', leadIds, 'created_at', true),
        fetchChildRows('lead_tags', leadIds, undefined, false, ['lead_id', 'tag_lookup_id']),
        fetchChildRows('assessments', leadIds, 'scheduled_at'),
        fetchChildRows('service_requests', leadIds, 'created_at'),
        fetchChildRows('quotes', leadIds, 'sent_at'),
        fetchChildRows('jobs', leadIds, 'scheduled_start'),
        fetchChildRows('invoices', leadIds, 'issued_at'),
        // Plural lead assignment. Composite PK (lead_id, hub_user_id) — no `id`
        // column, so keyCols must name both, exactly like lead_tags. Ordered
        // created_at ASCENDING: the first row assigned is the primary, and
        // people-mapper preserves that order.
        fetchChildRows('lead_assignees', leadIds, 'created_at', true, ['lead_id', 'hub_user_id']),
      ])

      const tagLookupIds = Array.from(new Set((leadTagsRaw || []).map((lt: any) => lt.tag_lookup_id)))
      let tag_lookups: Record<string, any> = {}
      if (tagLookupIds.length > 0) {
        const { data: tagLookupRows } = await supabaseService
          .from('lookups')
          .select('*')
          .in('id', tagLookupIds)
        ;(tagLookupRows || []).forEach((row: any) => {
          tag_lookups[row.id] = row
        })
      }

      const groupBy = <T extends { lead_id: string }>(rows: T[] | null) => {
        const out: Record<string, T[]> = {}
        ;(rows || []).forEach(r => {
          if (!out[r.lead_id]) out[r.lead_id] = []
          out[r.lead_id].push(r)
        })
        return out
      }

      const notesByLead       = groupBy(leadNotesRaw)
      const touchByLead       = groupBy(touchpointsRaw)
      const contactsByLead    = groupBy(leadContactsRaw)
      const tagsByLead        = groupBy(leadTagsRaw)
      const assessByLead      = groupBy(assessmentsRaw)
      const serviceReqsByLead = groupBy(serviceRequestsRaw)
      const quotesByLead      = groupBy(quotesRaw)
      const jobsByLead        = groupBy(jobsRaw)
      const invoicesByLead    = groupBy(invoicesRaw)
      const assigneesByLead   = groupBy(leadAssigneesRaw)

      // ── ONE paginated sweep over ALL engagements (open + closed): repeat
      // counts for the board chips + the per-client Closed Won roll-up that
      // feeds the people-side 'Client' status (won clients must not read as
      // Nurturing). Runs BEFORE the people mapping so the roll-up ships on
      // every Person — deliberately independent of the open-engagements
      // fetch below AND of the stored leads.client_status column.
      const repeatCounts: Record<string, number> = {}
      const wonByClient: Record<string, { count: number; value: number; lastClosedAt: string | null }> = {}
      for (let from = 0; ; from += PAGE) {
        let q = supabaseService
          .from('engagements')
          .select('id, client_id, stage, total_paid, total_invoiced, closed_at')
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (scopeLocationUuid) {
          q = q.eq('location_uuid', scopeLocationUuid)
        }
        const { data, error } = await q
        if (error) {
          console.error('[hub-page] engagement sweep error:', error.message)
          break
        }
        for (const r of data || []) {
          repeatCounts[r.client_id] = (repeatCounts[r.client_id] || 0) + 1
          if (r.stage === 'Closed Won') {
            const w = wonByClient[r.client_id] || (wonByClient[r.client_id] = { count: 0, value: 0, lastClosedAt: null })
            w.count += 1
            w.value += Number(r.total_paid) || Number(r.total_invoiced) || 0
            if (r.closed_at && (!w.lastClosedAt || r.closed_at > w.lastClosedAt)) w.lastClosedAt = r.closed_at
          }
        }
        if ((data || []).length < PAGE) break
      }

      const { mapLeadToPerson } = await import('@/lib/people-mapper')
      initialPeople = leadsRaw.map((row: any) =>
        mapLeadToPerson(row, {
          lead_notes:       notesByLead[row.id]       || [],
          touchpoints:      touchByLead[row.id]       || [],
          lead_contacts:    contactsByLead[row.id]    || [],
          lead_tags:        tagsByLead[row.id]        || [],
          assessments:      assessByLead[row.id]      || [],
          service_requests: serviceReqsByLead[row.id] || [],
          quotes:           quotesByLead[row.id]      || [],
          jobs:             jobsByLead[row.id]        || [],
          invoices:         invoicesByLead[row.id]    || [],
          lead_assignees:   assigneesByLead[row.id]   || [],
          tag_lookups,
          won_summary:      wonByClient[row.id]       || null,
        })
      )
      console.log(`[hub-page] Fetched ${initialPeople.length} leads + joined data for ${hubUser.email}`)

      // ── HIVE Phase 1 step 4: open engagements (dual-read; additive) ──
      // Same short-page .range() loop as the leads load above — the 1000-row
      // cap lesson (80ded92/3099875) applies to engagements too. Child rows
      // for the within-stage chips are reused from the fetches above (they
      // carry engagement_id since step 1); repeat counts come from the
      // all-engagements sweep above.
      {
        const engOpen: any[] = []
        let engErr: { message: string } | null = null
        for (let from = 0; ; from += PAGE) {
          let q = supabaseService
            .from('engagements')
            .select('*')
            .not('stage', 'in', '("Closed Won","Closed Lost")')
            .order('created_at', { ascending: false })
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1)
          if (scopeLocationUuid) {
            q = q.eq('location_uuid', scopeLocationUuid)
          }
          const { data, error } = await q
          if (error) { engErr = error; break }
          engOpen.push(...(data || []))
          if ((data || []).length < PAGE) break
        }

        if (engErr) {
          console.error('[hub-page] engagements fetch error:', engErr.message)
        } else if (engOpen.length > 0) {
          const leadInfoById: Record<string, { name: string; phone: string | null; email: string | null }> = {}
          for (const l of leadsRaw) leadInfoById[l.id] = { name: l.name || 'Unknown', phone: l.phone || null, email: l.email || null }

          const byEngagement = <T extends { engagement_id?: string | null }>(rows: T[] | null) => {
            const out: Record<string, T[]> = {}
            ;(rows || []).forEach(r => {
              if (!r.engagement_id) return
              if (!out[r.engagement_id]) out[r.engagement_id] = []
              out[r.engagement_id].push(r)
            })
            return out
          }
          const quotesByEng      = byEngagement(quotesRaw)
          const jobsByEng        = byEngagement(jobsRaw)
          const invoicesByEng    = byEngagement(invoicesRaw)
          const assessmentsByEng = byEngagement(assessmentsRaw)
          const serviceReqsByEng = byEngagement(serviceRequestsRaw)

          initialEngagements = engOpen.map((e: any) => ({
            ...e,
            client_name: leadInfoById[e.client_id]?.name || 'Unknown',
            client_phone: leadInfoById[e.client_id]?.phone ?? null,
            client_email: leadInfoById[e.client_id]?.email ?? null,
            repeat_count: repeatCounts[e.client_id] || 1,
            quotes: (quotesByEng[e.id] || []).map((q: any) => ({
              id: q.id, status: q.status, total: q.total,
              sent_at: q.sent_at, approved_at: q.approved_at,
            })),
            jobs: (jobsByEng[e.id] || []).map((j: any) => ({
              id: j.id, status: j.status, title: j.title,
              scheduled_start: j.scheduled_start, completed_at: j.completed_at,
            })),
            invoices: (invoicesByEng[e.id] || []).map((i: any) => ({
              id: i.id, status: i.status, total: i.total,
              balance_owing: i.balance_owing,
            })),
            assessments: (assessmentsByEng[e.id] || []).map((a: any) => ({
              id: a.id, scheduled_at: a.scheduled_at, status: a.status, completed_at: a.completed_at,
            })),
            // id-only: the board needs SRs solely for the linked-vs-local
            // gate (isJobberLinked) — request-founded engagements must not
            // read as local just because no quote exists yet.
            service_requests: (serviceReqsByEng[e.id] || []).map((sr: any) => ({ id: sr.id })),
          }))
          console.log(`[hub-page] Fetched ${initialEngagements.length} open engagements for ${hubUser.email}`)
        }

        {
          let cq = supabaseService
            .from('engagements')
            .select('id', { count: 'exact', head: true })
            .in('stage', ['Closed Won', 'Closed Lost'])
          if (scopeLocationUuid) {
            cq = cq.eq('location_uuid', scopeLocationUuid)
          }
          const { count, error } = await cq
          if (error) console.error('[hub-page] closed-engagement count error:', error.message)
          else initialEngagementsClosedCount = count ?? 0
        }

        // Won split for the List's Won/Lost filter chips (lost = closed − won).
        {
          let wq = supabaseService
            .from('engagements')
            .select('id', { count: 'exact', head: true })
            .eq('stage', 'Closed Won')
          if (scopeLocationUuid) {
            wq = wq.eq('location_uuid', scopeLocationUuid)
          }
          const { count, error } = await wq
          if (error) console.error('[hub-page] closed-won count error:', error.message)
          else initialEngagementsClosedWonCount = count ?? 0
        }
      }
    }
  } else {
    // ── The 'all' path: COUNTS ONLY, no records of any kind ─────────────────
    // Phase 4 kept the engagement board live here (292 open engagements,
    // 397 KB). Phase 4b removes it: a board that blends Kansas City, Portland
    // and Temecula deals into shared stage columns is a BLEND, not a view —
    // there is no column of work anyone can act on. So 'all' now follows one
    // rule without exception: any surface that enumerates records belonging to
    // a specific location asks you to pick one.
    //
    // Engagements are still READ here, but only server-side and only the
    // fields the overview reduces — they are never shipped. initialEngagements
    // stays empty, which is what drives the Engagements tab's picker prompt.
    const PAGE = 1000
    const overviewEngagements: any[] = []
    {
      const engLean: any[] = []
      let engErr: { message: string } | null = null
      for (let from = 0; ; from += PAGE) {
        // Three columns, not `*`. This set exists to be counted, not rendered.
        const { data, error } = await supabaseService
          .from('engagements')
          .select('id, client_id, stage')
          .not('stage', 'in', '("Closed Won","Closed Lost")')
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) { engErr = error; break }
        engLean.push(...(data || []))
        if ((data || []).length < PAGE) break
      }

      if (engErr) {
        console.error('[hub-page] all-overview engagement read failed:', engErr.message)
      } else if (engLean.length > 0) {
        const chunked = async (table: string, cols: string, col: string, ids: string[]) => {
          const acc: any[] = []
          for (let i = 0; i < ids.length; i += 200) {
            const { data, error } = await supabaseService
              .from(table).select(cols).in(col, ids.slice(i, i + 200))
            if (error) { console.error(`[hub-page] all-overview ${table} read failed: ${error.message}`); break }
            acc.push(...(data || []))
          }
          return acc
        }

        // Only the two child reads the overview actually reduces:
        //   quotes      → only for Estimate-stage rows (the follow-up card)
        //   assessments → for every open row (the today+1 card windows them)
        // jobs / invoices / service_requests are not read at all here: nothing
        // on the overview derives from them.
        const estimateIds = engLean.filter((e: any) => e.stage === 'Estimate').map((e: any) => e.id)
        const [quoteRows, assessRows] = await Promise.all([
          estimateIds.length ? chunked('quotes', 'engagement_id, sent_at', 'engagement_id', estimateIds) : Promise.resolve([]),
          chunked('assessments', 'id, engagement_id, scheduled_at', 'engagement_id', engLean.map((e: any) => e.id)),
        ])

        const byEng = (rows: any[]) => {
          const out: Record<string, any[]> = {}
          for (const r of rows || []) { if (r.engagement_id) (out[r.engagement_id] ||= []).push(r) }
          return out
        }
        const quotesByEng = byEng(quoteRows)
        const assessByEng = byEng(assessRows)

        // client_name is only ever read for an engagement with an assessment
        // (the "Next: <client>" label), so resolve names for those alone.
        const namedIds = Array.from(new Set(
          engLean.filter((e: any) => assessByEng[e.id]?.length).map((e: any) => e.client_id).filter(Boolean)
        ))
        const nameById: Record<string, string> = {}
        if (namedIds.length > 0) {
          const rows = await chunked('leads', 'id, name', 'id', namedIds)
          for (const l of rows) nameById[l.id] = l.name || 'Unknown'
        }

        // The shape buildAllOverview consumes — same contract as the scoped
        // board projection, populated only where the overview reads it.
        for (const e of engLean) {
          overviewEngagements.push({
            id: e.id, client_id: e.client_id, stage: e.stage,
            client_name: nameById[e.client_id] || 'Client',
            quotes: (quotesByEng[e.id] || []).map((q: any) => ({ sent_at: q.sent_at })),
            assessments: (assessByEng[e.id] || []).map((a: any) => ({ id: a.id, scheduled_at: a.scheduled_at })),
          })
        }
      }
    }

    // Closed counts stay: they are two head:true calls, and keeping them means
    // nothing downstream has to special-case a missing number.
    const [closedRes, wonRes] = await Promise.all([
      supabaseService.from('engagements').select('id', { count: 'exact', head: true })
        .in('stage', ['Closed Won', 'Closed Lost']),
      supabaseService.from('engagements').select('id', { count: 'exact', head: true })
        .eq('stage', 'Closed Won'),
    ])
    initialEngagementsClosedCount = closedRes.count ?? 0
    initialEngagementsClosedWonCount = wonRes.count ?? 0

    try {
      initialAllOverview = await buildAllOverview(supabaseService, overviewEngagements)
      console.log(
        `[hub-page] all-overview: ${initialAllOverview.leadCount} leads counted, ` +
        `${initialAllOverview.newUncontacted.count} new-uncontacted, ` +
        `${initialAllOverview.openEngagementsCount} open engagements (counted, not shipped)` +
        (initialAllOverview.truncated ? ' — TRUNCATED' : '')
      )
    } catch (e: any) {
      console.error('[hub-page] all-overview build failed:', e?.message || e)
    }
  }

  // Recycle Bin: load is_junk=true leads, same location-scoping as the main
  // query. Joined-table data (notes, touchpoints, etc.) is skipped — the bin
  // only renders name/location/timestamp, and on restore the PATCH response
  // returns the full row. 90-day retention keeps this bounded.
  //
  // Skipped entirely on 'all' (Phase 4): the bin enumerates PEOPLE, so it falls
  // on the ask-for-a-location side of the line. The tab renders a picker prompt
  // rather than a misleading empty bin.
  if (!overviewOnly) {
    let binQ = supabaseService
      .from('leads')
      .select('*')
      .eq('is_junk', true)
      .order('updated_at', { ascending: false })
      .limit(500)

    if (scopeLocationUuid) {
      binQ = binQ.eq('location_uuid', scopeLocationUuid)
    }

    const { data: binRaw, error: binError } = await binQ

    if (binError) {
      console.error('[hub-page] bin leads fetch error:', binError.message)
    } else if (binRaw && binRaw.length > 0) {
      const { mapLeadToPerson } = await import('@/lib/people-mapper')
      initialBinPeople = binRaw.map((row: any) => ({
        ...mapLeadToPerson(row, {}),
        deletedAt: row.updated_at || row.created_at || null,
      }))
      console.log(`[hub-page] Fetched ${initialBinPeople.length} bin leads for ${hubUser.email}`)
    }
  }

  // ── loc_other transfer queue (Fix 2, Phase 2) ──────────────────────────────
  // The unrouted global-form leads corp/admin routes to a real location — the
  // Home "needs transfer" card and the Inbox "Needs transfer" section. Both
  // used to read `atLocOther` off the loaded people graph, which meant Phase 1
  // silently emptied the routing queue the moment any real location was
  // selected: the work still existed, the surface that shows it just stopped
  // rendering. Phase 3 (a real location as the DEFAULT) would have made that
  // permanent.
  //
  // So this is fetched OUTSIDE the selected scope, deliberately. It is the one
  // read on this page that ignores `scopeLocationUuid`, because the queue is a
  // corporate routing surface rather than a view of a location's book.
  //
  // ELEVATED ONLY. A franchise user gets [] and the sections self-gate on
  // emptiness — the same posture as before, where their scope simply never
  // contained loc_other rows. `leads.location_id` is the SLUG here (the two
  // vocabularies again — see lib/hub-scope.ts).
  let initialTransferPeople: any[] = []
  if (isElevated) {
    // Already loaded? Then filter rather than re-query — see transferQueueSource
    // in lib/hub-scope.ts, which owns this decision and the history behind it.
    // The short version: this used to read `!scopeLocationUuid || loc_other`,
    // and Phase 4's overviewOnly made the 'all' half of that a filter over an
    // always-empty array, which emptied the routing queue on the one scope that
    // exists to work it. 'all' now falls through to the bounded query below.
    const alreadyLoaded = transferQueueSource({
      overviewOnly,
      scopeLocationUuid,
      locationSlug: scope.locationSlug,
    }) === 'filter-loaded'
    if (alreadyLoaded) {
      initialTransferPeople = initialPeople
        .filter((p: any) => p.atLocOther)
        .slice(0, TRANSFER_QUEUE_MAX)
    } else {
      const { data: transferRaw, error: transferErr } = await supabaseService
        .from('leads')
        .select('*')
        .eq('location_id', LOC_OTHER_SLUG)
        .not('is_junk', 'is', true)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .limit(TRANSFER_QUEUE_MAX)

      if (transferErr) {
        // Non-fatal: the queue is additive to the page. Log loudly — a silently
        // empty routing queue is the exact failure this block exists to end.
        console.error(`[hub-page] transfer queue fetch error: ${transferErr.message} — the needs-transfer surface will render EMPTY this load`)
      } else if (transferRaw && transferRaw.length > 0) {
        // These rows are pre-routing by definition (no Jobber record yet), but
        // the Inbox's touch-band filter reads outreachTimeline, so fetch the
        // two child tables that can legitimately carry data for an unrouted
        // lead. The Jobber-owned tables are skipped: a lead that has never been
        // routed cannot have quotes/jobs/invoices/assessments/service_requests.
        // Bounded at TRANSFER_QUEUE_MAX ids, so this is one chunk per table.
        const fetchTransferChildRows = createChildRowFetcher(supabaseService, { unscoped: false })
        const transferIds = transferRaw.map((r: any) => r.id)
        const [transferNotes, transferTouches, transferAssignees] = await Promise.all([
          fetchTransferChildRows('lead_notes', transferIds, 'created_at'),
          fetchTransferChildRows('touchpoints', transferIds, 'occurred_at'),
          // Unrouted, but NOT unassigned: intake assigns at loc_other like
          // anywhere else, so these rows carry junction data the panel shows.
          fetchTransferChildRows('lead_assignees', transferIds, 'created_at', true, ['lead_id', 'hub_user_id']),
        ])
        const byLead = (rows: any[]) => {
          const out: Record<string, any[]> = {}
          for (const r of rows || []) (out[r.lead_id] ||= []).push(r)
          return out
        }
        const notesByLead = byLead(transferNotes)
        const touchByLead = byLead(transferTouches)
        const assigneesByLead = byLead(transferAssignees)

        const { mapLeadToPerson } = await import('@/lib/people-mapper')
        initialTransferPeople = transferRaw.map((row: any) =>
          mapLeadToPerson(row, {
            lead_notes: notesByLead[row.id] || [],
            touchpoints: touchByLead[row.id] || [],
            lead_assignees: assigneesByLead[row.id] || [],
          })
        )
      }
      if (initialTransferPeople.length >= TRANSFER_QUEUE_MAX) {
        console.warn(
          `[hub-page] transfer queue hit its ${TRANSFER_QUEUE_MAX}-row bound — more unrouted leads exist than are being shown`
        )
      }
    }
    if (initialTransferPeople.length > 0) {
      console.log(`[hub-page] ${initialTransferPeople.length} lead(s) awaiting transfer for ${hubUser.email}`)
    }
  }

  // /clients/[id] passes initialSelectedLeadId — if the id doesn't exist in
  // the user's accessible leads (deleted, wrong location, or invalid uuid),
  // bounce to /clients with notfound=1 so the panel doesn't open and the
  // user gets a toast. initialPeople is already location-scoped above.
  //
  // For an ELEVATED user the scope has already moved to the lead's own location
  // if it lived outside the selection (the deep-link override above), so this
  // now fires only when the lead genuinely isn't reachable: it doesn't exist,
  // it's junked, or the id is malformed. For a franchise user nothing changed —
  // the override never applies to them, so another location's lead still
  // bounces here exactly as before. That fence is the point, not a side effect.
  if (initialSelectedLeadId) {
    const found = initialPeople.some((p: any) => p.id === initialSelectedLeadId)
    if (!found) {
      redirect('/clients?notfound=1')
    }
  }

  // /clients/<id>?e=<engagementId> — validate the engagement belongs to THIS
  // client before opening its panel. The client id is already location-scoped
  // (validated ∈ initialPeople above), so an `id = e AND client_id = <client>`
  // match transitively scopes the engagement — no separate location filter, no
  // way to deep-link another location's deal. A malformed uuid, an unknown id,
  // or an engagement under a different client is silently dropped (the client
  // opens, the engagement doesn't) — never an error/redirect that would leak
  // whether the id exists.
  let selectedEngagementId: string | undefined = undefined
  if (initialSelectedLeadId && initialSelectedEngagementId) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (UUID_RE.test(initialSelectedEngagementId)) {
      const { data: engRow } = await supabaseService
        .from('engagements')
        .select('id')
        .eq('id', initialSelectedEngagementId)
        .eq('client_id', initialSelectedLeadId)
        .maybeSingle()
      if (engRow) selectedEngagementId = initialSelectedEngagementId
    }
  }

  // Partners + Contacts (one table, `type` discriminator) and Companies — the
  // CRM module behind the Network tab. Location-scoped like leads.
  //
  // Skipped entirely on 'all' (Phase 4b, late): Network shipped after the
  // Phase 4 work but on Phase-1-era semantics — an elevated user on 'all' got
  // every location's partners and companies BLENDED, the exact pattern the
  // Inbox, Client List and Engagements retired. Network enumerates records
  // belonging to a specific location, so it sits on the ask-for-a-location
  // side of the line; the tab renders the same picker prompt. The tenant-wide
  // referral rollup (/api/network/summary, elevated-only) stays live — that is
  // the genuinely cross-location piece, like the loc_other queue on the Inbox.
  let initialPartners: any[] = []
  let initialCompanies: any[] = []
  // Set when either network load hits MAX_NETWORK_ROWS. Rides to the client so
  // the Network screen states the shortfall — the old limit(2000) cap truncated
  // with no error, no flag, no banner.
  let networkTruncated = false
  if (!overviewOnly) {
    // Paginated short-page loop, same shape as the leads loader above: a bare
    // bare limit(2000) silently dropped row 2001+ once a location outgrew it.
    // MAX_NETWORK_ROWS is a payload safety ceiling per table, ~alignment with
    // MAX_LEADS; hitting it sets the visible flag instead of whispering.
    const PAGE = 1000
    const MAX_NETWORK_ROWS = 5000
    const loadNetworkRows = async (table: 'partners' | 'companies', cols: string) => {
      const rows: any[] = []
      for (let from = 0; from < MAX_NETWORK_ROWS; from += PAGE) {
        // ⚠️ partners/companies.location_id holds the location UUID, NOT the
        // slug — the column NAME matches the child tables' slug column but the
        // VALUE form does not. Verified against prod 2026-07-22. Do not
        // "harmonize" this to scope.locationSlug; it would match nothing,
        // silently, and empty the Network tab.
        let q = supabaseService
          .from(table)
          .select(cols)
          .is('deleted_at', null)
          .order('name', { ascending: true })
          .range(from, from + PAGE - 1)
        if (scopeLocationUuid) q = q.eq('location_id', scopeLocationUuid)

        const { data: pageRows, error: pageErr } = await q
        if (pageErr) {
          console.error(`[hub-page] ${table} fetch error:`, pageErr.message)
          return null
        }
        rows.push(...(pageRows || []))
        if ((pageRows || []).length < PAGE) break
        if (from + PAGE >= MAX_NETWORK_ROWS) {
          networkTruncated = true
          console.warn(
            `[hub-page] ${table} load hit the ${MAX_NETWORK_ROWS}-row ceiling for ${hubUser.email} — the Network tab is INCOMPLETE; the user has been shown a truncation notice`
          )
        }
      }
      return rows
    }

    const [partnersRaw, companiesRaw] = await Promise.all([
      loadNetworkRows('partners', PARTNER_COLS),
      loadNetworkRows('companies', COMPANY_COLS),
    ])
    if (partnersRaw) initialPartners = partnersRaw.map(mapPartnerRow)
    if (companiesRaw) initialCompanies = companiesRaw.map(mapCompanyRow)
  }

  const initialLookups: Record<string, any[]> = {}
  {
    const { data: lookups, error: lookupsError } = await supabaseService
      .from('lookups')
      .select('id, category, label, sort_order, color, bg_color, icon, description, attrs, is_active')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })

    if (lookupsError) {
      console.error('[hub-page] lookups fetch error:', lookupsError.message)
    } else if (lookups) {
      for (const row of lookups) {
        const cat = row.category as string
        if (!initialLookups[cat]) initialLookups[cat] = []
        initialLookups[cat].push(row)
      }
    }
  }

  // Phase 2 co-owner onboarding: is the signed-in owner the DESIGNATED primary
  // owner of their location? A co-owner (owner seat with is_primary=false)
  // joining an already-launched location gets the slim onboarding flow. Owners
  // with no seat row (legacy/pre-seat) default to primary so they're never
  // mistakenly routed into the co-owner flow.
  const myOwnerSeat = (initialSeats || []).find(
    (s: any) => s.tier === 'owner' && s.user_id === hubUser.id
  )
  const isPrimaryOwner = myOwnerSeat ? !!myOwnerSeat.is_primary : true

  return (
    <BeeHub
      initialRoute={initialRoute}
      initialSelectedLeadId={initialSelectedLeadId}
      initialSelectedEngagementId={selectedEngagementId}
      notFoundToast={notFoundToast}
      initialRole={role}
      initialFranchiseRole={franchiseRole}
      initialLocFilter={initialLocFilter}
      initialGuideSlides={initialGuideSlides}
      initialManualSlides={initialManualSlides}
      initialTierPrices={initialTierPrices}
      initialLocations={initialLocations}
      initialUsers={initialUsers}
      initialSeats={initialSeats}
      initialPendingInvites={initialPendingInvites}
      initialLookups={initialLookups}
      initialPeople={initialPeople}
      initialBinPeople={initialBinPeople}
      // Corporate overview for 'All Locations' — server-reduced counts that
      // replace the people graph on that scope (null on a scoped load).
      initialAllOverview={initialAllOverview}
      // True when the leads load hit MAX_LEADS and the counts on this page are
      // therefore short. Rendered as a banner, never left implicit.
      initialLeadsTruncated={leadsTruncated}
      initialTransferPeople={initialTransferPeople}
      // The scope the server ACTUALLY used, so the client can reconcile the
      // cookie to it after hydration (a Server Component cannot write cookies).
      // Carries the deep-link override and the fall-back-to-'all' cases alike.
      initialScopeLocationId={scope.locationUuid}
      initialEngagements={initialEngagements}
      initialEngagementsClosedCount={initialEngagementsClosedCount}
      initialEngagementsClosedWonCount={initialEngagementsClosedWonCount}
      initialPartners={initialPartners}
      initialCompanies={initialCompanies}
      // True when a network load hit MAX_NETWORK_ROWS — the Network screen
      // states the shortfall instead of rendering a quietly short list.
      initialNetworkTruncated={networkTruncated}
      currentSubscription={currentSubscription}
      currentLocation={currentLocation}
      currentUser={{
        id: hubUser.id,
        email: hubUser.email,
        name: hubUser.full_name || hubUser.email,
        role: hubUser.role,
        locationId: hubUser.location_id,
        first_name: profileFields.first_name,
        last_name: profileFields.last_name,
        phone: profileFields.phone,
        booking_link: bookingLink,
        isPrimaryOwner,
      }}
    />
  )
}
