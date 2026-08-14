// lib/stripe-webhook.ts
//
// Signature verification + payload extraction for the Stripe webhook
// receiver (app/api/webhooks/stripe/route.ts).
//
// Verification is hand-rolled the same way the repo's other two HMAC
// verifiers are (lib/jobber-webhook.ts, app/api/slack/interactivity's
// verifySlackSignature) — no `stripe` npm dependency needed for
// milestone 1, since we make zero Stripe API calls. Stripe's scheme:
//   Stripe-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]
//   signed_payload   = `${t}.${rawBody}`
//   expected         = HMAC-SHA256(signed_payload, STRIPE_WEBHOOK_SECRET) hex
// Multiple v1 entries appear during secret rotation — any match passes.
//
// Fail-closed like the Jobber verifier: missing secret, missing header,
// stale timestamp, or HMAC mismatch all return false and the route 401s
// without any DB write.

import { createHmac, timingSafeEqual } from 'node:crypto'

// Stripe's own default tolerance is 5 minutes.
const TIMESTAMP_TOLERANCE_SEC = 5 * 60

export function parseStripeSignatureHeader(
  header: string | null,
): { timestamp: number; signatures: string[] } | null {
  if (!header) return null
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) timestamp = n
    } else if (key === 'v1' && value) {
      signatures.push(value)
    }
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, signatures }
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  nowMs: number = Date.now(),
): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — rejecting all webhooks (fail-closed)')
    return false
  }

  const parsed = parseStripeSignatureHeader(header)
  if (!parsed) return false

  const nowSec = Math.floor(nowMs / 1000)
  if (Math.abs(nowSec - parsed.timestamp) > TIMESTAMP_TOLERANCE_SEC) return false

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`, 'utf8')
    .digest('hex')
  const expectedBuf = Buffer.from(expected)

  for (const candidate of parsed.signatures) {
    const candidateBuf = Buffer.from(candidate)
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return true
    }
  }
  return false
}

// ── Event extraction ──────────────────────────────────────────
// The checkout.session.* event family carries the session object at
// event.data.object. We pull only the fields the handler needs; every
// field is treated as untrusted input (validated at the route).

export type StripeCheckoutSession = {
  eventId: string
  eventType: string
  sessionId: string | null
  paymentIntentId: string | null
  clientReferenceId: string | null
  tier: string | null
  amountTotal: number | null // cents
  currency: string | null
  paymentStatus: string | null // 'paid' | 'unpaid' | 'no_payment_required'
  customerEmail: string | null
  // Subscription-mode checkout (issue 161): the session carries the
  // subscription + customer Stripe created. Null for the legacy one-time
  // Payment-Link path (mode='payment').
  subscriptionId: string | null
  customerId: string | null
  // issue 212: the encoded seat plan the checkout route stamped on the session
  // when it built the line items ("owner:2,manager:1"). This is the signal the
  // activation branch creates seats from — see the route for why it beats
  // dividing amount_total by a unit price. Null on any session minted before
  // issue 212, on a Payment-Link session, or on a plain owner-only checkout.
  seatPlan: string | null
}

export const STRIPE_ACTIVATING_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
] as const

export const STRIPE_FAILURE_EVENTS = ['checkout.session.async_payment_failed'] as const

export function extractCheckoutSession(event: any): StripeCheckoutSession | null {
  if (!event || typeof event !== 'object') return null
  if (typeof event.id !== 'string' || typeof event.type !== 'string') return null
  const session = event.data?.object
  if (!session || typeof session !== 'object') return null

  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    eventId: event.id,
    eventType: event.type,
    sessionId: str(session.id),
    // payment_intent can arrive as a string id or an expanded object.
    paymentIntentId:
      str(session.payment_intent) ?? str(session.payment_intent?.id) ?? null,
    clientReferenceId: str(session.client_reference_id),
    tier: str(session.metadata?.tier),
    amountTotal: Number.isInteger(session.amount_total) ? session.amount_total : null,
    currency: str(session.currency),
    paymentStatus: str(session.payment_status),
    customerEmail: str(session.customer_details?.email) ?? str(session.customer_email),
    // subscription/customer arrive as a string id or an expanded object.
    subscriptionId: str(session.subscription) ?? str(session.subscription?.id),
    customerId: str(session.customer) ?? str(session.customer?.id),
    // issue 212 — stamped by /api/locations/[id]/checkout at session creation.
    seatPlan: str(session.metadata?.seat_plan),
  }
}

// ── Invoice + subscription lifecycle events (issue 161) ───────
// Renewals and card failures arrive on invoice.* ; cancellation and
// out-of-band changes on customer.subscription.* . These are NOT
// checkout sessions — data.object is an invoice / subscription — so they
// get their own extractors. The route maps them back to a location by
// stripe_subscription_id (there is no client_reference_id here).

export const STRIPE_INVOICE_EVENTS = ['invoice.paid', 'invoice.payment_failed'] as const
export const STRIPE_SUBSCRIPTION_EVENTS = [
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const

export type StripeInvoiceEvent = {
  eventId: string
  eventType: string
  invoiceId: string | null
  subscriptionId: string | null
  customerId: string | null
  paymentIntentId: string | null
  amountPaid: number | null // cents
  currency: string | null
  periodEnd: number | null // unix seconds (fallback; the route prefers the live subscription)
  billingReason: string | null // 'subscription_create' | 'subscription_cycle' | …
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

export function extractInvoiceEvent(event: any): StripeInvoiceEvent | null {
  if (!event || typeof event !== 'object') return null
  if (typeof event.id !== 'string' || typeof event.type !== 'string') return null
  const inv = event.data?.object
  if (!inv || typeof inv !== 'object') return null

  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  // dahlia moved the subscription id under parent.subscription_details;
  // fall back to the legacy top-level field for older payloads.
  const subDetails = inv.parent?.subscription_details
  const subscriptionId =
    str(subDetails?.subscription) ?? str(subDetails?.subscription?.id) ??
    str(inv.subscription) ?? str(inv.subscription?.id)
  return {
    eventId: event.id,
    eventType: event.type,
    invoiceId: str(inv.id),
    subscriptionId,
    customerId: str(inv.customer) ?? str(inv.customer?.id),
    paymentIntentId: str(inv.payment_intent) ?? str(inv.payment_intent?.id),
    amountPaid: num(inv.amount_paid),
    currency: str(inv.currency),
    periodEnd: num(inv.period_end),
    billingReason: str(inv.billing_reason),
  }
}

export type StripeSubscriptionEvent = {
  eventId: string
  eventType: string
  subscriptionId: string | null
  customerId: string | null
  status: string | null // 'active' | 'past_due' | 'canceled' | …
  cancelAtPeriodEnd: boolean
  periodEnd: number | null // unix seconds, from the first item
  locationHint: string | null // metadata.location_id we stamped at checkout
}

export function extractSubscriptionEvent(event: any): StripeSubscriptionEvent | null {
  if (!event || typeof event !== 'object') return null
  if (typeof event.id !== 'string' || typeof event.type !== 'string') return null
  const sub = event.data?.object
  if (!sub || typeof sub !== 'object') return null

  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const firstItem = sub.items?.data?.[0]
  return {
    eventId: event.id,
    eventType: event.type,
    subscriptionId: str(sub.id),
    customerId: str(sub.customer) ?? str(sub.customer?.id),
    status: str(sub.status),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    periodEnd: num(firstItem?.current_period_end),
    locationHint: str(sub.metadata?.location_id),
  }
}

// ── Quantity derivation ───────────────────────────────────────
// Payment Links support customer-adjustable quantity, but the
// checkout.session.completed payload does NOT include line items (that
// needs an expanded API fetch, i.e. a secret key we deliberately don't
// hold in milestone 1). So quantity is derived: amount_total divided by
// the tier's per-seat price. REQUIREMENT this creates: each link's unit
// price must equal the tier's price_annual in Admin > Pricing. When the
// division isn't clean (price drift, coupon, wrong link), we grant ONE
// seat and flag `uneven` so the route warns Kevin instead of guessing.
export function deriveSeatQuantity(
  amountTotal: number | null,
  unitCents: number | null,
): { quantity: number; uneven: boolean } {
  if (
    !Number.isInteger(amountTotal) || (amountTotal as number) <= 0 ||
    !Number.isInteger(unitCents) || (unitCents as number) <= 0
  ) {
    return { quantity: 1, uneven: false }
  }
  if ((amountTotal as number) % (unitCents as number) === 0) {
    // Cap mirrors /api/seats' bulk-create sanity guard.
    return { quantity: Math.min(50, (amountTotal as number) / (unitCents as number)), uneven: false }
  }
  return { quantity: 1, uneven: true }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: string | null): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}
