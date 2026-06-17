// app/api/drip-path-steps/[stepId]/route.ts
//
// PATCH /api/drip-path-steps/:stepId
//   Update a step's subject, body, and/or delay_days. Role-based:
//     - super_admin: any step (master or location-copy)
//     - owner:       only steps belonging to a path in their own location
//     - lite_user:   forbidden
//
// Body: { subject?: string | null, body?: string | null, delay_days?: number }
// Returns the updated step row.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { stepId: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  // Drip step edits are owner/elevated config — block lite_user (read-only)
  // and manager (operational lead; no drip/template config).
  if (hubUser.role === 'lite_user' || hubUser.role === 'manager') {
    return NextResponse.json({ error: 'forbidden_read_only' }, { status: 403 })
  }

  // Load step + the path it belongs to, so we can authorize.
  const { data: step, error: stepErr } = await supabaseService
    .from('drip_path_steps')
    .select('id, drip_path_id, drip_paths!inner(id, is_master, location_uuid)')
    .eq('id', params.stepId)
    .maybeSingle()

  if (stepErr) {
    console.error('[/api/drip-path-steps PATCH] lookup error', stepErr.message)
    return NextResponse.json({ error: 'lookup_failed' }, { status: 500 })
  }
  if (!step) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const dp = Array.isArray((step as any).drip_paths)
    ? (step as any).drip_paths[0]
    : (step as any).drip_paths
  if (!dp) return NextResponse.json({ error: 'orphan_step' }, { status: 500 })

  // Authorization
  if (dp.is_master) {
    if (!isAdmin(hubUser.role)) {
      return NextResponse.json({ error: 'forbidden_master_step' }, { status: 403 })
    }
  } else {
    // Location-owned step
    if (!isAdmin(hubUser.role) && hubUser.location_id !== dp.location_uuid) {
      return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
    }
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('subject' in body) {
    patch.subject = typeof body.subject === 'string' ? body.subject : null
  }
  if ('body' in body) {
    patch.body = typeof body.body === 'string' ? body.body : null
  }
  if ('delay_days' in body) {
    const n = Number(body.delay_days)
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: 'invalid_delay_days' }, { status: 400 })
    }
    patch.delay_days = Math.round(n)
  }

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: 'no_fields' }, { status: 400 })
  }

  const { data, error } = await supabaseService
    .from('drip_path_steps')
    .update(patch)
    .eq('id', params.stepId)
    .select('id, drip_path_id, step_order, delay_days, channel, subject, body, is_active, updated_at')
    .single()

  if (error) {
    console.error('[/api/drip-path-steps PATCH] update error', error.message)
    return NextResponse.json({ error: 'update_failed', detail: error.message }, { status: 500 })
  }

  return NextResponse.json({ step: data })
}
