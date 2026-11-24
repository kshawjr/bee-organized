-- migrations/marketing_unsubscribes_undo.sql
--
-- Undoes migrations/marketing_unsubscribes.sql: removes the shared
-- no-marketing list, its triggers on leads and its functions.
--
-- WHAT IS LOST: the list itself, including any no recorded AFTER the
-- migration ran (a button press, a record marked No marketing emails) and any
-- reversal history. The lead records are NOT touched by this undo: every
-- record's own "No marketing emails" mark and unsubscribed date stay exactly
-- as they are, so every send still refuses those records. What stops working
-- is only the "counts everywhere" part — another record with the same address
-- at another location could be emailed again.
--
-- So: before running it, save the list, so nothing is forgotten:
--   SELECT * FROM marketing_unsubscribes ORDER BY created_at;
-- (Export the result as CSV from the SQL editor.)
--
-- The table refuses DELETE and TRUNCATE; DROP TABLE is not stopped by those
-- triggers, which is what this file uses. One transaction.
--
-- CHECK AFTER: SELECT to_regclass('public.marketing_unsubscribes');  -- NULL
--   and the read-only check at the top of the migration shows the same
--   no_marketing / unsubscribed counts as before the undo.

BEGIN;

DROP TRIGGER IF EXISTS trg_leads_marketing_no_record ON public.leads;
DROP TRIGGER IF EXISTS trg_leads_marketing_no_guard  ON public.leads;
DROP FUNCTION IF EXISTS public.leads_marketing_no_record();
DROP FUNCTION IF EXISTS public.leads_marketing_no_guard();
DROP FUNCTION IF EXISTS public.marketing_reverse_unsubscribe(text, uuid, text);
DROP FUNCTION IF EXISTS public.marketing_address_said_no(text);
DROP TABLE IF EXISTS public.marketing_unsubscribes;   -- its own triggers go with it
DROP FUNCTION IF EXISTS public.marketing_unsubscribes_no_truncate();
DROP FUNCTION IF EXISTS public.marketing_unsubscribes_guard();
DROP FUNCTION IF EXISTS public.marketing_unsubscribe_writer();

COMMIT;
