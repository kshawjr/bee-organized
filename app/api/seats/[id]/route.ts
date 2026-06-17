// app/api/seats/[id]/route.ts
//
// PATCH /api/seats/[id] — schedule or cancel seat removal at renewal.
// Body: { scheduled_removal_at: 'YYYY-MM-DD' | null }
//   null  → clears the scheduled removal (seat stays active indefinitely)
//   date  → marks seat for removal on/after that date (cron / manual trigger removes it)
//
// Auth: owner of the seat's location OR super_admin/admin.
// The actual removal (status → inactive) is done by
// POST /api/admin/process-scheduled-removals (manual) or a future cron.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const SEAT_COLS =
  'id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes, is_primary, scheduled_removal_at'

async function loadCaller(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (!hubUser) return null
  return { userId: user.id, role: hubUser.role as string, locationId: hubUser.location_id as string | null }
}

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

// PATCH /api/seats/[id]
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const seatId = params.id
  if (!seatId) {
    return NextResponse.json({ error: 'seat id required' }, { status: 400 })
  }

  const body = await request.json().catch(() => ({}))
  const { scheduled_removal_at } = body || {}

  // scheduled_removal_at must be a date string (YYYY-MM-DD) or null.
  if (scheduled_removal_at !== null && typeof scheduled_removal_at !== 'string') {
    return NextResponse.json(
      { error: 'scheduled_removal_at must be a date string (YYYY-MM-DD) or null' },
      { status: 400 }
    )
  }

  // Validate date format and future constraint.
  if (scheduled_removal_at !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduled_removal_at)) {
      return NextResponse.json(
        { error: 'scheduled_removal_at must be in YYYY-MM-DD format' },
        { status: 400 }
      )
    }
    const inputDate = new Date(scheduled_removal_at + 'T00:00:00Z')
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    if (inputDate <= today) {
      return NextResponse.json(
        { error: 'scheduled_removal_at must be a future date' },
        { status: 400 }
      )
    }
  }

  // Fetch the seat to authorize and validate.
  const { data: seat, error: readErr } = await supabaseService
    .from('subscription_seats')
    .select('id, location_id, tier, status, is_primary, user_id')
    .eq('id', seatId)
    .single()

  if (readErr || !seat) {
    return NextResponse.json({ error: 'seat not found' }, { status: 404 })
  }

  // Auth check: owner of this location OR elevated.
  const canWrite =
    isElevated(caller.role) ||
    (caller.role === 'owner' && caller.locationId === seat.location_id)
  if (!canWrite) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Seat must be active — can't schedule removal on an already-inactive seat.
  if (seat.status !== 'active') {
    return NextResponse.json(
      { error: 'seat is already inactive', code: 'seat_inactive' },
      { status: 409 }
    )
  }

  // Cannot schedule removal of the primary owner seat.
  if (seat.tier === 'owner' && seat.is_primary && scheduled_removal_at !== null) {
    return NextResponse.json(
      {
        error: 'cannot schedule removal of the primary owner seat',
        code: 'cannot_remove_primary_owner',
      },
      { status: 409 }
    )
  }

  const { data: updated, error: updateErr } = await supabaseService
    .from('subscription_seats')
    .update({
      scheduled_removal_at: scheduled_removal_at ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', seatId)
    .select(SEAT_COLS)
    .single()

  if (updateErr) {
    console.error('[seats/[id] PATCH]', updateErr)
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, seat: updated })
}
