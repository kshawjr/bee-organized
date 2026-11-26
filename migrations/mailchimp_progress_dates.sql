-- migrations/mailchimp_progress_dates.sql
--
-- MAILCHIMP SLICE 6 (FL-75, 2026-11-26): two dates on each location that say
-- how far its Mailchimp set-up has got. Kevin's ruling (option B): these
-- dates, not sync_log, decide what is done.
--
-- WHY
--   The first version wrote a "review finished" row and a "first sync
--   finished" row to sync_log. sync_log's own rules refuse both (its direction,
--   entity_type and status columns only take Jobber-era words), so neither
--   could ever be saved: Done on "Who goes to Mailchimp" never ticked step 1,
--   and a finished first sync would have asked the first-sync question again
--   every time. sync_log is NOT widened; these two dates replace those rows.
--
-- WHAT IT ADDS (two empty columns on public.locations, nothing else)
--   mailchimp_review_done_at  — set when the owner presses Done on
--                               "Who goes to Mailchimp". Empty = not reviewed.
--   mailchimp_first_sync_at   — set once, when a first sync FULLY finishes
--                               (every batch sent, every tag applied). A sync
--                               that stops partway never sets it. Empty =
--                               the next sync is a first sync, and asks.
--
-- WRITES NO ROWS. Every location starts with both dates empty, which is the
-- truth today: no location has a saved review or a finished first sync.
-- No other column, table, rule or sending switch (mailchimp_sync_live) is
-- read or changed. Nothing is sent to Mailchimp.
--
-- SAFE TO RUN BEFORE OR AFTER THE CODE. Until it runs, the code reads the
-- dates as "not yet" (so it only ever asks for more confirmation, never
-- less) and Done says plainly that it could not save.
--
-- UNDO: migrations/mailchimp_progress_dates_undo.sql
--
-- CHECK AFTER:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'locations'
--     AND column_name IN ('mailchimp_review_done_at', 'mailchimp_first_sync_at')
--   ORDER BY column_name;
--   -- two rows: timestamp with time zone, YES, (no default)
--
--   SELECT count(*) FILTER (WHERE mailchimp_review_done_at IS NOT NULL) AS reviewed,
--          count(*) FILTER (WHERE mailchimp_first_sync_at IS NOT NULL)  AS first_synced
--   FROM public.locations;
--   -- 0, 0

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'locations'
               AND column_name IN ('mailchimp_review_done_at', 'mailchimp_first_sync_at')) THEN
    RAISE EXCEPTION 'mailchimp_progress_dates.sql has already been run (a column exists). Nothing was changed.';
  END IF;
END
$guard$;

ALTER TABLE public.locations
  ADD COLUMN mailchimp_review_done_at timestamptz,
  ADD COLUMN mailchimp_first_sync_at  timestamptz;

COMMENT ON COLUMN public.locations.mailchimp_review_done_at IS
  'When the owner last pressed Done on "Who goes to Mailchimp". Empty = not reviewed. (FL-75 slice 6)';
COMMENT ON COLUMN public.locations.mailchimp_first_sync_at IS
  'When the first Mailchimp sync fully finished. Set once; a partial sync never sets it. Empty = next sync is a first sync. (FL-75 slice 6)';

COMMIT;
