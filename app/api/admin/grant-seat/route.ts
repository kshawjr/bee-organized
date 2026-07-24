// app/api/admin/grant-seat/route.ts
//
// super_admin-only "Grant seat (comp)" — turn on a seat WITHOUT payment.
// The pre-Stripe lever Kevin uses to activate testers before the paid
// path is live. This is a comp lever, NOT a purchase path:
//   - super_admin ONLY (not owner, not admin/corp — stricter than
//     /api/seats POST, which also lets owners/admins create seats).
//   - Every grant is marked as manual via the seat's `notes` field
//     (see lib/subscription-activation.ts manualGrantSeatNote) and,
//     unlike a paid activation, writes NO billing_invoices row and
//     carries prorated_cost = 0 — so "who paid vs who was comped"
//     stays answerable.
//
// The grant is keyed on the OWNER (hub_users id). Seats live on the
// location, so we resolve the owner's location server-side (never trust
// a client-sent location_id) and grant there. A person who owns three
// territories appears as three owner rows, each showing its own
// location — the schema has no cross-territory single pool.
//
// Dispatch mirrors the Stripe webhook EXACTLY, minus the money:
//   - owner tier + location not yet active → activateLocationSubscription
//     (THE shared activation path — never a parallel one). Comp marker
//     rides seatNotes; paid_through_date is stamped to next renewal so
//     the tester's location behaves identically to a paid one.
//   - anything else (non-owner tier, or a co-owner on an already-active
//     location) → addManuallyGrantedSeats (the manual sibling of the
//     webhook's addStripePurchasedSeats).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  activateLocationSubscription,
  addManuallyGrantedSeats,
  getLocationBilling,
  manualGrantSeatNote,
  nextRenewalDateString,
} from '@/lib/subscription-activation'

export const runtime = 'nodejs'

const VALID_TIERS = ['owner', 'manager', 'light', 'readonly'] as const

async function loadSuperAdmin(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 401 as const, userId: null }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('role')
    .eq('id', user.id)
    .single()

  // super_admin ONLY. This is a comp lever, not a purchase path.
  if (!hubUser || hubUser.role !== 'super_admin') {
    return { status: 403 as const, userId: user.id }
  }
  return { status: 200 as const, userId: user.id }
}

// GET /api/admin/grant-seat — the owner picker's data source. Returns every
// franchise owner with their location + current subscription status, so the
// UI can show "which owner" and whether granting owner-tier will activate
// the location or add to an already-active pool.
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const auth = await loadSuperAdmin(supabase)
  if (auth.status !== 200) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'unauthorized' : 'forbidden — super_admin only' },
      { status: auth.status },
    )
  }

  // Owners are hub_users role='owner'; each is tied to one location.
  const { data: owners, error: ownerErr } = await supabaseService
    .from('hub_users')
    .select('id, full_name, email, location_id')
    .eq('role', 'owner')
    .order('full_name', { ascending: true })
  if (ownerErr) {
    console.error('[grant-seat GET owners]', ownerErr)
    return NextResponse.json({ error: ownerErr.message }, { status: 500 })
  }

  const locationIds = Array.from(
    new Set((owners || []).map(o => o.location_id).filter(Boolean)),
  ) as string[]

  const locById = new Map<string, { name: string | null; subscription_status: string | null }>()
  if (locationIds.length > 0) {
    const { data: locs, error: locErr } = await supabaseService
      .from('locations')
      .select('id, name, subscription_status')
      .in('id', locationIds)
    if (locErr) {
      console.error('[grant-seat GET locations]', locErr)
      return NextResponse.json({ error: locErr.message }, { status: 500 })
    }
    for (const l of locs || []) {
      locById.set(l.id, { name: l.name, subscription_status: l.subscription_status })
    }
  }

  const result = (owners || [])
    .filter(o => o.location_id)
    .map(o => {
      const loc = locById.get(o.location_id as string)
      return {
        owner_user_id: o.id,
        owner_name: o.full_name,
        owner_email: o.email,
        location_id: o.location_id,
        location_name: loc?.name ?? null,
        subscription_status: loc?.subscription_status ?? null,
      }
    })

  return NextResponse.json(result)
}

// POST /api/admin/grant-seat — grant a comp seat.
// Body: { owner_user_id, tier, quantity?, reason? }
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await loadSuperAdmin(supabase)
  if (auth.status !== 200) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'unauthorized' : 'forbidden — super_admin only' },
      { status: auth.status },
    )
  }

  const body = await request.json().catch(() => ({}))
  const { owner_user_id, tier, quantity, reason } = body || {}

  if (typeof owner_user_id !== 'string' || !owner_user_id) {
    return NextResponse.json({ error: 'owner_user_id required' }, { status: 400 })
  }
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `invalid tier — must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 },
    )
  }
  const qty = quantity === undefined || quantity === null ? 1 : quantity
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
    return NextResponse.json(
      { error: 'quantity must be an integer between 1 and 50' },
      { status: 400 },
    )
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return NextResponse.json({ error: 'reason must be a string or omitted' }, { status: 400 })
  }

  // Resolve the owner → their location (authoritative; the seat lives there).
  const { data: owner } = await supabaseService
    .from('hub_users')
    .select('id, role, location_id, full_name')
    .eq('id', owner_user_id)
    .maybeSingle()
  if (!owner) {
    return NextResponse.json({ error: 'owner not found' }, { status: 404 })
  }
  if (owner.role !== 'owner') {
    return NextResponse.json(
      { error: 'target user is not an owner — grant seats to franchise owners only' },
      { status: 400 },
    )
  }
  if (!owner.location_id) {
    return NextResponse.json({ error: 'owner has no location' }, { status: 400 })
  }

  const location = await getLocationBilling(owner.location_id)
  if (!location) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  // Dispatch mirrors the Stripe webhook, minus the payment.
  const isActivation = location.subscription_status !== 'active' && tier === 'owner'

  try {
    if (isActivation) {
      // Owner activation goes through THE shared function. quantity is
      // forced to 1 — activation mints exactly one owner seat (a co-owner
      // is a separate grant on the now-active location, handled below).
      const paidThrough = nextRenewalDateString()
      const result = await activateLocationSubscription({
        locationId: location.id,
        ownerUserId: owner.id,
        proratedCostCents: 0, // comp — no charge
        paidThroughDate: paidThrough,
        seatNotes: manualGrantSeatNote(auth.userId, reason),
      })
      return NextResponse.json(
        {
          ok: true,
          activated: true,
          comp: true,
          already_active: result.alreadyActive,
          seat: result.seat,
          location: result.location,
          paid_through_date: paidThrough,
        },
        { status: 201 },
      )
    }

    const { seats, ownerCapHit } = await addManuallyGrantedSeats({
      locationId: location.id,
      tier,
      quantity: qty,
      grantedBy: auth.userId,
      reason: typeof reason === 'string' ? reason : null,
    })
    if (ownerCapHit) {
      return NextResponse.json(
        {
          error: 'max_owners_reached',
          message: 'A location can have at most 2 owner seats.',
        },
        { status: 409 },
      )
    }
    return NextResponse.json(
      {
        ok: true,
        activated: false,
        comp: true,
        location_id: location.id,
        tier,
        quantity: qty,
        seats,
      },
      { status: 201 },
    )
  } catch (err: any) {
    console.error('[grant-seat POST]', err)
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
  }
}
