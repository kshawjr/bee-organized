// lib/subscription-activation.ts
//
// THE single activation path for a location's subscription, plus the
// server-side "does this purchase require Stripe checkout?" gate.
//
// Two callers, one write path:
//   - POST /api/locations/[id]/complete-onboarding (the PaymentConfirmStep
//     record-only fallback, and Kevin's manual rail via super_admin)
//   - POST /api/webhooks/stripe (real payments)
// Both funnel through activateLocationSubscription() so the webhook can
// never drift from what the onboarding flip writes.
//
// Everything here is idempotent by design — the Stripe webhook retries
// on 5xx and the same checkout session can arrive via two event types,
// so every write is safe to repeat:
//   - owner seat: created only if no active owner seat exists
//   - status flip: skipped when already 'active' (started_at never re-stamped)
//   - invoice: unique partial index on stripe_payment_intent_id (see
//     migrations/stripe_webhook_events.sql) turns replays into no-ops
//   - purchased seats: keyed by checkout session id in notes; existing
//     marker row means the seat was already created

import { supabaseService } from './supabase-service'
import { buildStripePayUrl } from './stripe-links'
import { nextRenewalDate } from './subscription-math'

const SEAT_COLS =
  'id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes, is_primary, scheduled_removal_at'

// payment_source values that mean "Bee Organized/corporate pays, not the
// owner" — these locations never go through Stripe checkout. Everything
// else ('direct', 'stripe', 'none', null) is an owner-pays location.
const NON_PAYING_SOURCES = ['prepaid_corporate', 'corporate_sponsored', 'corporate']

export type LocationBillingRow = {
  id: string
  name: string | null
  location_id: string | null // slug, used by sync_log
  subscription_status: string | null
  payment_source: string | null
  paid_through_date: string | null
}

export async function getLocationBilling(locationId: string): Promise<LocationBillingRow | null> {
  const { data } = await supabaseService
    .from('locations')
    .select('id, name, location_id, subscription_status, payment_source, paid_through_date')
    .eq('id', locationId)
    .maybeSingle()
  return (data as LocationBillingRow) ?? null
}

// ── The Stripe-payment gate ───────────────────────────────────
// A seat/activation purchase must go through Stripe checkout when the
// location is owner-pays AND a payment link is configured for the tier.
// No link configured (column NULL, or the tier_prices_payment_links
// migration not applied yet) → not required, the record-only flow stays
// available. This is the fail-open-to-status-quo direction on purpose:
// the gate can never lock a location out of activating before Stripe is
// set up, it can only close the free-seat path once a real link exists.
export async function getStripeRequirement(
  location: LocationBillingRow,
  tier: string,
  prefilledEmail?: string | null,
): Promise<{ required: boolean; payUrl: string | null }> {
  if (NON_PAYING_SOURCES.includes(location.payment_source || '')) {
    return { required: false, payUrl: null }
  }
  // select('*') so a pre-migration schema (no payment_link_url column)
  // yields undefined instead of a PostgREST unknown-column error.
  const { data: tierRow } = await supabaseService
    .from('tier_prices')
    .select('*')
    .eq('id', tier)
    .maybeSingle()
  const link = (tierRow as any)?.payment_link_url ?? null
  const payUrl = buildStripePayUrl(link, location.id, prefilledEmail)
  return { required: !!payUrl, payUrl }
}

export function nextRenewalDateString(from: Date = new Date()): string {
  return nextRenewalDate(from).toISOString().slice(0, 10)
}

// ── The ONE activation function ───────────────────────────────
export type ActivationResult = {
  alreadyActive: boolean
  seat: any | null // created or claimed owner seat row (null when one already existed)
  location: { id: string; name: string | null; subscription_status: string; subscription_started_at: string | null }
}

export async function activateLocationSubscription(args: {
  locationId: string
  // Claim/create the owner seat for this user. The onboarding route
  // passes the calling owner; the webhook passes the resolved primary
  // owner (or null — an unclaimed seat still holds the paid slot).
  ownerUserId?: string | null
  proratedCostCents?: number | null
  // YYYY-MM-DD. The webhook passes next March 1; the record-only path
  // omits it (matching the pre-Stripe behavior of never writing it).
  paidThroughDate?: string | null
  seatNotes?: string | null
}): Promise<ActivationResult> {
  const { locationId, ownerUserId, proratedCostCents, paidThroughDate, seatNotes } = args

  // 1. Owner seat — ensure exactly one paid owner slot exists.
  const { data: ownerSeats, error: seatReadErr } = await supabaseService
    .from('subscription_seats')
    .select(SEAT_COLS)
    .eq('location_id', locationId)
    .eq('tier', 'owner')
    .eq('status', 'active')
    .order('added_at', { ascending: true })
  if (seatReadErr) throw new Error(`owner seat read failed: ${seatReadErr.message}`)

  let seat: any | null = null
  const existing = ownerSeats || []
  if (existing.length === 0) {
    const insertRow: Record<string, any> = {
      location_id: locationId,
      tier: 'owner',
      user_id: ownerUserId ?? null,
      added_by: ownerUserId ?? null,
    }
    if (proratedCostCents != null) insertRow.prorated_cost = proratedCostCents
    if (seatNotes) insertRow.notes = seatNotes
    const { data: inserted, error: insErr } = await supabaseService
      .from('subscription_seats')
      .insert(insertRow)
      .select(SEAT_COLS)
      .single()
    if (insErr) throw new Error(`owner seat insert failed: ${insErr.message}`)
    seat = inserted
  } else if (ownerUserId && !existing.some((s: any) => s.user_id)) {
    // A pre-allocated unclaimed owner seat exists (invite-owner path) —
    // claim the earliest one for the activating owner instead of
    // stranding it and double-counting toward the 2-owner cap.
    const { data: claimed, error: claimErr } = await supabaseService
      .from('subscription_seats')
      .update({ user_id: ownerUserId, updated_at: new Date().toISOString() })
      .eq('id', existing[0].id)
      .is('user_id', null) // guard against a concurrent claim
      .select(SEAT_COLS)
      .maybeSingle()
    if (claimErr) throw new Error(`owner seat claim failed: ${claimErr.message}`)
    seat = claimed ?? null
  }

  // 2. Location flip — only when not already active. subscription_started_at
  // is stamped once; a duplicate payment or webhook retry never re-stamps it.
  const location = await getLocationBilling(locationId)
  if (!location) throw new Error('location not found')

  if (location.subscription_status === 'active') {
    // Still honor a paid-through extension when the column is empty —
    // covers the retry-after-partial-failure case without ever moving an
    // existing date backwards.
    if (paidThroughDate && !location.paid_through_date) {
      await supabaseService
        .from('locations')
        .update({ paid_through_date: paidThroughDate })
        .eq('id', locationId)
    }
    return {
      alreadyActive: true,
      seat,
      location: {
        id: location.id,
        name: location.name,
        subscription_status: 'active',
        subscription_started_at: null,
      },
    }
  }

  const update: Record<string, any> = {
    subscription_status: 'active',
    subscription_started_at: new Date().toISOString(),
  }
  if (paidThroughDate) update.paid_through_date = paidThroughDate

  const { data: updated, error: updErr } = await supabaseService
    .from('locations')
    .update(update)
    .eq('id', locationId)
    .select('id, name, subscription_status, subscription_started_at')
    .single()
  if (updErr) throw new Error(`subscription flip failed: ${updErr.message}`)

  return { alreadyActive: false, seat, location: updated as ActivationResult['location'] }
}

