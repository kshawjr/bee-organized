-- migrations/nurture_and_mailchimp_choices.sql
--
-- FL-137 + FL-135 (2026-11-28): the owner's choice about ONE person at ONE
-- location — "nurture them?" and "send them to Mailchimp?" — kept on that
-- person's record.
--
-- WHY A MIGRATION: nothing on a person can hold this today. marketing_opt_out
-- is NOT it: that flag means the PERSON said no, it stops Bee Hub's own
-- emails, and it is shared across every location. This is the owner's
-- judgment, and it never stops an email the person asked for.
--
-- WHAT IT ADDS, all on public.leads, all empty (NULL) for everyone:
--   nurture_choice        'in' | 'out' | NULL
--                           in  = in Nurturing now, no 30-day or 90-day wait
--                           out = never in Nurturing, the 30-day catch-all
--                                 included, until a later choice says in
--                           NULL = no choice made: the catch-all decides
--   nurture_choice_at     when it was made
--   nurture_choice_by     the hub user who made it (NULL = Bee Hub itself,
--                           the 35-day auto-close)
--   nurture_choice_how    'closed_lost' | 'auto_close' | 'nurturing_add'
--   mailchimp_choice      'in' | 'out' | NULL — the owner's "send to
--                           Mailchimp?" for this person. 'in' asks for a send;
--                           whether it went is in the existing
--                           mailchimp_status / mailchimp_sync_error columns.
--   mailchimp_choice_at   when
--   mailchimp_choice_by   who (NULL = Bee Hub itself)
--   mailchimp_choice_how  'send_to_jobber' | 'closed_lost' | 'auto_close' | 'nurturing_add'
--
-- DAY ONE: nothing is filled in. Nobody moves into or out of Nurturing and
-- nobody goes to Mailchimp because this ran. Old closes are not answered for
-- anyone (Kevin, 2026-11-28).
--
-- SAFE BEFORE THE CODE: today's code never reads or writes these columns.
-- Run this BEFORE the branch is merged (and before trying the branch
-- preview, which uses the live database).
--
-- NOTHING SENDS when this runs.
--
-- UNDO: migrations/nurture_and_mailchimp_choices_undo.sql
--
-- COUNTS
--   Before: SELECT count(*) FROM information_schema.columns
--             WHERE table_schema='public' AND table_name='leads'
--             AND column_name IN ('nurture_choice','mailchimp_choice');   -- 0
--   After:  the same                                                      -- 2
--           SELECT count(*) FROM public.leads
--             WHERE nurture_choice IS NOT NULL OR mailchimp_choice IS NOT NULL;  -- 0

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'leads'
               AND column_name IN ('nurture_choice', 'nurture_choice_at', 'nurture_choice_by', 'nurture_choice_how',
                                   'mailchimp_choice', 'mailchimp_choice_at', 'mailchimp_choice_by', 'mailchimp_choice_how')) THEN
    RAISE EXCEPTION 'nurture_and_mailchimp_choices.sql has already been run (a column exists). Nothing was changed.';
  END IF;
END
$guard$;

ALTER TABLE public.leads
  ADD COLUMN nurture_choice       text,
  ADD COLUMN nurture_choice_at    timestamptz,
  ADD COLUMN nurture_choice_by    uuid,
  ADD COLUMN nurture_choice_how   text,
  ADD COLUMN mailchimp_choice     text,
  ADD COLUMN mailchimp_choice_at  timestamptz,
  ADD COLUMN mailchimp_choice_by  uuid,
  ADD COLUMN mailchimp_choice_how text;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_nurture_choice_value CHECK (nurture_choice IS NULL OR nurture_choice IN ('in', 'out')),
  ADD CONSTRAINT leads_nurture_choice_how_value CHECK (nurture_choice_how IS NULL OR nurture_choice_how IN ('closed_lost', 'auto_close', 'nurturing_add')),
  -- A choice always says when and how; no half-made choice.
  ADD CONSTRAINT leads_nurture_choice_whole CHECK (
    (nurture_choice IS NULL AND nurture_choice_at IS NULL AND nurture_choice_how IS NULL AND nurture_choice_by IS NULL)
    OR (nurture_choice IS NOT NULL AND nurture_choice_at IS NOT NULL AND nurture_choice_how IS NOT NULL)),
  ADD CONSTRAINT leads_mailchimp_choice_value CHECK (mailchimp_choice IS NULL OR mailchimp_choice IN ('in', 'out')),
  ADD CONSTRAINT leads_mailchimp_choice_how_value CHECK (mailchimp_choice_how IS NULL OR mailchimp_choice_how IN ('send_to_jobber', 'closed_lost', 'auto_close', 'nurturing_add')),
  ADD CONSTRAINT leads_mailchimp_choice_whole CHECK (
    (mailchimp_choice IS NULL AND mailchimp_choice_at IS NULL AND mailchimp_choice_how IS NULL AND mailchimp_choice_by IS NULL)
    OR (mailchimp_choice IS NOT NULL AND mailchimp_choice_at IS NOT NULL AND mailchimp_choice_how IS NOT NULL));

COMMENT ON COLUMN public.leads.nurture_choice IS
  'FL-135/137: the owner''s Nurturing choice for this person. in = in Nurturing now; out = never, catch-all included; NULL = the 30-day catch-all decides. Never the person''s own marketing no (that is marketing_opt_out).';
COMMENT ON COLUMN public.leads.mailchimp_choice IS
  'FL-137: the owner''s Mailchimp choice for this person. in = send them; out = do not. Whether a send happened is mailchimp_status / mailchimp_sync_error.';

COMMIT;
