// lib/zip-routing.ts
// ─────────────────────────────────────────────────────────────
// Which location a lead belongs to. THE ZIP WINS (30 Sep 2026).
//
// Leslie's ruling: the territory list (location_zips) is the franchise
// agreements, and corporate reassigns anything outside them. So when a lead
// has a zip, the zip decides and the location the website sent is IGNORED —
// the form keeps sending one; Bee Hub no longer routes by it.
//
// NO ZIP AT ALL is the one case the sent location still decides
// (zipDecides below). Bee Hub's list cannot say anything about a lead with no
// zip, and at loc_other Leslie would have nothing to route it by either — the
// location the form was filled in on is the only evidence there is. No zip and
// no sent location → loc_other ('missing'), as before.
//
// Both are recorded on the intake log row (routeLogToken): the location the
// zip chose, the one the website sent, and sent_overridden=true when they
// disagree, so every overruled lead can be found later.
//
// THE RULE (decideZipRoute is pure; routeByZip adds the one DB read):
//   missing zip                          → loc_other  (reason 'missing')
//   not five digits / ZIP+4              → loc_other  ('malformed')
//   no row in location_zips              → loc_other  ('unmatched')
//   two or more locations claim it       → loc_other  ('conflict')
//   the lookup itself errored            → loc_other  ('lookup_failed')
//   one location, paused / any other     → loc_other  ('not_live')
//   one location, active OR onboarding   → that location ('matched')
//
// EVERY non-match lands at loc_other, never a guess. Picking "the nearest" or
// "the first row" would send a lead to the wrong franchise silently — the
// failure a wrong route costs far more than Leslie routing it by hand.
//
// A CONFLICT IS NOT RESOLVED HERE. Kevin's ruling (30 Sep 2026): the 11 Denver
// zips claimed twice are unknown until corporate settles them in Admin → Zip
// codes. The candidates ride along on the decision so the sync_log row names
// them.
//
// ONBOARDING LOCATIONS ROUTE DIRECTLY (Kevin, 20 Oct 2026). A zip whose only
// claimant is 'onboarding' goes to that location. Until then it went to
// loc_other ('not_live'), and Leslie moved every one by hand, 1 to 49 hours
// later.
//
// The old comment here said onboarding locations have their notifications
// muted. That was wrong, and it is what kept this switch on. Muting is
// locations.notifications_live, NOT lifecycle_status (lib/notifications-live),
// and every onboarding location had it on. Checked 19 Oct 2026: intake emailed
// all of them from late July to 30 Sep. The email they get is the non-Bee-Hub
// one (lib/lead-notification-email): every customer field, no Bee Hub button,
// nothing that needs a login, and replies go to the customer.
//
// What an onboarding location still does NOT get: the drip (intake enrols
// only 'active'), Slack (none of them have connected it), and usually an
// assignee (most have no hub_users). So the lead email is the only way the
// owner hears about it. If that email fails or bounces, lib/failure-alerts
// tells Kevin ('location_untold').
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'

export const ZIP_FALLBACK_SLUG = 'loc_other'

// false (Kevin, 20 Oct 2026): a zip whose only location is onboarding routes
// there. true would send it to loc_other ('not_live') with that location as
// the candidate. See ONBOARDING LOCATIONS in the header.
export const ROUTE_ONLY_TO_ACTIVE = false

// Which lifecycle states a zip may route a lead to. 'active' always;
// 'onboarding' only while ROUTE_ONLY_TO_ACTIVE is false. Anything else
// ('paused', null, a state added later) still goes to loc_other as 'not_live':
// the 20 Oct ruling was about onboarding, and a paused location is read-only
// (lib/read-only-access), so a lead routed there could not be worked.
export function locationTakesZipLeads(lifecycleStatus: string | null): boolean {
  if (lifecycleStatus === 'active') return true
  return !ROUTE_ONLY_TO_ACTIVE && lifecycleStatus === 'onboarding'
}

export type ZipRouteReason =
  | 'matched'
  | 'missing'
  | 'malformed'
  | 'unmatched'
  | 'conflict'
  | 'not_live'
  | 'lookup_failed'

export type ZipRouteDecision = {
  slug: string
  reason: ZipRouteReason
  // The normalized five-digit zip, or null when missing/malformed.
  zip: string | null
  // Slugs of the location(s) that claim the zip — for conflict and not_live,
  // the ones a person should look at. Empty otherwise except 'matched'.
  candidates: string[]
}

