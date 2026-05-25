// app/api/hub_users/[id]/jobber-link/route.ts
//
// Manual override for hub_users.jobber_user_id. Used by Settings → Team
// when the email-based auto-match misses (e.g., the owner's Bee Hub email
// differs from her Jobber email). The owner picks a Jobber roster entry
// from a dropdown sourced from locations.jobber_team_roster, and we patch
// the hub_users row.
//
// Authorization mirrors the DELETE handler in /api/hub_users/[id]/route.ts:
// super_admin / admin can patch any row; owner can patch any row at their
// own location. The body is a single field — jobber_user_id (string or
// null to unlink).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const targetId = params.id
  if (!targetId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const body = await request.json().catch(() => ({}))
  const raw = body?.jobber_user_id
  // Accept string (new value) or null (unlink). Anything else is a 400.
  if (raw !== null && (typeof raw !== 'string' || raw.trim() === '')) {
    return NextResponse.json(
      { error: 'jobber_user_id must be a non-empty string or null' },
      { status: 400 }
    )
  }
  const jobberUserId: string | null = raw === null ? null : String(raw).trim()

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!caller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: target, error: targetErr } = await supabaseService
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', targetId)
    .single()
  if (targetErr || !target) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 })
  }

  const isOwnerOfTargetLoc =
    caller.role === 'owner' && caller.location_id === target.location_id
  if (!isElevated(caller.role) && !isOwnerOfTargetLoc) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Sanity check: if a jobber_user_id is being set, confirm it exists in
  // the location's cached roster. Prevents an owner from typing a wrong
  // ID into the dropdown (or a stale-cache desync from the manual path).
  if (jobberUserId && target.location_id) {
    const { data: loc } = await supabaseService
      .from('locations')
      .select('jobber_team_roster')
      .eq('id', target.location_id)
      .maybeSingle()
    const roster = (loc?.jobber_team_roster as Array<{ id: string }> | null) || []
    if (roster.length > 0 && !roster.some((r) => r?.id === jobberUserId)) {
      return NextResponse.json(
        {
          error: 'That Jobber user is not in this location\'s cached roster. Refresh the roster and try again.',
          code: 'not_in_roster',
        },
        { status: 400 }
      )
    }
  }

  const { error: patchErr } = await supabaseService
    .from('hub_users')
    .update({ jobber_user_id: jobberUserId })
    .eq('id', targetId)
  if (patchErr) {
    console.error('[hub_users jobber-link PATCH]', patchErr)
    return NextResponse.json({ error: patchErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, jobber_user_id: jobberUserId })
}
