-- Stripe recurring Price ID per tier (subscription checkout — issue 161).
--
-- The subscription checkout path (POST /api/locations/[id]/checkout) and
-- the seat add/remove lines read the tier's Stripe Price here instead of
-- hardcoding ids — live mode has DIFFERENT price ids than test mode, so
-- they must live in data, not code.
--
-- NULL = subscription checkout not configured for that tier; the
-- onboarding pay step falls back to the record-only confirm (the
-- free-grant door stays open — issue 161 CRITICAL GUARDS). Code reads
-- tier_prices with select('*'), so it is safe to deploy before or after
-- this migration.
--
-- This is DISTINCT from payment_link_url (the retired one-time Payment
-- Link column, issue 161 says do NOT populate): stripe_price_id drives
-- server-created subscription Checkout Sessions, never a hosted link.
--
-- HELD AS REVIEW ARTIFACT — run in the Supabase SQL editor. This is the
-- ONLY issue-161 migration still unapplied: locations_stripe_columns.sql
-- and stripe_webhook_events.sql were verified already applied in prod on
-- 2026-08-01 (their columns/table exist). The Stripe subscription path
-- stays dark until this runs AND the owner/manager prices below are set.

ALTER TABLE tier_prices ADD COLUMN IF NOT EXISTS stripe_price_id text;

COMMENT ON COLUMN tier_prices.stripe_price_id IS
  'Stripe recurring (annual) Price id for one seat of this tier. NULL = subscription checkout not configured; onboarding falls back to record-only. Drives server-created subscription Checkout Sessions + seat line items — NOT a Payment Link.';

-- TEST-MODE seed (issue 161). Live mode has different ids — set those in
-- Admin once live prices exist. The unit price of each Stripe Price MUST
-- equal tier_prices.price_annual (owner $550/yr, manager $400/yr) so the
-- webhook's amount ÷ price seat-quantity derivation stays exact.
--
--   UPDATE tier_prices SET stripe_price_id = 'price_1TzcNeG6R4Z90Upnb0x2NACQ' WHERE id = 'owner';
--   UPDATE tier_prices SET stripe_price_id = 'price_1TzcNxG6R4Z90UpntIm02kQr' WHERE id = 'manager';
