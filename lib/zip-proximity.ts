// lib/zip-proximity.ts
// ─────────────────────────────────────────────────────────────
// Given a lead's zip: the N closest Bee Organized locations, in miles.
// Stage 2 of the Slack route-suggestion feature (20 Oct 2026). Nothing here
// decides what the card says — that is stage 3; this says only who is near.
//
// HOW CLOSE IS MEASURED. To each location's NEAREST CLAIMED ZIP, not to the
// middle of its territory (Kevin's rule): a lead just outside a big territory
// is close to it even when its centre is far. Every zip is a point — its
// Census internal point in zip_coords — and the distance is the straight-line
// (great-circle) distance between two points, in statute miles. Not driving
// distance. Checked against Kevin's four real cases on 20 Oct 2026: the same
// three locations in the same order every time; his pip-package miles differ
// by up to 8, and these Census figures were made the expected values.
//
// THE CASES IT REPORTS, never smooths over:
//   • missing / malformed zip           → no distances at all
//   • zip not in the Census file        → 'unknown_zip' (PO box / placeholder
//                                         zips have no area); who claims it is
//                                         still reported, that needs no map
//   • zip CLAIMED by one or more        → claimedBy lists them (two = a
//     locations                           conflict); each is also in `nearest`
//                                         at 0 miles via that zip
//   • lead's state ≠ the zip's state(s) → stateCheck 'mismatch' (a typo in one
//                                         or the other — the card should say so)
//   • a claimed zip the Census lacks    → can't be measured; skipped and counted
//                                         (unmeasuredClaims). The location's
//                                         other zips still place it.
// loc_other is never a location here.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { normalizeZip, isBlankZip, ZIP_FALLBACK_SLUG } from '@/lib/zip-routing'
import { normalizeStateCode } from '@/lib/us-states'

export const EARTH_RADIUS_MILES = 3958.7613

export type ZipPoint = { lat: number; lng: number; state: string | null; states: string[] }

export type ClaimedZip = {
  zip: string
  slug: string
  name: string
  lifecycle_status: string | null
}

export type ClaimingLocation = { slug: string; name: string; lifecycle_status: string | null }

export type NearbyLocation = ClaimingLocation & {
  miles: number
  // The claimed zip that was nearest — what "17 miles" was measured to.
  via_zip: string
}

export type StateCheck =
  | 'match'            // the lead's state is one the zip lies in
  | 'mismatch'         // it isn't
  | 'no_lead_state'    // the lead gave none
  | 'unreadable'       // the lead gave one we can't read with certainty
  | 'no_zip_state'     // the zip has no state on file

export type ProximityResult =
  | { status: 'missing'; zip: null }
  | { status: 'malformed'; zip: null }
  | { status: 'unknown_zip'; zip: string; claimedBy: ClaimingLocation[] }
  | {
      status: 'ok'
      zip: string
      origin: ZipPoint
      claimedBy: ClaimingLocation[]
      nearest: NearbyLocation[]
      stateCheck: StateCheck
      leadState: string | null   // the lead's state as a code, when readable
      unmeasuredClaims: number
    }

export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function checkLeadState(rawLeadState: unknown, origin: ZipPoint): { stateCheck: StateCheck; leadState: string | null } {
  const blank = rawLeadState == null || (typeof rawLeadState === 'string' && rawLeadState.trim() === '')
  if (blank) return { stateCheck: 'no_lead_state', leadState: null }
  const code = normalizeStateCode(rawLeadState)
  if (!code) return { stateCheck: 'unreadable', leadState: null }
  const zipStates = origin.states.length ? origin.states : origin.state ? [origin.state] : []
  if (zipStates.length === 0) return { stateCheck: 'no_zip_state', leadState: code }
  return { stateCheck: zipStates.includes(code) ? 'match' : 'mismatch', leadState: code }
}

const byName = (a: { name: string; slug: string }, b: { name: string; slug: string }) =>
  a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)

// The pure ranking. `coords` holds a point for every zip it knows (the lead's
// and the claimed ones); a zip absent from it is not in the Census file.
// Equal distances sort by location name, so the order is repeatable — a tie
// is NOT a pick; stage 3 decides what a near-tie means on the card.
export function rankNearestLocations(args: {
  zip: unknown
  leadState?: unknown
  coords: Map<string, ZipPoint>
  claims: ClaimedZip[]
  limit?: number
}): ProximityResult {
  const limit = args.limit ?? 3
  if (isBlankZip(args.zip)) return { status: 'missing', zip: null }
  const zip = normalizeZip(args.zip)
  if (!zip) return { status: 'malformed', zip: null }

  const claims = args.claims.filter((c) => c.slug && c.slug !== ZIP_FALLBACK_SLUG)
  const claimMap = new Map<string, ClaimingLocation>()
  for (const c of claims) {
    if (c.zip === zip && !claimMap.has(c.slug)) claimMap.set(c.slug, { slug: c.slug, name: c.name, lifecycle_status: c.lifecycle_status })
  }
  const claimedBy = Array.from(claimMap.values()).sort(byName)

  const origin = args.coords.get(zip)
  if (!origin) return { status: 'unknown_zip', zip, claimedBy }

  const best = new Map<string, NearbyLocation>()
  const unmeasured = new Set<string>()
  for (const c of claims) {
    const p = args.coords.get(c.zip)
    if (!p) { unmeasured.add(c.zip); continue }
    const miles = c.zip === zip ? 0 : haversineMiles(origin, p)
    const prev = best.get(c.slug)
    if (!prev || miles < prev.miles || (miles === prev.miles && c.zip < prev.via_zip)) {
      best.set(c.slug, { slug: c.slug, name: c.name, lifecycle_status: c.lifecycle_status, miles, via_zip: c.zip })
    }
  }
  const nearest = Array.from(best.values())
    .sort((a, b) => a.miles - b.miles || byName(a, b))
    .slice(0, Math.max(0, limit))

  return {
    status: 'ok',
    zip,
    origin,
    claimedBy,
    nearest,
    ...checkLeadState(args.leadState, origin),
    unmeasuredClaims: unmeasured.size,
  }
}

