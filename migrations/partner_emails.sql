-- migrations/partner_emails.sql
--
-- PARTNER EMAILS, SLICE 2 (2026-11-22): the database half. Kevin's "option C":
-- referral partners (the Network's `partners` table) use the SAME sequences as
-- client emails (drip_paths + drip_path_steps, the same master / "Customize
-- these emails?" / Reset to master system), but who-is-on-which-step for a
-- partner lives in its OWN table. The client tracking table is not touched,
-- read or named anywhere in this file.
--
-- NOTHING SENDS WHEN THIS RUNS, and nothing can send afterwards either: no
-- sender, job or screen reads any of this yet (slices 3 and 4).
--
-- WHAT IT ADDS
--   1. partners.unsubscribed_at, unsubscribe_source ('link' | 'owner'),
--      unsubscribed_by — NULL on every existing row. No existing row is written.
--   2. partner_unsubscribe_links — each partner's unsubscribe link key (64
--      random hex, made on first need, never expires, never shown to anyone).
--   3. partner_unsubscribes — the history: one row per unsubscribe, kept by
--      email address so it outlives the contact (purging a contact and adding
--      it again does not undo it). Never deleted. An OWNER's mark can later be
--      reversed by a super admin; the row stays, with who reversed it and when.
--   4. partner_drip_progress — which partner is on which partner sequence, at
--      which step, when the next email is due, and its status (active /
--      stopped / completed / unsubscribed). One row per partner per sequence.
--   (2, 3 and 4 are empty when this runs, and only the server can read them,
--    like the client drip tables: RLS on, no policies.)
--   5. Two MASTER sequences, the same kind of row as every other master, so a
--      location can customise and reset them the same way:
--        partner-introduction        "Partner introduction"        steps 1 + 2
--        partner-power-introduction  "Power Partner introduction"  step 1
--   6. The rules, in the database where no screen, import or sync can skip
--      them:
--        · TWO KINDS OF UNSUBSCRIBE, told apart in the data and impossible to
--          forge: 'link' = the partner pressed the button on the unsubscribe
--          page (permanent: nobody, not even a super admin, can reverse it);
--          'owner' = someone at the location marked them by hand (a super
--          admin can reverse it; the history keeps both events). Only the
--          database functions below can set, change or clear the three
--          columns: a direct write from an owner's browser, a route, an import
--          or a sync is refused, so nobody can label an owner's mark as the
--          partner's own, or the other way round;
--        · an unsubscribed partner can never be put on, or kept on, a partner
--          sequence (insert or update refused), and the same goes for any
--          contact with an unsubscribed email address, at any location;
--        · unsubscribing stops every active partner sequence for that contact
--          and that address;
--        · a partner sequence row must point at a partner sequence, and only at
--          a master or a copy belonging to the partner's own location;
--        · a location's client sequence (default_drip_path /
--          default_move_drip_path) can never be a partner sequence, so client
--          enrolment can never pick one up;
--        · a sequence copy cannot be deleted ("Reset to master") while a
--          partner is still active on it.
--
-- OPENING THE LINK DOES NOT UNSUBSCRIBE (mail scanners open every link).
-- partner_unsubscribe_status only LOOKS (it is declared STABLE, so Postgres
-- itself refuses any write inside it); the page shows a "Stop receiving these
-- emails?" button, and only pressing it (a POST) calls partner_unsubscribe.
--
-- HOW TO RUN: see the hand-over steps in the commit / report. In short: run the
-- read-only check below, paste this whole file into the Supabase SQL editor
-- and run it once, run the check again. It is one transaction: it all happens
-- or none of it does. Running it a second time is refused at step 0 and
-- changes nothing. No step depends on how many partners there are.
--
-- READ-ONLY CHECK, run alone BEFORE and AFTER:
--   SELECT (SELECT count(*) FROM drip_paths)                                 AS drip_paths,
--          (SELECT count(*) FROM drip_paths WHERE is_master)                 AS master_paths,
--          (SELECT count(*) FROM drip_path_steps)                            AS steps,
--          (SELECT count(*) FROM drip_paths WHERE path_key LIKE 'partner-%') AS partner_paths,
--          (SELECT count(*) FROM partners)                                   AS partners_all_rows,
--          (SELECT count(*) FROM partners WHERE deleted_at IS NULL)          AS partners_not_in_recycle_bin,
--          (SELECT count(*) FROM locations)                                  AS locations;
--   Expected on 2026-11-22 BEFORE: 79, 12, 238, 0, 316, 310, 54.
--   Expected AFTER:                81, 14, 241, 2, 316, 310, 54.
--   (The partner numbers move in everyday use: compare AFTER with the BEFORE
--   you ran a minute earlier. They must be equal to each other.)
--
-- UNDO: migrations/partner_emails_undo.sql.

