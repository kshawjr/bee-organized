// lib/jobber-team-roster.ts
//
// Jobber team roster — fetch from Jobber, cache on locations.jobber_team_roster,
// and auto-match hub_users.jobber_user_id by email. Used by:
//   - app/api/jobber/callback/route.ts   (on Jobber Connect success)
//   - app/api/hub_users/accept/route.ts  (on invite accept)
//   - app/api/locations/[id]/jobber/refresh-roster/route.ts (manual refresh)
//
// Roster cache shape (jsonb on locations.jobber_team_roster):
//   [{ id: 'gid://...', name: 'Jane Doe', email: 'jane@co.com' }, ...]
//
// Matching is case-insensitive on email. Owners can manually link a
// hub_users row to a roster entry from Settings → Team when auto-match
// misses (e.g., personal-vs-work email mismatch).
//
// Jobber's user query returns global IDs (base64-encoded GraphQL IDs).
// Stored as-is in jobber_user_id (text) — Send-to-Jobber expects the
// global ID form.

import { supabaseService } from './supabase-service'
import { jobberGraphQL, jobberQuery } from './jobber'

export type RosterEntry = {
  id: string
  name: string
  email: string
}

// Jobber's `users` field returns the team for the OAuth'd account. We
// flatten the GraphQL reply into a plain { id, name, email } shape so
// the cache is easy to read from Settings → Team. first: 200 is well
// above any realistic franchise team size; if a single Jobber account
// ever exceeds that we'll need pagination.
const TEAM_ROSTER_QUERY = `
  query JobberTeam {
    users(first: 200) {
      nodes {
        id
        name { full }
        email { raw }
      }
    }
  }
`

function flattenNodes(nodes: any[]): RosterEntry[] {
  return (nodes || [])
    .map((n) => {
      const id    = typeof n?.id === 'string' ? n.id : null
      const name  = n?.name?.full ?? null
      const email = n?.email?.raw ?? null
      if (!id || !email) return null
      return { id, name: name || email, email: String(email).trim() }
    })
    .filter((x): x is RosterEntry => x !== null)
}

// Low-level: fetch roster with a known-valid access token. Used by the
// OAuth callback, where we already hold a fresh token from the exchange
// and don't want to take another DB roundtrip to re-read it.
export async function fetchRosterWithToken(accessToken: string): Promise<RosterEntry[] | null> {
  try {
    const res = await jobberQuery(accessToken, TEAM_ROSTER_QUERY)
    if (res?.errors?.length) {
      console.error('[jobber-roster] GraphQL errors:', JSON.stringify(res.errors).slice(0, 500))
      return null
    }
    return flattenNodes(res?.data?.users?.nodes || [])
  } catch (err: any) {
    console.error('[jobber-roster] fetch failed:', err?.message || err)
    return null
  }
}

// High-level: refresh via locations.jobber_access_token (auto-refreshes
// expired tokens via lib/jobber's refresh path). Used by the manual
// "Refresh roster" button and the invite-accept lookup when the cache
// is missing or stale.
export async function fetchRosterByLocationSlug(locationSlug: string): Promise<RosterEntry[] | null> {
  try {
    const res = await jobberGraphQL(locationSlug, TEAM_ROSTER_QUERY)
    if (res.errors?.length) {
      console.error('[jobber-roster] GraphQL errors for', locationSlug, JSON.stringify(res.errors).slice(0, 500))
      return null
    }
    return flattenNodes(res.data?.users?.nodes || [])
  } catch (err: any) {
    console.error('[jobber-roster] fetch failed for', locationSlug, '—', err?.message || err)
    return null
  }
}

// Persist the roster cache on locations + run the auto-match for every
// hub_users row at this location that doesn't have a jobber_user_id yet.
// Returns the number of hub_users rows newly linked (0 on no-op).
//
// locationUuid is locations.id (the row PK). Callers usually have this
// from a prior query — the callback has supaLoc.id, accept has
// invite.location_id, refresh-roster has the route param.
export async function persistRosterAndMatch(
  locationUuid: string,
  roster: RosterEntry[],
): Promise<{ matched: number; rosterSize: number }> {
  const now = new Date().toISOString()

  // 1. Cache roster on the location row.
  const { error: cacheErr } = await supabaseService
    .from('locations')
    .update({
      jobber_team_roster:           roster,
      jobber_team_roster_synced_at: now,
      updated_at:                   now,
    })
    .eq('id', locationUuid)
  if (cacheErr) {
    console.error('[jobber-roster] cache write failed:', cacheErr)
    // Surface, but continue — auto-match below doesn't depend on the cache.
  }

  // 2. Fetch hub_users for this location that need linking.
  const { data: unlinkedUsers, error: usersErr } = await supabaseService
    .from('hub_users')
    .select('id, email, jobber_user_id')
    .eq('location_id', locationUuid)
    .is('jobber_user_id', null)
  if (usersErr || !unlinkedUsers) {
    console.error('[jobber-roster] hub_users fetch failed:', usersErr)
    return { matched: 0, rosterSize: roster.length }
  }

  // 3. Build an email → jobber_user_id index, then patch matches.
  const byEmail = new Map<string, string>()
  for (const r of roster) {
    if (r.email) byEmail.set(r.email.toLowerCase().trim(), r.id)
  }

  let matched = 0
  for (const u of unlinkedUsers) {
    if (!u.email) continue
    const jobberId = byEmail.get(String(u.email).toLowerCase().trim())
    if (!jobberId) continue

    const { error: patchErr } = await supabaseService
      .from('hub_users')
      .update({ jobber_user_id: jobberId })
      .eq('id', u.id)
    if (patchErr) {
      console.error('[jobber-roster] hub_users patch failed for', u.id, patchErr)
      continue
    }
    matched += 1
  }

  return { matched, rosterSize: roster.length }
}

// Single-user lookup: invite-accept calls this after creating the
// hub_users row. Reads the cached roster off the location to avoid an
// extra Jobber API call on every accept. Returns the linked jobber_user_id
// (already written to hub_users) or null if no match / no cache.
export async function matchHubUserFromCachedRoster(
  hubUserId: string,
  locationUuid: string,
  email: string,
): Promise<string | null> {
  if (!email) return null
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('jobber_team_roster')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr || !loc?.jobber_team_roster) return null

  const roster = loc.jobber_team_roster as RosterEntry[]
  const wanted = email.toLowerCase().trim()
  const match  = roster.find(
    (r) => r?.email && String(r.email).toLowerCase().trim() === wanted,
  )
  if (!match) return null

  const { error: patchErr } = await supabaseService
    .from('hub_users')
    .update({ jobber_user_id: match.id })
    .eq('id', hubUserId)
  if (patchErr) {
    console.error('[jobber-roster] accept-hook patch failed for', hubUserId, patchErr)
    return null
  }
  return match.id
}

// Reconnect detection: when the OAuth callback writes a new
// jobber_account_id that differs from the prior value, every cached
// jobber_user_id on hub_users for that location is stale (they belong
// to the previous Jobber account's namespace). NULL them so the auto-
// match below can repopulate from the fresh roster.
//
// Returns the number of rows nulled.
export async function clearStaleJobberUserIds(locationUuid: string): Promise<number> {
  const { data, error } = await supabaseService
    .from('hub_users')
    .update({ jobber_user_id: null })
    .eq('location_id', locationUuid)
    .not('jobber_user_id', 'is', null)
    .select('id')
  if (error) {
    console.error('[jobber-roster] clearStale failed:', error)
    return 0
  }
  return data?.length || 0
}
