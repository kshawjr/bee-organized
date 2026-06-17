// lib/owner-resolution.ts
//
// Single source of truth for "who is THE owner of this location" — used by
// every outbound-identity path (stage emails, welcome email, drip sends) so
// the sending owner is chosen deterministically instead of "whichever owner
// row the query happened to return first".
//
// Resolution order (Phase 2 co-owner support):
//   1. The DESIGNATED primary owner: an active owner-tier subscription_seat
//      with is_primary=true and a claimed user_id. The partial unique index
//      guarantees at most one per location.
//   2. Fallback for claimed-but-undesignated data: earliest-added active
//      owner seat with a user_id (covers a window where two owners exist but
//      none is flagged primary yet — shouldn't happen post-accept-route, but
//      keeps us deterministic if it does).
//   3. LEGACY fallback: the earliest hub_users row with role='owner' at the
//      location. Current production locations have ZERO claimed owner SEATS
//      (owners are represented purely as hub_users rows from the pre-seat
//      era), so without this tier every existing location would suddenly
//      resolve to null and lose its {{owner_name}} / phone fallback in
//      every email. This tier preserves the exact pre-Phase-2 behavior
//      (the email libs previously queried hub_users role='owner' directly).
//
// Returns the owner's hub_users row ({id, email, full_name, phone}) or null
// if the location genuinely has no owner.

import { supabaseService } from './supabase-service'

export type PrimaryOwner = {
  id: string
  email: string | null
  full_name: string | null
  phone: string | null
}

export async function getPrimaryOwnerForLocation(
  locationId: string
): Promise<PrimaryOwner | null> {
  if (!locationId) return null

  // 1. Designated primary owner seat.
  let ownerUserId: string | null = null
  const { data: primarySeat } = await supabaseService
    .from('subscription_seats')
    .select('user_id')
    .eq('location_id', locationId)
    .eq('tier', 'owner')
    .eq('is_primary', true)
    .eq('status', 'active')
    .not('user_id', 'is', null)
    .maybeSingle()
  ownerUserId = primarySeat?.user_id ?? null

  // 2. Fallback: earliest-added active owner seat with a claimed user.
  if (!ownerUserId) {
    const { data: fallbackSeat } = await supabaseService
      .from('subscription_seats')
      .select('user_id')
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .eq('status', 'active')
      .not('user_id', 'is', null)
      .order('added_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    ownerUserId = fallbackSeat?.user_id ?? null
  }

  if (ownerUserId) {
    const { data: owner } = await supabaseService
      .from('hub_users')
      .select('id, email, full_name, phone')
      .eq('id', ownerUserId)
      .maybeSingle()
    if (owner) return owner as PrimaryOwner
    // Seat points at a user_id with no hub_users row (shouldn't happen) —
    // fall through to the legacy lookup rather than returning null.
  }

  // 3. Legacy fallback: hub_users role='owner', earliest at the location.
  const { data: legacyOwner } = await supabaseService
    .from('hub_users')
    .select('id, email, full_name, phone')
    .eq('location_id', locationId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return (legacyOwner as PrimaryOwner) ?? null
}
