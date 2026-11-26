-- migrations/mailchimp_refusals_undo.sql
--
-- UNDO for migrations/mailchimp_refusals.sql.
--
-- Drops the refusals table and the no-marketing writer for Mailchimp "no"s.
-- What is lost: which addresses Mailchimp refused, so the next sync tries them
-- again (as before this change). Nobody is removed from Mailchimp, nothing is
-- sent.
--
-- What is NOT undone, on purpose: any row the function already added to the
-- no-marketing list (marketing_unsubscribes, source 'mailchimp'). That list
-- keeps every "no" and only a super admin's reversal clears one
-- (marketing_reverse_unsubscribe). Count them first:
--   SELECT count(*) FROM public.marketing_unsubscribes WHERE source = 'mailchimp';
--
-- Run the code back to a version that does not read these first, or the
-- Mailchimp screen shows no refused list and syncs try refused people again.
--
-- CHECK AFTER:
--   SELECT to_regclass('public.mailchimp_refusals');                                           -- NULL
--   SELECT to_regprocedure('public.marketing_unsubscribe_from_mailchimp(text,uuid,text,text)'); -- NULL

BEGIN;

DROP FUNCTION IF EXISTS public.marketing_unsubscribe_from_mailchimp(text, uuid, text, text);
DROP TABLE IF EXISTS public.mailchimp_refusals;

COMMIT;
