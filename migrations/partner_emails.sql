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
--   1. partners.unsubscribed_at, partners.unsubscribe_source — NULL on every
--      existing row. No row is written.
--   2. partner_unsubscribes — one row per partner whose unsubscribe link has
--      been made (the link's key, never shown to anyone), and the permanent
--      record of each unsubscribe, kept by email address so it outlives the
--      contact: purging a contact and adding it again does not undo it.
--      Empty when this runs. Only the server can read it.
--   3. partner_drip_progress — which partner is on which partner sequence, at
--      which step, when the next email is due, and its status (active /
--      stopped / completed / unsubscribed). One row per partner per sequence.
--      Empty when this runs. Only the server can read it, exactly like the
--      client drip tables (RLS on, no policies).
--   4. Two MASTER sequences, the same kind of row as every other master, so a
--      location can customise and reset them the same way:
--        partner-introduction        "Partner introduction"        steps 1 + 2
--        partner-power-introduction  "Power Partner introduction"  step 1
--   5. The rules, in the database where no screen, import or sync can skip
--      them:
--        · a partner who has unsubscribed can never be put on, or kept on, a
--          partner sequence (insert or update refused);
--        · unsubscribing stops every active partner sequence for that partner
--          and for any other contact with the same email address;
--        · once set, an unsubscribe can never be cleared or changed, by anyone
--          (the app, an import, a sync, an owner's browser) — refused;
--        · the permanent unsubscribe record can never be deleted or reopened;
--        · a partner sequence row must point at a partner sequence, and only at
--          a master or a copy belonging to the partner's own location;
--        · a location's client sequence (default_drip_path /
--          default_move_drip_path) can never be a partner sequence, so client
--          enrolment can never pick one up;
--        · a sequence copy cannot be deleted ("Reset to master") while a
--          partner is still active on it.
--      Plus three server-only functions: partner_send_block_reason (the one
--      eligibility check every partner send must pass), partner_unsubscribe_token
--      (makes the link key on first need), partner_unsubscribe (what the public
--      unsubscribe page calls).
--
-- SUBJECT LINES: Kevin has not given any. The three steps are saved with NO
-- subject (NULL). That is safe: the send already holds any email whose subject
-- is blank (issue 316, lib/drip-send.ts), so nothing could go out with a made-up
-- subject. But the master wording must be final on day one (a location that
-- customises stops getting master updates), so DO NOT RUN THIS until Kevin has
-- given the three subjects and they are written into section 8 below.
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and run it once.
-- It is one transaction: it all happens or none of it does. Run the read-only
-- check in the comment just below FIRST and compare with the expected numbers.
-- Re-running it is refused at step 0 with a plain message, and changes nothing.
--
-- READ-ONLY CHECK, run alone BEFORE (and the same query after):
--   SELECT (SELECT count(*) FROM drip_paths)                         AS drip_paths,
--          (SELECT count(*) FROM drip_paths WHERE is_master)         AS master_paths,
--          (SELECT count(*) FROM drip_path_steps)                    AS steps,
--          (SELECT count(*) FROM drip_paths WHERE path_key LIKE 'partner-%') AS partner_paths,
--          (SELECT count(*) FROM partners)                           AS partners,
--          (SELECT count(*) FROM locations)                          AS locations;
--   Expected on 2026-11-22 BEFORE: 79, 12, 238, 0, 316, 54.
--   Expected AFTER:                81, 14, 241, 2, 316, 54.
--   (partners changes in everyday use, and so may a location's own copies;
--   compare with what the BEFORE run showed a minute earlier. The client drip
--   rows are not in this check on purpose: this file never names that table.
--   Count them separately before and after if you want: they must not move
--   except for the hourly job.)
--
-- UNDO: migrations/partner_emails_undo.sql.

BEGIN;

-- ── 0. Refuse to run twice, or out of order ─────────────────────────────────
DO $guard$
BEGIN
  IF to_regclass('public.partner_drip_progress') IS NOT NULL
     OR to_regclass('public.partner_unsubscribes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'partners'
                   AND column_name IN ('unsubscribed_at', 'unsubscribe_source')) THEN
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
  ADD COLUMN unsubscribe_source text;
ALTER TABLE public.partners
  ADD CONSTRAINT partners_unsubscribe_source_check
    CHECK (unsubscribe_source IS NULL OR unsubscribe_source IN ('link', 'manual')),
  ADD CONSTRAINT partners_unsubscribe_pair_check
    CHECK ((unsubscribed_at IS NULL) = (unsubscribe_source IS NULL));


-- ── 3. The link keys and the permanent record ───────────────────────────────
CREATE TABLE public.partner_unsubscribes (
  -- The unsubscribe link's only key: 64 random hex characters. Never derived
  -- from the contact, never expires (CAN-SPAM: a link must keep working).
  token            text PRIMARY KEY CHECK (token ~ '^[0-9a-f]{64}$'),
  -- SET NULL, not CASCADE: purging the contact must not erase the record.
  partner_id       uuid UNIQUE REFERENCES public.partners(id) ON DELETE SET NULL,
  location_id      uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  -- lower(trim(email)) — what keeps the address unsubscribed after the contact
  -- is gone, or when the same address is added again.
  email_normalized text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at  timestamptz,
  source           text CHECK (source IS NULL OR source IN ('link', 'manual')),
  CONSTRAINT partner_unsubscribes_pair_check CHECK ((unsubscribed_at IS NULL) = (source IS NULL))
);
CREATE INDEX idx_partner_unsubscribes_email
  ON public.partner_unsubscribes (email_normalized)
  WHERE unsubscribed_at IS NOT NULL;
ALTER TABLE public.partner_unsubscribes ENABLE ROW LEVEL SECURITY;
-- No policies (server only), and no table rights at all for the two browser
-- roles, so the keys cannot be read even by a future policy mistake.
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


-- ── 5. The one eligibility check ────────────────────────────────────────────
-- NULL = this partner may be sent a partner email now. Anything else is the
-- reason not to. Every partner send (start, next step, a one-off 502, a test
-- sent to a partner) must ask this first (lib/network/partner-email-eligibility.ts),
-- and the database asks it again on every active row (section 7).
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
                    WHERE u.unsubscribed_at IS NOT NULL
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
  LANGUAGE plpgsql VOLATILE
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
    INSERT INTO public.partner_unsubscribes (token, partner_id, location_id, email_normalized)
    VALUES (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
            v_partner.id, v_partner.location_id, lower(btrim(v_partner.email)))
    ON CONFLICT (partner_id) DO NOTHING;
    SELECT token INTO v_token FROM public.partner_unsubscribes WHERE partner_id = p_partner_id;
    RETURN v_token;
  END
  $fn$;

-- What the public unsubscribe page calls. One call, one transaction: records
-- the unsubscribe on the permanent record and on the contact, and stops every
-- active partner sequence for the contact and for the same address. Clicking
-- again (or a mail program opening the link first) changes nothing.
--   outcome = 'unsubscribed' (this click did it) | 'already' | 'not_found'
CREATE FUNCTION public.partner_unsubscribe(p_token text)
  RETURNS TABLE (outcome text, partner_name text, partner_first_name text, partner_network_types text[])
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_rec     public.partner_unsubscribes%ROWTYPE;
    v_partner public.partners%ROWTYPE;
    v_email   text;
    v_now     timestamptz := now();
  BEGIN
    SELECT * INTO v_rec FROM public.partner_unsubscribes WHERE token = p_token FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text[];
      RETURN;
    END IF;
    SELECT * INTO v_partner FROM public.partners WHERE id = v_rec.partner_id;
    IF v_rec.unsubscribed_at IS NOT NULL THEN
      RETURN QUERY SELECT 'already'::text, v_partner.name, v_partner.first_name, v_partner.network_types;
      RETURN;
    END IF;
    -- The address it was sent to, and the contact's address now if that has
    -- changed since: both stay unsubscribed.
    v_email := coalesce(nullif(lower(btrim(v_partner.email)), ''), v_rec.email_normalized);
    UPDATE public.partner_unsubscribes
       SET unsubscribed_at = v_now, source = 'link', email_normalized = v_email
     WHERE token = p_token;
    IF v_partner.id IS NOT NULL AND v_partner.unsubscribed_at IS NULL THEN
      UPDATE public.partners
         SET unsubscribed_at = v_now, unsubscribe_source = 'link', updated_at = v_now
       WHERE id = v_partner.id;
    END IF;
    UPDATE public.partner_drip_progress d
       SET status = 'unsubscribed', stopped_at = v_now, stopped_reason = 'unsubscribed'
     WHERE d.status = 'active'
       AND d.partner_id IN (SELECT o.id FROM public.partners o
                             WHERE o.id = v_rec.partner_id
                                OR lower(btrim(o.email)) IN (v_email, v_rec.email_normalized));
    RETURN QUERY SELECT 'unsubscribed'::text, v_partner.name, v_partner.first_name, v_partner.network_types;
  END
  $fn$;

-- Server only. Supabase gives every new function to the browser roles by
-- default; these three are taken back, so no browser can read a key, mint
-- one, or unsubscribe someone else's contact through the API.
REVOKE ALL ON FUNCTION public.partner_send_block_reason(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_unsubscribe_token(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_unsubscribe(text)       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_send_block_reason(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_unsubscribe_token(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_unsubscribe(text)       TO service_role;


-- ── 6. An unsubscribe cannot be undone ──────────────────────────────────────
-- On the contact: once unsubscribed_at is set, neither it nor its source may
-- change, whoever writes the row (Network edit, CSV import, Referred by, Add to
-- Network, a sync, an owner's browser through the API). Every other column
-- still saves, and writing the same values back is fine. Setting it (an owner
-- marking "asked us to stop") is allowed; its source defaults to 'manual'.
CREATE FUNCTION public.partners_unsubscribe_is_final() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF TG_OP = 'UPDATE' AND OLD.unsubscribed_at IS NOT NULL
       AND (NEW.unsubscribed_at IS DISTINCT FROM OLD.unsubscribed_at
            OR NEW.unsubscribe_source IS DISTINCT FROM OLD.unsubscribe_source) THEN
      RAISE EXCEPTION 'partner_unsubscribe_is_final: this contact unsubscribed on % and that cannot be undone or changed', OLD.unsubscribed_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.unsubscribed_at IS NOT NULL AND NEW.unsubscribe_source IS NULL THEN
      NEW.unsubscribe_source := 'manual';
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_partners_unsubscribe_is_final
  BEFORE INSERT OR UPDATE ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.partners_unsubscribe_is_final();

-- When a contact becomes unsubscribed, however that happened: keep the
-- permanent record by address, and stop every active partner sequence for the
-- contact and for the same address. And when an unsubscribed contact's email
-- is later changed, the new address is recorded too, so changing the email,
-- purging the contact and adding it again cannot get round it. SECURITY
-- DEFINER so it still works when an owner's own browser session made the
-- change (the two tables are server only).
CREATE FUNCTION public.partners_after_unsubscribe() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_email text := nullif(lower(btrim(NEW.email)), '');
  BEGIN
    IF NEW.unsubscribed_at IS NULL THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' OR OLD.unsubscribed_at IS NULL THEN
      -- Becoming unsubscribed now.
      UPDATE public.partner_unsubscribes
         SET unsubscribed_at = NEW.unsubscribed_at, source = NEW.unsubscribe_source,
             email_normalized = coalesce(v_email, email_normalized)
       WHERE partner_id = NEW.id AND unsubscribed_at IS NULL;
      IF NOT EXISTS (SELECT 1 FROM public.partner_unsubscribes WHERE partner_id = NEW.id) THEN
        INSERT INTO public.partner_unsubscribes (token, partner_id, location_id, email_normalized, unsubscribed_at, source)
        VALUES (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                NEW.id, NEW.location_id, v_email, NEW.unsubscribed_at, NEW.unsubscribe_source);
      END IF;
    ELSIF v_email IS NOT NULL AND v_email IS DISTINCT FROM nullif(lower(btrim(OLD.email)), '')
          AND NOT EXISTS (SELECT 1 FROM public.partner_unsubscribes
                           WHERE email_normalized = v_email AND unsubscribed_at IS NOT NULL) THEN
      -- Already unsubscribed, and given a new address: that address too.
      INSERT INTO public.partner_unsubscribes (token, partner_id, location_id, email_normalized, unsubscribed_at, source)
      VALUES (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
              NULL, NEW.location_id, v_email, NEW.unsubscribed_at, NEW.unsubscribe_source);
    END IF;
    UPDATE public.partner_drip_progress d
       SET status = 'unsubscribed', stopped_at = NEW.unsubscribed_at, stopped_reason = 'unsubscribed'
     WHERE d.status = 'active'
       AND d.partner_id IN (SELECT o.id FROM public.partners o
                             WHERE o.id = NEW.id OR (v_email IS NOT NULL AND lower(btrim(o.email)) = v_email));
    RETURN NULL;
  END
  $fn$;
REVOKE ALL ON FUNCTION public.partners_after_unsubscribe() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_partners_after_unsubscribe
  AFTER INSERT OR UPDATE OF unsubscribed_at, email ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.partners_after_unsubscribe();

-- On the permanent record: once it says unsubscribed, nothing about it may
-- change and it may not be deleted. The one exception is the database itself
-- clearing partner_id when the contact is purged (the record stays).
CREATE FUNCTION public.partner_unsubscribes_is_final() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF OLD.unsubscribed_at IS NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'partner_unsubscribe_is_final: an unsubscribe record cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.token IS DISTINCT FROM OLD.token
       OR NEW.unsubscribed_at IS DISTINCT FROM OLD.unsubscribed_at
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR (NEW.partner_id IS DISTINCT FROM OLD.partner_id AND NEW.partner_id IS NOT NULL) THEN
      RAISE EXCEPTION 'partner_unsubscribe_is_final: an unsubscribe record cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $fn$;
CREATE TRIGGER trg_partner_unsubscribes_is_final
  BEFORE UPDATE OR DELETE ON public.partner_unsubscribes
  FOR EACH ROW EXECUTE FUNCTION public.partner_unsubscribes_is_final();


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
-- shown as "3 months"). SUBJECTS: NULL until Kevin gives them — see the header.
--
--   path_key                    name                         step  email  delay        subject
--   partner-introduction        Partner introduction         1     500    0 days       (none yet)
--   partner-introduction        Partner introduction         2     501    3 months     (none yet)
--   partner-power-introduction  Power Partner introduction   1     502    0 days       (none yet)
WITH paths AS (
  INSERT INTO public.drip_paths (location_uuid, path_key, name, is_active, is_default, is_master, cloned_from_id)
  VALUES (NULL, 'partner-introduction',       'Partner introduction',       true, false, true, NULL),
         (NULL, 'partner-power-introduction', 'Power Partner introduction', true, false, true, NULL)
  RETURNING id, path_key
)
INSERT INTO public.drip_path_steps
  (drip_path_id, step_order, delay_days, delay_unit, channel, subject, body, body_format,
   master_template_id, is_active, is_paused, origin, button_text, button_link, button_align)
SELECT paths.id, s.step_order, s.delay_days, s.delay_unit, 'email', NULL, s.body, 'plain',
       NULL, true, false, 'master', NULL, NULL, NULL
FROM paths
JOIN (VALUES
  ('partner-introduction', 1, 0, NULL,
$email500$Hi {{partner_name}},

It was such a pleasure meeting you, thank you again for taking the time to connect.

At Bee Organized, our WHY is simple: we believe an organized space creates the freedom for people to focus on what matters most in their lives. Our goal is to support clients with thoughtful sustainable systems with Compassion, Confidentiality, and Judgement Free.

We tend to serve clients best during times of transition, whether that's busy families trying to keep up with life, individuals or businesses who need help organizing their spaces, clients preparing for a move, or anyone feeling overwhelmed and ready for a more functional, organized environment.

I'd love to learn more about the people you most often help. Please share a little bit about the clients you typically work with so we can better support each other and keep an eye out for great referral opportunities.

Looking forward to staying connected!

Warmly,
{{signature}}$email500$),
  ('partner-introduction', 2, 90, 'months',
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
  ('partner-power-introduction', 1, 0, NULL,
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
) AS s (path_key, step_order, delay_days, delay_unit, body) ON s.path_key = paths.path_key;


-- ── 9. Show what was added, then finish ─────────────────────────────────────
-- Expect 3 rows: partner-introduction 1 + 2, partner-power-introduction 1,
-- every subject NULL, and the counts line: partner_paths 2, partner_steps 3,
-- unsubscribed 0, unsubscribe_records 0, partner_progress 0.
SELECT p.path_key, p.name, p.is_master, p.location_uuid, s.step_order, s.delay_days, s.delay_unit,
       s.channel, s.subject, s.body_format, length(s.body) AS body_length,
       (SELECT count(*) FROM public.drip_paths WHERE path_key LIKE 'partner-%')            AS partner_paths,
       (SELECT count(*) FROM public.drip_path_steps ds JOIN public.drip_paths dp ON dp.id = ds.drip_path_id
         WHERE dp.path_key LIKE 'partner-%')                                                AS partner_steps,
       (SELECT count(*) FROM public.partners WHERE unsubscribed_at IS NOT NULL)            AS unsubscribed,
       (SELECT count(*) FROM public.partner_unsubscribes)                                  AS unsubscribe_records,
       (SELECT count(*) FROM public.partner_drip_progress)                                 AS partner_progress
  FROM public.drip_paths p JOIN public.drip_path_steps s ON s.drip_path_id = p.id
 WHERE p.path_key LIKE 'partner-%'
 ORDER BY p.path_key, s.step_order;

COMMIT;
