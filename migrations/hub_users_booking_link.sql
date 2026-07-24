-- migrations/hub_users_booking_link.sql
--
-- REVIEW ARTIFACT — NOT EXECUTED. Run in the Supabase SQL editor after Kevin
-- approves. Everything below is one statement; there is no data movement.
--
-- ── PURPOSE ────────────────────────────────────────────────────────────
-- Today {{book_assessment_link}} and {{booking_link}} both resolve to
-- locations.calendar_link, so every owner at a location sends the SAME
-- scheduling link. When a lead is assigned to a specific person, the email
-- should carry THAT person's calendar. This column is where their own link
-- lives, and it backs the new {{owner_booking_link}} merge tag:
--
--   lead.assigned_to → that hub_user's booking_link
--     → the location's primary owner's booking_link
--       → locations.calendar_link            (today's behavior, unchanged)
--
-- locations.calendar_link is NOT removed and NOT deprecated. It stays the
-- final tier of the chain and the only source for the two legacy aliases.
--
-- ── WHY NULL IS SAFE ───────────────────────────────────────────────────
-- NULL means "fall back", not "broken". Every existing hub_user lands NULL,
-- which resolves straight through to the location's calendar_link — i.e. the
-- exact link they send today. No existing user is affected by this ALTER, and
-- no backfill is needed or wanted. A user opts in by typing their own link
-- into Settings → Profile → Booking Link.
--
-- The application code SHIPS BEFORE THIS RUNS and is written for the column
-- to be absent: every read of hub_users.booking_link is its own defensive
-- query that swallows the "column does not exist" error and returns null, so
-- the chain simply falls to calendar_link. Applying this migration is what
-- turns the feature on; it cannot break the pre-migration deployment.
--
-- ── READ-ONLY DRY ANALYSIS (run 2026-07-23, production) ────────────────
--   hub_users rows the ALTER touches ............ 12
--     by role: owner 9 · manager 1 · super_admin 1 · admin 1
--     disabled (disabled_at set) ................. 0
--   hub_users.booking_link already exists? ...... NO
--     probe: "column hub_users.booking_link does not exist"
--   leads carrying assigned_to .................. 7,129 of 7,235 (98.5%)
--     — the tag's primary tier is populated for essentially every lead
--   ACTIVE locations on a booking path (-b/-d) .. 3
--     loc_seattle    organizing-b / moving-b   calendar_link SET
--     loc_scottsdale organizing-d / moving-d   calendar_link SET
--     loc_portland   organizing-d / moving-d   calendar_link SET
--   Active booking-path locations with a BLANK
--   calendar_link ............................... 0
--     — so the new send guard holds ZERO sends on the day it ships.
--
-- ── FORWARD ────────────────────────────────────────────────────────────
ALTER TABLE hub_users ADD COLUMN booking_link text;

COMMENT ON COLUMN hub_users.booking_link IS
  'This user''s personal scheduling link, rendered into CLIENT emails by the '
  '{{owner_booking_link}} merge tag when a lead is assigned to them. NULL '
  'means fall back to the location primary owner''s link, then to '
  'locations.calendar_link. Free-form text, set by the user in '
  'Settings → Profile.';

-- ── ROLLBACK ───────────────────────────────────────────────────────────
-- Dropping the column returns every send to the location-level link. The
-- resolver's defensive reads treat the missing column exactly like a NULL
-- value, so the running app degrades to today's behavior with no deploy.
-- The only loss is whatever links users had typed in — copy them out first
-- if the drop is anything other than an immediate mistake-undo:
--
--   -- SELECT id, email, booking_link FROM hub_users WHERE booking_link IS NOT NULL;
--   -- ALTER TABLE hub_users DROP COLUMN booking_link;
