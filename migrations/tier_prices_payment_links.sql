-- Stripe Payment Link per tier (subscription milestone 1).
--
-- Kevin creates one Payment Link per tier in the Stripe dashboard and
-- pastes the URL into Admin > Pricing. NULL = online payment not
-- configured for that tier; every pay surface falls back to the
-- record-only "we'll invoice you separately" flow, so this column
-- doubles as the feature flag.
--
-- The app appends ?client_reference_id=<location uuid> (+ prefilled_email)
-- at click time — the stored URL is location-agnostic. The link itself
-- must carry metadata key `tier` = <tier id> (set in the Stripe
-- dashboard) so the webhook can map the payment back.
--
-- HELD AS REVIEW ARTIFACT — run in the Supabase SQL editor. Code reads
-- tier_prices with select('*') so it is safe to deploy before or after
-- this migration; the Stripe path simply stays dark until both this and
-- stripe_webhook_events.sql are applied.

ALTER TABLE tier_prices ADD COLUMN IF NOT EXISTS payment_link_url text;

COMMENT ON COLUMN tier_prices.payment_link_url IS
  'Stripe Payment Link for ONE seat of this tier (fixed price, quantity 1). NULL = Stripe checkout not configured; UI falls back to record-only. App appends client_reference_id at render.';
