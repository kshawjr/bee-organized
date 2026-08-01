// lib/stripe-billing.ts
// ─────────────────────────────────────────────────────────────
// The Stripe *operations* layer for subscription billing (issue 161).
// Sits on top of the thin client in lib/stripe.ts and owns every write
// we make to Stripe: customers, subscription checkout, seat lines, and
// the billing portal.
//
// THE MODEL (issue 161):
//   - One Stripe customer per location, one subscription per location,
//     one renewal date (the owner's signup anniversary — the annual
//     price's billing_cycle_anchor, which Stripe sets automatically at
//     checkout). We do NOT compute renewal dates or prorations; Stripe
//     does. We read them back (subscriptionPeriodEndUnix).
//   - Additional seats are quantity on line items of the SAME
//     subscription. Adding a manager seat bumps the manager line's
//     quantity; Stripe prorates the difference to the existing renewal
//     date and bills it on the card on file at the next cycle.
//   - Cards are entered ONLY on Stripe Checkout / the Portal — never in
//     Bee Hub. Nothing here touches a card number.
//
// IDEMPOTENCY: every create/mutation takes a stable idempotency key so a
// user who retries (double-click, webhook-driven re-run, network retry)
// can never mint a second customer, a second subscription, or a double
// seat charge. Keys are derived from stable Bee Hub identifiers
// (location id, seat id) so the SAME logical action always replays.
// ─────────────────────────────────────────────────────────────

import type Stripe from 'stripe'
import { getStripe } from './stripe'

// ── Customer ──────────────────────────────────────────────────
// One Stripe customer per location. Dedup is two-layered: the caller
// passes the location's stored stripe_customer_id when it has one (we
// trust it and skip the API entirely), and the create call carries an
// idempotency key so even a first-time double-submit yields one customer.
export async function getOrCreateStripeCustomer(args: {
  locationId: string
  name?: string | null
  email?: string | null
  existingCustomerId?: string | null
}): Promise<{ customerId: string; created: boolean }> {
  const { locationId, name, email, existingCustomerId } = args
  if (existingCustomerId) return { customerId: existingCustomerId, created: false }

  const stripe = getStripe()
  const customer = await stripe.customers.create(
    {
      name: name || undefined,
      email: email || undefined,
      metadata: { location_id: locationId },
    },
    { idempotencyKey: `bh_customer_${locationId}` },
  )
  return { customerId: customer.id, created: true }
}

// ── Owner-activation checkout return URLs (issue 163) ─────────
// Where Stripe sends the owner after hosted checkout. Both point at the
// onboarding route ('/') — the pay step now navigates the WHOLE tab to
// Stripe (no window.open), so these success_url / cancel_url are what bring
// the owner back into Bee Hub. The onboarding client reads the
// ?stripe_checkout= marker on mount (payStepForCheckoutReturn):
//   • complete → resume at the polling wait (webhook is still the truth)
//   • cancel   → resume at the pay step
// Subscription-mode Checkout Sessions use success_url / cancel_url — the
// dahlia API's return_url is for embedded (ui_mode:'embedded') checkout
// only, which we do not use — so these are the correct fields.
export function ownerCheckoutReturnUrls(
  origin: string,
): { successUrl: string; cancelUrl: string } {
  const base = origin.replace(/\/$/, '')
  return {
    successUrl: `${base}/?stripe_checkout=complete`,
    cancelUrl: `${base}/?stripe_checkout=cancel`,
  }
}

// ── Owner-activation checkout idempotency key (issue 165) ─────
// The key must vary per checkout ATTEMPT. The old location-only key
// (bh_owner_checkout_{locationId}) never changed, so Stripe — which
// replays the SAME session for a repeated key — made a location's FIRST
// checkout session its ONLY one. That first session can be already
// completed (a location reset for a repeat onboarding test) or expired
// (Checkout Sessions die after 24h). Stripe then serves "you're all done
// here — you've either completed your payment or this checkout session has
// timed out" with no chance to enter card details and no way to start over.
//
// Fix: bucket the key by a coarse time window. Two create calls inside the
// SAME window (a double-click, or an immediate network re-send) share a key
// and Stripe replays ONE session — exactly the double-submit idempotency
// exists to stop. A deliberate later retry, or a return after abandoning,
// lands in a NEW window and mints a fresh session, so a dead session never
// traps the owner.
//
// Why a fresh session here can't leak a second subscription: a subscription
// is created only when a session is COMPLETED, and activation is idempotent
// per location (the Stripe webhook short-circuits once subscription_status
// === 'active'), so extra open sessions never become extra subscriptions.
// One-customer-per-location is guaranteed separately by bh_customer_
// {locationId} (getOrCreateStripeCustomer), which is intentionally
// permanent and left unchanged.
//
// The window is far shorter than a Checkout Session's 24h life (so an
// abandoned/dead session is never the only one an owner can ever have) yet
// comfortably wider than a rapid double-submit (sub-second to a few
// seconds of network retry).
export const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 60 * 1000 // 60 seconds

export function ownerCheckoutIdempotencyKey(
  locationId: string,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / CHECKOUT_IDEMPOTENCY_WINDOW_MS)
  return `bh_owner_checkout_${locationId}_${bucket}`
}

