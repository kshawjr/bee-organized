-- ═══════════════════════════════════════════════════════════════════════════
-- Notification Log — record WHO an email went out as and WHERE replies go.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Additive: two nullable
-- columns on an existing table, no index, no constraint. Idempotent — ADD
-- COLUMN IF NOT EXISTS, safe to re-run.
--
-- WHY. On 2026-09-03 Kansas City reported "every client email still arrives
-- from Lynette" after Moving/Relocation had been handed to Carol. The notebook
-- recorded the recipient, subject and Resend message id but NOT the From line,
-- so the question could not be answered with a query — it took a read of the
-- send path plus a look in the Resend dashboard. With these two columns the
-- next complaint of that shape is:
--
--   SELECT created_at, email_kind, recipient, sender, reply_to
--     FROM public.notification_log
--    WHERE location_slug = 'loc_kc' AND email_kind = 'drip'
--    ORDER BY created_at DESC LIMIT 20;
--
-- WHAT LANDS.
--   sender    the full From line as handed to Resend: "Carol Kern <carol@…>"
--   reply_to  the Reply-To address
-- Written by lib/resend.ts sendEmailDirect() on every EMAIL row, accepted or
-- failed. Slack rows leave both NULL — there is no sender identity on that
-- rail. Rows written before this migration ran are NULL and stay NULL; nothing
-- backfills them, because nothing recorded the value at the time.
--
-- SHIPS-BEFORE-THE-COLUMNS. lib/notification-log.ts names these columns on
-- insert; until this runs PostgREST rejects that insert (PGRST204), and the
-- writer retries once WITHOUT them so the row is still logged exactly as it
-- was before — plus a console.warn naming this file. So the code can deploy
-- ahead of the SQL; the only cost of the gap is rows without sender/reply_to.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.notification_log
  ADD COLUMN IF NOT EXISTS sender   text,
  ADD COLUMN IF NOT EXISTS reply_to text;

COMMENT ON COLUMN public.notification_log.sender   IS 'From line as handed to Resend: "Name <address>". NULL on slack rows and on rows written before 2026-09-03.';
COMMENT ON COLUMN public.notification_log.reply_to IS 'Reply-To address as handed to Resend. NULL on slack rows and on rows written before 2026-09-03.';

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- Expect two new nullable text columns:
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'notification_log' AND column_name IN ('sender', 'reply_to');
--
-- Then wait for the next drip (or POST a test lead at loc_test) and confirm:
-- SELECT created_at, email_kind, recipient, sender, reply_to
--   FROM public.notification_log
--   WHERE channel = 'email' ORDER BY created_at DESC LIMIT 5;
