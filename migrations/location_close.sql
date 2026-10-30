-- migrations/location_close.sql
--
-- ✅ RUN ON PRODUCTION 29 Oct 2026 by Kevin, and verified: the constraint now
-- lists 'closed', close_record exists as jsonb, 54 locations, none closed.
-- Do not run again (step 1 is safe to repeat, but there is no reason to).
--
-- Closing a location (lib/location-close.ts, 29 Oct 2026). Two schema changes,
-- nothing else:
--
--   1. locations.lifecycle_status may now be 'closed'. The CHECK constraint
--      locations_lifecycle_status_check allows onboarding / active / paused /
--      inactive today; this re-creates it with 'closed' added. Nothing else
--      changes in it.
--   2. locations.close_record jsonb — what the close did and what a reopen
--      needs: when, by whom, the status and notifications_live it had, the
--      Jobber account id and Stripe subscription it had, every zip it
--      released, and the counts. NULL on every location until one is closed.
--
-- NO ROW IS WRITTEN. No location is closed by this file. The close itself is
-- a button (super_admin only) that runs a dry run first.
--
-- Deploy order (done): run this BEFORE the code ships. The code reads close_record on
-- every close/reopen and writes lifecycle_status='closed'; without the
-- constraint change that write is refused (the close stops at step 1, before
-- anything moves). The rest of the app only ever compares lifecycle_status to
-- 'active' / 'onboarding' / 'paused', so the new value is inert until used.
--
-- Run in the Supabase SQL editor, steps in order. 0 is the dry run.

-- ── 0. DRY RUN (read-only) ─────────────────────────────────────────────────
-- Expect: the constraint WITHOUT 'closed'; close_record_exists = false;
-- the statuses in use are only active / onboarding (46 + 8 on 29 Oct).
SELECT pg_get_constraintdef(oid) AS current_check
  FROM pg_constraint
 WHERE conrelid = 'public.locations'::regclass
   AND conname = 'locations_lifecycle_status_check';

SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'close_record'
) AS close_record_exists;

SELECT lifecycle_status, count(*) FROM locations GROUP BY 1 ORDER BY 1;

-- ── 1. The change, one transaction ─────────────────────────────────────────
BEGIN;

ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_lifecycle_status_check;
ALTER TABLE locations ADD CONSTRAINT locations_lifecycle_status_check
  CHECK (lifecycle_status = ANY (ARRAY['onboarding'::text, 'active'::text, 'paused'::text, 'inactive'::text, 'closed'::text]));

ALTER TABLE locations ADD COLUMN IF NOT EXISTS close_record jsonb;

COMMENT ON COLUMN locations.close_record IS
  'Set when a location is closed (lib/location-close.ts): closed_at, closed_by, from_status, notifications_live, jobber_account_id, stripe_subscription_id, released_zips, counts, reopened_at. NULL = never closed.';

COMMIT;

-- ── 2. Check ───────────────────────────────────────────────────────────────
-- Expect: the constraint now lists 'closed'; close_record_exists = true;
-- rows_with_record = 0.
SELECT pg_get_constraintdef(oid) AS new_check
  FROM pg_constraint
 WHERE conrelid = 'public.locations'::regclass
   AND conname = 'locations_lifecycle_status_check';

SELECT count(*) FILTER (WHERE close_record IS NOT NULL) AS rows_with_record,
       count(*) AS locations
  FROM locations;
