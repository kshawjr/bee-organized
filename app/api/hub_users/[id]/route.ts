// app/api/hub_users/[id]/route.ts
//
// Remove a hub_user from a location. Used by the Settings → Team "Remove
// from Location" affordance. Owners can remove any member at their
// location except themselves; super_admin / admin can remove anyone.
//
// Seat freeing is the client's responsibility (it PATCHes user_id=null
// on the assigned seat before calling this). We don't fan out to seats
// here because the seat row may be owned by a different membership
// (admin moved a user between locations, etc.) and we want explicit
// caller control over which slot returns to the pool.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function DELETE(
  _request: NextRequest,
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
  if (targetId === user.id) {
    return NextResponse.json(
      { error: 'You cannot remove yourself.' },
      { status: 400 }
    )
  }

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
    .select('id, role, location_id, email')
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
  // Owners cannot remove the location owner (themselves OR another owner)
  // through this endpoint. Owner transitions require corporate touch.
  if (target.role === 'owner' && !isElevated(caller.role)) {
    return NextResponse.json(
      { error: 'Removing the location owner requires corporate.' },
      { status: 403 }
    )
  }

  const { error: delErr } = await supabaseService
    .from('hub_users')
    .delete()
    .eq('id', targetId)
  if (delErr) {
    console.error('[hub_users DELETE]', delErr)
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
