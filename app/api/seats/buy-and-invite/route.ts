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
import { sendEmailDirect } from '@/lib/resend'
import {
  buildInviteEmail,
  INVITE_FROM_EMAIL,
  INVITE_FROM_NAME,
  INVITE_REPLY_TO_EMAIL,
} from '@/lib/invite-email'
import { applySeatDeltaToStripe } from '@/lib/seat-stripe-sync'
import {
  quoteSeatPurchase,
  seatCostDivergence,
  seatCostResponse,
  unpricedSeatNote,
} from '@/lib/seat-cost'

export const runtime = 'nodejs'

// issue 217 note on the co-owner rule: 'owner' is absent from this whitelist,
// so this route CANNOT receive an owner tier — a tier='owner' body is a 400
// before any pricing runs. The cost quote still goes through lib/seat-plan's
// planBillingLines rather than a flat tier lookup, because a whitelist is a
// gate that can be widened and the co-owner rule must not have to be
// remembered on the day it is.
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
  if (tier === 'light') {
    return NextResponse.json(
      { error: 'tier_unavailable', message: 'Worker Bee tier is currently unavailable. Use Honey Watcher for read-only access.' },
      { status: 503 }
    )
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }
  // issue 217 — this shape check is all that remains of the client's
  // prorated_cost. The value is NOT written; it is kept in the contract only so
  // today's clients don't start failing, and so a value that disagrees with the
  // server's can be recorded as divergence. Drop the field from the body once
  // the divergence notes stop appearing.
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

  // NOTE (milestone 1, Kevin's call): no Stripe gate here — the free
  // grant stays open so buy-and-invite keeps working everywhere. When a
  // Payment Link exists the client shows the Stripe path instead of
  // calling this; the server-side closure (402 payment_required, which
  // the client already handles) comes as a separate step once the paid
  // path is proven.

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
  // issue 217 — the server computes the figure. `prorated_cost` from the body
  // is never written: it was shape-checked but never value-checked, so the
  // browser's arithmetic was the permanent record of what this seat cost. The
  // quote resolves the renewal anchor from this location's real
  // paid_through_date and prices the increment through lib/seat-plan.
  const quote = await quoteSeatPurchase({ locationId: location_id, tier, quantity: 1 })

  const seatRow: Record<string, any> = {
    location_id,
    tier,
    user_id: null,
    added_by: caller.id,
  }
  const serverCents = quote.perSeatCents?.[0]
  if (typeof serverCents === 'number') seatRow.prorated_cost = serverCents

  const noteParts: string[] = []
  if (quote.unpricedReason) noteParts.push(unpricedSeatNote(quote.unpricedReason))

  const divergence = seatCostDivergence(prorated_cost, quote.perSeatCents)
  if (divergence.diverged) {
    console.error(
      `[buy-and-invite] ${divergence.note} loc=${location_id} tier=${tier}`,
    )
    noteParts.push(divergence.note)
  }
  if (noteParts.length > 0) seatRow.notes = noteParts.join(' · ')

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

  // ─── Stripe seat line (issue 161) ───
  // Add a line to the location's existing subscription for this tier. This
  // is the "add the Stripe step" motion: buy-and-invite already captured
  // WHO the seat is for (name/email/role) above. CONDITIONAL — a no-op when
  // the location has no live subscription, so the free-grant invite path
  // keeps working. NEVER rolls back the seat/invite: a Stripe failure is
  // logged and reported, not fatal (the seat is real; billing reconciles).
  const billing = await applySeatDeltaToStripe({
    locationId: location_id,
    tier,
    delta: 1,
    seatId: insertedSeat.id,
  })

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    request.nextUrl.origin
  const invite_url = `${origin}/auth/invite/${inviteToken}`

  // Send the invite email — same system sender and template as
  // /api/hub_users/invite, so the invitee's experience doesn't depend on
  // which path the owner's click took. Failure doesn't roll back the seat
  // or invite (both are real and the owner can share the link manually);
  // email_sent / email_error surface the outcome so the client can adjust
  // messaging instead of implying delivery.
  let email_sent = false
  let email_error: string | undefined
  try {
    const [{ data: location }, { data: inviter }] = await Promise.all([
      supabaseService
        .from('locations')
        .select('name')
        .eq('id', location_id)
        .single(),
      supabaseService
        .from('hub_users')
        .select('full_name, first_name, email')
        .eq('id', caller.id)
        .single(),
    ])

    const locationName = location?.name ?? null
    const inviterName =
      inviter?.full_name?.trim() ||
      inviter?.first_name?.trim() ||
      inviter?.email ||
      'Your team'
    const inviteeName =
      typeof full_name === 'string' && full_name.trim()
        ? full_name.trim().split(/\s+/)[0]
        : null

    const { html, text } = buildInviteEmail({
      inviteUrl: invite_url,
      locationName,
      inviterName,
      expiresAt,
      inviteeName,
    })

    const result = await sendEmailDirect({
      from: INVITE_FROM_EMAIL,
      fromName: INVITE_FROM_NAME,
      replyTo: INVITE_REPLY_TO_EMAIL,
      to: normalizedEmail,
      subject: locationName
        ? `You've been invited to join ${locationName} on Bee Hub`
        : `You've been invited to join Bee Hub`,
      html,
      text,
    })

    if (result.success) {
      email_sent = true
    } else {
      email_error = result.error
      console.error('[buy-and-invite email send]', email_error)
    }
  } catch (err) {
    email_error = err instanceof Error ? err.message : String(err)
    console.error('[buy-and-invite email send] unexpected error', err)
  }

  return NextResponse.json(
    {
      seat: insertedSeat,
      invite,
      invite_url,
      email_sent,
      // issue 217 — what the SERVER decided this seat cost, so a caller can
      // see the authoritative figure (and any reason there isn't one) rather
      // than assuming the number it sent was accepted.
      cost: seatCostResponse(quote),
      ...(email_error ? { email_error } : {}),
      billing: { stripe_applied: billing.applied, ...(billing.reason ? { stripe_skip_reason: billing.reason } : {}) },
    },
    { status: 201 }
  )
}
