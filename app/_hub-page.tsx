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
  normalizeScopeCookie,
  resolveHubScope,
  childLocationFilter,
  SCOPE_ALL,
} from '@/lib/hub-scope'
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
  //   • normalizeScopeCookie collapses anything that isn't a well-formed uuid
  //     (absent, '', 'all', a slug, an injection attempt) to SCOPE_ALL before
  //     it can reach a query;
  //   • a surviving uuid is then looked up in `locations` — an unknown or
  //     deleted id yields null and degrades to 'all';
  //   • the lookup is skipped ENTIRELY for non-elevated users, and
  //     resolveHubScope ignores `validated` for them regardless, so a franchise
  //     user who hand-sets the cookie still cannot escape their own location.
  //
  // Every rejection path lands on the same place: locationUuid=null, which is
  // literally today's behavior. That is what makes Phase 1 revertible by
  // clearing one cookie.
  const scopeCookieRaw = (await cookies()).get(SCOPE_COOKIE_NAME)?.value
  const scopeCookie = normalizeScopeCookie(scopeCookieRaw)
  let scopeValidated: { id: string; slug: string | null } | null = null
  if (isElevated && scopeCookie !== SCOPE_ALL) {
    const { data: scopeRow, error: scopeErr } = await supabaseService
      .from('locations')
      .select('id, location_id')
      .eq('id', scopeCookie)
      .maybeSingle()
    if (scopeErr) {
      // Never fail the page over a scope hint — fall through to 'all'.
      console.error(`[hub-page] scope validation failed for ${scopeCookie}: ${scopeErr.message} — falling back to all-locations`)
    } else if (scopeRow) {
      scopeValidated = { id: (scopeRow as any).id, slug: (scopeRow as any).location_id ?? null }
    } else {
      console.warn(`[hub-page] scope cookie named an unknown location (${scopeCookie}) for ${hubUser.email} — falling back to all-locations`)
    }
  }

  const scope = resolveHubScope({
    isElevated,
    hubUserLocationId: hubUser.location_id,
    validated: scopeValidated,
  })

  // THE single filter value every `location_uuid` query below uses. For a
  // non-elevated user this is exactly `hubUser.location_id` — the same value
  // the old `if (!isElevated && hubUser.location_id)` guard applied — so their
  // load is unchanged. For an elevated user it is their picked location, or
  // null (no filter) when they are on 'all'.
  const scopeLocationUuid = scope.locationUuid

  // Child tables are filtered on their OWN location column, which needs BOTH
  // the uuid and the slug (two vocabularies — see lib/hub-scope.ts). Only an
  // elevated scoped load takes that path; everyone else keeps the lead-id
  // paths they use today, so `childScopeLocation` stays null for them.
  const childScopeLocation =
    scope.source === 'cookie' && scope.locationUuid
      ? { uuid: scope.locationUuid, slug: scope.locationSlug }
      : null

  // The client's locFilter MUST agree with what the server actually shipped.
  // If the server scopes to location A and the client still filters on 'all'
  // it merely renders the scoped set (harmless), but if it filters on
  // location B it filters a scoped array down to EMPTY.
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
        'id, name, subscription_status, subscription_plan, payment_source, paid_through_date, deferred_until, billing_notes, jobber_account_id, jobber_account_name, jobber_initial_import_completed_at, jobber_team_roster, jobber_team_roster_synced_at, last_sync_status, token_expiry, onboarding_state, default_drip_path, default_move_drip_path, address, city, state, zip, phone, email, timezone, sender_name, send_from_email, reply_to_email, reviews_link, calendar_link, activated_at, lifecycle_status, slack_connected, slack_team_name, slack_channel_name'
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
        activated_at: locRow.activated_at || null,
      }
    }
  }

  let initialSeats: any[] = []
  let initialPendingInvites: any[] = []
  if (currentLocation?.id) {
    const { data: seatsRaw, error: seatsErr } = await supabaseService
      .from('subscription_seats')
      .select(
        'id, location_id, tier, user_id, status, is_primary, added_at, removed_at, prorated_cost, added_by, notes, scheduled_removal_at'
      )
      .eq('location_id', currentLocation.id)
      .eq('status', 'active')
      .order('added_at', { ascending: true })

    if (seatsErr) console.error('[hub-page] seats fetch error:', seatsErr.message)
    initialSeats = seatsRaw || []

    const { data: pendingRaw, error: pendingErr } = await supabaseService
      .from('pending_invites')
      .select('id, location_id, email, full_name, role, tier, invite_expires_at, accepted_at, created_at')
      .eq('location_id', currentLocation.id)
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
        'id, name, address, city, state, zip, phone, email, timezone, reviews_link, calendar_link, sender_name, send_from_email, reply_to_email, lifecycle_status, subscription_status, subscription_plan, payment_source, paid_through_date, billing_notes, jobber_account_id, jobber_account_name, jobber_initial_import_completed_at, jobber_team_roster, jobber_team_roster_synced_at, last_sync_status, token_expiry, created_at, onboarding_state, default_drip_path, default_move_drip_path, activated_at, corporate_sponsorship_started_at, corporate_sponsorship_ends_at, slack_connected, slack_team_name, slack_channel_name'
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
  {
    // Paginated load — a single .limit(1000) silently truncated locations
    // with >1000 leads (Portland: 1616), so the client-side "Active" count
    // and every derived stat ran over an incomplete set. Same short-page
    // loop as the alreadyWritten fix in the import route (3099875).
    // MAX_LEADS is a payload safety ceiling for the elevated all-locations
    // view — hitting it is the trigger point for moving these stats to
    // server-side counts instead of shipping every row to the client.
    const PAGE = 1000
    const MAX_LEADS = 10000
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
        console.warn(
          `[hub-page] leads load hit ${MAX_LEADS}-row safety ceiling for ${hubUser.email} — stats are truncated; time to move to server-side counts`
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
  }

  // Recycle Bin: load is_junk=true leads, same location-scoping as the main
  // query. Joined-table data (notes, touchpoints, etc.) is skipped — the bin
  // only renders name/location/timestamp, and on restore the PATCH response
  // returns the full row. 90-day retention keeps this bounded.
  {
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

  // /clients/[id] passes initialSelectedLeadId — if the id doesn't exist in
  // the user's accessible leads (deleted, wrong location, or invalid uuid),
  // bounce to /clients with notfound=1 so the panel doesn't open and the
  // user gets a toast. initialPeople is already location-scoped above.
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
  // CRM module behind the "Contacts" tab. Location-scoped like leads; elevated
  // users get every location's rows. Soft-deleted rows are excluded (the recycle
  // bin re-fetches lazily / restores via the API response). Mapped to the same
  // camelCase client shape the API returns so setPartners/setCompanies snapshots
  // stay consistent across reloads and writes.
  let initialPartners: any[] = []
  let initialCompanies: any[] = []
  {
    let pq = supabaseService
      .from('partners')
      .select(PARTNER_COLS)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(2000)
    let cq = supabaseService
      .from('companies')
      .select(COMPANY_COLS)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(2000)

    // ⚠️ partners/companies.location_id holds the location UUID, NOT the slug —
    // the column NAME matches the child tables' slug column but the VALUE form
    // does not. Verified against prod 2026-07-22. Do not "harmonize" this to
    // scope.locationSlug; it would match nothing, silently, and empty the
    // Contacts tab. (This is why the child tables go through
    // childLocationFilter() rather than reading a column name off a list.)
    if (scopeLocationUuid) {
      pq = pq.eq('location_id', scopeLocationUuid)
      cq = cq.eq('location_id', scopeLocationUuid)
    }

    const [{ data: partnersRaw, error: partnersErr }, { data: companiesRaw, error: companiesErr }] =
      await Promise.all([pq, cq])

    if (partnersErr) console.error('[hub-page] partners fetch error:', partnersErr.message)
    else initialPartners = (partnersRaw || []).map(mapPartnerRow)

    if (companiesErr) console.error('[hub-page] companies fetch error:', companiesErr.message)
    else initialCompanies = (companiesRaw || []).map(mapCompanyRow)
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
      initialEngagements={initialEngagements}
      initialEngagementsClosedCount={initialEngagementsClosedCount}
      initialEngagementsClosedWonCount={initialEngagementsClosedWonCount}
      initialPartners={initialPartners}
      initialCompanies={initialCompanies}
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
        isPrimaryOwner,
      }}
    />
  )
}
