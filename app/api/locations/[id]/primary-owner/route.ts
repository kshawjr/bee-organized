// app/api/locations/[id]/primary-owner/route.ts
//
// Designate which of a location's owners is the PRIMARY owner — the sending
// identity used for outbound emails/drips (see lib/owner-resolution.ts).
//
// Auth: super_admin / admin, OR any owner of this location (it doesn't have to
// be the current primary — co-owners are full equals and either can re-assign
// the designation).
//
// Body: { owner_user_id }
//
// The target must be an owner of this location: an active owner-tier
// subscription_seat whose user_id matches. We flip the designation in two
// writes (clear the existing primary, then set the new one) because the
// partial unique index `subscription_seats_primary_owner_per_location_idx`
// permits only one is_primary=true owner seat per location — setting the new
// one first would collide with the old. Supabase REST has no transaction, so
// if the second write fails we restore the prior primary (best effort) and
// surface a 500.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const locationId = params.id
  if (!locationId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!caller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const isOwnerOfLocation =
    caller.role === 'owner' && caller.location_id === locationId
  if (!isElevated(caller.role) && !isOwnerOfLocation) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const { owner_user_id } = body || {}
  if (typeof owner_user_id !== 'string' || !owner_user_id) {
    return NextResponse.json(
      { error: 'invalid_target_owner', message: 'owner_user_id required' },
      { status: 400 }
    )
  }

  // The target must hold an active owner seat at this location.
  const { data: targetSeat, error: targetErr } = await supabaseService
    .from('subscription_seats')
    .select('id, user_id, is_primary')
    .eq('location_id', locationId)
    .eq('tier', 'owner')
    .eq('status', 'active')
    .eq('user_id', owner_user_id)
    .maybeSingle()
  if (targetErr) {
    console.error('[primary-owner target fetch]', targetErr)
    return NextResponse.json({ error: targetErr.message }, { status: 500 })
  }
  if (!targetSeat) {
    return NextResponse.json(
      {
        error: 'owner_not_found_at_location',
        message: 'That user is not an owner of this location.',
      },
      { status: 404 }
    )
  }

  // Already primary — no-op success (lets the UI be idempotent).
  if (targetSeat.is_primary) {
    const { data: hu } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email')
      .eq('id', owner_user_id)
      .maybeSingle()
    return NextResponse.json({
      success: true,
      primary_owner: hu
        ? { id: hu.id, full_name: hu.full_name, email: hu.email, is_primary: true }
        : { id: owner_user_id, is_primary: true },
    })
  }

  // 1. Clear the current primary (if any) so the unique index won't reject
  //    the new one. Capture which seat we cleared for rollback.
  const { data: priorPrimary } = await supabaseService
    .from('subscription_seats')
    .select('id')
    .eq('location_id', locationId)
    .eq('tier', 'owner')
    .eq('is_primary', true)
    .maybeSingle()

  if (priorPrimary) {
    const { error: clearErr } = await supabaseService
      .from('subscription_seats')
      .update({ is_primary: false, updated_at: new Date().toISOString() })
      .eq('id', priorPrimary.id)
    if (clearErr) {
      console.error('[primary-owner clear prior]', clearErr)
      return NextResponse.json({ error: clearErr.message }, { status: 500 })
    }
  }

  // 2. Promote the target seat.
  const { error: promoteErr } = await supabaseService
    .from('subscription_seats')
    .update({ is_primary: true, updated_at: new Date().toISOString() })
    .eq('id', targetSeat.id)
  if (promoteErr) {
    console.error('[primary-owner promote target]', promoteErr)
    // Best-effort restore of the prior primary so the location isn't left
    // with no designated owner.
    if (priorPrimary) {
      await supabaseService
        .from('subscription_seats')
        .update({ is_primary: true, updated_at: new Date().toISOString() })
        .eq('id', priorPrimary.id)
    }
    return NextResponse.json({ error: promoteErr.message }, { status: 500 })
  }

  const { data: hu } = await supabaseService
    .from('hub_users')
    .select('id, full_name, email')
    .eq('id', owner_user_id)
    .maybeSingle()

  return NextResponse.json({
    success: true,
    primary_owner: hu
      ? { id: hu.id, full_name: hu.full_name, email: hu.email, is_primary: true }
      : { id: owner_user_id, is_primary: true },
  })
}
