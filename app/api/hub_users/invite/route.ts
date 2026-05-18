// app/api/hub_users/invite/route.ts
//
// Create a pending team invite. Generates a one-time invite_token, stores
// the invitee's email + tier + role on a pending_invites row, and returns
// the shareable invite URL. The seat is NOT pre-claimed — that happens
// when the invitee accepts via /auth/invite/[token] and the accept route
// PATCHes one available subscription_seats row to user_id = auth.uid().
//
// Auth: super_admin/admin OR the owner of the target location.
// RLS backstops via pending_invites policies (see invite_tokens.sql).

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const VALID_TIERS = ['owner', 'manager', 'light', 'readonly'] as const
type Tier = (typeof VALID_TIERS)[number]

const INVITE_TTL_DAYS = 7

// hub_users.role enum lookup — invited team members are 'lite_user' regardless
// of seat tier (manager / light / readonly). Owner-tier seats only get created
// during onboarding co-owner flow (out of scope here).
function roleForTier(tier: Tier): string {
  if (tier === 'owner') return 'owner'
  return 'lite_user'
}

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

function isValidEmail(s: string): boolean {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
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
  const { email, full_name, location_id, tier } = body || {}

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }
  if (typeof location_id !== 'string' || !location_id) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `invalid tier — must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    )
  }

  const isOwnerOfLocation =
    caller.role === 'owner' && caller.location_id === location_id
  if (!isElevated(caller.role) && !isOwnerOfLocation) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const normalizedEmail = String(email).trim().toLowerCase()

  // Refuse if the email is already a hub_user at this location — they'd
  // double-claim a seat on accept. (We tolerate the same email at a
  // different location; that's a separate identity story.)
  const { data: existing } = await supabaseService
    .from('hub_users')
    .select('id, location_id, email')
    .eq('email', normalizedEmail)
    .eq('location_id', location_id)
    .limit(1)
  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: 'A team member with this email already exists at this location.' },
      { status: 409 }
    )
  }

  // Available seats at the requested tier (subtract pending invites at the
  // same tier — we don't pre-claim seats, but counts must reflect outstanding
  // reservations so two invites can't be issued against one slot).
  const { data: seatsAtTier, error: seatsErr } = await supabaseService
    .from('subscription_seats')
    .select('id, user_id, status')
    .eq('location_id', location_id)
    .eq('tier', tier)
    .eq('status', 'active')
  if (seatsErr) {
    console.error('[invite seats fetch]', seatsErr)
    return NextResponse.json({ error: seatsErr.message }, { status: 500 })
  }
  const availableSeats = (seatsAtTier || []).filter((s: any) => !s.user_id).length

  const { count: pendingCount, error: pendingErr } = await supabaseService
    .from('pending_invites')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', location_id)
    .eq('tier', tier)
    .is('accepted_at', null)
  if (pendingErr) {
    console.error('[invite pending count]', pendingErr)
    return NextResponse.json({ error: pendingErr.message }, { status: 500 })
  }

  if (availableSeats - (pendingCount || 0) < 1) {
    return NextResponse.json(
      {
        error:
          'No available seats at this tier. Add more seats before inviting.',
        code: 'no_available_seats',
      },
      { status: 409 }
    )
  }

  const inviteToken = crypto.randomBytes(24).toString('hex')
  const expiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const { data: invite, error: insertErr } = await supabaseService
    .from('pending_invites')
    .insert({
      location_id,
      email: normalizedEmail,
      full_name: typeof full_name === 'string' && full_name.trim() ? full_name.trim() : null,
      role: roleForTier(tier as Tier),
      tier,
      invite_token: inviteToken,
      invite_expires_at: expiresAt,
      invited_by: caller.id,
    })
    .select('id, email, full_name, role, tier, location_id, invite_token, invite_expires_at, created_at')
    .single()

  if (insertErr) {
    console.error('[invite insert]', insertErr)
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  // Build the absolute invite URL from the request origin so prod / preview
  // / local each get the right host. NEXT_PUBLIC_SITE_URL is the override
  // for fronted-by-proxy deploys where request origin doesn't match.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    request.nextUrl.origin
  const invite_url = `${origin}/auth/invite/${inviteToken}`

  return NextResponse.json({ invite, invite_url }, { status: 201 })
}
