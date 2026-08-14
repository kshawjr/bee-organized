// app/api/admin/process-scheduled-removals/route.ts
//
// POST /api/admin/process-scheduled-removals
// super_admin only — deactivates seats whose scheduled_removal_at <= today.
//
// This does NOT process renewals. Stripe processes renewals, on each
// location's own subscription cycle; this endpoint only retires seats an
// owner already scheduled for removal.
//
// issue 216 — THE UPDATE IS NOW SCOPED. It used to run one bare
//   UPDATE subscription_seats SET status='inactive'
//   WHERE scheduled_removal_at <= today AND status='active'
// with no location filter and no row filter: a single click deactivated
// every due seat across every location, and every affected seat with a
// user_id logs that person out. Two things were wrong with that. The
// operator could not decline a single row, and the set actually updated was
// re-derived at write time — so anything scheduled between loading the
// preview and pressing the button was swept in unseen.
//
// The request must now name its scope explicitly; there is no unscoped
// default:
//   { seat_ids: [...] }   process exactly these rows (what the UI sends —
//                         the operator processes the rows they were shown,
//                         and the preview is the contract)
//   { location_id }       every due seat at one location
//   { scope: 'all' }      deliberate fleet-wide run, for a future cron
// Anything else is a 400. Fail closed: a malformed body must never mean
// "everything".
//
// Returns: { removed_count, removed_ids, skipped_ids }
// skipped_ids are requested seats that were not eligible (already inactive,
// no longer scheduled, or not yet due) — reported, never silently dropped.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (hubUser?.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden — super_admin only' }, { status: 403 })
  }

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  const body = await request.json().catch(() => ({}))
  const { seat_ids, location_id, scope } = (body || {}) as {
    seat_ids?: unknown
    location_id?: unknown
    scope?: unknown
  }

  const hasSeatIds = Array.isArray(seat_ids)
  const hasLocation = typeof location_id === 'string' && location_id.length > 0
  const isFleetWide = scope === 'all'

  // Exactly one scope, always stated. No body → no run.
  const scopeCount = [hasSeatIds, hasLocation, isFleetWide].filter(Boolean).length
  if (scopeCount === 0) {
    return NextResponse.json(
      {
        error: 'scope_required',
        message:
          'Name what to process: { seat_ids: [...] }, { location_id }, or { scope: "all" }.',
      },
      { status: 400 }
    )
  }
  if (scopeCount > 1) {
    return NextResponse.json(
      { error: 'ambiguous_scope', message: 'Pass exactly one of seat_ids, location_id, or scope.' },
      { status: 400 }
    )
  }
  if (hasSeatIds) {
    if (seat_ids.length === 0) {
      return NextResponse.json(
        { error: 'no_seats_selected', message: 'Select at least one seat to process.' },
        { status: 400 }
      )
    }
    if (!seat_ids.every((id) => typeof id === 'string' && id.length > 0)) {
      return NextResponse.json(
        { error: 'invalid_seat_ids', message: 'seat_ids must be an array of seat id strings.' },
        { status: 400 }
      )
    }
  }

  // The due-and-active predicate is applied in EVERY branch, so naming a
  // seat id can never retire a seat that isn't actually due — the explicit
  // list narrows the set, it never widens it.
  let query = supabaseService
    .from('subscription_seats')
    .update({
      status: 'inactive',
      removed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .lte('scheduled_removal_at', today)
    .eq('status', 'active')

  if (hasSeatIds) query = query.in('id', seat_ids as string[])
  else if (hasLocation) query = query.eq('location_id', location_id as string)

  const { data, error } = await query.select('id')

  if (error) {
    console.error('[process-scheduled-removals]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const removed_ids = (data || []).map((r: { id: string }) => r.id)
  // Requested but not eligible — surfaced so the operator sees the gap
  // between what they confirmed and what actually happened.
  const skipped_ids = hasSeatIds
    ? (seat_ids as string[]).filter((id) => !removed_ids.includes(id))
    : []

  return NextResponse.json({
    removed_count: removed_ids.length,
    removed_ids,
    skipped_ids,
  })
}
