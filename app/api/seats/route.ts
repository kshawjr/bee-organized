// app/api/seats/route.ts
//
// CRUD for subscription_seats — the pool-model seat table backing the
// Activate flow, "+ Add seats", and Team Invite assignment (Dispatch 3).
//
// Auth model mirrors RLS:
//   - GET    any authenticated hub_user with access to the location
//   - POST   super_admin/admin OR owner of the target location
//   - PATCH  super_admin/admin OR owner of the seat's location
//   - DELETE super_admin/admin only (soft-delete; real removal needs caution)
//
// We do app-layer checks on top of RLS so failures surface as clean 403/400s
// instead of opaque RLS errors, matching /api/admin/tier-prices' pattern.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { applySeatDeltaToStripe } from '@/lib/seat-stripe-sync'
import { quoteSeatPurchase, seatCostDivergence, unpricedSeatNote } from '@/lib/seat-cost'

export const runtime = 'nodejs'

const VALID_TIERS = ['owner', 'manager', 'light', 'readonly'] as const
type Tier = (typeof VALID_TIERS)[number]

type SeatRow = {
  id: string
  location_id: string
  tier: Tier
  user_id: string | null
  status: 'active' | 'inactive'
  added_at: string
  removed_at: string | null
  prorated_cost: number | null
  added_by: string | null
  notes: string | null
  is_primary: boolean
  scheduled_removal_at: string | null
}

const SEAT_COLS =
  'id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes, is_primary, scheduled_removal_at'

// Resolve the calling user's auth uid + hub_users row in one shot. Returns
// null if unauthenticated or the hub_user is missing.
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

function canWriteLocation(role: string, callerLocationId: string | null, targetLocationId: string) {
  if (isElevated(role)) return true
  if (role === 'owner' && callerLocationId === targetLocationId) return true
  return false
}

