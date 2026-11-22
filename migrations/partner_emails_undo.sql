-- migrations/partner_emails_undo.sql
--
-- Reverses migrations/partner_emails.sql completely: the two master partner
-- sequences (and any location's copy of them), the partner tracking table, the
-- unsubscribe link and history tables, the three partners columns, the rules
-- and the functions. Nothing else is touched: no client sequence, no client drip row,
-- no other partners column, no location value.
--
-- IT REFUSES TO RUN once the feature has been used, and changes nothing:
--   · if any unsubscribe has ever been recorded (even one later reversed) —
--     that history is the evidence CAN-SPAM compliance turns on, and dropping
--     it would let the person be emailed again. Export it first and decide
--     with Kevin:
--       SELECT * FROM partner_unsubscribes;
--       SELECT id, location_id, name, email, unsubscribed_at, unsubscribe_source, unsubscribed_by
--         FROM partners WHERE unsubscribed_at IS NOT NULL;
--   · if any unsubscribe link has been made (an email may carry it);
--   · if any partner has ever been put on a partner sequence.
--
-- One transaction: all of it or none of it. Paste the whole file into the
-- Supabase SQL editor and run it once.
--
-- Expected after (with the READ-ONLY CHECK at the top of partner_emails.sql):
-- partner_paths 0, and drip_paths / master_paths / steps back to the numbers
-- the BEFORE check showed (79, 12, 238 on 2026-11-22), as long as no location
-- had made its own copy of a partner sequence (a copy is removed too; its
-- steps go with it).

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.partner_drip_progress') IS NULL THEN
    RAISE EXCEPTION 'partner_emails.sql is not in place (no partner_drip_progress). Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partners WHERE unsubscribed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.partner_unsubscribes) THEN
    RAISE EXCEPTION 'A partner has unsubscribed. Undoing would erase that record; export it and ask Kevin first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_unsubscribe_links) THEN
    RAISE EXCEPTION 'An unsubscribe link has been made and may be in an email. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_drip_progress) THEN
    RAISE EXCEPTION 'A partner has been put on a partner sequence. Nothing was changed.';
  END IF;
END
$guard$;

ALTER TABLE public.locations DROP CONSTRAINT locations_default_paths_not_partner;

DROP TRIGGER trg_drip_paths_keep_active_partners ON public.drip_paths;
DROP TRIGGER trg_partners_after_email_change    ON public.partners;
DROP TRIGGER trg_partners_unsubscribe_guard     ON public.partners;

DROP TABLE public.partner_drip_progress;
DROP TABLE public.partner_unsubscribes;
DROP TABLE public.partner_unsubscribe_links;

-- The masters and any location copies (steps go with them: ON DELETE CASCADE).
DELETE FROM public.drip_paths WHERE path_key LIKE 'partner-%';

ALTER TABLE public.partners
  DROP CONSTRAINT partners_unsubscribed_by_check,
  DROP CONSTRAINT partners_unsubscribe_pair_check,
  DROP CONSTRAINT partners_unsubscribe_source_check,
  DROP COLUMN unsubscribed_by,
  DROP COLUMN unsubscribe_source,
  DROP COLUMN unsubscribed_at;

DROP FUNCTION public.drip_paths_keep_active_partners();
DROP FUNCTION public.partner_drip_progress_guard();
DROP FUNCTION public.partners_after_email_change();
DROP FUNCTION public.partner_reverse_unsubscribe(uuid, uuid);
DROP FUNCTION public.partner_mark_unsubscribed(uuid, uuid);
DROP FUNCTION public.partner_unsubscribe(text);
DROP FUNCTION public.partner_unsubscribe_status(text);
DROP FUNCTION public.partner_unsubscribe_token(uuid);
DROP FUNCTION public.partner_send_block_reason(uuid);
DROP FUNCTION public.partner_unsubscribe_links_guard();
DROP FUNCTION public.partner_unsubscribes_guard();
DROP FUNCTION public.partners_unsubscribe_guard();
DROP FUNCTION public.partner_unsubscribe_writer();
DROP FUNCTION public.is_partner_path_key(text);

-- Expect partner_paths 0 and all three tables gone (NULL).
SELECT (SELECT count(*) FROM public.drip_paths WHERE path_key LIKE 'partner-%') AS partner_paths,
       to_regclass('public.partner_drip_progress')                               AS partner_drip_progress,
       to_regclass('public.partner_unsubscribes')                                AS partner_unsubscribes,
       to_regclass('public.partner_unsubscribe_links')                           AS partner_unsubscribe_links;

COMMIT;
