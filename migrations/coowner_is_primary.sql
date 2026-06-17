-- Co-owner primary designation
-- is_primary on subscription_seats: only one owner seat per
-- location can be is_primary=true (partial unique index enforces).
-- Email/drip helpers use the primary owner as the sending identity.
-- Safe to re-run — IF NOT EXISTS makes it idempotent.

ALTER TABLE subscription_seats
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_seats_primary_owner_per_location_idx
  ON subscription_seats (location_id)
  WHERE tier = 'owner' AND is_primary = true;

-- Backfill (no-op in production where applied: no claimed owners yet)
WITH primary_owners AS (
  SELECT DISTINCT ON (location_id) id
  FROM subscription_seats
  WHERE tier = 'owner' AND user_id IS NOT NULL AND status = 'active'
  ORDER BY location_id, added_at ASC
)
UPDATE subscription_seats
SET is_primary = true
WHERE id IN (SELECT id FROM primary_owners);