BEGIN;

-- ── 0. Refuse to run twice, or out of order ─────────────────────────────────
DO $guard$
BEGIN
  IF to_regclass('public.partner_drip_progress') IS NOT NULL
     OR to_regclass('public.partner_unsubscribes') IS NOT NULL
     OR to_regclass('public.partner_unsubscribe_links') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'partners'
                   AND column_name IN ('unsubscribed_at', 'unsubscribe_source', 'unsubscribed_by')) THEN
    RAISE EXCEPTION 'partner_emails.sql has already been run (its tables or columns exist). Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.drip_paths WHERE path_key LIKE 'partner-%') THEN
    RAISE EXCEPTION 'A sequence named partner-... already exists. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.locations
              WHERE default_drip_path LIKE 'partner-%' OR default_move_drip_path LIKE 'partner-%') THEN
    RAISE EXCEPTION 'A location already has a partner-... client sequence. Nothing was changed.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'drip_path_steps'
         AND column_name IN ('delay_unit', 'body_format', 'is_paused', 'origin')) <> 4 THEN
    RAISE EXCEPTION 'drip_path_steps is missing delay_unit / body_format / is_paused / origin: run those migrations first. Nothing was changed.';
  END IF;
END
$guard$;


-- ── 1. Which sequences are partner sequences ────────────────────────────────
-- By name: every partner sequence's key starts "partner-". A location's copy
-- keeps its master's key (app/api/locations/[id]/drip-paths/clone), so the
-- copy is a partner sequence too. lib/partner-sequences.ts says the same.
CREATE FUNCTION public.is_partner_path_key(p_key text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $fn$ SELECT coalesce(p_key LIKE 'partner-%', false) $fn$;


-- ── 2. Unsubscribe, on the contact ──────────────────────────────────────────
ALTER TABLE public.partners
  ADD COLUMN unsubscribed_at    timestamptz,
  ADD COLUMN unsubscribe_source text,
  ADD COLUMN unsubscribed_by    uuid;
ALTER TABLE public.partners
  ADD CONSTRAINT partners_unsubscribe_source_check
    CHECK (unsubscribe_source IS NULL OR unsubscribe_source IN ('link', 'owner')),
  ADD CONSTRAINT partners_unsubscribe_pair_check
    CHECK ((unsubscribed_at IS NULL) = (unsubscribe_source IS NULL)),
  -- who marked it: only an owner's mark has a person; the partner's own has none
  ADD CONSTRAINT partners_unsubscribed_by_check
    CHECK ((unsubscribed_by IS NULL) OR (unsubscribe_source = 'owner'));


-- ── 3. The link keys, and the history ───────────────────────────────────────
CREATE TABLE public.partner_unsubscribe_links (
  -- The link's only key: 64 random hex. Never derived from the contact, never
  -- expires (CAN-SPAM: an unsubscribe link must keep working).
  token            text PRIMARY KEY CHECK (token ~ '^[0-9a-f]{64}$'),
  -- SET NULL, not CASCADE: a link in an old email must still work after the
  -- contact is purged (it then records the address).
  partner_id       uuid UNIQUE REFERENCES public.partners(id) ON DELETE SET NULL,
  location_id      uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  email_normalized text,                 -- lower(trim(email)) when the key was made
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.partner_unsubscribe_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_unsubscribe_links FROM anon, authenticated;

CREATE TABLE public.partner_unsubscribes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid REFERENCES public.partners(id) ON DELETE SET NULL,
  location_id      uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  email_normalized text,                 -- the address that is unsubscribed
  source           text NOT NULL CHECK (source IN ('link', 'owner')),
  token            text,                 -- which link was pressed (source 'link'; NULL on an extra address row)
  unsubscribed_at  timestamptz NOT NULL,
  marked_by        uuid,                 -- who, for source 'owner' (hub_users.id)
  reversed_at      timestamptz,          -- an owner's mark reversed by a super admin
  reversed_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_unsubscribes_kind_check CHECK (
    (source = 'link'  AND marked_by IS NULL AND reversed_at IS NULL AND reversed_by IS NULL) OR
    (source = 'owner' AND token IS NULL AND (reversed_at IS NULL) = (reversed_by IS NULL))
  )
);
CREATE INDEX idx_partner_unsubscribes_email
  ON public.partner_unsubscribes (email_normalized) WHERE reversed_at IS NULL;
CREATE INDEX idx_partner_unsubscribes_partner ON public.partner_unsubscribes (partner_id);
CREATE UNIQUE INDEX idx_partner_unsubscribes_one_per_link
  ON public.partner_unsubscribes (token) WHERE token IS NOT NULL;
ALTER TABLE public.partner_unsubscribes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_unsubscribes FROM anon, authenticated;


-- ── 4. Who is on which partner sequence ─────────────────────────────────────
CREATE TABLE public.partner_drip_progress (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     uuid NOT NULL REFERENCES public.partners(id)   ON DELETE CASCADE,
  drip_path_id   uuid NOT NULL REFERENCES public.drip_paths(id) ON DELETE CASCADE,
  -- The sequence's key, filled in from drip_path_id by the guard below. One
  -- row per partner per SEQUENCE: a master and a location's copy of it are the
  -- same sequence, so a partner cannot be on both.
  path_key       text NOT NULL,
  current_step   int  NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'stopped', 'completed', 'unsubscribed')),
  next_send_at   timestamptz,
  last_sent_at   timestamptz,
  started_at     timestamptz NOT NULL DEFAULT now(),
  started_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  stopped_at     timestamptz,
  stopped_reason text,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_drip_progress_one_per_sequence UNIQUE (partner_id, path_key),
  CONSTRAINT partner_drip_progress_status_dates CHECK (
    (status = 'active'       AND stopped_at IS NULL AND completed_at IS NULL) OR
    (status = 'completed'    AND completed_at IS NOT NULL) OR
    (status IN ('stopped', 'unsubscribed') AND stopped_at IS NOT NULL)
  )
);
CREATE INDEX idx_partner_drip_progress_partner ON public.partner_drip_progress (partner_id);
CREATE INDEX idx_partner_drip_progress_path    ON public.partner_drip_progress (drip_path_id);
-- The future sender's "what is due now?"
CREATE INDEX idx_partner_drip_progress_due
  ON public.partner_drip_progress (next_send_at)
  WHERE status = 'active';
