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
const VALID_TYPES = new Set(['bug', 'feature'])
const VALID_STATUSES = new Set([
  'submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined',
])

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

    if (status && VALID_STATUSES.has(status)) query = query.eq('status', status)
    if (type && VALID_TYPES.has(type)) query = query.eq('type', type)

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
