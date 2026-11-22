-- migrations/partner_emails_undo.sql
--
-- Reverses migrations/partner_emails.sql completely: the two master partner
-- sequences (and any location's copy of them), the partner tracking table, the
-- unsubscribe record table, the two partners columns, the rules and the
-- functions. Nothing else is touched: no client sequence, no client drip row,
-- no other partners column, no location value.
--
-- IT REFUSES TO RUN once the feature has been used, and changes nothing:
--   · if any partner has unsubscribed — that record is the evidence CAN-SPAM
--     compliance turns on, and dropping it would let the person be emailed
--     again. Export it first and decide with Kevin:
--       SELECT * FROM partner_unsubscribes WHERE unsubscribed_at IS NOT NULL;
--       SELECT id, location_id, name, email, unsubscribed_at, unsubscribe_source
--         FROM partners WHERE unsubscribed_at IS NOT NULL;
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
     OR EXISTS (SELECT 1 FROM public.partner_unsubscribes WHERE unsubscribed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A partner has unsubscribed. Undoing would erase that record; export it and ask Kevin first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_drip_progress) THEN
    RAISE EXCEPTION 'A partner has been put on a partner sequence. Nothing was changed.';
  END IF;
END
$guard$;

ALTER TABLE public.locations DROP CONSTRAINT locations_default_paths_not_partner;

DROP TRIGGER trg_drip_paths_keep_active_partners ON public.drip_paths;
DROP TRIGGER trg_partners_after_unsubscribe     ON public.partners;
DROP TRIGGER trg_partners_unsubscribe_is_final  ON public.partners;

DROP TABLE public.partner_drip_progress;
DROP TABLE public.partner_unsubscribes;

-- The masters and any location copies (steps go with them: ON DELETE CASCADE).
DELETE FROM public.drip_paths WHERE path_key LIKE 'partner-%';

ALTER TABLE public.partners
  DROP CONSTRAINT partners_unsubscribe_pair_check,
  DROP CONSTRAINT partners_unsubscribe_source_check,
  DROP COLUMN unsubscribe_source,
  DROP COLUMN unsubscribed_at;

DROP FUNCTION public.drip_paths_keep_active_partners();
DROP FUNCTION public.partner_drip_progress_guard();
DROP FUNCTION public.partner_unsubscribes_is_final();
DROP FUNCTION public.partners_after_unsubscribe();
DROP FUNCTION public.partners_unsubscribe_is_final();
DROP FUNCTION public.partner_unsubscribe(text);
DROP FUNCTION public.partner_unsubscribe_token(uuid);
DROP FUNCTION public.partner_send_block_reason(uuid);
DROP FUNCTION public.is_partner_path_key(text);

-- Expect partner_paths 0 and both tables gone (NULL).
SELECT (SELECT count(*) FROM public.drip_paths WHERE path_key LIKE 'partner-%') AS partner_paths,
       to_regclass('public.partner_drip_progress')                               AS partner_drip_progress,
       to_regclass('public.partner_unsubscribes')                                AS partner_unsubscribes;

COMMIT;