// ── Stripe invoice recording ──────────────────────────────────
// Returns 'inserted' | 'duplicate'. 'duplicate' means the payment_intent
// already has a billing_invoices row (unique partial index) — the caller
// keeps going so an interrupted first delivery still converges, but skips
// the "possible duplicate payment" alerting.
export async function recordStripeInvoice(args: {
  locationId: string
  amountCents: number
  currency: string | null
  sessionId: string | null
  paymentIntentId: string | null
  memo: string
  periodEnd?: string | null
}): Promise<'inserted' | 'duplicate' | 'skipped_zero_amount'> {
  const { locationId, amountCents, currency, sessionId, paymentIntentId, memo, periodEnd } = args
  // billing_invoices CHECKs amount_cents > 0; a 100%-coupon session is
  // recorded in stripe_webhook_events + sync_log only.
  if (!Number.isInteger(amountCents) || amountCents <= 0) return 'skipped_zero_amount'

  const { error } = await supabaseService.from('billing_invoices').insert({
    location_id: locationId,
    amount_cents: amountCents,
    currency: currency || 'usd',
    paid_at: new Date().toISOString(),
    period_end: periodEnd ?? null,
    source: 'stripe',
    payment_method: 'card',
    reference_number: sessionId,
    memo,
    stripe_payment_intent_id: paymentIntentId,
  })
  if (error) {
    if ((error as any).code === '23505') return 'duplicate'
    throw new Error(`billing_invoices insert failed: ${error.message}`)
  }
  return 'inserted'
}

// ── Stripe-purchased seats (post-activation "+ seats") ────────
// Creates `quantity` ghost seats (user_id null) for a paid checkout —
// links are quantity-adjustable in Stripe, and the caller derives the
// count from amount_total (lib/stripe-webhook.ts deriveSeatQuantity).
// All rows carry the checkout session id in notes and are inserted in
// ONE statement, so a webhook retry finds the marker and no-ops instead
// of double-granting (all-or-nothing on the insert itself).
export async function addStripePurchasedSeats(args: {
  locationId: string
  tier: string
  quantity: number
  perSeatCents: number | null
  sessionId: string | null
}): Promise<{ seats: any[]; deduped: boolean; ownerCapHit: boolean }> {
  const { locationId, tier, quantity, perSeatCents, sessionId } = args
  const qty = Math.max(1, Math.min(50, Math.trunc(quantity)))
  const marker = sessionId ? `stripe_session=${sessionId}` : null

  if (marker) {
    const { data: prior } = await supabaseService
      .from('subscription_seats')
      .select('id')
      .eq('location_id', locationId)
      .like('notes', `%${marker}%`)
      .limit(1)
    if (prior && prior.length > 0) return { seats: [], deduped: true, ownerCapHit: false }
  }

  // Mirror /api/seats POST's owner cap (max 2 active owner seats).
  if (tier === 'owner') {
    const { count } = await supabaseService
      .from('subscription_seats')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .eq('status', 'active')
    if ((count ?? 0) + qty > 2) return { seats: [], deduped: false, ownerCapHit: true }
  }

  const baseRow: Record<string, any> = {
    location_id: locationId,
    tier,
    user_id: null,
    notes: marker ? `Purchased via Stripe checkout (${marker})` : 'Purchased via Stripe checkout',
  }
  if (perSeatCents != null && Number.isInteger(perSeatCents) && perSeatCents >= 0) {
    baseRow.prorated_cost = perSeatCents
  }

  const { data: seats, error } = await supabaseService
    .from('subscription_seats')
    .insert(Array.from({ length: qty }, () => ({ ...baseRow })))
    .select(SEAT_COLS)
  if (error) throw new Error(`stripe seat insert failed: ${error.message}`)
  return { seats: seats || [], deduped: false, ownerCapHit: false }
}
