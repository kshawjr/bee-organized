-- import_resume_after.sql
-- ─────────────────────────────────────────────────────────────
-- PURPOSE: one column backing the sample-now / bulk-later onboarding import.
--
-- A `mode=sample` import writes a small curated slice (~75 clients) during
-- the onboarding call, then PARKS the still-'running' job by setting
-- resume_after to the next off-hours window. Everything that resumes an
-- import — the cron sweeper, the browser poller's re-POST, a manual
-- "Start Import" click — checks this column and waits until the timestamp
-- has passed, so the bulk remainder runs overnight instead of saturating
-- Supabase mid-day (the 2026-07-22 504s).
--
-- NULL resume_after means "resume now". Every existing row and every
-- normal (non-sample) import keeps NULL, so current behavior is unchanged:
-- the sweeper re-pokes immediately, the poller auto-continues, manual
-- POSTs resume — exactly as today.
--
-- A non-null resume_after in the PAST also means "resume now" (the parked
-- window has opened); it additionally tells the write phase this is the
-- deferred bulk run, which paces its writes (~250ms/record) so the app
-- stays responsive if someone logs in mid-run.
--
-- ROLLBACK:
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS resume_after;
-- (Code tolerates the column's absence only at the type level — deploy the
-- app code and this column together; the column is additive and safe to
-- add before the deploy.)
-- ─────────────────────────────────────────────────────────────

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS resume_after timestamptz;

COMMENT ON COLUMN import_jobs.resume_after IS
  'Parked-until timestamp for sample-now/bulk-later imports. NULL = resume immediately (all pre-existing behavior). Future = job is parked; sweeper/poller/POST wait. Past non-null = deferred bulk run in progress (write pacing on).';
