-- migrations/marketing_unsubscribes.sql
--
-- MAILCHIMP SLICE 2 (FL-75, 2026-11-23): an unsubscribe counts everywhere.
--
-- Kevin's ruling: a "no" to marketing at one location stops marketing at EVERY
-- location, matched by email address, across different owners' Mailchimp
-- accounts. Today a "no" lives on one lead record: it dies when that record is
-- deleted and the other 53 locations cannot see it.
--
-- WHAT IT ADDS
--   1. marketing_unsubscribes — the list of addresses that said no, kept apart
--      from the lead records, keyed on the address (lower(trim(email))). One
--      row per "no" event. Never deleted. Only its own functions can add to it.
--      SEPARATE from partner_unsubscribes on purpose: a referral partner saying
--      "stop sending me partner intros" has not asked to leave a location's
--      marketing list. This file does not read, write or name that table's
--      functions.
--   2. Triggers on leads, so no route, import, sync or re-added record can get
--      round the list:
--        · setting "No marketing emails" on a record, or the person pressing the
--          unsubscribe button, adds the address to the list (same transaction);
--        · a NEW record whose address is on the list arrives already marked
--          "No marketing emails" — deleting and re-adding does not clear a no;
--        · changing a record's email TO a listed address marks it too;
--        · clearing "No marketing emails" on a record whose address is still on
--          the list is refused — only a super admin's reversal clears it.
--   3. marketing_address_said_no(email) — the one question every send asks.
--   4. marketing_reverse_unsubscribe(email, by, reason) — the ONLY way back:
--      a super admin, with a written reason. The history row stays, stamped with
--      who, when and why.
--   5. The seed: every record marked "No marketing emails" or unsubscribed
--      today, with a usable address, goes on the list.
--   6. Room for slice 7: source 'mailchimp' and a mailchimp_audience_id column.
--      Nothing pulls from Mailchimp yet; slice 7 adds its own writer function.
--
-- NOTHING SENDS when this runs. No lead record is written by it (the triggers
-- only act on FUTURE writes). The only rows written are the seed rows in the
-- new table.
--
-- HOW TO RUN: run the read-only check below, paste this whole file into the
-- Supabase SQL editor, run it once, run the check again. One transaction: all
-- or nothing. A second run is refused at step 0 and changes nothing.
--
-- READ-ONLY CHECK, run alone BEFORE and AFTER:
--   SELECT (SELECT count(*) FROM leads)                                            AS leads,
--          (SELECT count(*) FROM leads WHERE marketing_opt_out IS TRUE)            AS no_marketing,
--          (SELECT count(*) FROM leads WHERE marketing_unsubscribed_at IS NOT NULL) AS unsubscribed,
--          (SELECT count(*) FROM leads WHERE (marketing_opt_out IS TRUE OR marketing_unsubscribed_at IS NOT NULL)
--                                        AND nullif(btrim(email), '') IS NOT NULL) AS seedable_records,
--          (SELECT count(DISTINCT lower(btrim(email))) FROM leads
--            WHERE (marketing_opt_out IS TRUE OR marketing_unsubscribed_at IS NOT NULL)
--              AND nullif(btrim(email), '') IS NOT NULL)                           AS seedable_addresses,
--          (SELECT count(*) FROM partner_unsubscribes)                             AS partner_list_rows,
--          to_regclass('public.marketing_unsubscribes') IS NOT NULL                AS list_exists;
--   Read at 2026-11-24 01:27 UTC (BEFORE): leads 49,292 (moves daily);
--     no_marketing 32, unsubscribed 6, seedable_records 29,
--     seedable_addresses 29, partner_list_rows 0, list_exists false.
--   Expected AFTER: every figure above the same, list_exists true, and
--     SELECT count(*) FROM marketing_unsubscribes            = seedable_records (29)
--     SELECT count(DISTINCT email_normalized) FROM marketing_unsubscribes = seedable_addresses (29)
--     SELECT source, count(*) FROM marketing_unsubscribes GROUP BY 1  → link 6, marked 23
--   (no_marketing moves if an owner marks someone between the two runs:
--    compare AFTER with the BEFORE you ran a minute earlier.)
--
-- UNDO: migrations/marketing_unsubscribes_undo.sql.

BEGIN;

