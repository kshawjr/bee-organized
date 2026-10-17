-- migrations/welcome_skip_overdue_undo.sql
--
-- Reverses migrations/welcome_skip_overdue.sql: puts each skipped welcome back
-- on its original schedule, removes the timeline notes, clears the skip columns.
--
-- CAUTION: once the send-drips cache fix is live, restoring the schedule means
-- the cron SENDS these welcomes on its next hourly run — every one of them late.
-- Only run this if that is what you want.
--
-- Steps 1–2 in order. 3 (dropping the columns) is optional and separate.

-- ── 1. Restore + remove notes, ONE statement ───────────────────────────────
WITH restored AS (
  UPDATE leads l
     SET welcome_email_scheduled_at   = l.welcome_email_skipped_due_at,
         welcome_email_skipped_at     = NULL,
         welcome_email_skip_reason    = NULL,
         welcome_email_skipped_due_at = NULL,
         updated_at                   = now()
   WHERE l.welcome_email_skip_reason = 'overdue_send_fault_2026_10'
     AND l.welcome_email_sent_at IS NULL
  RETURNING l.id
)
DELETE FROM touchpoints t
 USING restored r
 WHERE t.lead_id = r.id AND t.kind = 'system' AND t.label = 'Welcome email not sent'
RETURNING t.lead_id;

-- ── 2. Verify ──────────────────────────────────────────────────────────────
-- Expect still_skipped = 0, notes_left = 0.
SELECT
  (SELECT count(*) FROM leads WHERE welcome_email_skip_reason = 'overdue_send_fault_2026_10') AS still_skipped,
  (SELECT count(*) FROM touchpoints WHERE kind = 'system' AND label = 'Welcome email not sent') AS notes_left;

-- ── 3. Optional: drop the columns (only if no other skip has used them) ────
-- ALTER TABLE leads DROP COLUMN IF EXISTS welcome_email_skipped_at;
-- ALTER TABLE leads DROP COLUMN IF EXISTS welcome_email_skip_reason;
-- ALTER TABLE leads DROP COLUMN IF EXISTS welcome_email_skipped_due_at;
