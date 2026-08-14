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
// issue 222 — AND IT NOW CREDITS STRIPE.
//
// THE GAP: this route deactivated seats and never called Stripe at all. Not the
// wrong line — no line, at any tier. A seat retired through the scheduled door
// kept its price on the location's subscription forever, so the owner went on
// paying at renewal for a seat nobody holds. issue 221 fixed WHICH line an
// immediate removal credits; this door was never crediting, and it is the wider
// one, because scheduling is how a seat is *meant* to leave.
//
// The credit is quoteSeatRemoval() + applySeatRemovalToStripe(), the same two
// calls /api/seats DELETE makes. There is no second removal-pricing path — the
// co-owner rule living in one place is what issues 217 through 221 bought. What
// is genuinely different here is that a run retires MANY seats across MANY
// locations, so lib/seat-removal-batch groups them by location and tier and
// differences each group once, at its real quantity. Removing two owner seats
// from one location in one click credits owner × 1 + manager × 1 — what they
// were charged — instead of the manager line twice.
//
// Returns: { removed_count, removed_ids, skipped_ids, billing }
// skipped_ids are requested seats that were not eligible (already inactive,
// no longer scheduled, or not yet due) — reported, never silently dropped.
// billing is the per-location credit outcome, including the seats whose credit
// was owed and did not land.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { creditRemovedSeats, type RemovedSeatRow } from '@/lib/seat-removal-batch'

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

  // issue 222 — location_id and tier come back because the credit needs them,
  // and notes so a mismatch note appends to what the row already says.
  const { data, error } = await query.select('id, location_id, tier, notes')

  if (error) {
    console.error('[process-scheduled-removals]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const removedRows = (data || []) as RemovedSeatRow[]
  const removed_ids = removedRows.map((r) => r.id)
  // Requested but not eligible — surfaced so the operator sees the gap
  // between what they confirmed and what actually happened.
  const skipped_ids = hasSeatIds
    ? (seat_ids as string[]).filter((id) => !removed_ids.includes(id))
    : []

  // issue 222 — DEACTIVATE FIRST, THEN CREDIT. Both orders have a failure mode
  // and this one is chosen, not inherited:
  //
  //   • The credit cannot be priced before the write. quoteSeatRemoval counts
  //     the owner seats that REMAIN ACTIVE and adds the removal back — its
  //     stated contract, and what makes a re-issued removal recompute the
  //     identical line instead of a different one. Crediting first would mean
  //     pricing against a state that has not happened yet.
  //   • The set actually retired is decided at write time. issue 216 keeps the
  //     due-and-active predicate on the UPDATE precisely so a named seat that
  //     is no longer due cannot be forced. Crediting first would credit rows
  //     the UPDATE then declines to touch — money moved for seats that stay,
  //     which is the failure with no clean undo: a wrongly-issued credit needs
  //     a corrective charge on a real customer's invoice.
  //   • /api/seats DELETE already writes first (issue 221). Two doors that
  //     order this differently would price the co-owner rule differently.
  //
  // The failure this leaves open is the seat being gone while the credit is
  // not. That one is recoverable — a super_admin can apply the credit — so it
  // is made VISIBLE rather than prevented: a loud log, the per-line reason in
  // the response below, and issue 219's note written onto each affected seat
  // row. Never fatal: the seats are already retired and no billing outcome may
  // turn that into a failed request.
  const billing = await creditRemovedSeats(removedRows)

  return NextResponse.json({
    removed_count: removed_ids.length,
    removed_ids,
    skipped_ids,
    billing,
  })
}
