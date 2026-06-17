// app/api/admin/feedback/route.ts
//
// GET /api/admin/feedback — org-wide feedback triage list. Fail-closed to
// super_admin / admin (the "corporate" tier). Embeds the submitter (name +
// email) and the location name so the admin table renders without N+1 lookups.
//
// Optional filters via query string: ?status=, ?type=, ?location_id=, ?user_id=
//
// Reads go through supabaseService (service role) — this is an org-wide view
// that intentionally crosses location boundaries, so RLS scoping doesn't apply.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const ALLOWED_ROLES = ['super_admin', 'admin']
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
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !ALLOWED_ROLES.includes(caller.role)) {
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

  const locationId = req.nextUrl.searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)

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