ALTER TABLE public.partner_drip_progress ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_partner_drip_progress_updated_at
  BEFORE UPDATE ON public.partner_drip_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ── 5. Who may write an unsubscribe ─────────────────────────────────────────
-- Only the functions in section 6. They run as the owner of these tables
-- (SECURITY DEFINER); everybody else — an owner's browser session, the
-- server's routes, an import, a sync — runs as another role and is refused.
CREATE FUNCTION public.partner_unsubscribe_writer() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
  AS $fn$
    SELECT current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
                            WHERE c.oid = 'public.partner_unsubscribes'::regclass)
  $fn$;

-- The contact's three columns: only the functions may set, change or clear
-- them; and a partner's own unsubscribe ('link') never changes, whoever asks.
-- Every other column of the contact saves exactly as before.
CREATE FUNCTION public.partners_unsubscribe_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF (NEW.unsubscribed_at IS NOT NULL OR NEW.unsubscribe_source IS NOT NULL OR NEW.unsubscribed_by IS NOT NULL) THEN
        RAISE EXCEPTION 'partner_unsubscribe_via_function_only: a new contact cannot arrive already unsubscribed'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.unsubscribed_at    IS NOT DISTINCT FROM OLD.unsubscribed_at
       AND NEW.unsubscribe_source IS NOT DISTINCT FROM OLD.unsubscribe_source
       AND NEW.unsubscribed_by    IS NOT DISTINCT FROM OLD.unsubscribed_by THEN
      RETURN NEW;
    END IF;
    IF OLD.unsubscribe_source = 'link' THEN
      RAISE EXCEPTION 'partner_unsubscribe_is_final: this partner unsubscribed themselves on % and that cannot be undone or changed', OLD.unsubscribed_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT public.partner_unsubscribe_writer() THEN
      RAISE EXCEPTION 'partner_unsubscribe_via_function_only: an unsubscribe can only be recorded or reversed through its own functions'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_partners_unsubscribe_guard
  BEFORE INSERT OR UPDATE ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.partners_unsubscribe_guard();

