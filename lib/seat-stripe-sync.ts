// lib/seat-stripe-sync.ts
//
// Ties a Bee Hub seat change to the location's Stripe subscription
// (issue 161): +1 line item on invite, −1 on removal. Stripe prorates the
// difference to the existing renewal date — we never compute the proration.
// An invite invoices + charges the prorated amount immediately; a removal
// credits the next invoice (see adjustSubscriptionSeatQuantity).
//
// CRITICAL GUARD (issue 161): this is a CONDITIONAL side effect, never a
// gate. A location that has not yet completed Stripe checkout has no
// stripe_subscription_id, so every seat change is a Stripe no-op and the
// free-grant path (record-only seats + invites) keeps working. Only once
// a real subscription exists do seat changes touch Stripe. A Stripe
// failure here NEVER rolls back the seat DB write — the seat is real; the
// billing line is reconciled from the loud log + Slack instead of
// stranding the invitee.

import { supabaseService } from './supabase-service'
import { stripeConfigured } from './stripe'
import { adjustSubscriptionSeatQuantity } from './stripe-billing'
import { getLocationBilling, NON_PAYING_SOURCES } from './subscription-activation'

export type SeatStripeResult = {
  applied: boolean
  // Why we skipped or failed — surfaced to the caller for logging, never fatal.
  reason?:
    | 'non_paying'
    | 'no_subscription'
    | 'stripe_unconfigured'
    | 'no_price'
    | 'stripe_error'
  quantity?: number
  detail?: string
}

// Apply a seat quantity delta for one tier to the location's live
// subscription. seatId (when known) anchors the Stripe idempotency key so
// a retry of the SAME seat change is a replay, not a double charge.
export async function applySeatDeltaToStripe(args: {
  locationId: string
  tier: string
  delta: number
  seatId?: string | null
}): Promise<SeatStripeResult> {
  const { locationId, tier, delta, seatId } = args
  if (!delta) return { applied: false, reason: 'no_subscription' }

  const location = await getLocationBilling(locationId)
  if (!location) return { applied: false, reason: 'no_subscription' }

  // Corporate / prepaid never bill through Stripe.
  if (NON_PAYING_SOURCES.includes(location.payment_source || '')) {
    return { applied: false, reason: 'non_paying' }
  }
  // No live subscription → free-grant location; skip Stripe entirely.
  if (!location.stripe_subscription_id) {
    return { applied: false, reason: 'no_subscription' }
  }
  if (!stripeConfigured()) return { applied: false, reason: 'stripe_unconfigured' }

  const { data: tierRow } = await supabaseService
    .from('tier_prices')
    .select('*')
    .eq('id', tier)
    .maybeSingle()
  const priceId = (tierRow as any)?.stripe_price_id ?? null
  if (!priceId) return { applied: false, reason: 'no_price' }

  const direction = delta > 0 ? 'add' : 'remove'
  const idempotencyKey = `bh_seat_${direction}_${seatId || `${tier}_${locationId}_${delta}`}`

  try {
    const res = await adjustSubscriptionSeatQuantity({
      subscriptionId: location.stripe_subscription_id,
      priceId,
      delta,
      idempotencyKey,
    })
    return { applied: true, quantity: res.quantity }
  } catch (err: any) {
    // Non-fatal by design — the seat write already landed.
    console.error(
      `[seat-stripe-sync] ${direction} tier=${tier} loc=${locationId} failed —`,
      err?.message || err,
    )
    return { applied: false, reason: 'stripe_error', detail: String(err?.message || err).slice(0, 300) }
  }
}
