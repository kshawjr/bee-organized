// lib/mailchimp-webhook-key.ts
//
// FL-131: the key in the address Mailchimp calls when someone joins a list.
//
// Derived, never stored: an HMAC of the location's id, keyed by that
// location's own Mailchimp connection token (which only the server reads).
// So no migration and no new setting, the server and the one-off set-up
// script (scripts/mailchimp-webhook-setup.mts) always agree, and a new
// connection (a reconnect) makes the old address useless by itself.
//
// The key only lets a caller ASK Bee Hub to look. What happens next is read
// from Mailchimp itself, never taken from the message, so a forged message
// can at most make Bee Hub look at the real list one extra time.
//
// No imports but Node's own, so the set-up script can load this file as is.

import { createHmac, timingSafeEqual } from 'node:crypto'

export function mailchimpWebhookKey(token: string | null | undefined, locationUuid: string): string | null {
  if (!token || typeof token !== 'string' || token.length < 8 || !locationUuid) return null
  return createHmac('sha256', token).update(`bee-hub mailchimp webhook v1:${locationUuid}`).digest('hex').slice(0, 40)
}

export function mailchimpWebhookKeyMatches(given: unknown, token: string | null | undefined, locationUuid: string): boolean {
  const want = mailchimpWebhookKey(token, locationUuid)
  if (!want || typeof given !== 'string' || given.length !== want.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(want))
}

// The address Mailchimp is given. The key rides in the query: Mailchimp's
// audience notifications carry no signature of their own unless one is set
// up by hand in its dashboard.
export function mailchimpWebhookUrl(origin: string, token: string | null | undefined, locationUuid: string): string | null {
  const k = mailchimpWebhookKey(token, locationUuid)
  if (!k) return null
  return `${origin.replace(/\/+$/, '')}/api/mailchimp/webhook?l=${encodeURIComponent(locationUuid)}&k=${k}`
}
