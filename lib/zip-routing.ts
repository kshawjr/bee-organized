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
//   one location, not lifecycle 'active' → loc_other  ('not_live')
//   the lookup itself errored            → loc_other  ('lookup_failed')
//   one active location                  → that location ('matched')
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
// NOT-LIVE LOCATIONS. A zip that matches an onboarding location goes to
// loc_other too, with that location named as the candidate. Reason: an
// onboarding location has its notifications muted (notifications_live) and no
// drip, and often no hub_users to assign — a lead routed there can arrive with
// nobody told. At loc_other a person sees it and can transfer it. This is the
// one switch Kevin has not ruled on: ROUTE_ONLY_TO_ACTIVE below.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'

export const ZIP_FALLBACK_SLUG = 'loc_other'

// Kevin has not decided (30 Sep 2026). true = a zip whose only location is not
// 'active' goes to loc_other with that location as the candidate. false = it
// routes to the onboarding location, the "path it's on today" for a local-form
// lead at that location.
export const ROUTE_ONLY_TO_ACTIVE = true

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
  if (ROUTE_ONLY_TO_ACTIVE && only.lifecycle_status !== 'active') {
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