-- The history: only the functions add to it; nothing is ever deleted; a
-- row's facts never change. The only changes allowed: the database clearing
-- partner_id when a contact is purged (the row stays), and a super admin's
-- reversal of an OWNER's mark (reversed_at / reversed_by, once).
CREATE FUNCTION public.partner_unsubscribes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'partner_unsubscribe_is_final: an unsubscribe record cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NOT public.partner_unsubscribe_writer() THEN
        RAISE EXCEPTION 'partner_unsubscribe_via_function_only: an unsubscribe can only be recorded through its own functions'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.token IS DISTINCT FROM OLD.token OR NEW.unsubscribed_at IS DISTINCT FROM OLD.unsubscribed_at
       OR NEW.marked_by IS DISTINCT FROM OLD.marked_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.partner_id IS DISTINCT FROM OLD.partner_id AND NEW.partner_id IS NOT NULL) THEN
      RAISE EXCEPTION 'partner_unsubscribe_is_final: an unsubscribe record cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reversed_at IS DISTINCT FROM OLD.reversed_at OR NEW.reversed_by IS DISTINCT FROM OLD.reversed_by THEN
      IF OLD.source <> 'owner' OR OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL
         OR NOT public.partner_unsubscribe_writer() THEN
        RAISE EXCEPTION 'partner_unsubscribe_is_final: only an owner''s mark can be reversed, once, by a super admin'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_partner_unsubscribes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.partner_unsubscribes
  FOR EACH ROW EXECUTE FUNCTION public.partner_unsubscribes_guard();

-- The link keys never change and are never deleted (only partner_id cleared
-- when the contact is purged), so a link in an old email keeps working.
CREATE FUNCTION public.partner_unsubscribe_links_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'partner_unsubscribe_link_is_final: an unsubscribe link cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.token IS DISTINCT FROM OLD.token OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.partner_id IS DISTINCT FROM OLD.partner_id AND NEW.partner_id IS NOT NULL) THEN
      RAISE EXCEPTION 'partner_unsubscribe_link_is_final: an unsubscribe link cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_partner_unsubscribe_links_guard
  BEFORE UPDATE OR DELETE ON public.partner_unsubscribe_links
  FOR EACH ROW EXECUTE FUNCTION public.partner_unsubscribe_links_guard();


-- ── 6. The functions (server only) ──────────────────────────────────────────

-- The one eligibility check. NULL = this partner may be sent a partner email
-- now; anything else is the reason not to. Every partner send (start, next
-- step, a one-off 502, a test sent to a partner) must ask this first
-- (lib/network/partner-email-eligibility.ts), and the database asks it again
-- on every active row (section 7).
CREATE FUNCTION public.partner_send_block_reason(p_partner_id uuid) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
  AS $fn$
    SELECT CASE
      WHEN p.id IS NULL                              THEN 'not_found'
      WHEN p.unsubscribed_at IS NOT NULL             THEN 'unsubscribed'
      WHEN p.deleted_at IS NOT NULL                  THEN 'deleted'
      WHEN nullif(btrim(p.email), '') IS NULL        THEN 'no_email'
      WHEN EXISTS (SELECT 1 FROM public.partner_unsubscribes u
                    WHERE u.reversed_at IS NULL
                      AND u.email_normalized = lower(btrim(p.email)))
        OR EXISTS (SELECT 1 FROM public.partners o
                    WHERE o.id <> p.id AND o.unsubscribed_at IS NOT NULL
                      AND lower(btrim(o.email)) = lower(btrim(p.email)))
                                                     THEN 'address_unsubscribed'
      ELSE NULL
    END
    FROM (SELECT 1) one
    LEFT JOIN public.partners p ON p.id = p_partner_id
  $fn$;

