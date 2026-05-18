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
}

const SEAT_COLS =
  'id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes'

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

// POST /api/seats — create a seat (owner's first seat at activation OR add-seat flow).
// Body: { location_id, tier, user_id?, prorated_cost?, notes? }
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { location_id, tier, user_id, prorated_cost, notes } = body || {}

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

  if (!canWriteLocation(caller.role, caller.locationId, location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Use service role for the insert so first-time owners (whose RLS context
  // works fine but whose policy depends on a hub_users row that may have
  // been created via service-role) write atomically. App-layer check above
  // is the real gate; service role bypasses RLS only after we've authorized.
  const insertRow: Record<string, any> = {
    location_id,
    tier,
    user_id: user_id ?? null,
    added_by: caller.userId,
  }
  if (prorated_cost !== undefined && prorated_cost !== null) {
    insertRow.prorated_cost = prorated_cost
  }
  if (typeof notes === 'string' && notes.trim()) {
    insertRow.notes = notes.trim()
  }

  const { data, error } = await supabaseService
    .from('subscription_seats')
    .insert(insertRow)
    .select(SEAT_COLS)
    .single()

  if (error) {
    console.error('[seats POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
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

  return NextResponse.json(data)
}
