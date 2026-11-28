-- migrations/nurture_and_mailchimp_choices_undo.sql
--
-- Undoes migrations/nurture_and_mailchimp_choices.sql: removes the eight
-- choice columns from public.leads.
--
-- RUN THE CODE BACK FIRST: the FL-137/135 code reads these columns, so put
-- main back to before it, then run this.
--
-- WHAT IS LOST: every Nurturing and Mailchimp choice owners have made since.
-- People ticked in go back to the 30-day catch-all; people left unticked can
-- be pulled in by it again. Nobody already sent to Mailchimp is removed from
-- Mailchimp, and nothing in Mailchimp is touched.
--
-- Save them first if anyone has used it:
--   SELECT id, location_id, nurture_choice, nurture_choice_at, nurture_choice_by, nurture_choice_how,
--          mailchimp_choice, mailchimp_choice_at, mailchimp_choice_by, mailchimp_choice_how
--   FROM public.leads WHERE nurture_choice IS NOT NULL OR mailchimp_choice IS NOT NULL;
--
-- CHECK AFTER: SELECT count(*) FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='leads'
--   AND column_name LIKE ANY (ARRAY['nurture_choice%', 'mailchimp_choice%']);   -- 0

BEGIN;

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_nurture_choice_value,
  DROP CONSTRAINT IF EXISTS leads_nurture_choice_how_value,
  DROP CONSTRAINT IF EXISTS leads_nurture_choice_whole,
  DROP CONSTRAINT IF EXISTS leads_mailchimp_choice_value,
  DROP CONSTRAINT IF EXISTS leads_mailchimp_choice_how_value,
  DROP CONSTRAINT IF EXISTS leads_mailchimp_choice_whole,
  DROP COLUMN IF EXISTS nurture_choice,
  DROP COLUMN IF EXISTS nurture_choice_at,
  DROP COLUMN IF EXISTS nurture_choice_by,
  DROP COLUMN IF EXISTS nurture_choice_how,
  DROP COLUMN IF EXISTS mailchimp_choice,
  DROP COLUMN IF EXISTS mailchimp_choice_at,
  DROP COLUMN IF EXISTS mailchimp_choice_by,
  DROP COLUMN IF EXISTS mailchimp_choice_how;

COMMIT;
