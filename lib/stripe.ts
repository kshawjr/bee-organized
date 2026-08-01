// lib/stripe.ts
// ─────────────────────────────────────────────────────────────
// Thin Stripe API client — the secret-key half of the Stripe
// integration (issue 161). Mirrors lib/jobber.ts's shape: a single
// module that owns the credential and hands back a ready client, so
// no route ever reads STRIPE_SECRET_KEY directly.
//
// Fail-closed like the webhook verifier: getStripe() THROWS when
// STRIPE_SECRET_KEY is unset rather than constructing a client that
// would 401 on the first call with an opaque error. Callers that must
// degrade gracefully (the onboarding checkout route falls back to the
// record-only flow) guard with stripeConfigured() first.
//
// Test vs live: STRIPE_SECRET_KEY selects the mode. This file is
// mode-agnostic — the test price IDs live in tier_prices.stripe_price_id
// (see migrations/tier_prices_stripe_price_id.sql), never hardcoded here,
// because live mode has different price IDs.
// ─────────────────────────────────────────────────────────────

import Stripe from 'stripe'

let _stripe: Stripe | null = null

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}

// Cached singleton — one client per warm serverless instance, same as
// jobber's module-level state. apiVersion is intentionally left to the
// SDK's pinned default so a future `npm install stripe@latest` can bump
// both together without a stale hardcoded version string drifting here.
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY not set — Stripe client unavailable (fail-closed)',
    )
  }
  if (!_stripe) {
    _stripe = new Stripe(key, {
      appInfo: { name: 'bee-organized', url: 'https://beeorganized.app' },
      maxNetworkRetries: 2,
    })
  }
  return _stripe
}
