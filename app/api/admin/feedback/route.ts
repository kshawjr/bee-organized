// app/api/admin/feedback/route.ts
//
// GET /api/admin/feedback — feedback triage list.
//   - super_admin / admin: org-wide, crosses location boundaries.
//   - owner / manager: scoped to their own location_id ONLY (they manage
//     feedback for their franchise; manager is a paid operational role).
//   - everyone else: 403.
//
// Embeds the submitter (name + email) and the location name so the table
// renders without N+1 lookups.
//
// Optional filters via query string: ?status=, ?type=, ?location_id=, ?user_id=
// For owner/manager the location filter is FORCED to their own location — a
// ?location_id= pointing elsewhere is ignored, never honored.
//
// Reads go through supabaseService (service role); location scoping is enforced
// in app code here (we add the location_id filter for non-elevated callers).
//
// ─── INTERNAL ITEMS ARE NEVER RETURNED TO AN OWNER (issue 247 step 1) ──
// feedback_items is now the single tracker: owner reports AND internally-found
// bugs. An internal item may be TAGGED with a location — that tag is how an
// overlap becomes visible ("Kevin logged this, then Ankur reported it") — so
// the old location-only predicate is no longer sufficient. owner/manager reads
// also filter is_internal=false. Elevated callers (super_admin/admin) are
// unchanged and still see everything, internal included.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { withInternalFallback } from '@/lib/feedback-internal'

export const runtime = 'nodejs'

// Org-wide (cross-location) access. owner/manager are handled separately with
// a forced location_id scope.
const ELEVATED_ROLES = ['super_admin', 'admin']
const LOCATION_SCOPED_ROLES = ['owner', 'manager']

// READ-SIDE ONLY — "what may be FILTERED on". Corp-only. Widened to four for
// issue 247 step 2 so ?type=decision returns decisions.
//
// THIS IS NOT THE SAME CONSTANT as the identically-named VALID_TYPES in
// app/api/feedback/route.ts, which is "what an OWNER may FILE" and stays
// ('bug','feature') — that narrowness IS the enforcement that an owner can
// never file a decision or a hazard. The two answer different questions and
// will diverge further. They are deliberately not shared, and neither points at
// lib/feedback-types: importing would create exactly the coupling that lets a
// later tidy-up widen the owner path by accident.
const VALID_TYPES = new Set(['bug', 'feature', 'decision', 'hazard'])

// A THIRD meaning, kept separate for the same reason: what the internal
// composer below may file. All four are legal here precisely because every row
// POST writes is is_internal — the two internal-only types can exist only on
// such a row (feedback_items_internal_type_check).
const INTERNAL_FILEABLE_TYPES = new Set(['bug', 'feature', 'decision', 'hazard'])

const VALID_STATUSES = new Set([
  'submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined',
])

