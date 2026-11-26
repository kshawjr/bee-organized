-- migrations/mailchimp_import_choices.sql
--
-- MAILCHIMP SLICE 7 (FL-75, 2026-11-26): the owner's ticks on the "Who comes
-- in from Mailchimp" screen survive leaving it, the same way slice 6's ticks
-- on "Who goes to Mailchimp" do (migrations/mailchimp_review_choices.sql).
--
-- WHAT IT ADDS
--   One table, mailchimp_import_choices. One row per choice an owner made on
--   that screen, for one location, ONLY where it differs from the default:
--     scope 'group'  — the "New to Bee Hub" group ticked or unticked
--                      (key = 'new', the only group)
--     scope 'person' — one person ticked or unticked by hand, overriding the
--                      group (key = their email address, lower-cased, trimmed)
--   Everyone new starts ticked. Someone with no row follows the group, and
--   the group with no row is ticked. So the table stays small: an owner who
--   unticks 3 of Chattanooga's 70 writes 3 rows, not 70.
--
-- WHY NOT slice 6's table: mailchimp_review_choices means "send this person
-- TO Mailchimp". Its guard refuses ticking in anyone with no record here, and
-- every person on this screen has no record here, so it would refuse them all.
-- And an "out" saved here would, once the person is brought in, quietly keep
-- them out of Mailchimp on slice 6's screen. Two meanings, two tables.
--
-- A SAVED TICK IS NEVER TRUSTED ON ITS OWN. The import re-checks every rule
-- (staff, already in Bee Hub, held, bounced, Recycle Bin) when it runs. A row
-- here can only keep someone OUT; it can never let anyone past a rule.
--
-- THE GUARD (by any route, not only the screen)
--   A person can't be ticked IN if a record outside the Recycle Bin at this
--   location already has their address: they are already in Bee Hub, so
--   their choice is spent. (Ticking OUT is always allowed.) The import also
--   deletes a person's row once they are brought in.
--
-- WHO CAN WRITE
--   Only the server (service role). Row level security is on with no
--   policies, and anon/authenticated have no rights.
--
-- NOTHING SENDS when this runs, and it writes no rows. No lead record and no
-- other table is touched.
--
-- UNDO: migrations/mailchimp_import_choices_undo.sql
--
-- COUNTS
--   Before: SELECT to_regclass('public.mailchimp_import_choices');  -- NULL
--   After:  SELECT to_regclass('public.mailchimp_import_choices');  -- not NULL
--           SELECT count(*) FROM public.mailchimp_import_choices;   -- 0
--           SELECT count(*) FROM public.mailchimp_review_choices;   -- unchanged (0 on 2026-11-26)

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.mailchimp_import_choices') IS NOT NULL THEN
    RAISE EXCEPTION 'mailchimp_import_choices.sql has already been run (the table exists). Nothing was changed.';
  END IF;
END
$guard$;

CREATE TABLE public.mailchimp_import_choices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('group', 'person')),
  key         text NOT NULL CHECK (length(key) BETWEEN 1 AND 400),
  choice      text NOT NULL CHECK (choice IN ('in', 'out')),
  chosen_by   uuid,
  chosen_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailchimp_import_choices_one_per_key UNIQUE (location_id, scope, key),
  CONSTRAINT mailchimp_import_choices_group_key CHECK (scope <> 'group' OR key = 'new'),
  -- A person's key is their address as the rules read it: lower-case, trimmed.
  CONSTRAINT mailchimp_import_choices_person_key CHECK (scope <> 'person' OR key = lower(btrim(key)))
);

ALTER TABLE public.mailchimp_import_choices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mailchimp_import_choices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mailchimp_import_choices TO service_role;

CREATE FUNCTION public.mailchimp_import_choices_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
BEGIN
  IF NEW.scope = 'person' AND NEW.choice = 'in' THEN
    IF EXISTS (
      SELECT 1 FROM public.leads l
       WHERE l.location_uuid = NEW.location_id
         AND lower(btrim(l.email)) = NEW.key
         AND l.is_junk IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'mailchimp_import_already_here: this address is already in Bee Hub at this location'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER trg_mailchimp_import_choices_guard
  BEFORE INSERT OR UPDATE ON public.mailchimp_import_choices
  FOR EACH ROW EXECUTE FUNCTION public.mailchimp_import_choices_guard();

REVOKE ALL ON FUNCTION public.mailchimp_import_choices_guard() FROM PUBLIC, anon, authenticated;

COMMIT;
