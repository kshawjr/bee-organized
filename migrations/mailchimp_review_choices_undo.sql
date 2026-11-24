-- migrations/mailchimp_review_choices_undo.sql
--
-- Undoes migrations/mailchimp_review_choices.sql: removes the table of owners'
-- choices on the "Who goes to Mailchimp" screen, and its guard.
--
-- WHAT IS LOST: every choice owners have made on that screen. Everyone goes
-- back to the default (ticked, except archived people). Nothing in Mailchimp
-- and no lead record is touched.
--
-- Save them first if anyone has used the screen:
--   SELECT * FROM public.mailchimp_review_choices ORDER BY location_id, scope, key;
--
-- CHECK AFTER: SELECT to_regclass('public.mailchimp_review_choices');  -- NULL

BEGIN;

DROP TABLE IF EXISTS public.mailchimp_review_choices;   -- its trigger goes with it
DROP FUNCTION IF EXISTS public.mailchimp_review_choices_guard();

COMMIT;