const MAX_TITLE = 100
const MAX_DESCRIPTION = 2000

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  const isElevatedCaller = !!caller && ELEVATED_ROLES.includes(caller.role)
  const isLocationScopedCaller =
    !!caller && LOCATION_SCOPED_ROLES.includes(caller.role) && !!caller.location_id
  if (!isElevatedCaller && !isLocationScopedCaller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const status = req.nextUrl.searchParams.get('status')
  const type = req.nextUrl.searchParams.get('type')
  const userId = req.nextUrl.searchParams.get('user_id')

  // ─── AN UNKNOWN FILTER VALUE IS REJECTED, NOT DROPPED (issue 247 step 2) ──
  // Both of these read `if (v && VALID.has(v))` before, so an unrecognised value
  // fell through to NO filter at all and the caller received the UNFILTERED
  // list. Asking for decisions returned everything — a wrong RESULT SET dressed
  // as a 200, and the worst of the ten read sites precisely because nothing in
  // the answer says it ignored you. An empty param still means "no filter",
  // which is what it has always meant.
  if (type && !VALID_TYPES.has(type)) {
    return NextResponse.json(
      { error: 'invalid_type', allowed: Array.from(VALID_TYPES) },
      { status: 400 },
    )
  }
  if (status && !VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { error: 'invalid_status', allowed: Array.from(VALID_STATUSES) },
      { status: 400 },
    )
  }

  // Built as a FUNCTION, not a chain, so the whole query can be re-run with the
  // is_internal predicate dropped when that column has not been migrated yet
  // (lib/feedback-internal). Everything except that one predicate is identical
  // between the two passes — that is what makes the retry safe to reason about.
  const buildQuery = (filterInternal: boolean) => {
    // Disambiguate the embeds by FK column — feedback_items has exactly one FK
    // into hub_users (user_id) and one into locations (location_id).
    let query = supabaseService
      .from('feedback_items')
      .select(`
        *,
        submitter:hub_users!user_id ( id, full_name, first_name, email ),
        location:locations!location_id ( id, name )
      `)
      .order('created_at', { ascending: false })

    // Validated above — an unknown value never reaches here, so a present value
    // always becomes a real predicate.
    if (status) query = query.eq('status', status)
    if (type) query = query.eq('type', type)

    // owner/manager are hard-scoped to their own location, ignoring any
    // ?location_id= override. Elevated callers may filter by an arbitrary
    // location_id (or omit it to see everything).
    if (isLocationScopedCaller) {
      query = query.eq('location_id', caller!.location_id)
      // THE OWNER GUARD (issue 247 step 1). location_id alone is no longer
      // enough: it means "submitted from here", and an INTERNAL item tagged
      // with this owner's location would otherwise match — which is precisely
      // the case the tag exists to create. Server-side, on the query, never a
      // client filter: the rows must not reach the browser at all.
      //
      // This is the ONLY owner-facing list read of feedback_items. The owner
      // screen's header count, its four tab counts and its subtitle are all
      // derived from this response (components/feedback/OwnerFeedbackScreen
      // `counts`), so filtering here fixes every number an owner can see —
      // there is no second place to keep in step.
      if (filterInternal) query = query.eq('is_internal', false)
    } else {
      const locationId = req.nextUrl.searchParams.get('location_id')
      if (locationId) query = query.eq('location_id', locationId)
    }

    if (userId) query = query.eq('user_id', userId)
    return query
  }

  const { data, error, internalSupported } = await withInternalFallback<any[]>(
    async (filterInternal) => await buildQuery(filterInternal),
  )
  if (error) {
    console.error('[admin feedback GET]', error)
    return NextResponse.json({ error: (error as { message?: string })?.message }, { status: 500 })
  }
  if (!internalSupported && isLocationScopedCaller) {
    // Pre-migration breadcrumb. Not a warning about a leak: with no column, no
    // row can be internal, so the unfiltered read and the filtered one return
    // the same rows.
    console.warn('[admin feedback GET] is_internal column missing — owner read unfiltered (migration pending)')
  }

  // ── record context: resolve the pointer to a NAME (issue 233) ──────
  // feedback_items.context stores IDS ONLY, on purpose (issue 110a) — the
  // migration's own note says "the reader resolves lead_id → the live record".
  // This is that reader. Triage renders the pointer as an "Open the record"
  // card with the client's name and stage, so one batched lookup here replaces
  // a row of naked uuids nobody could act on. Resolving live also means a
  // renamed client reads correctly, which a stored copy of the name would not.
  //
  // Failure is NON-FATAL: if the lookup errors (or the context column predates
  // its migration and every value is undefined), the items still return and the
  // card falls back to the stage + link it already has.
  const rows = data || []
  // Array.from, not a spread — the tsconfig target predates iterable spread of
  // a Set, and this is a .ts file so it is genuinely type-checked.
  const contextLeadIds = Array.from(
    new Set(
      rows
        .map((r: any) => r?.context?.lead_id)
        .filter((v: any): v is string => typeof v === 'string' && !!v),
    ),
  )
  const leadNameById = new Map<string, string>()
  if (contextLeadIds.length) {
    const { data: leads, error: leadErr } = await supabaseService
      .from('leads')
      .select('id, name')
      .in('id', contextLeadIds)
    if (leadErr) console.warn('[admin feedback GET] context lead lookup failed:', leadErr.message)
    for (const l of leads || []) if (l?.id && l?.name) leadNameById.set(l.id, l.name)
  }

  // Flatten the embeds into the shape the admin UI expects.
  const items = rows.map((r: any) => ({
    ...r,
    submitter_name:
      r.submitter?.full_name?.trim() ||
      r.submitter?.first_name?.trim() ||
      r.submitter?.email ||
      'Unknown',
    submitter_email: r.submitter?.email || null,
    location_name: r.location?.name || null,
    context_client_name: r?.context?.lead_id ? leadNameById.get(r.context.lead_id) || null : null,
  }))

  return NextResponse.json({ items })
}

