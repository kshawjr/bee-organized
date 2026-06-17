-- Stripe billing integration columns on locations.
-- These columns exist in production (added directly via Supabase
-- dashboard before the migrations folder existed) but had no
-- migration file on disk. This migration brings the repo into
-- sync so any future DB rebuild creates them correctly.
--
-- Safe to run against production — IF NOT EXISTS makes it a no-op
-- where the columns already exist.
--
-- Forward-compatible with future Stripe webhook handlers that will
-- populate these on customer.subscription.created and similar
-- events. Today they're read-but-never-written stubs.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- Partial unique index on customer_id (one Stripe customer per
-- location). Speeds up webhook handler lookups.
CREATE UNIQUE INDEX IF NOT EXISTS locations_stripe_customer_id_unique
  ON locations (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Partial unique index on subscription_id (one Stripe subscription
-- per location). Speeds up webhook handler lookups.
CREATE UNIQUE INDEX IF NOT EXISTS locations_stripe_subscription_id_unique
  ON locations (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
