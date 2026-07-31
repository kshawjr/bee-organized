-- migrations/sync_log_status_partial.sql
-- ─────────────────────────────────────────────────────────────
-- issue 145 — admit 'partial' as a sync_log.status value.
--
-- Background: send-to-jobber's terminal sync_log row was hard-coded
-- status:'success', so a send whose CORE succeeded (client/request/
-- assessment/job created) but whose team/salesperson assignment silently
-- failed still reported clean. That is the 3-week silence issue 145 closes:
-- the send path now reports 'partial' when a sub-step degraded — 'success'
-- hid it, and 'error' would falsely imply the whole send failed.
--
-- Like the 2026-07-10 entity_type fix, sync_log carries CHECK constraints
-- that fail-soft-reject unknown values (the writeSyncLog catch swallows the
-- error), so a 'partial' write would VANISH — re-creating the very silence
-- this issue fixes — if a status CHECK exists and still lists only
-- ('success','error'). pg_constraint isn't readable via PostgREST, so
-- whether a status CHECK exists today could not be confirmed from the app.
-- This migration is written to be correct either way:
--   · DROP ... IF EXISTS is a no-op when no status CHECK exists (the
--     constraint would follow Postgres's auto-name sync_log_status_check,
--     matching the confirmed sync_log_entity_type_check);
--   · the re-ADD then guarantees ('success','error','partial') is enforced.
--
-- SAFE AGAINST EXISTING DATA: verified read-only 2026-07-31 that all 16,079
-- sync_log rows have status IN ('success','error') — none violate the new
-- CHECK, so the ADD validates cleanly.
--
-- ORDER-GATED: apply this WITH the deploy. If the code ships first and a
-- status CHECK exists, 'partial' terminal rows fail-soft-drop until this runs.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.sync_log
  DROP CONSTRAINT IF EXISTS sync_log_status_check;

ALTER TABLE public.sync_log
  ADD CONSTRAINT sync_log_status_check
  CHECK (status IN ('success', 'error', 'partial'));

-- Verification (read-only, run after):
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.sync_log'::regclass
--     AND conname = 'sync_log_status_check';
--   -- expect: CHECK (status = ANY (ARRAY['success','error','partial']))