// ── Owner-activation checkout ─────────────────────────────────
// Subscription-mode Checkout Session for the owner's annual seat. The
// card is captured on Stripe's hosted page; the webhook
// (checkout.session.completed) writes stripe_subscription_id and
// activates. client_reference_id carries the location uuid so the
// webhook maps the payment back exactly as the Payment-Link path did.
export async function createOwnerCheckoutSession(args: {
  customerId: string
  priceId: string
  locationId: string
  successUrl: string
  cancelUrl: string
  tier?: string
  nowMs?: number
}): Promise<Stripe.Checkout.Session> {
  const { customerId, priceId, locationId, successUrl, cancelUrl } = args
  const tier = args.tier || 'owner'
  const stripe = getStripe()
  return stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: locationId,
      metadata: { tier, location_id: locationId },
      subscription_data: { metadata: { tier, location_id: locationId } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    // issue 165: bucket the key per attempt (see ownerCheckoutIdempotencyKey
    // above). A retry within the window replays the same session; a later
    // attempt gets a fresh one instead of a dead completed/expired session.
    { idempotencyKey: ownerCheckoutIdempotencyKey(locationId, args.nowMs) },
  )
}

// ── Billing portal ────────────────────────────────────────────
// One button → one hosted Portal session. Owners manage cards, invoices,
// and cancellation there; Bee Hub builds NO billing UI for those.
export async function createBillingPortalSession(args: {
  customerId: string
  returnUrl: string
}): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripe()
  return stripe.billingPortal.sessions.create({
    customer: args.customerId,
    return_url: args.returnUrl,
  })
}

// ── Subscription reads ────────────────────────────────────────
export async function retrieveSubscription(
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  const stripe = getStripe()
  return stripe.subscriptions.retrieve(subscriptionId)
}

// The renewal anchor. In the current Stripe API (dahlia) current_period_end
// lives on the subscription ITEM, not the subscription — read the first
// item's. Returns unix seconds, or null if the shape is unexpected.
export function subscriptionPeriodEndUnix(
  sub: Stripe.Subscription | null | undefined,
): number | null {
  const item = sub?.items?.data?.[0] as any
  const end = item?.current_period_end
  return typeof end === 'number' && Number.isFinite(end) ? end : null
}

export function unixToDateString(sec: number | null | undefined): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return null
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

// ── Seat lines (add / remove) ─────────────────────────────────
// Adjust the quantity of the line item for `priceId` by `delta` on an
// EXISTING subscription. This is the "additional seats are lines on the
// same subscription" seam: +1 on invite, -1 on removal. Stripe prorates to
// the existing renewal date — we never compute the proration.
//
// PRORATION TIMING (issue 161, Kevin's call):
//   • ADD (delta > 0): proration_behavior='always_invoice' — Stripe creates
//     the proration invoice immediately, finalizes it, and (the subscription
//     is charge_automatically, created by Checkout) auto-charges the card on
//     file NOW. So the prorated seat cost is collected at purchase, not
//     deferred to the next annual invoice. A failed charge surfaces via the
//     invoice.payment_failed webhook (location → past_due).
//   • REMOVE (delta < 0): proration_behavior='create_prorations' (Stripe's
//     default, UNCHANGED). The unused-time value becomes a proration CREDIT
//     that is applied against the location's NEXT invoice — Stripe does not
//     refund the card. Left as-is deliberately; see the report.
//
// The idempotency key (seat-id-derived, supplied by the caller) makes a
// retry of the SAME seat change a no-op replay rather than a double bump.
export async function adjustSubscriptionSeatQuantity(args: {
  subscriptionId: string
  priceId: string
  delta: number
  idempotencyKey: string
}): Promise<{ quantity: number; itemId: string | null; created: boolean; removed: boolean }> {
  const { subscriptionId, priceId, delta, idempotencyKey } = args
  const stripe = getStripe()

  // Increases invoice + collect now; decreases stay on the default credit-at-
  // next-invoice behavior.
  const prorationBehavior: Stripe.SubscriptionItemUpdateParams.ProrationBehavior =
    delta > 0 ? 'always_invoice' : 'create_prorations'

  const sub = await stripe.subscriptions.retrieve(subscriptionId)
  const items = (sub.items?.data || []) as Stripe.SubscriptionItem[]
  const existing = items.find((it) => (it.price?.id ?? null) === priceId) || null
  const currentQty = existing?.quantity ?? 0
  const nextQty = currentQty + delta

  // No line yet + nothing to add → nothing to do.
  if (!existing && nextQty <= 0) {
    return { quantity: 0, itemId: null, created: false, removed: false }
  }

  // First seat at this tier → create the line (always an add → invoice now).
  if (!existing) {
    const created = await stripe.subscriptionItems.create(
      { subscription: subscriptionId, price: priceId, quantity: nextQty, proration_behavior: prorationBehavior },
      { idempotencyKey },
    )
    return { quantity: created.quantity ?? nextQty, itemId: created.id, created: true, removed: false }
  }

  // Line exists and would drop to zero → remove it (the owner base line
  // always remains, so the subscription is never left item-less). Removal
  // stays on create_prorations → credit at next invoice.
  if (nextQty <= 0) {
    await stripe.subscriptionItems.del(existing.id, { proration_behavior: 'create_prorations' }, { idempotencyKey })
    return { quantity: 0, itemId: existing.id, created: false, removed: true }
  }

  // Otherwise bump/reduce the quantity in place. An increase invoices now;
  // a decrease credits the next invoice.
  const updated = await stripe.subscriptionItems.update(
    existing.id,
    { quantity: nextQty, proration_behavior: prorationBehavior },
    { idempotencyKey },
  )
  return { quantity: updated.quantity ?? nextQty, itemId: updated.id, created: false, removed: false }
}
