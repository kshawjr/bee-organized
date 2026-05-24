// app/api/locations/[id]/owner-status/route.ts
//
// Owner-seat status for a location, used by the Super Admin
// LocationDetailSheet to decide whether to render "Invite Owner",
// "Invitation pending" with resend/revoke controls, or the claimed
// owner's profile card.
//
// Source-of-truth ordering:
//   1. Is there an active owner-tier subscription_seat with user_id NOT NULL?
//      → owner claimed. Resolve to hub_users for name/email/joined date.
//   2. Otherwise, is there an unaccepted pending_invites row at tier='owner'
//      for this location? → invitation pending. Return invite metadata
//      (no token — that's secret) plus expiry.
//   3. Otherwise → owner seat is unclaimed and no invite is outstanding.
//
// Auth: super_admin/admin OR owner of this location (RLS backstops both
// reads).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function GET(
  _request: NextRequest,
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

  const { data: ownerSeat, error: seatErr } = await supabaseService
    .from('subscription_seats')
    .select('id, location_id, tier, user_id, status, added_at')
    .eq('location_id', locationId)
    .eq('tier', 'owner')
    .eq('status', 'active')
    .order('added_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (seatErr) {
    console.error('[owner-status seat fetch]', seatErr)
    return NextResponse.json({ error: seatErr.message }, { status: 500 })
  }

  let owner_user: any = null
  if (ownerSeat?.user_id) {
    const { data: hu } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email, created_at, invite_accepted_at')
      .eq('id', ownerSeat.user_id)
      .maybeSingle()
    if (hu) {
      owner_user = {
        id: hu.id,
        full_name: hu.full_name,
        email: hu.email,
        joined_at: hu.invite_accepted_at || hu.created_at,
      }
    }
  }

  // Pending owner-tier invite (if any). Only relevant when the seat is
  // unclaimed — a claimed seat with an outstanding invite would be a bug
  // we'd want to surface, but in practice the invite would just 410 on
  // accept and the row is harmless.
  let pending_invite: any = null
  if (!owner_user) {
    const { data: inv } = await supabaseService
      .from('pending_invites')
      .select('id, email, full_name, tier, invite_expires_at, created_at')
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .is('accepted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (inv) {
      pending_invite = inv
    }
  }

  // Also report total non-owner pending invites so the panel can show
  // "+ N team invites pending" at a glance.
  const { count: otherPendingCount } = await supabaseService
    .from('pending_invites')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .neq('tier', 'owner')
    .is('accepted_at', null)

  return NextResponse.json({
    location_id: locationId,
    seat: ownerSeat
      ? { id: ownerSeat.id, tier: ownerSeat.tier, user_id: ownerSeat.user_id }
      : null,
    owner_user,
    pending_invite,
    other_pending_count: otherPendingCount || 0,
  })
}
