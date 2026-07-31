// lib/resend-webhook.ts
//
// Signature verification + payload extraction for the Resend delivery webhook
// receiver (app/api/webhooks/resend/route.ts). This is Half B of the outbound-
// mail notebook — the async delivery side that Half A (migrations/
// notification_log.sql) reserved delivery_status/delivery_updated_at for.
//
// Resend signs webhooks with SVIX. That is a THIRD signature scheme in this
// repo, and it differs from the other two hand-rolled verifiers:
//   - lib/stripe-webhook.ts   → HMAC-SHA256, HEX, over `${t}.${body}`, secret used raw
//   - lib/jobber-webhook.ts   → HMAC-SHA256, BASE64, over the raw body, secret used raw
//   - THIS (Svix)             → HMAC-SHA256, BASE64, over `${id}.${ts}.${body}`,
//                               secret is `whsec_<base64>` and the base64 part is
//                               DECODED to the key bytes before signing.
// We hand-roll it the same way — no `svix` npm dependency for a ~15-line HMAC —
// matching the repo's standing "verify inbound webhooks with node:crypto"
// house style.
//
// Svix headers (all three required):
//   svix-id         opaque message id — part of the signed content
//   svix-timestamp  unix SECONDS — part of the signed content + replay window
//   svix-signature  space-delimited list of `v<version>,<base64sig>` entries.
//                   Multiple appear during secret rotation; ANY v1 match passes.
//
// Fail-closed exactly like the Jobber/Stripe verifiers: missing secret, missing
// header, stale timestamp, malformed secret, or HMAC mismatch all return false,
// and the route 401s with NO DB write. Never throws — a malformed base64 secret
// resolves to false, not an exception.

import { createHmac, timingSafeEqual } from 'node:crypto'

// Svix's own default tolerance is 5 minutes either side.
const TIMESTAMP_TOLERANCE_SEC = 5 * 60

export interface SvixHeaders {
  id: string | null
  timestamp: string | null
  signature: string | null
}

// Pull the base64 signatures out of the `v1,<sig> v1,<sig>` header. Only v1 is
// understood; any other version token is ignored (forward-compatible — a future
// v2 alongside v1 still verifies via the v1 entry). Returns [] when nothing
// usable is present.
export function parseSvixSignatures(header: string | null): string[] {
  if (!header) return []
  const out: string[] = []
  for (const part of header.split(' ')) {
    const comma = part.indexOf(',')
    if (comma === -1) continue
    const version = part.slice(0, comma)
    const sig = part.slice(comma + 1)
    if (version === 'v1' && sig) out.push(sig)
  }
  return out
}

export function verifyResendSignature(
  rawBody: string,
  headers: SvixHeaders,
  nowMs: number = Date.now(),
): boolean {
  const rawSecret = process.env.RESEND_WEBHOOK_SECRET
  if (!rawSecret) {
    console.error('[resend-webhook] RESEND_WEBHOOK_SECRET not set — rejecting all webhooks (fail-closed)')
    return false
  }

  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return false

  // Replay window — reject a body older/newer than the tolerance. timestamp is
  // unix seconds; a non-numeric value fails closed.
  const ts = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return false
  const nowSec = Math.floor(nowMs / 1000)
  if (Math.abs(nowSec - ts) > TIMESTAMP_TOLERANCE_SEC) return false

  const candidates = parseSvixSignatures(signature)
  if (candidates.length === 0) return false

  try {
    // Secret is `whsec_<base64>`; strip the prefix and decode to the key bytes.
    const secretBody = rawSecret.startsWith('whsec_') ? rawSecret.slice(6) : rawSecret
    const key = Buffer.from(secretBody, 'base64')
    if (key.length === 0) return false

    const signedContent = `${id}.${timestamp}.${rawBody}`
    const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64')
    const expectedBuf = Buffer.from(expected)

    for (const candidate of candidates) {
      const candidateBuf = Buffer.from(candidate)
      if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
        return true
      }
    }
    return false
  } catch {
    // Malformed secret / signature encoding → treat as an invalid signature,
    // never a thrown 500.
    return false
  }
}

// ── Event extraction ──────────────────────────────────────────
// A Resend webhook envelope is { type, created_at, data }. Every field is
// untrusted input; the route validates before acting. We surface only what the
// drip-stop path needs: the event type, the message id (data.email_id — this is
// the resend_message_id the notebook keyed its rows on), and, for a bounce, the
// SES-derived classification (data.bounce.type: 'Permanent' | 'Transient' |
// 'Undetermined').

export type ResendEvent = {
  type: string
  // The Resend message id → notification_log.resend_message_id. Null on a
  // malformed envelope; the route treats that as unactionable (200, no write).
  messageId: string | null
  // Only present on email.bounced. 'Permanent' is the hard bounce that stops a
  // drip; 'Transient' / 'Undetermined' record delivery_status only.
  bounceType: string | null
}

export function extractResendEvent(event: any): ResendEvent | null {
  if (!event || typeof event !== 'object') return null
  if (typeof event.type !== 'string') return null
  const data = event.data
  const messageId =
    data && typeof data === 'object' && typeof data.email_id === 'string'
      ? data.email_id
      : null
  const bounceType =
    data && typeof data === 'object' && data.bounce && typeof data.bounce === 'object' &&
    typeof data.bounce.type === 'string'
      ? data.bounce.type
      : null
  return { type: event.type, messageId, bounceType }
}

// Map a Resend event type → the notification_log.delivery_status value. The
// value set here is CONSTRAINED by the CHECK in migrations/notification_log.sql
// ('delivered'|'bounced'|'complained'|'deferred'|'opened'|'clicked'); those six
// values were reserved by Half A precisely to match these events. An event with
// no delivery_status mapping (email.sent — already captured as 'accepted' at
// send time — or email.failed) returns null and the route acks it unhandled.
const DELIVERY_STATUS_BY_EVENT: Record<string, string> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'deferred',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
}

export function deliveryStatusForEvent(type: string): string | null {
  return DELIVERY_STATUS_BY_EVENT[type] ?? null
}

// TERMINAL (drip-stopping) classification. A hard bounce (email.bounced with
// SES type 'Permanent' — the mailbox does not exist) and a spam complaint both
// stop a client's drip. A 'Transient' bounce (mailbox full, message too large)
// or 'Undetermined' is NOT terminal — it may deliver on retry, so it records
// delivery_status and stops nothing. This mirrors lib/drip-send.ts's send-time
// classifier (name='validation_error' = terminal), the two halves of one
// policy: 422 at send time, Permanent bounce after.
export function isHardBounce(evt: ResendEvent): boolean {
  return evt.type === 'email.bounced' && evt.bounceType === 'Permanent'
}
export function isComplaint(evt: ResendEvent): boolean {
  return evt.type === 'email.complained'
}
