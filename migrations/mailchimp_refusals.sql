-- migrations/mailchimp_refusals.sql
--
-- MAILCHIMP SLICE 6 (FL-75, 2026-11-26): Bee Hub remembers who Mailchimp
-- refused, and stops sending them again silently.
--
-- WHY. Test Location's first sync added 14 people; Mailchimp refused 6 ("looks
-- fake or invalid"). The run told the owner once, then every later Sync now
-- would have sent those 6 again, been refused again, and said nothing. At a
-- real location that is customers who quietly never arrive.
--
-- Kevin's rulings (2026-11-26):
--   • "Asked Mailchimp to forget them" (permanently deleted), unsubscribed,
--     bounced and compliance blocks are people saying no. They go on the
--     EXISTING no-marketing list (marketing_unsubscribes, source 'mailchimp'),
--     with no "Try again". That list stops marketing to the address at every
--     location (slice 2's rule) — only a super admin's reversal clears it.
--   • Only invalid addresses and possibly temporary refusals are remembered
--     here, by ADDRESS, with Edit address, Try again and Leave out on screen.
--
-- WHAT IT ADDS
--   1. public.mailchimp_refusals — one row per location and email address that
--      Mailchimp refused:
--        kind 'invalid'    the address itself ("looks fake or invalid"): held
--                          (not sent again) until the address is edited — a
--                          new address has no row — or the owner presses
--                          Try again (retry_requested_at), which sends it once.
--        kind 'temporary'  anything else Mailchimp said: tried again on the
--                          next sync; held after 3 refusals.
--      mailchimp_said is Mailchimp's own words, shown as Mailchimp's.
--      A row is removed when that address is later added successfully.
--   2. public.marketing_unsubscribe_from_mailchimp(email, location, audience,
--      note) — the no-marketing list's writer for source 'mailchimp' (the list
--      can only be added to through its own functions; this is the "slice 7
--      writer" its migration left room for). Adds one row unless the address is
--      already on the list. Server only.
--
-- WRITES NO ROWS. Nothing existing is changed: no lead, no location, and the
-- no-marketing list is not written by running this (only by the function,
-- later, when a sync meets a "no"). Nothing is sent to Mailchimp.
--
-- WHO CAN WRITE: the server only. RLS on with no policies, browser roles
-- revoked, the function executable by service_role only.
--
-- SAFE TO RUN BEFORE OR AFTER THE CODE. Until it runs, the code reads "no
-- refusals remembered" and syncs exactly as before (refused people are tried
-- again), and a "no" from Mailchimp is only written on the lead record's
-- mailchimp_sync_error, as today.
--
-- UNDO: migrations/mailchimp_refusals_undo.sql
--
-- CHECK AFTER:
--   SELECT to_regclass('public.mailchimp_refusals');                        -- not NULL
--   SELECT count(*) FROM public.mailchimp_refusals;                         -- 0
--   SELECT to_regprocedure('public.marketing_unsubscribe_from_mailchimp(text,uuid,text,text)'); -- not NULL
--   SELECT count(*) FROM public.marketing_unsubscribes;                     -- same as before

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.mailchimp_refusals') IS NOT NULL
     OR to_regprocedure('public.marketing_unsubscribe_from_mailchimp(text,uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'mailchimp_refusals.sql has already been run (its table or function exists). Nothing was changed.';
  END IF;
  IF to_regclass('public.marketing_unsubscribes') IS NULL THEN
    RAISE EXCEPTION 'marketing_unsubscribes is missing: run marketing_unsubscribes.sql first. Nothing was changed.';
  END IF;
END
$guard$;

-- ── 1. Who Mailchimp refused ────────────────────────────────────────────────
CREATE TABLE public.mailchimp_refusals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  email_key          text NOT NULL CHECK (email_key = lower(btrim(email_key)) AND email_key <> ''),
  kind               text NOT NULL CHECK (kind IN ('invalid', 'temporary')),
  mailchimp_code     text,
  mailchimp_said     text NOT NULL CHECK (length(mailchimp_said) BETWEEN 1 AND 1000),
  refused_count      integer NOT NULL DEFAULT 1 CHECK (refused_count >= 1),
  first_refused_at   timestamptz NOT NULL DEFAULT now(),
  last_refused_at    timestamptz NOT NULL DEFAULT now(),
  held               boolean NOT NULL DEFAULT false,
  retry_requested_at timestamptz,
  CONSTRAINT mailchimp_refusals_one_per_address UNIQUE (location_id, email_key)
);
ALTER TABLE public.mailchimp_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mailchimp_refusals FROM PUBLIC, anon, authenticated;

-- ── 2. A "no" from Mailchimp goes on the no-marketing list ──────────────────
-- SECURITY DEFINER so it runs as the list's owner, which is what the list's
-- guard (marketing_unsubscribe_writer) requires. Adds one row, source
-- 'mailchimp', unless the address is already on the list (not reversed).
CREATE FUNCTION public.marketing_unsubscribe_from_mailchimp(p_email text, p_location uuid, p_audience text, p_note text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_email text := nullif(lower(btrim(p_email)), '');
  BEGIN
    IF v_email IS NULL THEN RETURN false; END IF;
    IF public.marketing_address_said_no(v_email) THEN RETURN false; END IF;
    INSERT INTO public.marketing_unsubscribes (email_normalized, source, location_id, mailchimp_audience_id, unsubscribed_at, note)
    VALUES (v_email, 'mailchimp', p_location, nullif(btrim(p_audience), ''), now(), left(p_note, 1000));
    RETURN true;
  END
  $fn$;
REVOKE ALL ON FUNCTION public.marketing_unsubscribe_from_mailchimp(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_unsubscribe_from_mailchimp(text, uuid, text, text) TO service_role;

COMMIT;
