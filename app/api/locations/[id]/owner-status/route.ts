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

  // Phase 2: a location may have up to TWO owner seats (primary + co-owner).
  // Fetch all active owner seats, ordered earliest-first, and resolve each
  // claimed one to its hub_users row.
  const { data: ownerSeats, error: seatErr } = await supabaseService
    .from('subscription_seats')
    .select('id, location_id, tier, user_id, status, is_primary, added_at')
    .eq('location_id', locationId)
    .eq('tier', 'owner')
    .eq('status', 'active')
    .order('added_at', { ascending: true })
  if (seatErr) {
    console.error('[owner-status seat fetch]', seatErr)
    return NextResponse.json({ error: seatErr.message }, { status: 500 })
  }

  const claimedSeats = (ownerSeats || []).filter((s: any) => s.user_id)
  const userIds = claimedSeats.map((s: any) => s.user_id)

  const usersById: Record<string, any> = {}
  if (userIds.length > 0) {
    const { data: hus } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email, created_at, invite_accepted_at')
      .in('id', userIds)
    ;(hus || []).forEach((hu: any) => {
      usersById[hu.id] = hu
    })
  }

  // One entry per CLAIMED owner seat, carrying the is_primary marker.
  const owners = claimedSeats
    .map((seat: any) => {
      const hu = usersById[seat.user_id]
      if (!hu) return null
      return {
        id: hu.id,
        full_name: hu.full_name,
        email: hu.email,
        is_primary: !!seat.is_primary,
        seat_id: seat.id,
        joined_at: hu.invite_accepted_at || hu.created_at,
        claimed_at: seat.added_at,
      }
    })
    .filter(Boolean) as any[]

  const primary_owner = owners.find((o) => o.is_primary) || null

  // Backward-compat: single-owner card consumers read `owner_user`. Resolve
  // it to the primary owner, falling back to the earliest claimed owner.
  const owner_user = primary_owner || owners[0] || null

  // Backward-compat single seat shape: the primary's seat, else the earliest.
  const primarySeatRow =
    (ownerSeats || []).find((s: any) => s.is_primary && s.user_id) ||
    claimedSeats[0] ||
    (ownerSeats || [])[0] ||
    null

  // Outstanding owner-tier invite, if any. Still relevant alongside a claimed
  // owner (e.g. one owner claimed, a co-owner invite pending).
  let pending_invite: any = null
  {
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
    // New multi-owner shape
    owners,
    primary_owner,
    count: owners.length,
    // Backward-compat fields (single-owner consumers)
    seat: primarySeatRow
      ? { id: primarySeatRow.id, tier: primarySeatRow.tier, user_id: primarySeatRow.user_id }
      : null,
    owner_user,
    pending_invite,
    other_pending_count: otherPendingCount || 0,
  })
}
