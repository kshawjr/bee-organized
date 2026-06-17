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

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

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

  const status = req.nextUrl.searchParams.get('status')
  if (status && VALID_STATUSES.has(status)) query = query.eq('status', status)

  const type = req.nextUrl.searchParams.get('type')
  if (type && VALID_TYPES.has(type)) query = query.eq('type', type)

  // owner/manager are hard-scoped to their own location, ignoring any
  // ?location_id= override. Elevated callers may filter by an arbitrary
  // location_id (or omit it to see everything).
  if (isLocationScopedCaller) {
    query = query.eq('location_id', caller!.location_id)
  } else {
    const locationId = req.nextUrl.searchParams.get('location_id')
    if (locationId) query = query.eq('location_id', locationId)
  }

  const userId = req.nextUrl.searchParams.get('user_id')
  if (userId) query = query.eq('user_id', userId)

  const { data, error } = await query
  if (error) {
    console.error('[admin feedback GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flatten the embeds into the shape the admin UI expects.
  const items = (data || []).map((r: any) => ({
    ...r,
    submitter_name:
      r.submitter?.full_name?.trim() ||
      r.submitter?.first_name?.trim() ||
      r.submitter?.email ||
      'Unknown',
    submitter_email: r.submitter?.email || null,
    location_name: r.location?.name || null,
  }))

  return NextResponse.json({ items })
}
