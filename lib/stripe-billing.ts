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

// ── Customer idempotency key (issue 167) ──────────────────────
// The customer-create key used to be permanent (bh_customer_{locationId}).
// That was WRONG, and confirmed live: a location whose stripe_customer_id
// was NULL called customers.create, and Stripe — which caches idempotency
// keys for 24h — REPLAYED the id of a customer since DELETED in the
// dashboard. Session creation then threw "No such customer: cus_…" and the
// route 502'd, and clearing the column couldn't help because the replay
// happens at Stripe, keyed on a permanent key we could never rotate.
//
// Fix mirrors the owner-checkout key (issue 165): bucket the key by the same
// coarse time window. Two creates in the SAME window (a double-submit) still
// share a key ⇒ Stripe yields ONE customer — the double-submit guarantee.
// A deliberate later attempt (a repeat onboarding test, or recovery after a
// dashboard deletion) lands in a NEW window ⇒ a genuinely fresh customer,
// never a 24h replay of a dead one. One-customer-per-location within an
// attempt still holds; across attempts we WANT a fresh customer if the old
// one is gone.
export function customerIdempotencyKey(
  locationId: string,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / CHECKOUT_IDEMPOTENCY_WINDOW_MS)
  return `bh_customer_${locationId}_${bucket}`
}

// ── Customer ──────────────────────────────────────────────────
// One Stripe customer per location per attempt. Dedup is two-layered: the
// caller passes the location's stored stripe_customer_id when it has one (we
// trust it and skip the API entirely), and the create call carries a
// per-attempt idempotency key (customerIdempotencyKey) so a double-submit
// still yields one customer. `idempotencyKey` can be overridden for the
// stale-customer recovery path (issue 167) so a fresh customer is minted
// under a key that can never replay the dead id.
export async function getOrCreateStripeCustomer(args: {
  locationId: string
  name?: string | null
  email?: string | null
  existingCustomerId?: string | null
  nowMs?: number
  idempotencyKey?: string
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
    { idempotencyKey: args.idempotencyKey || customerIdempotencyKey(locationId, args.nowMs) },
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
  // issue 167: override the derived key on the stale-customer recovery retry.
  // The first (failed) session-create request poisons its key for the SAME
  // request body; the retry uses a fresh customer (a DIFFERENT body), so it
  // must also carry a fresh key or Stripe rejects the key reuse.
  idempotencyKey?: string
  // issue 182: a FUTURE billing_cycle_anchor (unix seconds) for the
  // "checkout link for an already-active location" path. Present only for
  // that path; the onboarding pay step omits it and its behavior is
  // unchanged. See the subscription_data assembly below for the zero-charge
  // guarantee.
  billingCycleAnchor?: number
  // issue 182: the full set of subscription lines to create, one per seat
  // tier (owner + managers + …) at the location's ACTIVE seat quantities, so
  // the whole existing team is on the subscription from creation and bills as
  // ONE invoice on the anchor date. When omitted (the onboarding path), the
  // subscription is created with just the single owner line — unchanged.
  lineItems?: Array<{ price: string; quantity: number }>
}): Promise<Stripe.Checkout.Session> {
  const { customerId, priceId, locationId, successUrl, cancelUrl } = args
  const tier = args.tier || 'owner'
  const stripe = getStripe()

  // Default to the single owner line (onboarding); issue 182 passes an
  // explicit per-tier set. An empty array is treated as "not provided".
  const lineItems =
    args.lineItems && args.lineItems.length > 0
      ? args.lineItems
      : [{ price: priceId, quantity: 1 }]

  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata: { tier, location_id: locationId },
  }
  // issue 182: an already-active location has been paid for (by corporate)
  // through paid_through_date. Its checkout link exists only to put a card on
  // file and start billing on that date — never to charge today. A FUTURE
  // billing_cycle_anchor with proration_behavior 'none' makes Stripe collect
  // the payment method now via a SetupIntent (amount due = $0, no
  // PaymentIntent) and generate the FIRST full invoice on the anchor date.
  // 'none' is essential: the default 'create_prorations' would bill the gap
  // between now and the anchor immediately, which is exactly the charge we
  // must avoid. Onboarding's pay step passes no anchor, so it keeps its
  // signup-anchored, full-year-today behavior untouched.
  if (typeof args.billingCycleAnchor === 'number' && Number.isFinite(args.billingCycleAnchor)) {
    subscriptionData.billing_cycle_anchor = args.billingCycleAnchor
    subscriptionData.proration_behavior = 'none'
  }

  return stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      client_reference_id: locationId,
      metadata: { tier, location_id: locationId },
      subscription_data: subscriptionData,
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    // issue 165: bucket the key per attempt (see ownerCheckoutIdempotencyKey
    // above). A retry within the window replays the same session; a later
    // attempt gets a fresh one instead of a dead completed/expired session.
    { idempotencyKey: args.idempotencyKey || ownerCheckoutIdempotencyKey(locationId, args.nowMs) },
  )
}

