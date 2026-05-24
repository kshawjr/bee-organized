-- Corporate invitations: allow pending_invites rows without a location.
--
-- Original schema (invite_tokens.sql) was franchise-only: every invite
-- belonged to a location and claimed a subscription_seats slot at accept
-- time. Corporate users (role='admin', no location) don't have seats —
-- they need an invite path where location_id is null and tier='admin'.
--
-- Changes:
--   1. pending_invites.location_id becomes nullable.
--   2. pending_invites.tier CHECK extends to include 'admin'.
--   3. Indexes that referenced (location_id, tier) keep working
--      (Postgres treats null as distinct from any value — corporate
--      invites land in a separate partial-index bucket).
--
-- Safe to re-run: every statement is idempotent / no-op if already applied.

BEGIN;

ALTER TABLE public.pending_invites
  ALTER COLUMN location_id DROP NOT NULL;

ALTER TABLE public.pending_invites
  DROP CONSTRAINT IF EXISTS pending_invites_tier_check;

ALTER TABLE public.pending_invites
  ADD CONSTRAINT pending_invites_tier_check
  CHECK (tier IN ('owner', 'manager', 'light', 'readonly', 'admin'));

-- Sanity: tier='admin' invites must NOT carry a location_id, and franchise
-- tiers MUST carry one. This catches API regressions at the DB layer
-- instead of silently producing invalid invite rows.
ALTER TABLE public.pending_invites
  DROP CONSTRAINT IF EXISTS pending_invites_tier_location_alignment;

ALTER TABLE public.pending_invites
  ADD CONSTRAINT pending_invites_tier_location_alignment
  CHECK (
    (tier = 'admin' AND location_id IS NULL)
    OR (tier IN ('owner', 'manager', 'light', 'readonly') AND location_id IS NOT NULL)
  );

COMMIT;
