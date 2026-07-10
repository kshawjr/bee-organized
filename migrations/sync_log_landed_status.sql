-- migrations/sync_log_landed_status.sql
-- ─────────────────────────────────────────────────────────────
-- Webhook observability Phase 1: recorded "landed" status.
--
-- RUN THIS BEFORE deploying the code that writes landed_status.
-- (writeSyncLog only includes the column when a value is passed, so
-- non-webhook callers keep working either way — but webhook rows would
-- silently fail to insert until this runs.)
--
-- landed_status semantics (recorded at the END of handler processing by
-- re-reading the record's actual state — not by "no error threw"):
--   'landed'      — the intended record outcome was verified
--                   (row written, engagement attached, stage advanced…)
--   'not_landed'  — processed WITHOUT error but the record did not
--                   reach its intended state (the silent-stuck case)
--   'na'          — processed-only events (no intended record outcome),
--                   no-op destroys, and errored rows (the ✗ + error
--                   message already tell that story)
--   NULL          — rows written before this instrumentation existed
--                   (dashboard renders them as "—")
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.sync_log
  ADD COLUMN IF NOT EXISTS landed_status text
  CONSTRAINT sync_log_landed_status_check
  CHECK (landed_status IN ('landed', 'not_landed', 'na'));

-- "Capture every webhook" includes events we cannot scope to a location:
-- webhooks from unknown/disconnected Jobber accounts, and signature-valid
-- payloads that fail parsing. Those rows carry location_id = NULL.
-- (No-op if the column is already nullable; FK constraints, if any,
-- permit NULL by definition.)
ALTER TABLE public.sync_log
  ALTER COLUMN location_id DROP NOT NULL;

-- Scan indexes for the admin Webhooks dashboard (newest-first inbound
-- feed) and the twice-daily Slack digest (failures + not-landed in a
-- 12h window).
CREATE INDEX IF NOT EXISTS sync_log_inbound_created_idx
  ON public.sync_log (created_at DESC)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS sync_log_attention_idx
  ON public.sync_log (created_at DESC)
  WHERE direction = 'inbound'
    AND (status = 'error' OR landed_status = 'not_landed');

-- ── verification (read-only, run after) ──────────────────────
-- Expect landed_status present + location_id nullable:
--   SELECT column_name, is_nullable, data_type
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'sync_log';
--
-- Sanity-check there is no legacy CHECK constraint on entity_type that
-- would reject 'property' / 'assessment' / 'location' rows (expected:
-- only the new landed_status check and any PK/FK):
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.sync_log'::regclass;
