// lib/stripe-links.ts
//
// Pure helpers for Stripe Payment Link URLs — safe to import from both
// the client (BeeHub.jsx pay surfaces) and server routes (the 402
// payment_required responses build the same URL).
//
// A stored payment_link_url is location-agnostic: one link per tier,
// created once in the Stripe dashboard. The location identity travels
// as ?client_reference_id=<location uuid>, appended here at click time,
// which Stripe passes through to the checkout session the webhook
// receives. prefilled_email is cosmetic (pre-fills the checkout form).

export const STRIPE_TIER_METADATA_KEY = 'tier'

// Payment Links live on buy.stripe.com (or a Stripe-managed custom
// domain). We only hard-require https so a custom domain doesn't get
// rejected; the admin UI warns (not blocks) on unexpected hosts.
export function isValidPaymentLinkUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.trim()) return false
  try {
    return new URL(url.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

export function isCanonicalStripeHost(url: string): boolean {
  try {
    return new URL(url).hostname === 'buy.stripe.com'
  } catch {
    return false
  }
}

// Build the per-location checkout URL from a stored per-tier link.
// Handles links that already carry query params (Stripe sometimes
// appends its own). Returns null when the link is missing/invalid so
// callers can fall back to the record-only flow.
export function buildStripePayUrl(
  paymentLinkUrl: string | null | undefined,
  locationId: string,
  prefilledEmail?: string | null,
): string | null {
  if (!isValidPaymentLinkUrl(paymentLinkUrl) || !locationId) return null
  const url = new URL(paymentLinkUrl.trim())
  url.searchParams.set('client_reference_id', locationId)
  if (prefilledEmail && prefilledEmail.includes('@')) {
    url.searchParams.set('prefilled_email', prefilledEmail)
  }
  return url.toString()
}
