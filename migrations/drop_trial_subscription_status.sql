-- Drop 'trial' from locations.subscription_status CHECK constraint.
-- Pure dead value: nothing sets it, nothing honors it.
-- Pre-verified: zero locations had subscription_status='trial'.
-- Safe to re-run — IF EXISTS / DROP + ADD pattern is idempotent.

ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_subscription_status_check;
ALTER TABLE locations ADD CONSTRAINT locations_subscription_status_check
  CHECK (subscription_status IN ('deferred', 'active', 'past_due', 'canceled'));