-- ── 0. Refuse to run twice ──────────────────────────────────────────────────
DO $guard$
BEGIN
  IF to_regclass('public.marketing_unsubscribes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname IN
                ('marketing_address_said_no', 'marketing_reverse_unsubscribe', 'marketing_unsubscribe_writer',
                 'leads_marketing_no_guard', 'leads_marketing_no_record', 'marketing_unsubscribes_guard')) THEN
    RAISE EXCEPTION 'marketing_unsubscribes.sql has already been run (its table or functions exist). Nothing was changed.';
  END IF;
END
$guard$;


-- ── 1. The list ─────────────────────────────────────────────────────────────
CREATE TABLE public.marketing_unsubscribes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized      text NOT NULL CHECK (email_normalized = lower(btrim(email_normalized)) AND email_normalized <> ''),
  -- Where the no came from:
  --   'link'      the person pressed Unsubscribe in a Bee Hub email (from this
  --               slice on, a button press — opening the link changes nothing)
  --   'marked'    "No marketing emails" was set on a record (by someone at the
  --               location, by an import, or carried over by this migration)
  --   'mailchimp' the person unsubscribed inside an owner's Mailchimp account
  --               (slice 7 — nothing writes this yet)
  source                text NOT NULL CHECK (source IN ('link', 'marked', 'mailchimp')),
  -- The record and location it came from. SET NULL, not CASCADE: deleting the
  -- record must not delete the no.
  lead_id               uuid REFERENCES public.leads(id)     ON DELETE SET NULL,
  location_id           uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  mailchimp_audience_id text,                 -- source 'mailchimp' only (slice 7)
  unsubscribed_at       timestamptz NOT NULL,
  note                  text,
  -- A super admin's reversal. All three or none.
  reversed_at           timestamptz,
  reversed_by           uuid,
  reversal_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_unsubscribes_reversal_check CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL) OR
    (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND nullif(btrim(reversal_reason), '') IS NOT NULL)
  ),
  CONSTRAINT marketing_unsubscribes_mailchimp_check CHECK (
    mailchimp_audience_id IS NULL OR source = 'mailchimp'
  )
);
CREATE INDEX idx_marketing_unsubscribes_active
  ON public.marketing_unsubscribes (email_normalized) WHERE reversed_at IS NULL;
CREATE INDEX idx_marketing_unsubscribes_lead ON public.marketing_unsubscribes (lead_id);
-- Server only, like partner_unsubscribes: RLS on, no policies, browser roles
-- revoked. The owner's screens never read this table directly.
ALTER TABLE public.marketing_unsubscribes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_unsubscribes FROM anon, authenticated;


-- ── 2. Who may write the list ───────────────────────────────────────────────
-- Only the functions in this file. They run as the owner of the table
-- (SECURITY DEFINER); the server's routes, an owner's browser, an import or a
-- sync run as another role and are refused.
CREATE FUNCTION public.marketing_unsubscribe_writer() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
  AS $fn$
    SELECT current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
                            WHERE c.oid = 'public.marketing_unsubscribes'::regclass)
  $fn$;

-- The list's rows: added only by the functions; never deleted; facts never
-- change. The only changes allowed: lead_id / location_id cleared when that
-- record or location is deleted (the row stays), and one reversal, by the
-- reversal function.
CREATE FUNCTION public.marketing_unsubscribes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'marketing_unsubscribe_is_kept: a no-marketing record cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NOT public.marketing_unsubscribe_writer() THEN
        RAISE EXCEPTION 'marketing_unsubscribe_via_function_only: the no-marketing list can only be added to through its own functions'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.reversed_at IS NOT NULL THEN
        RAISE EXCEPTION 'marketing_unsubscribe_via_function_only: a no-marketing record cannot arrive already reversed'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
       OR NEW.source IS DISTINCT FROM OLD.source OR NEW.unsubscribed_at IS DISTINCT FROM OLD.unsubscribed_at
       OR NEW.mailchimp_audience_id IS DISTINCT FROM OLD.mailchimp_audience_id
       OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.lead_id IS DISTINCT FROM OLD.lead_id AND NEW.lead_id IS NOT NULL)
       OR (NEW.location_id IS DISTINCT FROM OLD.location_id AND NEW.location_id IS NOT NULL) THEN
      RAISE EXCEPTION 'marketing_unsubscribe_is_kept: a no-marketing record cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reversed_at IS DISTINCT FROM OLD.reversed_at OR NEW.reversed_by IS DISTINCT FROM OLD.reversed_by
       OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason THEN
      IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL OR NOT public.marketing_unsubscribe_writer() THEN
        RAISE EXCEPTION 'marketing_unsubscribe_is_kept: a no can only be reversed once, by a super admin, through its own function'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_marketing_unsubscribes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.marketing_unsubscribes
  FOR EACH ROW EXECUTE FUNCTION public.marketing_unsubscribes_guard();