-- The link key, made the first time a partner email needs one (first-mint-
-- wins: two sends racing both get the same key). NULL = no such contact, or no
-- email address — and a send with no working unsubscribe link must not go.
CREATE FUNCTION public.partner_unsubscribe_token(p_partner_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_partner public.partners%ROWTYPE;
    v_token   text;
  BEGIN
    SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id;
    IF NOT FOUND OR nullif(btrim(v_partner.email), '') IS NULL THEN
      RETURN NULL;
    END IF;
    INSERT INTO public.partner_unsubscribe_links (token, partner_id, location_id, email_normalized)
    VALUES (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
            v_partner.id, v_partner.location_id, lower(btrim(v_partner.email)))
    ON CONFLICT (partner_id) DO NOTHING;
    SELECT token INTO v_token FROM public.partner_unsubscribe_links WHERE partner_id = p_partner_id;
    RETURN v_token;
  END
  $fn$;

-- What OPENING the link calls: LOOKS ONLY. Declared STABLE, so Postgres
-- refuses any write inside it. outcome = 'pending' (show the button) |
-- 'already' (this link was used) | 'not_found'.
CREATE FUNCTION public.partner_unsubscribe_status(p_token text)
  RETURNS TABLE (outcome text, partner_name text, partner_first_name text, partner_network_types text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
    SELECT CASE
             WHEN l.token IS NULL THEN 'not_found'
             WHEN EXISTS (SELECT 1 FROM public.partner_unsubscribes u WHERE u.token = l.token)
               OR p.unsubscribe_source = 'link' THEN 'already'
             ELSE 'pending'
           END,
           p.name, p.first_name, p.network_types
    FROM (SELECT 1) one
    LEFT JOIN public.partner_unsubscribe_links l ON l.token = p_token
    LEFT JOIN public.partners p ON p.id = l.partner_id
  $fn$;

-- What PRESSING the button calls (and, later, a mail program's RFC 8058
-- one-click POST). One transaction: the history row, the contact, and every
-- active (or owner-stopped) partner sequence of the contact and the address,
-- now final. Pressing again changes nothing.
--   outcome = 'unsubscribed' (this press did it) | 'already' | 'not_found'
CREATE FUNCTION public.partner_unsubscribe(p_token text)
  RETURNS TABLE (outcome text, partner_name text, partner_first_name text, partner_network_types text[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_link    public.partner_unsubscribe_links%ROWTYPE;
    v_partner public.partners%ROWTYPE;
    v_email   text;
    v_now     timestamptz := now();
  BEGIN
    SELECT * INTO v_link FROM public.partner_unsubscribe_links WHERE token = p_token FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text[];
      RETURN;
    END IF;
    SELECT * INTO v_partner FROM public.partners WHERE id = v_link.partner_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.partner_unsubscribes WHERE token = p_token)
       OR v_partner.unsubscribe_source = 'link' THEN
      RETURN QUERY SELECT 'already'::text, v_partner.name, v_partner.first_name, v_partner.network_types;
      RETURN;
    END IF;
    -- The address it was sent to, and the contact's address now if that has
    -- changed since: both stay unsubscribed.
    v_email := coalesce(nullif(lower(btrim(v_partner.email)), ''), v_link.email_normalized);
    INSERT INTO public.partner_unsubscribes (partner_id, location_id, email_normalized, source, token, unsubscribed_at)
    VALUES (v_link.partner_id, v_link.location_id, v_email, 'link', p_token, v_now);
    IF v_link.email_normalized IS DISTINCT FROM v_email AND v_link.email_normalized IS NOT NULL THEN
      INSERT INTO public.partner_unsubscribes (partner_id, location_id, email_normalized, source, token, unsubscribed_at)
      VALUES (v_link.partner_id, v_link.location_id, v_link.email_normalized, 'link', NULL, v_now);
    END IF;
    IF v_partner.id IS NOT NULL THEN
      -- A partner's own unsubscribe replaces an owner's mark, and is final.
      UPDATE public.partners
         SET unsubscribed_at = v_now, unsubscribe_source = 'link', unsubscribed_by = NULL, updated_at = v_now
       WHERE id = v_partner.id;
    END IF;
    UPDATE public.partner_drip_progress d
       SET status = 'unsubscribed', stopped_at = coalesce(d.stopped_at, v_now), stopped_reason = 'unsubscribed'
     WHERE (d.status = 'active' OR (d.status = 'stopped' AND d.stopped_reason = 'owner_unsubscribed'))
       AND d.partner_id IN (SELECT o.id FROM public.partners o
                             WHERE o.id = v_link.partner_id
                                OR lower(btrim(o.email)) IN (v_email, v_link.email_normalized));
    RETURN QUERY SELECT 'unsubscribed'::text, v_partner.name, v_partner.first_name, v_partner.network_types;
  END
  $fn$;

-- Someone at the location marks a contact unsubscribed by hand ("they asked
-- us to stop"). p_by must be a hub user who can edit this location's Network
-- (owner / manager there, or admin / super admin). Their sequences are
-- STOPPED (not final), so a super admin's reversal lets them be restarted.
--   outcome = 'unsubscribed' | 'already' | 'not_found' | 'not_allowed'
CREATE FUNCTION public.partner_mark_unsubscribed(p_partner_id uuid, p_by uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_partner public.partners%ROWTYPE;
    v_email   text;
    v_now     timestamptz := now();
  BEGIN
    SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.hub_users h WHERE h.id = p_by AND (
         h.role IN ('super_admin', 'admin')
         OR (h.role IN ('owner', 'manager') AND h.location_id = v_partner.location_id::text))) THEN
      RETURN 'not_allowed';
    END IF;
    IF v_partner.unsubscribed_at IS NOT NULL THEN RETURN 'already'; END IF;
    v_email := nullif(lower(btrim(v_partner.email)), '');
    UPDATE public.partners
       SET unsubscribed_at = v_now, unsubscribe_source = 'owner', unsubscribed_by = p_by, updated_at = v_now
     WHERE id = p_partner_id;
    INSERT INTO public.partner_unsubscribes (partner_id, location_id, email_normalized, source, unsubscribed_at, marked_by)
    VALUES (p_partner_id, v_partner.location_id, v_email, 'owner', v_now, p_by);
    UPDATE public.partner_drip_progress d
       SET status = 'stopped', stopped_at = v_now, stopped_reason = 'owner_unsubscribed'
     WHERE d.status = 'active'
       AND d.partner_id IN (SELECT o.id FROM public.partners o
                             WHERE o.id = p_partner_id OR (v_email IS NOT NULL AND lower(btrim(o.email)) = v_email));
    RETURN 'unsubscribed';
  END
  $fn$;

-- A SUPER ADMIN reverses an OWNER's mark. Never a partner's own ('link').
-- The history rows stay, stamped with who reversed them and when. Stopped
-- sequences stay stopped; an owner can start them again.
--   outcome = 'reversed' | 'not_super_admin' | 'not_found' | 'not_unsubscribed'
--           | 'partner_unsubscribed_themselves'
--   still_blocked = the eligibility answer afterwards (e.g. the same address
--                   is unsubscribed on another contact), NULL if clear.
CREATE FUNCTION public.partner_reverse_unsubscribe(p_partner_id uuid, p_by uuid)
  RETURNS TABLE (outcome text, still_blocked text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_partner public.partners%ROWTYPE;
    v_now     timestamptz := now();
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.hub_users h WHERE h.id = p_by AND h.role = 'super_admin') THEN
      RETURN QUERY SELECT 'not_super_admin'::text, NULL::text; RETURN;
    END IF;
    SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN;
    END IF;
    IF v_partner.unsubscribe_source IS NULL THEN
      RETURN QUERY SELECT 'not_unsubscribed'::text, public.partner_send_block_reason(p_partner_id); RETURN;
    END IF;
    IF v_partner.unsubscribe_source = 'link' THEN
      RETURN QUERY SELECT 'partner_unsubscribed_themselves'::text, 'unsubscribed'::text; RETURN;
    END IF;
    UPDATE public.partner_unsubscribes
       SET reversed_at = v_now, reversed_by = p_by
     WHERE partner_id = p_partner_id AND source = 'owner' AND reversed_at IS NULL;
    UPDATE public.partners
       SET unsubscribed_at = NULL, unsubscribe_source = NULL, unsubscribed_by = NULL, updated_at = v_now
     WHERE id = p_partner_id;
    RETURN QUERY SELECT 'reversed'::text, public.partner_send_block_reason(p_partner_id);
  END
  $fn$;

-- When an unsubscribed contact's email is changed, the new address is
-- recorded too (same kind as the contact's unsubscribe: a partner's own stays
-- permanent, an owner's mark is reversed with it), so changing the
-- email, purging the contact and adding it again cannot get round it.
CREATE FUNCTION public.partners_after_email_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_email text := nullif(lower(btrim(NEW.email)), '');
  BEGIN
    IF NEW.unsubscribed_at IS NULL OR v_email IS NULL
       OR v_email IS NOT DISTINCT FROM nullif(lower(btrim(OLD.email)), '') THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.partner_unsubscribes
                    WHERE email_normalized = v_email AND reversed_at IS NULL AND partner_id = NEW.id) THEN
      INSERT INTO public.partner_unsubscribes (partner_id, location_id, email_normalized, source, unsubscribed_at, marked_by)
      VALUES (NEW.id, NEW.location_id, v_email, NEW.unsubscribe_source, NEW.unsubscribed_at,
              CASE WHEN NEW.unsubscribe_source = 'owner' THEN NEW.unsubscribed_by END);
    END IF;
    RETURN NULL;
  END
  $fn$;
CREATE TRIGGER trg_partners_after_email_change
  AFTER UPDATE OF email ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.partners_after_email_change();

-- Server only. Supabase gives every new function to the browser roles by
-- default; these are taken back, so no browser can read or make a key,
-- unsubscribe anyone, mark or reverse.
REVOKE ALL ON FUNCTION public.partner_send_block_reason(uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_unsubscribe_token(uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_unsubscribe_status(text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_unsubscribe(text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_mark_unsubscribed(uuid, uuid)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_reverse_unsubscribe(uuid, uuid)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partners_after_email_change()             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_send_block_reason(uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_unsubscribe_token(uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_unsubscribe_status(text)        TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_unsubscribe(text)               TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_mark_unsubscribed(uuid, uuid)   TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_reverse_unsubscribe(uuid, uuid) TO service_role;


-- ── 7. The partner sequence rows obey the rules ─────────────────────────────
CREATE FUNCTION public.partner_drip_progress_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_path    public.drip_paths%ROWTYPE;
    v_loc     uuid;
    v_reason  text;
  BEGIN
    SELECT * INTO v_path FROM public.drip_paths WHERE id = NEW.drip_path_id;
    IF NOT FOUND OR NOT public.is_partner_path_key(v_path.path_key) THEN
      RAISE EXCEPTION 'partner_path_required: a partner can only be put on a partner sequence'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT location_id INTO v_loc FROM public.partners WHERE id = NEW.partner_id;
    IF v_path.location_uuid IS NOT NULL AND v_path.location_uuid IS DISTINCT FROM v_loc THEN
      RAISE EXCEPTION 'partner_path_wrong_location: that sequence belongs to another location'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.path_key := v_path.path_key;
    IF TG_OP = 'UPDATE' AND OLD.status = 'unsubscribed' AND NEW.status <> 'unsubscribed' THEN
      RAISE EXCEPTION 'partner_unsubscribe_is_final: this partner unsubscribed; the sequence cannot be restarted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'active' THEN
      v_reason := public.partner_send_block_reason(NEW.partner_id);
      IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION 'partner_cannot_receive: %', v_reason
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_partner_drip_progress_guard
  BEFORE INSERT OR UPDATE ON public.partner_drip_progress
  FOR EACH ROW EXECUTE FUNCTION public.partner_drip_progress_guard();

-- "Reset to master" deletes a location's copy. Refuse while a partner is still
-- active on it (the client rows have their own check in the Reset route).
CREATE FUNCTION public.drip_paths_keep_active_partners() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_active int;
  BEGIN
    SELECT count(*) INTO v_active FROM public.partner_drip_progress
     WHERE drip_path_id = OLD.id AND status = 'active';
    IF v_active > 0 THEN
      RAISE EXCEPTION 'partner_progress_active: % partner(s) are still on this sequence; stop them before resetting it', v_active
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END
  $fn$;
CREATE TRIGGER trg_drip_paths_keep_active_partners
  BEFORE DELETE ON public.drip_paths
  FOR EACH ROW EXECUTE FUNCTION public.drip_paths_keep_active_partners();

-- Client enrolment picks its sequence from these two columns only
-- (lib/drip-lifecycle.ts startDrip). A partner sequence can never be there.
ALTER TABLE public.locations
  ADD CONSTRAINT locations_default_paths_not_partner CHECK (
    (default_drip_path IS NULL OR default_drip_path NOT LIKE 'partner-%') AND
    (default_move_drip_path IS NULL OR default_move_drip_path NOT LIKE 'partner-%')
  );


-- ── 8. The two master sequences, Kevin's words as written ───────────────────
-- Masters: is_master = true, location_uuid = NULL, like the twelve client
-- masters. Body format 'plain', like every master (blank line = new
-- paragraph, a single line break kept). Timing is days from the start:
-- 500 the moment the owner starts it (0), 501 three months later (90 days,
-- shown as "3 months"). Subjects as Kevin approved them (2026-11-22).
--
--   path_key                    name                         step  email  delay     subject
--   partner-introduction        Partner introduction         1     500    0 days    Great to meet you
--   partner-introduction        Partner introduction         2     501    3 months  Thinking of you and your clients
--   partner-power-introduction  Power Partner introduction   1     502    0 days    Great to meet you
WITH paths AS (
  INSERT INTO public.drip_paths (location_uuid, path_key, name, is_active, is_default, is_master, cloned_from_id)
  VALUES (NULL, 'partner-introduction',       'Partner introduction',       true, false, true, NULL),
         (NULL, 'partner-power-introduction', 'Power Partner introduction', true, false, true, NULL)
  RETURNING id, path_key
)
INSERT INTO public.drip_path_steps
  (drip_path_id, step_order, delay_days, delay_unit, channel, subject, body, body_format,
   master_template_id, is_active, is_paused, origin, button_text, button_link, button_align)
SELECT paths.id, s.step_order, s.delay_days, s.delay_unit, 'email', s.subject, s.body, 'plain',
       NULL, true, false, 'master', NULL, NULL, NULL
FROM paths
JOIN (VALUES
  ('partner-introduction', 1, 0, NULL, 'Great to meet you',
$email500$Hi {{partner_name}},

It was such a pleasure meeting you, thank you again for taking the time to connect.

At Bee Organized, our WHY is simple: we believe an organized space creates the freedom for people to focus on what matters most in their lives. Our goal is to support clients with thoughtful sustainable systems with Compassion, Confidentiality, and Judgement Free.

We tend to serve clients best during times of transition, whether that's busy families trying to keep up with life, individuals or businesses who need help organizing their spaces, clients preparing for a move, or anyone feeling overwhelmed and ready for a more functional, organized environment.

I'd love to learn more about the people you most often help. Please share a little bit about the clients you typically work with so we can better support each other and keep an eye out for great referral opportunities.

Looking forward to staying connected!

Warmly,
{{signature}}$email500$),
  ('partner-introduction', 2, 90, 'months', 'Thinking of you and your clients',
$email501$Hi {{partner_name}},

I hope you've been doing well since we last connected. I really enjoyed meeting you.

Our team helps individuals, families, and businesses create sustainable systems and navigate life transitions with less stress and more clarity.

You can refer Bee Organized when someone:

- Is preparing for a move, downsizing, or major life transition
- Feels overwhelmed by clutter and doesn't know where to start
- Needs help organizing a home, office, or storage spaces
- Is a busy family looking for systems to keep life running smoothly
- Wants a fresh start with functional, sustainable organization

One thing we tell our partners often is that our goal is to make you look good to your clients. We take great care of the people you refer by showing up with compassion, professionalism, and clear processes that make transitions smoother and less stressful.

If a client ever comes to mind who could use organizing or move support, we'd be HONORED to help.

Looking forward to staying connected.

Warmly,
{{signature}}$email501$),
  ('partner-power-introduction', 1, 0, NULL, 'Great to meet you',
$email502$Hi {{partner_name}},

It was such a pleasure meeting you, thank you again for taking the time to connect. I truly enjoyed learning more about the work you do and the clients you support.

Our WHY is simple: we believe an organized space creates the freedom for people to focus on what matters most. Our team works alongside clients to create thoughtful, sustainable systems and guide them through life's transitions with Compassion, Confidentiality, and Judgement Free.

We often collaborate with partners who share our commitment to helping people move through transitions smoothly, and I'd love to continue the conversation about how we can partner together to support one another and create a great experience for the clients we both serve.

We tend to serve clients best during times like:

- Busy families trying to keep up with the pace of everyday life
- Individuals or businesses preparing for a move, downsizing, or a major life transition
- Homeowners or businesses who need help organizing their spaces to function better
- Anyone feeling overwhelmed and ready for a fresh start with systems that truly work

Our goal with every referral is simple: to take great care of your clients and make you look good in the process. We approach every project with professionalism, discretion, and a supportive process that helps people feel calm, confident, and ready for what's next.

Looking forward to building a great partnership.

Warmly,
{{signature}}$email502$)
) AS s (path_key, step_order, delay_days, delay_unit, subject, body) ON s.path_key = paths.path_key;




-- ── 9. Show what was added, then finish ─────────────────────────────────────
-- Expect 3 rows (partner-introduction 1 + 2, partner-power-introduction 1,
-- with the subjects above), and on each: partner_paths 2, partner_steps 3,
-- unsubscribed 0, unsubscribe_links 0, unsubscribe_records 0, partner_progress 0.
SELECT p.path_key, p.name, p.is_master, p.location_uuid, s.step_order, s.delay_days, s.delay_unit,
       s.channel, s.subject, s.body_format, length(s.body) AS body_length,
       (SELECT count(*) FROM public.drip_paths WHERE path_key LIKE 'partner-%')            AS partner_paths,
       (SELECT count(*) FROM public.drip_path_steps ds JOIN public.drip_paths dp ON dp.id = ds.drip_path_id
         WHERE dp.path_key LIKE 'partner-%')                                                AS partner_steps,
       (SELECT count(*) FROM public.partners WHERE unsubscribed_at IS NOT NULL)            AS unsubscribed,
       (SELECT count(*) FROM public.partner_unsubscribe_links)                             AS unsubscribe_links,
       (SELECT count(*) FROM public.partner_unsubscribes)                                  AS unsubscribe_records,
       (SELECT count(*) FROM public.partner_drip_progress)                                 AS partner_progress
  FROM public.drip_paths p JOIN public.drip_path_steps s ON s.drip_path_id = p.id
 WHERE p.path_key LIKE 'partner-%'
 ORDER BY p.path_key, s.step_order;

COMMIT;
