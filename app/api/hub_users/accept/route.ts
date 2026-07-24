// app/api/hub_users/accept/route.ts
//
// Consume a pending_invites token: create the hub_users row keyed by
// auth.uid(), PATCH one available subscription_seats row to claim the
// seat (franchise tiers only), and mark the invite accepted. Called by
// /auth/invite/[token] after the invitee signs in with Google.
//
// Email matching: the Google-authenticated email MUST equal the invite's
// email (case-insensitive). We refuse the accept otherwise to prevent
// link-forwarding from granting a seat to a different account.
//
// Atomicity / drift policy: the three writes (hub_users insert, seat
// claim, invite mark) are NOT wrapped in a single transaction — Supabase
// REST doesn't expose one. Instead the order is deliberate and each step
// is retry-safe:
//   1. hub_users insert — idempotent via the existingHubUser short-circuit.
//   2. subscription_seats claim — picks ANY unclaimed seat at the tier;
//      if step 3 fails on retry we just re-claim the same row to the same
//      user_id (no-op).
//   3. pending_invites.accepted_at — set last. If a transient failure
//      occurs after step 2 succeeds, we leave accepted_at null and log
//      the error so the invitee can retry the link (steps 1 & 2 are
//      no-ops on retry, step 3 succeeds, drift resolves).
// Corporate (tier='admin') invites skip step 2 entirely — admins have no
// location and don't claim a seat.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { matchHubUserFromCachedRoster } from '@/lib/jobber-team-roster'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { invite_token } = body || {}
  if (typeof invite_token !== 'string' || !invite_token) {
    return NextResponse.json({ error: 'invite_token required' }, { status: 400 })
  }

  // Service-role read: the invitee is authenticated but may not be in
  // hub_users yet, so RLS policies that key on hub_users.id = auth.uid()
  // would return nothing.
  const { data: invite, error: inviteErr } = await supabaseService
    .from('pending_invites')
    .select('id, email, full_name, role, tier, location_id, invite_token, invite_expires_at, accepted_at, invited_by')
    .eq('invite_token', invite_token)
    .single()
  if (inviteErr || !invite) {
    return NextResponse.json({ error: 'invite not found' }, { status: 404 })
  }
  if (invite.accepted_at) {
    return NextResponse.json({ error: 'invite already accepted' }, { status: 410 })
  }
  if (new Date(invite.invite_expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'invite expired' }, { status: 410 })
  }

  const authEmail = (user.email || '').toLowerCase().trim()
  if (!authEmail || authEmail !== String(invite.email).toLowerCase().trim()) {
    return NextResponse.json(
      {
        error: `This invitation was for ${invite.email}. Please sign in with that account.`,
        code: 'email_mismatch',
      },
      { status: 403 }
    )
  }

  // Idempotency: if a hub_users row already exists for this auth user, reuse
  // it (means they already accepted and bounced back to the link). Otherwise
  // upsert so a race between two browser tabs doesn't produce duplicates.
  const { data: existingHubUser } = await supabaseService
    .from('hub_users')
    .select('id, location_id, role')
    .eq('id', user.id)
    .single()

  // Hard-block 2nd-location accept: if this auth user already has a hub_users
  // row at a DIFFERENT location, reject before either the insert or seat claim
  // runs. Without this, the insert short-circuits (user stays at Location A)
  // but the seat claim still fires → orphaned seat at Location B the user can't
  // access. When Phase 4 multi-location support ships, this becomes the entry
  // point for the junction-table path.
  //
  // Exemptions (don't block):
  //   - invite.tier === 'admin': corporate invite, location-less by design.
  //   - existingHubUser.location_id === null: existing user is corporate (no
  //     location assigned); location mismatch check doesn't apply.
  //   - existingHubUser.location_id === invite.location_id: same-location
  //     re-invite (e.g. after seat reassignment, or 2nd owner-tier invite at
  //     same location) — normal idempotent accept, continue.
  if (
    existingHubUser &&
    invite.tier !== 'admin' &&
    existingHubUser.location_id !== null &&
    existingHubUser.location_id !== invite.location_id
  ) {
    return NextResponse.json(
      {
        error: 'user_already_at_different_location',
        message:
          'This email is already registered at another location. ' +
          'Multi-location accounts are not yet supported. Contact ' +
          'support if you need to move locations.',
        existing_location_id: existingHubUser.location_id,
        invited_location_id: invite.location_id,
      },
      { status: 409 }
    )
  }

  if (!existingHubUser) {
    const { error: hubInsertErr } = await supabaseService
      .from('hub_users')
      .insert({
        id: user.id,
        email: authEmail,
        full_name: invite.full_name || user.user_metadata?.full_name || authEmail,
        role: invite.role,
        location_id: invite.location_id,
        invited_by: invite.invited_by || null,
        invite_accepted_at: new Date().toISOString(),
      })
    if (hubInsertErr) {
      console.error('[accept hub_users insert]', hubInsertErr)
      return NextResponse.json({ error: hubInsertErr.message }, { status: 500 })
    }

    // Auto-link jobber_user_id from the location's cached roster, if any.
    // Franchise tier only — corporate invites have no location and no
    // Jobber identity. Non-fatal: if the cache is empty or the email
    // doesn't match, the owner can manually link in Settings → Team.
    if (invite.tier !== 'admin' && invite.location_id) {
      try {
        await matchHubUserFromCachedRoster(user.id, invite.location_id, authEmail)
      } catch (matchErr) {
        console.warn('[accept jobber match]', matchErr)
      }
    }
  }

  // Claim one available seat at the invite tier. Skipped for tier='admin'
  // (corporate invites — no subscription_seat exists). For franchise tiers,
  // if no seat is free (owner removed seats between invite + accept) we
  // surface a clear error rather than letting them in without a seat.
  if (invite.tier !== 'admin') {
    const { data: availableSeats, error: seatsErr } = await supabaseService
      .from('subscription_seats')
      .select('id')
      .eq('location_id', invite.location_id)
      .eq('tier', invite.tier)
      .eq('status', 'active')
      .is('user_id', null)
      // Never claim a seat scheduled for removal — the invite gate excluded
      // it from availability, and claiming it would strand the new member on
      // the removal date. Keep the two filters in lockstep.
      .is('scheduled_removal_at', null)
      .order('added_at', { ascending: true })
      .limit(1)
    if (seatsErr) {
      console.error('[accept seats fetch]', seatsErr)
      return NextResponse.json({ error: seatsErr.message }, { status: 500 })
    }
    if (!availableSeats || availableSeats.length === 0) {
      return NextResponse.json(
        {
          error:
            'No available seats remain at your tier. Ask the location owner to add a seat.',
          code: 'no_available_seats',
        },
        { status: 409 }
      )
    }

    const seatId = availableSeats[0].id
    const { error: claimErr } = await supabaseService
      .from('subscription_seats')
      .update({ user_id: user.id, updated_at: new Date().toISOString() })
      .eq('id', seatId)
    if (claimErr) {
      console.error('[accept seat claim]', claimErr)
      return NextResponse.json({ error: claimErr.message }, { status: 500 })
    }

    // Phase 2: the FIRST owner to claim a seat at a location becomes the
    // designated primary owner (the sending identity for emails/drips) when
    // no primary is set yet. A co-owner accepting later (a primary already
    // exists) is left is_primary=false and is promoted only via an explicit
    // "Make Primary" action. Best-effort: a failure here leaves the seat
    // claimed but undesignated; the resolver's earliest-owner fallback keeps
    // outbound identity deterministic until someone designates a primary.
    if (invite.tier === 'owner') {
      const { count: primaryCount } = await supabaseService
        .from('subscription_seats')
        .select('id', { count: 'exact', head: true })
        .eq('location_id', invite.location_id)
        .eq('tier', 'owner')
        .eq('is_primary', true)
      if ((primaryCount ?? 0) === 0) {
        const { error: primaryErr } = await supabaseService
          .from('subscription_seats')
          .update({ is_primary: true, updated_at: new Date().toISOString() })
          .eq('id', seatId)
        if (primaryErr) {
          console.error('[accept mark primary owner]', primaryErr)
        }
      }
    }
  }

  // Mark invite consumed last — if it fails the seat claim still stands,
  // and we leave invite.accepted_at null so the user can retry without
  // a 410. Most likely failure here is a transient DB blip.
  const { error: markErr } = await supabaseService
    .from('pending_invites')
    .update({
      accepted_at: new Date().toISOString(),
      accepted_user_id: user.id,
    })
    .eq('id', invite.id)
  if (markErr) {
    console.error('[accept mark consumed]', markErr)
  }

  return NextResponse.json({ ok: true, location_id: invite.location_id }, { status: 200 })
}