CREATE FUNCTION public.marketing_unsubscribes_no_truncate() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    RAISE EXCEPTION 'marketing_unsubscribe_is_kept: the no-marketing list cannot be emptied'
      USING ERRCODE = 'check_violation';
  END
  $fn$;
CREATE TRIGGER trg_marketing_unsubscribes_no_truncate
  BEFORE TRUNCATE ON public.marketing_unsubscribes
  FOR EACH STATEMENT EXECUTE FUNCTION public.marketing_unsubscribes_no_truncate();


-- ── 3. The one question every send asks ─────────────────────────────────────
-- true = this address said no somewhere and it has not been reversed. Any
-- location, any record, any source.
CREATE FUNCTION public.marketing_address_said_no(p_email text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
    SELECT EXISTS (SELECT 1 FROM public.marketing_unsubscribes u
                    WHERE u.reversed_at IS NULL
                      AND u.email_normalized = nullif(lower(btrim(p_email)), ''))
  $fn$;


-- ── 4. Lead records obey the list ───────────────────────────────────────────
-- BEFORE: a new record (or a record whose email changes) at a listed address
-- arrives marked "No marketing emails"; clearing the mark while the address
-- is still listed is refused. Every send rail already honours
-- marketing_opt_out, so this alone keeps a re-added record quiet.
CREATE FUNCTION public.leads_marketing_no_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_listed boolean := public.marketing_address_said_no(NEW.email);
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF v_listed THEN NEW.marketing_opt_out := true; END IF;
      RETURN NEW;
    END IF;
    IF v_listed AND NEW.email IS DISTINCT FROM OLD.email THEN
      NEW.marketing_opt_out := true;
    END IF;
    IF v_listed AND OLD.marketing_opt_out IS TRUE AND NEW.marketing_opt_out IS NOT TRUE
       AND NOT public.marketing_unsubscribe_writer() THEN
      RAISE EXCEPTION 'marketing_no_is_listed: this email address said no to marketing; only a super admin can reverse it'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_leads_marketing_no_guard
  BEFORE INSERT OR UPDATE OF email, marketing_opt_out ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_marketing_no_guard();

-- AFTER: a new "no" on a record goes on the list, in the same transaction.
--   marketing_unsubscribed_at newly set  → 'link'   (only the unsubscribe
--                                                    button sets it)
--   marketing_opt_out newly true         → 'marked' (unless the address is
--                                                    already listed)
-- A record that changes email while marked adds the new address as well.
CREATE FUNCTION public.leads_marketing_no_record() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_email     text := nullif(lower(btrim(NEW.email)), '');
    v_new_email boolean := TG_OP = 'INSERT' OR v_email IS DISTINCT FROM nullif(lower(btrim(OLD.email)), '');
  BEGIN
    IF v_email IS NULL THEN RETURN NULL; END IF;
    IF NEW.marketing_unsubscribed_at IS NOT NULL
       AND (v_new_email OR OLD.marketing_unsubscribed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.marketing_unsubscribes u
                        WHERE u.email_normalized = v_email AND u.reversed_at IS NULL
                          AND u.source = 'link' AND u.lead_id = NEW.id) THEN
      INSERT INTO public.marketing_unsubscribes (email_normalized, source, lead_id, location_id, unsubscribed_at, note)
      VALUES (v_email, 'link', NEW.id, NEW.location_uuid, NEW.marketing_unsubscribed_at,
              'Pressed Unsubscribe in a Bee Hub email.');
      RETURN NULL;
    END IF;
    IF NEW.marketing_opt_out IS TRUE
       AND (v_new_email OR OLD.marketing_opt_out IS NOT TRUE)
       AND NOT public.marketing_address_said_no(v_email) THEN
      INSERT INTO public.marketing_unsubscribes (email_normalized, source, lead_id, location_id, unsubscribed_at, note)
      VALUES (v_email, 'marked', NEW.id, NEW.location_uuid, now(),
              CASE WHEN TG_OP = 'INSERT' THEN 'Arrived marked No marketing emails on a new record.'
                   ELSE 'No marketing emails was set on the record.' END);
    END IF;
    RETURN NULL;
  END
  $fn$;
CREATE TRIGGER trg_leads_marketing_no_record
  AFTER INSERT OR UPDATE OF email, marketing_opt_out, marketing_unsubscribed_at ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_marketing_no_record();


-- ── 5. The only way back: a super admin, with a reason ──────────────────────
-- Reverses EVERY active no for the address (any source, any location), clears
-- "No marketing emails" and the unsubscribed date on every record at that
-- address, and keeps the history rows with who / when / why. A person's own
-- unsubscribe is reversible ONLY this way — for when they ask to come back
-- (the unsubscribe page tells them to reply and ask), or when a no was a
-- mistake (before this slice, a mail scanner opening the link unsubscribed).
--   outcome = 'reversed' | 'not_super_admin' | 'reason_required' | 'not_listed'
CREATE FUNCTION public.marketing_reverse_unsubscribe(p_email text, p_by uuid, p_reason text)
  RETURNS TABLE (outcome text, rows_reversed int, records_cleared int)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_email   text := nullif(lower(btrim(p_email)), '');
    v_now     timestamptz := now();
    v_rows    int;
    v_records int;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.hub_users h WHERE h.id = p_by AND h.role = 'super_admin') THEN
      RETURN QUERY SELECT 'not_super_admin'::text, 0, 0; RETURN;
    END IF;
    IF nullif(btrim(p_reason), '') IS NULL THEN
      RETURN QUERY SELECT 'reason_required'::text, 0, 0; RETURN;
    END IF;
    UPDATE public.marketing_unsubscribes
       SET reversed_at = v_now, reversed_by = p_by, reversal_reason = btrim(p_reason)
     WHERE email_normalized = v_email AND reversed_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      RETURN QUERY SELECT 'not_listed'::text, 0, 0; RETURN;
    END IF;
    UPDATE public.leads
       SET marketing_opt_out = false, marketing_unsubscribed_at = NULL, updated_at = v_now
     WHERE lower(btrim(email)) = v_email
       AND (marketing_opt_out IS TRUE OR marketing_unsubscribed_at IS NOT NULL);
    GET DIAGNOSTICS v_records = ROW_COUNT;
    RETURN QUERY SELECT 'reversed'::text, v_rows, v_records;
  END
  $fn$;

