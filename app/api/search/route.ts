// app/api/search/route.ts
//
// GET /api/search?q=<term> — the real ⌘K search.
//
// GlobalSearch was an in-memory substring scan over the loaded people array.
// That was fine when the page loaded every lead in the tenant; since Fix 2
// Phase 1 an elevated user holds ONE location, so the search silently returned
// one location's results — the same silent-narrowing failure class as MAX_LEADS
// dropping leads with no error. Phase 2 labelled the scope as a holding action;
// this is the real fix.
//
// SCOPE:
//   elevated      — every location. Each hit carries its location name so the
//                   result is actionable rather than ambiguous ("which Sarah?").
//   non-elevated  — hard-fenced to hubUser.location_id, exactly as every other
//                   read is. A franchise user cannot search another location by
//                   any spelling of the query.
//
// The `q` value is user input reaching a PostgREST `or(...)` filter, where `,`
// and `)` are structural. It is sanitized to a conservative character set
// before it can reach the query — see sanitizeTerm.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { PARTNER_COLS, mapPartnerRow } from '@/lib/crm'

export const runtime = 'nodejs'

const LIMIT = 20
const PARTNER_LIMIT = 10
const MIN_TERM = 2

// PostgREST's `or=(a.ilike.*x*,b.ilike.*y*)` grammar makes `,` `(` `)` `.` and
// `*` structural. A term containing them could restructure the filter rather
// than be matched by it, so they are stripped rather than escaped — this is a
// name/phone/email search box, and no legitimate query needs them. `%` and `_`
// are stripped too: they are LIKE wildcards, and letting a user pass `%` would
// turn any search into a full-table scan.
function sanitizeTerm(raw: string): string {
  return raw.replace(/[,()*%_\\.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

// Digits-only variant, so "5615550199", "561-555-0199" and "(561) 555-0199" all
// find the same lead. leads.phone_normalized is the DB-side match key (a
// GENERATED column — never written directly).
const digitsOf = (s: string) => s.replace(/\D/g, '')

export async function GET(req: Request) {
  const url = new URL(req.url)
  const raw = (url.searchParams.get('q') || '').trim()
  const term = sanitizeTerm(raw)
  if (term.length < MIN_TERM) {
    return NextResponse.json({ results: [], term, tooShort: true })
  }

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users').select('id, role, location_id').eq('id', user.id).single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  const elevated = isAdmin(hubUser.role)
  // The fence: non-elevated is pinned to their own location, and a franchise
  // user with no location gets nothing rather than everything.
  const scopeUuid = elevated ? null : (hubUser.location_id || null)
  if (!elevated && !scopeUuid) {
    return NextResponse.json({ results: [], term })
  }

  const like = `*${term}*`
  const digits = digitsOf(term)
  const ors = [
    `name.ilike.${like}`,
    `email.ilike.${like}`,
    `phone.ilike.${like}`,
  ]
  // Only add the normalized-phone clause for a term that actually looks like a
  // phone fragment; otherwise a 2-character alphabetic query would also scan it
  // for nothing.
  if (digits.length >= 3) ors.push(`phone_normalized.ilike.*${digits}*`)

  let q = supabaseService
    .from('leads')
    .select('id, name, email, phone, location_uuid, location_id, is_junk')
    .not('is_junk', 'is', true)
    .or(ors.join(','))
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  if (scopeUuid) q = q.eq('location_uuid', scopeUuid)

  const { data, error } = await q
  if (error) {
    console.error('[search] lead search failed:', error.message)
    return NextResponse.json({ error: 'search_failed', detail: error.message }, { status: 500 })
  }

  // Partners (the Network tab's rows) ride the same fence: every location for
  // an elevated caller, hard-scoped for everyone else. Added when Phase 4b
  // stopped loading partners on 'all' — GlobalSearch's partner scan reads the
  // LOADED array, so without a server search 'all' would have silently lost
  // partner lookup, the exact narrowing class this endpoint exists to end.
  // Client-shaped rows (mapPartnerRow) because a selected hit is handed
  // straight to the Network record overlay. Non-fatal on error: partner hits
  // degrade to the local scan, lead search still answers.
  let partnerHits: any[] = []
  {
    // partners.location_id holds the location UUID (same vocabulary as
    // scopeUuid — verified against prod 2026-07-22).
    let pq = supabaseService
      .from('partners')
      .select(PARTNER_COLS)
      .is('deleted_at', null)
      .or([`name.ilike.${like}`, `company.ilike.${like}`, `title.ilike.${like}`].join(','))
      .order('name', { ascending: true })
      .limit(PARTNER_LIMIT)
    if (scopeUuid) pq = pq.eq('location_id', scopeUuid)
    const { data: partnerRows, error: partnerErr } = await pq
    if (partnerErr) console.error('[search] partner search failed:', partnerErr.message)
    else partnerHits = (partnerRows || []).map(mapPartnerRow)
  }

  // Resolve location NAMES for the hits — the point of a cross-location search
  // is knowing WHERE a result lives. One bounded lookup over the distinct
  // locations actually present in the results.
  const locIds = Array.from(new Set((data || []).map((r: any) => r.location_uuid).filter(Boolean)))
  const nameByLoc: Record<string, string> = {}
  if (locIds.length > 0) {
    const { data: locs } = await supabaseService
      .from('locations').select('id, name').in('id', locIds)
    for (const l of locs || []) nameByLoc[l.id] = l.name
  }

  return NextResponse.json({
    term,
    scope: elevated ? 'all' : scopeUuid,
    // `truncated` is stated rather than implied: a capped result set that looks
    // complete is the same silent-narrowing problem in a smaller box.
    truncated: (data || []).length >= LIMIT,
    // Client-shaped partner hits (see above). Absent from older cached
    // responses/mocks — GlobalSearch falls back to its local scan then.
    partners: partnerHits,
    results: (data || []).map((r: any) => ({
      id: r.id,
      name: r.name || 'Unnamed',
      email: r.email || null,
      phone: r.phone || null,
      locationId: r.location_uuid || null,
      locationName: r.location_uuid ? (nameByLoc[r.location_uuid] || null) : null,
      atLocOther: r.location_id === 'loc_other',
    })),
  })
}
