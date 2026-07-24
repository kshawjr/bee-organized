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