// ─── POST /api/admin/feedback — file an INTERNAL item ─────────────────
//
// THE WRITER. Steps 1 and 2 part 1 built the column, the owner-side exclusion
// and the widened type domain, but nothing that could write an internal row —
// filing one meant hand-run SQL. This is that path.
//
// ELEVATED ONLY (super_admin / admin). owner and manager get 403 here even
// though they may read and PATCH their own location's items: an owner must
// never file an internal item, and the two internal-only types are offered
// nowhere they can reach.
//
// is_internal IS ALWAYS TRUE AND IS NEVER READ FROM THE BODY. Filing internal
// items is this endpoint's entire job, so the flag is a property of the route,
// not a parameter. A caller-controlled flag would be one typo away from writing
// an OWNER-VISIBLE row carrying a type the owner UI cannot render — the precise
// failure step 1 and feedback_items_internal_type_check exist to prevent. The
// owner filing path is POST /api/feedback and is untouched by this.
//
// THE LOCATION TAG is optional, and it is the point of one tracker: tagging
// "Palm Beach import is stuck" with Palm Beach is how the overlap with an
// owner's later report becomes visible. Step 1 is what makes it safe — internal
// rows are excluded from owner reads regardless of location — so here
// location_id carries SUBJECT meaning ("this is about Palm Beach") without ever
// meaning "Palm Beach submitted it".
export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()

  if (!caller || !ELEVATED_ROLES.includes(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: {
    type?: string
    title?: string
    description?: string
    location_id?: string | null
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const type = String(body.type || '').trim()
  if (!INTERNAL_FILEABLE_TYPES.has(type)) {
    return NextResponse.json(
      { error: 'invalid_type', allowed: Array.from(INTERNAL_FILEABLE_TYPES) },
      { status: 400 },
    )
  }

  const title = String(body.title || '').trim()
  if (title.length < 1 || title.length > MAX_TITLE) {
    return NextResponse.json({ error: 'title_must_be_1_100_chars' }, { status: 400 })
  }

  const description = String(body.description || '').trim()
  if (description.length < 1 || description.length > MAX_DESCRIPTION) {
    return NextResponse.json({ error: 'description_must_be_1_2000_chars' }, { status: 400 })
  }

  // Optional. Empty string and undefined both mean "no location" — an untagged
  // internal item is legal and common (a platform-wide bug belongs to nobody).
  const rawLocation = body.location_id
  const locationId = typeof rawLocation === 'string' && rawLocation.trim()
    ? rawLocation.trim()
    : null

  const { data: row, error } = await supabaseService
    .from('feedback_items')
    .insert({
      user_id: caller.id,
      location_id: locationId,
      type,
      title,
      description,
      status: 'submitted',
      is_internal: true,
    })
    .select('*')
    .single()

  if (error) {
    const code = (error as { code?: string }).code
    // A location_id that is not a real location. Reported as a 400 naming the
    // field rather than a 500 — it is the caller's input, not our fault.
    if (code === '23503') {
      return NextResponse.json({ error: 'unknown_location' }, { status: 400 })
    }
    // The type/is_internal coupling. Unreachable from here (is_internal is
    // hard-coded true above), so if it ever fires the constraint has caught
    // something this route believed impossible — surface it as such.
    if (code === '23514') {
      console.error('[admin feedback POST] constraint rejected an internal insert', error)
      return NextResponse.json({ error: 'constraint_violation' }, { status: 400 })
    }
    console.error('[admin feedback POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(row, { status: 201 })
}
