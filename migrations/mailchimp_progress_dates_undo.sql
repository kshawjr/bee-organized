-- migrations/mailchimp_progress_dates_undo.sql
--
-- UNDO for migrations/mailchimp_progress_dates.sql.
--
-- Drops the two dates from public.locations. Whatever they held is lost:
-- after this, every location reads as "not reviewed" and "never synced", so
-- the next sync asks the first-sync question again (the safe direction).
-- Nobody is removed from Mailchimp and nothing is sent.
--
-- Run the code back to a version that does not read these columns first, or
-- the Mailchimp screen shows "not reviewed" and Done says it could not save.
--
-- CHECK AFTER:
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'locations'
--     AND column_name IN ('mailchimp_review_done_at', 'mailchimp_first_sync_at');
--   -- 0

BEGIN;

ALTER TABLE public.locations
  DROP COLUMN IF EXISTS mailchimp_review_done_at,
  DROP COLUMN IF EXISTS mailchimp_first_sync_at;

COMMIT;