// ── the database read ─────────────────────────────────────────
// SUPABASE CAPS EVERY READ. A request returns at most max_rows rows (1,000 on
// this project) whatever .range() or .limit() asks for, with NO error — the
// way System Health asks for 2,000 leads and gets 1,000. The territory list is
// 1,535 rows, so a single read would silently drop a third of it and the
// suggestion would be wrong with nothing to show it.
//
// So neither read trusts itself to have got everything. Each asks the
// database for the true number of matching rows (count: 'exact', counted by
// Postgres, not subject to the cap) and THROWS if what came back is short.
// Paging stops on that count, never on "this page was short" — a cap set
// lower than PAGE would otherwise end the loop after the first page.
const PAGE = 1000
const COORD_CHUNK = 300 // a long .in() list goes in the URL; 300 zips is well under any limit

// Exported so a test can count what it reads back against what is claimed.
export async function readAllClaims(): Promise<ClaimedZip[]> {
  const out: ClaimedZip[] = []
  let total: number | null = null
  let read = 0
  while (total === null || read < total) {
    const { data, error, count } = await supabaseService
      .from('location_zips')
      .select('zip, location:locations!inner(location_id, name, lifecycle_status)', { count: 'exact' })
      .order('zip', { ascending: true })
      .order('id', { ascending: true })
      .range(read, read + PAGE - 1)
    if (error) throw new Error(`location_zips read failed: ${error.message}`)
    if (typeof count !== 'number') throw new Error('location_zips read failed: no row count came back, so a short read could not be detected')
    total = count
    const rows = (data as any[]) || []
    if (rows.length === 0 && read < total) {
      throw new Error(`location_zips read short: got ${read} of ${total} territory rows`)
    }
    read += rows.length
    for (const r of rows) {
      const l = Array.isArray(r.location) ? r.location[0] : r.location
      if (!l?.location_id) throw new Error(`location_zips read failed: zip ${r.zip} came back with no location`)
      out.push({ zip: r.zip, slug: l.location_id, name: l.name || l.location_id, lifecycle_status: l.lifecycle_status ?? null })
    }
  }
  if (out.length !== total) throw new Error(`location_zips read short: got ${out.length} of ${total} territory rows`)
  return out
}

async function readCoords(zips: string[]): Promise<Map<string, ZipPoint>> {
  const out = new Map<string, ZipPoint>()
  const unique = Array.from(new Set(zips))
  for (let i = 0; i < unique.length; i += COORD_CHUNK) {
    const chunk = unique.slice(i, i + COORD_CHUNK)
    const { data, error, count } = await supabaseService
      .from('zip_coords')
      .select('zip, lat, lng, state, states', { count: 'exact' })
      .in('zip', chunk)
    if (error) throw new Error(`zip_coords read failed: ${error.message}`)
    const rows = (data as any[]) || []
    // A zip with no row is fine — the Census lacks it (PO boxes). Fewer rows
    // than the database says match is NOT: that is a cut-off read, and it
    // would pass a real zip off as one the Census doesn't carry.
    if (typeof count !== 'number') throw new Error('zip_coords read failed: no row count came back, so a short read could not be detected')
    if (rows.length < count) throw new Error(`zip_coords read short: got ${rows.length} of ${count} rows for ${chunk.length} zips`)
    for (const r of rows) {
      out.set(r.zip, { lat: Number(r.lat), lng: Number(r.lng), state: r.state ?? null, states: Array.isArray(r.states) ? r.states : [] })
    }
  }
  return out
}

// The closest `limit` locations to a lead's zip, read live. Throws when a read
// fails — a caller suggesting a location must not suggest one from half a map.
export async function nearestLocationsForZip(rawZip: unknown, leadState?: unknown, limit = 3): Promise<ProximityResult> {
  if (isBlankZip(rawZip)) return { status: 'missing', zip: null }
  const zip = normalizeZip(rawZip)
  if (!zip) return { status: 'malformed', zip: null }
  const claims = await readAllClaims()
  const coords = await readCoords([zip, ...claims.map((c) => c.zip)])
  return rankNearestLocations({ zip, leadState, coords, claims, limit })
}
