// app/api/hub_users/accept/route.ts
//
// Consume a pending_invites token: create the hub_users row keyed by
// auth.uid(), PATCH one available subscription_seats row to claim the
// seat, and mark the invite accepted. Called by /auth/invite/[token]
// after the invitee signs in with Google.
//
// Email matching: the Google-authenticated email MUST equal the invite's
// email (case-insensitive). We refuse the accept otherwise to prevent
// link-forwarding from granting a seat to a different account.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

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
  }

  // Claim one available seat at the invite tier. If none are free (owner
  // removed seats between invite + accept), surface a clear error rather
  // than letting them in without a seat.
  const { data: availableSeats, error: seatsErr } = await supabaseService
    .from('subscription_seats')
    .select('id')
    .eq('location_id', invite.location_id)
    .eq('tier', invite.tier)
    .eq('status', 'active')
    .is('user_id', null)
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