export type ZipLocationRow = {
  location_id: string // the slug
  lifecycle_status: string | null
}

// Five digits, or ZIP+4 (12345-6789 / 123456789) reduced to its five. A number
// is accepted as its digits ONLY when it already has five — a four-digit value
// is not quietly re-padded here, because on a live payload "2801" is as likely
// a typo as a lost zero, and a wrong guess is a wrong franchise.
export function normalizeZip(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(s)
  return m ? m[1] : null
}

export function isBlankZip(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')
}

export function decideZipRoute(
  rawZip: unknown,
  rows: ZipLocationRow[],
): ZipRouteDecision {
  if (isBlankZip(rawZip)) {
    return { slug: ZIP_FALLBACK_SLUG, reason: 'missing', zip: null, candidates: [] }
  }
  const zip = normalizeZip(rawZip)
  if (!zip) {
    return { slug: ZIP_FALLBACK_SLUG, reason: 'malformed', zip: null, candidates: [] }
  }
  // loc_other is never a target, even if a row somehow points there.
  const slugs = Array.from(
    new Set(rows.map((r) => r.location_id).filter((s) => s && s !== ZIP_FALLBACK_SLUG)),
  ).sort()
  if (slugs.length === 0) {
    return { slug: ZIP_FALLBACK_SLUG, reason: 'unmatched', zip, candidates: [] }
  }
  if (slugs.length > 1) {
    return { slug: ZIP_FALLBACK_SLUG, reason: 'conflict', zip, candidates: slugs }
  }
  const only = rows.find((r) => r.location_id === slugs[0])!
  if (!locationTakesZipLeads(only.lifecycle_status)) {
    return { slug: ZIP_FALLBACK_SLUG, reason: 'not_live', zip, candidates: slugs }
  }
  return { slug: slugs[0], reason: 'matched', zip, candidates: slugs }
}

// The one read. A failed read never loses the lead: it routes to loc_other and
// says so ('lookup_failed'), the same fail-soft stance as the dedup gate.
export async function routeByZip(rawZip: unknown): Promise<ZipRouteDecision> {
  const pre = decideZipRoute(rawZip, [])
  if (pre.reason === 'missing' || pre.reason === 'malformed') return pre

  const { data, error } = await supabaseService
    .from('location_zips')
    .select('zip, location:locations!inner(location_id, lifecycle_status)')
    .eq('zip', pre.zip)

  if (error) {
    console.warn(`[zip-routing] location_zips lookup failed for ${pre.zip}: ${error.message}`)
    return { slug: ZIP_FALLBACK_SLUG, reason: 'lookup_failed', zip: pre.zip, candidates: [] }
  }
  const rows: ZipLocationRow[] = (Array.isArray(data) ? data : [])
    .map((r: any) => (Array.isArray(r.location) ? r.location[0] : r.location))
    .filter(Boolean)
    .map((l: any) => ({ location_id: l.location_id, lifecycle_status: l.lifecycle_status ?? null }))
  return decideZipRoute(rawZip, rows)
}

// Does the zip decide this lead? Yes whenever a zip was sent — blank counts as
// none, a malformed one still decides (→ loc_other). Only a lead with NO zip
// AND a sent location is left to the sent location. See the header.
export function zipDecides(rawZip: unknown, sentSlug: string | null): boolean {
  return !isBlankZip(rawZip) || !sentSlug
}

// The whole routing record for the intake log row. Zip-decided rows carry the
// zip's verdict, the location it chose, and the location the website sent;
// sent_overridden=true marks a disagreement. A no-zip row says the sent
// location decided.
export function routeLogToken(zipRoute: ZipRouteDecision | null, sentSlug: string | null): string {
  if (!zipRoute) return ` routed_by=sent_no_zip sent_loc=${sentSlug ?? 'none'}`
  return (
    zipRouteToken(zipRoute) +
    ` zip_loc=${zipRoute.slug} sent_loc=${sentSlug ?? 'none'}` +
    (sentSlug && sentSlug !== zipRoute.slug ? ' sent_overridden=true' : '')
  )
}

// The zip's own verdict: presence-signal style, like unknown_keys= / desc_key=.
export function zipRouteToken(d: ZipRouteDecision): string {
  return (
    ` routed_by=zip zip_route=${d.reason}` +
    (d.candidates.length && d.reason !== 'matched' ? ` zip_candidates=${d.candidates.join(',')}` : '')
  )
}
