// app/api/admin/feedback/[id]/route.ts
//
// PATCH /api/admin/feedback/[id] — triage update. Body: { status?, admin_response? }.
//   - super_admin / admin: can patch any feedback item.
//   - owner / manager: can patch ONLY items belonging to their own location.
//   - everyone else: 403.
//
// When admin_response is provided (non-empty), admin_response_at is stamped to
// now(). updated_at is maintained by the feedback_items_updated_at trigger.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const ELEVATED_ROLES = ['super_admin', 'admin']
const LOCATION_SCOPED_ROLES = ['owner', 'manager']
const VALID_STATUSES = new Set([
  'submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined',
])

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  // owner/manager may only touch feedback for their own location. Load the
  // item's location_id first and 403 if it isn't theirs (404-safe: a missing
  // row also fails the ownership check below).
  if (isLocationScopedCaller) {
    const { data: target } = await supabaseService
      .from('feedback_items')
      .select('id, location_id')
      .eq('id', id)
      .single()
    if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (target.location_id !== caller!.location_id) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  let body: { status?: string; admin_response?: string | null }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, any> = {}

  if (body.status !== undefined) {
    if (!VALID_STATUSES.has(String(body.status))) {
      return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
    }
    patch.status = body.status
  }

  if (body.admin_response !== undefined) {
    const resp = body.admin_response === null ? null : String(body.admin_response).trim()
    if (resp) {
      patch.admin_response = resp
      patch.admin_response_at = new Date().toISOString()
    } else {
      // Empty/null clears the response.
      patch.admin_response = null
      patch.admin_response_at = null
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_fields_to_update' }, { status: 400 })
  }

  const { data: row, error } = await supabaseService
    .from('feedback_items')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    console.error('[admin feedback PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json(row)
}
