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
import { TAG_CATEGORIES } from '@/lib/tags'

export const runtime = 'nodejs'

const LIMIT = 20
const PARTNER_LIMIT = 10
// Tag hits have their OWN, larger cap (2026-10-16, Kevin): "Realtor" is 30
// Network people, and four of them defeats the point. Past this, the panel's
// "All N tagged …" line opens the full list with the tag already ticked —
// tagMatches carries those N.
const TAG_LIMIT = 25
const TAG_SCAN = 1000
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

// ── tag matches (2026-10-15) ─────────────────────────────────────────────────
// Typing "realtor" must find people TAGGED Realtor, not only names containing
// the word. Active tags from THE one list (lib/tags.ts) whose name contains the
// term — corporate, plus the caller's own location's (an elevated caller: any
// location's, as with every other hit). The people behind them are then read
// through the SAME fence as the name search. Each such hit says which tag it
// matched on, so a result named "Karen Pell" for "realtor" is not a mystery.
// Name matches always come first; a tag hit never pushes one out.
type TagHit = { id: string; label: string; icon: string | null }
async function matchingTags(term: string, scopeUuid: string | null): Promise<TagHit[]> {
  let tq = supabaseService
    .from('lookups')
    .select('id, label, icon')
    .in('category', TAG_CATEGORIES)
    .eq('is_active', true)
    .ilike('label', `%${term}%`)
    .limit(20)
  tq = scopeUuid ? tq.or(`location_id.is.null,location_id.eq.${scopeUuid}`) : tq
  const { data, error } = await tq
  if (error) {
    console.error('[search] tag lookup failed:', error.message)
    return []
  }
  return (data || []).map((t: any) => ({ id: t.id, label: t.label, icon: t.icon || null }))
}
// First matched tag per record id, from a junction's rows.
function firstTagBy(rows: any[], idCol: string, tags: TagHit[]): Map<string, TagHit> {
  const byId = new Map(tags.map((t) => [t.id, t]))
  const out = new Map<string, TagHit>()
  for (const r of rows || []) {
    const t = byId.get(r.tag_lookup_id)
    if (t && !out.has(r[idCol])) out.set(r[idCol], t)
  }
  return out
}

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

  const { data: nameRows, error } = await q
  if (error) {
    console.error('[search] lead search failed:', error.message)
    return NextResponse.json({ error: 'search_failed', detail: error.message }, { status: 500 })
  }

  // Tag hits — clients tagged with a matching tag, fenced exactly like the
  // name search, after the name matches, up to TAG_LIMIT (their own cap).
  // Every fenced client behind a matching tag is counted per tag, so the
  // panel can say "All N tagged Realtor". Non-fatal: a failure here leaves
  // the name results standing.
  const tagHits = await matchingTags(term, scopeUuid)
  const tagByLead = new Map<string, TagHit>()
  const clientCountByTag = new Map<string, number>()
  const networkCountByTag = new Map<string, number>()
  const data: any[] = [...(nameRows || [])]
  if (tagHits.length > 0) {
    const { data: links, error: linkErr } = await supabaseService
      .from('lead_tags').select('lead_id, tag_lookup_id')
      .in('tag_lookup_id', tagHits.map((t) => t.id)).limit(TAG_SCAN)
    if (linkErr) console.error('[search] lead tag links failed:', linkErr.message)
    const linkedIds = Array.from(new Set((links || []).map((l: any) => l.lead_id)))
    if (linkedIds.length > 0) {
      let tq = supabaseService
        .from('leads')
        .select('id, name, email, phone, location_uuid, location_id, is_junk')
        .not('is_junk', 'is', true)
        .in('id', linkedIds.slice(0, TAG_SCAN))
        .order('created_at', { ascending: false })
        .limit(TAG_SCAN)
      if (scopeUuid) tq = tq.eq('location_uuid', scopeUuid)
      const { data: fenced, error: fencedErr } = await tq
      if (fencedErr) console.error('[search] tagged lead read failed:', fencedErr.message)
      const inScope = new Set((fenced || []).map((r: any) => r.id))
      for (const l of links || []) {
        if (inScope.has(l.lead_id)) clientCountByTag.set(l.tag_lookup_id, (clientCountByTag.get(l.tag_lookup_id) || 0) + 1)
      }
      const first = firstTagBy((links || []).filter((l: any) => inScope.has(l.lead_id)), 'lead_id', tagHits)
      const have = new Set(data.map((r: any) => r.id))
      for (const r of (fenced || []).filter((r: any) => !have.has(r.id)).slice(0, TAG_LIMIT)) {
        tagByLead.set(r.id, first.get(r.id)!)
        data.push(r)
      }
    }
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

    // Tag hits — Network people tagged with a matching tag, same fence,
    // after the name matches, up to TAG_LIMIT; every fenced one counted per
    // tag for the "All N tagged …" line.
    if (!partnerErr && tagHits.length > 0) {
      const { data: links, error: linkErr } = await supabaseService
        .from('partner_tags').select('partner_id, tag_lookup_id')
        .in('tag_lookup_id', tagHits.map((t) => t.id)).limit(TAG_SCAN)
      if (linkErr) console.error('[search] partner tag links failed:', linkErr.message)
      const linkedIds = Array.from(new Set((links || []).map((l: any) => l.partner_id)))
      if (linkedIds.length > 0) {
        // Ids only first — the count needs every fenced one, the panel only
        // needs TAG_LIMIT full rows.
        let fq = supabaseService
          .from('partners')
          .select('id')
          .is('deleted_at', null)
          .in('id', linkedIds.slice(0, TAG_SCAN))
          .limit(TAG_SCAN)
        if (scopeUuid) fq = fq.eq('location_id', scopeUuid)
        const { data: fenced, error: fencedErr } = await fq
        if (fencedErr) console.error('[search] tagged partner fence failed:', fencedErr.message)
        const inScope = new Set((fenced || []).map((r: any) => r.id))
        for (const l of links || []) {
          if (inScope.has(l.partner_id)) networkCountByTag.set(l.tag_lookup_id, (networkCountByTag.get(l.tag_lookup_id) || 0) + 1)
        }
        const first = firstTagBy((links || []).filter((l: any) => inScope.has(l.partner_id)), 'partner_id', tagHits)
        const have = new Set(partnerHits.map((p: any) => p.id))
        const wanted = Array.from(inScope).filter((id) => !have.has(id))
        if (wanted.length > 0) {
          const { data: tagged, error: taggedErr } = await supabaseService
            .from('partners')
            .select(PARTNER_COLS)
            .in('id', wanted)
            .order('name', { ascending: true })
            .limit(TAG_LIMIT)
          if (taggedErr) console.error('[search] tagged partner read failed:', taggedErr.message)
          partnerHits = [...partnerHits, ...(tagged || []).map((r: any) => ({ ...mapPartnerRow(r), matchedTag: first.get(r.id) }))]
        }
      }
    }
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
    truncated: (nameRows || []).length >= LIMIT,
    // One entry per matching tag that anyone in scope carries: how many
    // clients and Network people, for the panel's "All N tagged …" lines.
    tagMatches: tagHits
      .map((t) => ({ ...t, clients: clientCountByTag.get(t.id) || 0, network: networkCountByTag.get(t.id) || 0 }))
      .filter((t) => t.clients > 0 || t.network > 0),
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
      // Present only when this client was found BY A TAG, not by name.
      ...(tagByLead.has(r.id) ? { matchedTag: tagByLead.get(r.id) } : {}),
    })),
  })
}
