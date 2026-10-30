-- migrations/email_screen_dry_run.sql
--
-- READ-ONLY. The dry run for the five Settings → Emails migrations
-- (2026-10-30). Nothing here writes. (A sixth, locations_email_switches.sql,
-- was ABANDONED and deleted: the two switches drive the existing sequence
-- variant instead of new columns.) Run it in the Supabase SQL editor BEFORE
-- the migrations, then again AFTER, and compare.
--
--   locations_email_style.sql        locations.email_style
--   drip_path_steps_paused.sql       drip_path_steps.is_paused
--   drip_path_steps_delay_unit.sql   drip_path_steps.delay_unit
--   locations_booking_links.sql      locations.discovery_booking_link, virtual_booking_link
--   email_buttons.sql                drip_path_steps + templates .button_text, .button_link
--
-- Each migration only ADDS columns with defaults that mean "today's
-- behaviour". None of them changes a row's existing values. The app reads every
-- one of them tolerantly, so the order you run them in does not matter, and
-- the code is safe to ship before any of them run.

-- ── 1. Which of the new columns exist right now ───────────────────────────
-- BEFORE: expect 0 rows. AFTER: expect 9 rows.
SELECT table_name, column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'locations' AND column_name IN
          ('email_style','discovery_booking_link','virtual_booking_link'))
     OR (table_name = 'drip_path_steps' AND column_name IN ('is_paused','delay_unit','button_text','button_link'))
     OR (table_name = 'templates' AND column_name IN ('button_text','button_link')))
 ORDER BY table_name, column_name;

-- ── 2. How many rows each migration touches (it only adds a column) ─────
-- Same numbers BEFORE and AFTER. Every existing row gets the default:
--   email_style NULL (= Soft),
--   is_paused false, delay_unit NULL (= days), every button NULL.
SELECT 'locations'        AS t, count(*) FROM public.locations
UNION ALL SELECT 'drip_path_steps', count(*) FROM public.drip_path_steps
UNION ALL SELECT 'templates',       count(*) FROM public.templates;

-- ── 3. What the existing booking link is used for today ──────────────────
-- calendar_link stays the link behind {{booking_link}} / {{book_assessment_link}}.
-- The new screen labels it "In-home assessment booking link". This shows how
-- many locations have one, and how many owners override it with their own
-- (hub_users.booking_link, which keeps overriding {{owner_booking_link}} only).
SELECT
  (SELECT count(*) FROM public.locations WHERE coalesce(trim(calendar_link), '') <> '') AS locations_with_calendar_link,
  (SELECT count(*) FROM public.locations WHERE coalesce(trim(rate_per_hour::text), '') = '') AS locations_with_blank_rate,
  (SELECT count(*) FROM public.hub_users WHERE coalesce(trim(booking_link), '') <> '') AS users_with_own_booking_link;

-- ── 4. AFTER only — nothing changed anyone's emails ─────────────────────
-- Expect every count to be 0 straight after the migrations run.
-- SELECT
--   (SELECT count(*) FROM public.locations WHERE email_style IS NOT NULL)          AS styles_chosen,
--   (SELECT count(*) FROM public.drip_path_steps WHERE is_paused)                  AS paused_emails,
--   (SELECT count(*) FROM public.drip_path_steps WHERE delay_unit IS NOT NULL)     AS months_or_years,
--   (SELECT count(*) FROM public.drip_path_steps WHERE button_text IS NOT NULL)    AS step_buttons,
--   (SELECT count(*) FROM public.templates WHERE button_text IS NOT NULL)          AS template_buttons;
