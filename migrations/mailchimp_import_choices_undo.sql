-- migrations/mailchimp_import_choices_undo.sql
--
-- Undoes migrations/mailchimp_import_choices.sql: removes the table of
-- owners' ticks on the "Who comes in from Mailchimp" screen, and its guard.
--
-- WHAT IS LOST: every tick owners have changed on that screen. Everyone new
-- goes back to the default (ticked). Nobody already brought in is touched,
-- no lead record is touched, and nothing in Mailchimp is touched.
--
-- Save them first if anyone has used the screen:
--   SELECT * FROM public.mailchimp_import_choices ORDER BY location_id, scope, key;
--
-- CHECK AFTER: SELECT to_regclass('public.mailchimp_import_choices');  -- NULL

BEGIN;

DROP TABLE IF EXISTS public.mailchimp_import_choices;   -- its trigger goes with it
DROP FUNCTION IF EXISTS public.mailchimp_import_choices_guard();

COMMIT;