REVOKE ALL ON FUNCTION public.marketing_address_said_no(text)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.marketing_reverse_unsubscribe(text, uuid, text)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_marketing_no_record()                      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_address_said_no(text)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.marketing_reverse_unsubscribe(text, uuid, text) TO service_role;


-- ── 6. The seed: today's no's go on the list ────────────────────────────────
-- One row per record with a usable address. Records with no email stay
-- protected by their own mark (there is no address to list).
--   unsubscribed (pressed the old link)  → 'link', dated when it happened
--   "No marketing emails" only           → 'marked', dated now (the mark has
--                                          no date of its own)
INSERT INTO public.marketing_unsubscribes (email_normalized, source, lead_id, location_id, unsubscribed_at, note)
SELECT lower(btrim(l.email)),
       CASE WHEN l.marketing_unsubscribed_at IS NOT NULL THEN 'link' ELSE 'marked' END,
       l.id,
       l.location_uuid,
       coalesce(l.marketing_unsubscribed_at, now()),
       CASE WHEN l.marketing_unsubscribed_at IS NOT NULL
            THEN 'Carried over 2026-11: opened the unsubscribe link before it needed a button press (may have been a mail scanner).'
            ELSE 'Carried over 2026-11 from the record''s No marketing emails mark.' END
  FROM public.leads l
 WHERE (l.marketing_opt_out IS TRUE OR l.marketing_unsubscribed_at IS NOT NULL)
   AND nullif(btrim(l.email), '') IS NOT NULL
 ORDER BY l.id;


-- ── 7. Show what was added, then finish ─────────────────────────────────────
-- Expect one row per source; total rows = seedable_records, addresses =
-- seedable_addresses from the check at the top.
SELECT source, count(*) AS rows, count(DISTINCT email_normalized) AS addresses,
       (SELECT count(*) FROM public.marketing_unsubscribes) AS total_rows,
       (SELECT count(DISTINCT email_normalized) FROM public.marketing_unsubscribes) AS total_addresses
  FROM public.marketing_unsubscribes
 GROUP BY source
 ORDER BY source;

COMMIT;
