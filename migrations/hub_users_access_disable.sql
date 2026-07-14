-- migrations/hub_users_access_disable.sql
-- ─────────────────────────────────────────────────────────────
-- Reversible "Remove access" offboard for hub_users.
--
-- Adds a nullable disabled flag (disabled_at) + audit (disabled_by).
--   disabled_at IS NOT NULL  ==  access removed (locked out, seat freed).
--   disabled_at IS NULL      ==  active (default).
--
-- This is the PRIMARY lockout signal: middleware.ts reads it on every
-- request and bounces a disabled user to /access-removed regardless of
-- whether their Supabase auth ban (Layer 2) succeeded. Reactivation just
-- clears these two columns (login restored; a paid seat is NOT re-added).
--
-- location_id stays TEXT (unchanged). No new uuid comparisons, so no RLS
-- change is required: the existing self-read policy already lets a caller
-- read their own row (which is all middleware needs), and every write to
-- these columns goes through the service-role key in the offboard route.
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE hub_users
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_by uuid;

-- Partial index: the only hot query is "is THIS user disabled?" (middleware,
-- by PK) which the PK already serves. This index instead accelerates the
-- roster/admin "who is removed" scans, staying tiny because the vast
-- majority of rows are active (disabled_at IS NULL, excluded).
CREATE INDEX IF NOT EXISTS idx_hub_users_disabled_at
  ON hub_users (disabled_at)
  WHERE disabled_at IS NOT NULL;
