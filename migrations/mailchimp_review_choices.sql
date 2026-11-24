-- migrations/mailchimp_review_choices.sql
--
-- MAILCHIMP SLICE 5 (FL-75, 2026-11-24): the owner's choices on the
-- "Who goes to Mailchimp" screen survive leaving it.
--
-- WHAT IT ADDS
--   One table, mailchimp_review_choices. One row per choice an owner made on
--   that screen, for one location:
--     scope 'group'  — a whole group ticked or unticked
--                      (key = the group's name, e.g. 'archived', 'worked',
--                       'added:2024-11-15', 'never_other')
--     scope 'person' — one person ticked or unticked by hand, overriding their
--                      group (key = their email address, lower-cased, trimmed)
--     scope 'phone'  — the owner's answer to "Is this the same person?" for a
--                      phone-only match (key = '<mailchimp member id>|<address>',
--                      choice 'same' or 'different'). Nothing is joined: it is
--                      only the answer, kept.
--   A group or person with no row follows its default (everyone ticked, except
--   archived people, who start unticked). That is why the table stays small:
--   18,922 people at Philadelphia Suburbs are a handful of group rows, not
--   18,922 ticks.
--
-- THE GUARD (by any route, not only the screen)
--   A person can never be ticked IN if their address cannot be marketed to:
--   on the shared no-marketing list (marketing_address_said_no), or with no
--   record at this location that is out of the Recycle Bin, not marked "No
--   marketing emails" and not unsubscribed. The insert or update is refused.
--   (Choosing them OUT is always allowed.) Sending re-checks all of this again
--   at send time; this guard means a stored tick can never say otherwise.
--
-- WHO CAN WRITE
--   Only the server (service role). Row level security is on with no
--   policies, and anon/authenticated have no rights: a browser cannot read or
--   write this table directly.
--
-- NOTHING SENDS when this runs, and it writes no rows. No lead record and no
-- other table is touched. The sending switch (mailchimp_sync_live) is not
-- read or changed.
--
-- NEEDS FIRST: migrations/marketing_unsubscribes.sql (for
-- marketing_address_said_no). The guard below stops if it is missing.
--
-- UNDO: migrations/mailchimp_review_choices_undo.sql
--
-- CHECK AFTER:
--   SELECT to_regclass('public.mailchimp_review_choices');   -- not NULL
--   SELECT count(*) FROM public.mailchimp_review_choices;    -- 0

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.mailchimp_review_choices') IS NOT NULL THEN
    RAISE EXCEPTION 'mailchimp_review_choices.sql has already been run (the table exists). Nothing was changed.';
  END IF;
  IF to_regprocedure('public.marketing_address_said_no(text)') IS NULL THEN
    RAISE EXCEPTION 'marketing_address_said_no(text) is missing: run marketing_unsubscribes.sql first. Nothing was changed.';
  END IF;
END
$guard$;

CREATE TABLE public.mailchimp_review_choices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('group', 'person', 'phone')),
  key         text NOT NULL CHECK (length(key) BETWEEN 1 AND 400),
  choice      text NOT NULL CHECK (
                (scope IN ('group', 'person') AND choice IN ('in', 'out'))
             OR (scope = 'phone' AND choice IN ('same', 'different'))),
  chosen_by   uuid,
  chosen_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailchimp_review_choices_one_per_key UNIQUE (location_id, scope, key),
  -- A person's key is their address as the rules read it: lower-case, trimmed.
  CONSTRAINT mailchimp_review_choices_person_key CHECK (scope <> 'person' OR key = lower(btrim(key)))
);

ALTER TABLE public.mailchimp_review_choices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mailchimp_review_choices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mailchimp_review_choices TO service_role;

CREATE FUNCTION public.mailchimp_review_choices_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
BEGIN
  IF NEW.scope = 'person' AND NEW.choice = 'in' THEN
    IF public.marketing_address_said_no(NEW.key) THEN
      RAISE EXCEPTION 'mailchimp_review_said_no: this address is on the no-marketing list and can never be ticked'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.location_uuid = NEW.location_id
         AND lower(btrim(l.email)) = NEW.key
         AND l.is_junk IS NOT TRUE
         AND l.marketing_opt_out IS NOT TRUE
         AND l.marketing_unsubscribed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'mailchimp_review_not_offered: no record at this location can be marketed to at this address'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER trg_mailchimp_review_choices_guard
  BEFORE INSERT OR UPDATE ON public.mailchimp_review_choices
  FOR EACH ROW EXECUTE FUNCTION public.mailchimp_review_choices_guard();

REVOKE ALL ON FUNCTION public.mailchimp_review_choices_guard() FROM PUBLIC, anon, authenticated;

COMMIT;