// GET /api/seats?location_id=<uuid>
// Returns active+inactive seats for the location, ordered by added_at ASC.
// RLS does the real gating; we still 400 on missing param and 403 on no access.
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
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

  if (!isElevated(caller.role) && caller.locationId !== locationId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabase
    .from('subscription_seats')
    .select(SEAT_COLS)
    .eq('location_id', locationId)
    .order('added_at', { ascending: true })

  if (error) {
    console.error('[seats GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data || [])
}

// POST /api/seats — create one or more seats (owner activation OR add-seat flow).
// Body: { location_id, tier, user_id?, prorated_cost?, notes?, quantity? }
//   quantity defaults to 1 (caps at 50 — bulk creates from "+ Add seats" cap
//   their UI picker at 10, the 50 ceiling is just a server-side sanity guard).
//   When quantity > 1, returns an array of inserted seats; quantity = 1 keeps
//   the legacy single-object shape so the onboarding Activate path doesn't break.
//
// issue 217 — `prorated_cost` IN THE BODY IS NO LONGER WRITTEN. It used to be
// copied into the row verbatim, shape-checked but never value-checked, which
// made the browser's arithmetic the permanent record of what a seat cost. The
// figure is now computed by lib/seat-cost from the location's own
// paid_through_date, the live tier_prices rates and lib/seat-plan's co-owner
// rule. The field is still ACCEPTED — a stale client must not start 400ing —
// but only so a value that disagrees can be logged; it never reaches the
// table. See seatCostDivergence() for where that lands.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { location_id, tier, user_id, prorated_cost, notes, quantity } = body || {}

  if (typeof location_id !== 'string' || !location_id) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `invalid tier — must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    )
  }
  if (user_id !== undefined && user_id !== null && typeof user_id !== 'string') {
    return NextResponse.json({ error: 'user_id must be a uuid string or null' }, { status: 400 })
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

  const qty = quantity === undefined || quantity === null ? 1 : quantity
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
    return NextResponse.json(
      { error: 'quantity must be an integer between 1 and 50' },
      { status: 400 }
    )
  }

  if (!canWriteLocation(caller.role, caller.locationId, location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // NOTE (milestone 1, Kevin's call): the free grant deliberately stays
  // OPEN here — owners can still record-only create seats even when a
  // Stripe link exists, because buy-and-invite (an owner's first team
  // member) rides this rail. The UI prefers the Stripe Pay button when a
  // link is configured; closing this grant server-side (402
  // payment_required, which the clients already handle) is a separate
  // step once the paid path is proven.

  // Hard cap: a location may have at most 2 owner seats (primary + one
  // co-owner). Counts assigned AND unassigned active owner seats so a
  // pre-allocated-but-unclaimed seat still counts toward the limit. Includes
  // the requested quantity so a bulk create can't leapfrog the cap.
  if (tier === 'owner') {
    const { count } = await supabaseService
      .from('subscription_seats')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', location_id)
      .eq('tier', 'owner')
      .eq('status', 'active')
    if ((count ?? 0) + qty > 2) {
      return NextResponse.json(
        {
          error: 'max_owners_reached',
          message: 'A location can have at most 2 owner seats.',
        },
        { status: 409 }
      )
    }
  }

  // Use service role for the insert so first-time owners (whose RLS context
  // works fine but whose policy depends on a hub_users row that may have
  // been created via service-role) write atomically. App-layer check above
  // is the real gate; service role bypasses RLS only after we've authorized.
  const baseRow: Record<string, any> = {
    location_id,
    tier,
    user_id: user_id ?? null,
    added_by: caller.userId,
  }

  // issue 217 — THE SERVER COMPUTES THE FIGURE. `prorated_cost` from the body
  // is deliberately absent from baseRow: what the client believes a seat costs
  // has no bearing on what we record. The quote resolves the renewal anchor
  // from this location's real paid_through_date and prices the increment
  // through lib/seat-plan's co-owner rule, so a 2nd owner seat records the
  // manager rate rather than the owner rate a flat lookup would have written.
  const quote = await quoteSeatPurchase({ locationId: location_id, tier, quantity: qty })
  const noteParts: string[] = []
  if (typeof notes === 'string' && notes.trim()) noteParts.push(notes.trim())
  if (quote.unpricedReason) noteParts.push(unpricedSeatNote(quote.unpricedReason))

  const divergence = seatCostDivergence(prorated_cost, quote.perSeatCents)
  if (divergence.diverged) {
    console.error(
      `[seats POST] ${divergence.note} loc=${location_id} tier=${tier} qty=${qty}`,
    )
    noteParts.push(divergence.note)
  }

  const sharedNote = noteParts.join(' · ')
  const rowsToInsert = Array.from({ length: qty }, (_, i) => {
    const row: Record<string, any> = { ...baseRow }
    // Per-seat, not per-request: an owner buy that crosses the co-owner
    // boundary produces one owner-rate seat and one manager-rate seat, and
    // writing a single flat figure to both would misprice one of them. A null
    // entry means no honest figure exists — the column is left unset.
    const cents = quote.perSeatCents?.[i]
    if (typeof cents === 'number') row.prorated_cost = cents
    if (sharedNote) row.notes = sharedNote
    return row
  })

  const { data, error } = await supabaseService
    .from('subscription_seats')
    .insert(rowsToInsert)
    .select(SEAT_COLS)

  if (error) {
    console.error('[seats POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // issue 217 — the response shape is unchanged (bare seat object at qty=1, an
  // array above it) because SeatsContext and the onboarding Activate path both
  // consume it directly. No `cost` envelope is added here: the authoritative
  // figure is already on each returned row as prorated_cost, and any reason it
  // could not be computed is on that row's notes.
  if (qty === 1) {
    return NextResponse.json((data && data[0]) || null, { status: 201 })
  }
  return NextResponse.json(data || [], { status: 201 })
}

// PATCH /api/seats — assign or unassign a user to a seat.
// Body: { id, user_id (uuid or null to unassign) }
export async function PATCH(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { id, user_id } = body || {}

  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }
  if (user_id !== null && (typeof user_id !== 'string' || !user_id)) {
    return NextResponse.json(
      { error: 'user_id must be a uuid string or null (to unassign)' },
      { status: 400 }
    )
  }

  // Need the seat's location_id to authorize the write.
  const { data: existing, error: readErr } = await supabaseService
    .from('subscription_seats')
    .select('id, location_id')
    .eq('id', id)
    .single()

  if (readErr || !existing) {
    return NextResponse.json({ error: 'seat not found' }, { status: 404 })
  }

  if (!canWriteLocation(caller.role, caller.locationId, existing.location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabaseService
    .from('subscription_seats')
    .update({
      user_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(SEAT_COLS)
    .single()

  if (error) {
    console.error('[seats PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

// DELETE /api/seats?id=<uuid> — soft-delete (status='inactive' + removed_at=now).
// Super_admin only — real seat removal is rare and we don't want owners
// accidentally dropping seats they paid for.
export async function DELETE(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!isElevated(caller.role)) {
    return NextResponse.json(
      { error: 'forbidden — super_admin or admin only' },
      { status: 403 }
    )
  }

  const id = request.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  }

  const { data, error } = await supabaseService
    .from('subscription_seats')
    .update({
      status: 'inactive',
      removed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(SEAT_COLS)
    .single()

  if (error) {
    console.error('[seats DELETE]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Decrement the matching line on the location's Stripe subscription
  // (issue 161) — Stripe credits the unused portion. CONDITIONAL + non-fatal:
  // a no-op when the location has no live subscription, and a Stripe failure
  // never un-does the seat removal (the seat is inactive; billing reconciles).
  let billing: any = null
  const seat = data as any
  if (seat?.location_id && seat?.tier) {
    const res = await applySeatDeltaToStripe({
      locationId: seat.location_id,
      tier: seat.tier,
      delta: -1,
      seatId: seat.id,
    })
    billing = { stripe_applied: res.applied, ...(res.reason ? { stripe_skip_reason: res.reason } : {}) }
  }

  return NextResponse.json({ ...data, billing })
}
