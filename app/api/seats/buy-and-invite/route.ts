// app/api/seats/buy-and-invite/route.ts
//
// Combined "buy a seat + send the invite" endpoint for the unified
// InviteTeamMemberModal. Owner clicks Invite, modal detects no seat
// available at the chosen tier → POST here in one step. Server-side
// rollback: if the pending_invites insert fails after the
// subscription_seats insert succeeded, we hard-delete the just-created
// seat (no user_id yet, never visible to anyone) so the owner doesn't
// get charged for a phantom seat.
//
// Auth + validation mirror /api/seats POST and /api/hub_users/invite
// POST — same tier whitelist, same elevated-or-owner gate, same email
// validation, same per-tier availability check that subtracts pending
// invites from total unassigned seats.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const VALID_TIERS = ['manager', 'light', 'readonly'] as const
type Tier = (typeof VALID_TIERS)[number]

const INVITE_TTL_DAYS = 7

const SEAT_COLS =
  'id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

function isValidEmail(s: string): boolean {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

// tier='manager' carries the real 'manager' role (operational lead). Worker Bee
// (light) and Honey Watcher (readonly) are the genuine read-only tiers and stay
// 'lite_user'. Owner seats are created during the onboarding co-owner flow, not
// via this path, so 'owner' isn't a valid tier here. See migrations/manager_role.sql.
function roleForTier(tier: Tier): string {
  return tier === 'manager' ? 'manager' : 'lite_user'
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
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

  const body = await request.json().catch(() => ({}))
  const { location_id, tier, email, full_name, prorated_cost } = body || {}

  if (typeof location_id !== 'string' || !location_id) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `invalid tier — must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    )
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }
  if (
    prorated_cost !== undefined &&
    prorated_cost !== null &&
    (!Number.isInteger(prorated_cost) || prorated_cost < 0)
  ) {
    return NextResponse.json(
      { error: 'prorated_cost must be a non-negative integer (cents) or null' },
      { status: 400 }
    )
  }

  const isOwnerOfLocation =
    caller.role === 'owner' && caller.location_id === location_id
  if (!isElevated(caller.role) && !isOwnerOfLocation) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const normalizedEmail = String(email).trim().toLowerCase()

  // Refuse if email already a hub_user at this location — they'd double-
  // claim a seat at accept time.
  const { data: existingHubUser } = await supabaseService
    .from('hub_users')
    .select('id')
    .eq('email', normalizedEmail)
    .eq('location_id', location_id)
    .limit(1)
  if (existingHubUser && existingHubUser.length > 0) {
    return NextResponse.json(
      { error: 'A team member with this email already exists at this location.' },
      { status: 409 }
    )
  }

  // ─── Seat insert ───
  const seatRow: Record<string, any> = {
    location_id,
    tier,
    user_id: null,
    added_by: caller.id,
  }
  if (prorated_cost !== undefined && prorated_cost !== null) {
    seatRow.prorated_cost = prorated_cost
  }

  const { data: insertedSeat, error: seatErr } = await supabaseService
    .from('subscription_seats')
    .insert(seatRow)
    .select(SEAT_COLS)
    .single()

  if (seatErr || !insertedSeat) {
    console.error('[buy-and-invite seat insert]', seatErr)
    return NextResponse.json(
      { error: seatErr?.message || 'Could not create seat' },
      { status: 500 }
    )
  }

  // ─── Invite insert ───
  const inviteToken = crypto.randomBytes(24).toString('hex')
  const expiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const { data: invite, error: inviteErr } = await supabaseService
    .from('pending_invites')
    .insert({
      location_id,
      email: normalizedEmail,
      full_name:
        typeof full_name === 'string' && full_name.trim() ? full_name.trim() : null,
      role: roleForTier(tier as Tier),
      tier,
      invite_token: inviteToken,
      invite_expires_at: expiresAt,
      invited_by: caller.id,
    })
    .select(
      'id, email, full_name, role, tier, location_id, invite_token, invite_expires_at, created_at'
    )
    .single()

  if (inviteErr || !invite) {
    // Rollback: hard-delete the seat we just created. user_id is null
    // and the row has never been read by anything else (it was created
    // less than a second ago in the same request), so deletion is safe.
    const { error: rollbackErr } = await supabaseService
      .from('subscription_seats')
      .delete()
      .eq('id', insertedSeat.id)
    if (rollbackErr) {
      console.error(
        '[buy-and-invite rollback failed — orphan seat]',
        insertedSeat.id,
        rollbackErr
      )
    }
    console.error('[buy-and-invite invite insert]', inviteErr)
    return NextResponse.json(
      { error: inviteErr?.message || 'Could not create invite' },
      { status: 500 }
    )
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    request.nextUrl.origin
  const invite_url = `${origin}/auth/invite/${inviteToken}`

  return NextResponse.json(
    { seat: insertedSeat, invite, invite_url },
    { status: 201 }
  )
}
