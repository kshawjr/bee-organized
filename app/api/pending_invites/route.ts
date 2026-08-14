// app/api/pending_invites/route.ts — issue 226 step 5.
//
// GET /api/pending_invites?location_id=<uuid>
// The location's outstanding invitations, EVERY TIER.
//
// WHY A NEW COLLECTION ROUTE RATHER THAN EXTENDING owner-status.
//
// /api/locations/[id]/owner-status already returns invite data, but only the
// owner tier, and its whole contract is owner-shaped: `owners`,
// `primary_owner`, a SINGULAR `pending_invite`, plus backward-compat `seat`
// and `owner_user` fields three consumers already read. Hanging an all-tier
// invite list off it would make a route named "owner-status" the source of
// team-invite data and grow a payload those consumers would then carry for
// nothing. It does expose `other_pending_count` — a COUNT, deliberately, for
// an at-a-glance line — and that is the right amount of team-invite data for
// a route about owners.
//
// This is also not a new concept: app/api/pending_invites/[id]/route.ts
// (DELETE) and .../[id]/resend already exist. The collection route is the
// missing sibling, not a new surface.
//
// AUTH mirrors GET /api/seats, not owner-status: this returns invitees' names
// and email addresses, so it is elevated roles, or the caller's own location.
// Reads go through the service role, which bypasses RLS — THIS ROUTE IS THE
// GATE.
//
// The invite TOKEN is never selected. Resending is /[id]/resend's job, and it
// mints a fresh one server-side.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string | null | undefined) {
  return role === 'super_admin' || role === 'admin' || role === 'corporate'
}

export async function GET(request: NextRequest) {
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
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const locationId = request.nextUrl.searchParams.get('location_id')
  if (!locationId) {
    return NextResponse.json(
      { error: 'location_id query param required' },
      { status: 400 }
    )
  }

  // hub_users.location_id is TEXT and may hold either the uuid or the slug,
  // so compare as strings rather than assuming one shape.
  if (!isElevated(caller.role) && String(caller.location_id) !== String(locationId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabaseService
    .from('pending_invites')
    .select('id, location_id, email, full_name, role, tier, invite_expires_at, accepted_at, created_at')
    .eq('location_id', locationId)
    .is('accepted_at', null)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[pending_invites GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data || [])
}
