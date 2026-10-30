-- migrations/location_close_undo.sql
--
-- Undoes migrations/location_close.sql: the CHECK goes back to onboarding /
-- active / paused / inactive, and locations.close_record is dropped.
--
-- ONLY SAFE WHILE NO LOCATION HAS EVER BEEN CLOSED. A closed location fails
-- the old constraint, and dropping close_record throws away the only record
-- of which people, zips, Jobber account and Stripe subscription it had — what
-- a reopen needs. Step 0 checks; step 1 refuses on its own if it finds one.
--
-- Run in the Supabase SQL editor, steps in order.

-- ── 0. DRY RUN (read-only) ─────────────────────────────────────────────────
-- Expect closed = 0 and with_record = 0. Anything else: STOP, do not undo.
SELECT count(*) FILTER (WHERE lifecycle_status = 'closed') AS closed,
       count(*) FILTER (WHERE close_record IS NOT NULL)    AS with_record
  FROM locations;

-- ── 1. Undo, one transaction, refuses if anything was ever closed ──────────
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM locations WHERE lifecycle_status = 'closed' OR close_record IS NOT NULL) THEN
    RAISE EXCEPTION 'location_close_undo refused: a location is closed or has a close_record. Reopen it and keep the record.';
  END IF;
END $$;

ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_lifecycle_status_check;
ALTER TABLE locations ADD CONSTRAINT locations_lifecycle_status_check
  CHECK (lifecycle_status = ANY (ARRAY['onboarding'::text, 'active'::text, 'paused'::text, 'inactive'::text]));

ALTER TABLE locations DROP COLUMN IF EXISTS close_record;

COMMIT;

-- ── 2. Check ───────────────────────────────────────────────────────────────
-- Expect the constraint without 'closed' and close_record_exists = false.
SELECT pg_get_constraintdef(oid) AS check_now
  FROM pg_constraint
 WHERE conrelid = 'public.locations'::regclass
   AND conname = 'locations_lifecycle_status_check';

SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'close_record'
) AS close_record_exists;
