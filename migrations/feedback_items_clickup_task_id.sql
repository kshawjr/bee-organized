-- migrations/feedback_items_clickup_task_id.sql
--
-- Bee Desk ↔ ClickUp two-way sync (ClickUp task 868mm1h7z).
--
-- RUN and verified live by Kevin (reported 2026-10-22). This file now reads
-- as the corrected form — see THE LOCKS below. Re-running it is safe: the
-- column and index are IF NOT EXISTS, and the CHECK is dropped and re-added
-- with the same twelve values.
--
-- Two changes:
--
--   1. feedback_items.clickup_task_id — nullable text. The id ClickUp returns
--      when triage creates a task for an owner's item (lib/clickup-sync). Null
--      means "no task yet", which is every existing row: no backfill.
--      A partial UNIQUE index keeps one task per item and one item per task —
--      two Bee Desk rows pointing at the same ClickUp task would mean one
--      ClickUp close replies to two owners.
--
--   2. sync_log.entity_type gains 'feedback'. Every outbound create and every
--      inbound ClickUp webhook writes a sync_log row with that entity type.
--      Without this the CHECK rejects those rows and writeSyncLog swallows the
--      rejection — the exact silence the sync_log rule exists to prevent (a
--      failed sync here means an owner never hears back). The set below is the
--      one migrations/sync_log_entity_type_extend.sql installed, plus
--      'feedback'.
--
-- THE LOCKS. DROP CONSTRAINT and ADD CONSTRAINT both take an ACCESS EXCLUSIVE
-- lock on sync_log, and Postgres holds every lock until its transaction ends.
-- A VALIDATE inside that same transaction therefore scans the whole table
-- while ACCESS EXCLUSIVE is still held, and every webhook insert waits behind
-- it — NOT VALID buys nothing there. So the VALIDATE runs in its OWN
-- transaction after the COMMIT: the swap itself is instant (NOT VALID skips
-- the scan), and the scan then runs under SHARE UPDATE EXCLUSIVE, which lets
-- inserts keep landing. Between the two commits the new CHECK is already
-- enforced on new rows; it is only marked unvalidated for the old ones.
--
-- THE COST OF SPLITTING. If the VALIDATE fails (an old row carries a value
-- the list below omits), the first transaction has already committed: the
-- CHECK stays in force for NEW rows, and any writer of the omitted value is
-- silently rejected by writeSyncLog's catch. Read the live definition first
-- (pg_get_constraintdef, in VERIFY below) and make sure every value in it is
-- in this list.
--
-- ORDER: run this BEFORE the code deploys. The code reads clickup_task_id with
-- its own query and degrades loudly (a sync_log error, no task) when the column
-- is missing, so a deploy-first never breaks triage — but no task is created
-- until this runs.

BEGIN;

ALTER TABLE public.feedback_items
  ADD COLUMN IF NOT EXISTS clickup_task_id text;

CREATE UNIQUE INDEX IF NOT EXISTS feedback_items_clickup_task_id_key
  ON public.feedback_items (clickup_task_id)
  WHERE clickup_task_id IS NOT NULL;

COMMENT ON COLUMN public.feedback_items.clickup_task_id IS
  'ClickUp task created for this item at triage (list 901111225249). Null = no task. Written by lib/clickup-sync, read by the ClickUp webhook as a cross-check.';

ALTER TABLE public.sync_log
  DROP CONSTRAINT IF EXISTS sync_log_entity_type_check;

ALTER TABLE public.sync_log
  ADD CONSTRAINT sync_log_entity_type_check
  CHECK (entity_type IN (
    'client', 'request', 'quote', 'job', 'invoice',
    'payment', 'note', 'location', 'property', 'assessment',
    'engagement', 'feedback'
  )) NOT VALID;

COMMIT;

-- Its own transaction — see THE LOCKS above.
BEGIN;

ALTER TABLE public.sync_log
  VALIDATE CONSTRAINT sync_log_entity_type_check;

COMMIT;


-- ─── VERIFY AFTER RUNNING (read-only) ────────────────────────────────
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'feedback_items'
--     AND column_name = 'clickup_task_id';
--   -- expect: one row, text, YES
--
--   SELECT count(*) FROM feedback_items WHERE clickup_task_id IS NOT NULL;
--   -- expect: 0
--
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.sync_log'::regclass
--     AND conname = 'sync_log_entity_type_check';
--   -- expect: the twelve values, 'feedback' last
--
-- The undo is migrations/feedback_items_clickup_task_id_undo.sql.