// ── Stale / deleted customer recovery (issue 167) ─────────────
// True when a Stripe error means the customer we referenced no longer exists
// — deleted in the dashboard, or an idempotency-key replay of a since-deleted
// customer. Stripe surfaces this as code 'resource_missing' on param
// 'customer' with a "No such customer: cus_…" message.
export function isNoSuchCustomerError(err: any): boolean {
  if (!err) return false
  const code = err.code ?? err?.raw?.code
  const param = err.param ?? err?.raw?.param
  const msg = String(err.message ?? err?.raw?.message ?? '')
  if (code === 'resource_missing' && param === 'customer') return true
  return /no such customer/i.test(msg)
}

// Create the owner checkout session, recovering from a stale/deleted customer
// instead of 502ing. On the first "No such customer", we mint a genuinely
// fresh customer under a key derived from the dead id (so it can NEVER replay
// the same ghost), persist it over the stale column via the injected
// persistCustomerId, and retry the session ONCE with a fresh session key.
// persistCustomerId is only invoked when the id actually changes (issue 167).
export async function createOwnerCheckoutSessionResilient(args: {
  locationId: string
  name?: string | null
  email?: string | null
  existingCustomerId?: string | null
  priceId: string
  successUrl: string
  cancelUrl: string
  tier?: string
  nowMs?: number
  // issue 182: forwarded verbatim to createOwnerCheckoutSession — a future
  // billing_cycle_anchor and the per-tier line items for the
  // already-active-location link. Both undefined for the onboarding path
  // (unchanged: no anchor, single owner line).
  billingCycleAnchor?: number
  lineItems?: Array<{ price: string; quantity: number }>
  persistCustomerId: (customerId: string) => Promise<void>
}): Promise<{ session: Stripe.Checkout.Session; customerId: string; recovered: boolean }> {
  const { locationId, name, email, existingCustomerId, priceId, successUrl, cancelUrl, tier, nowMs, billingCycleAnchor, lineItems, persistCustomerId } = args

  const first = await getOrCreateStripeCustomer({ locationId, name, email, existingCustomerId, nowMs })
  let customerId = first.customerId
  if (customerId !== existingCustomerId) await persistCustomerId(customerId)

  try {
    const session = await createOwnerCheckoutSession({ customerId, priceId, locationId, tier, successUrl, cancelUrl, nowMs, billingCycleAnchor, lineItems })
    return { session, customerId, recovered: false }
  } catch (err: any) {
    if (!isNoSuchCustomerError(err)) throw err

    const staleId = customerId
    const fresh = await getOrCreateStripeCustomer({
      locationId, name, email,
      existingCustomerId: null,
      // Distinct from any key that could ever replay the dead customer, and
      // stable across retries of the SAME recovery so it stays idempotent.
      idempotencyKey: `bh_customer_${locationId}_recover_${staleId}`,
    })
    customerId = fresh.customerId
    await persistCustomerId(customerId)

    const session = await createOwnerCheckoutSession({
      customerId, priceId, locationId, tier, successUrl, cancelUrl, billingCycleAnchor, lineItems,
      // Fresh customer ⇒ a different request body ⇒ a fresh session key.
      idempotencyKey: `${ownerCheckoutIdempotencyKey(locationId, nowMs)}_recover_${staleId}`,
    })
    return { session, customerId, recovered: true }
  }
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
