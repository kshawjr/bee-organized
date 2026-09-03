-- migrations/returning_drip_path_variants.sql
--
-- The returning-client sequence follows the location's two Settings answers
-- the same way the ordinary drips do: by VARIANT, not by conditional blocks.
-- The ordinary masters are organizing-a..d / moving-a..d, one per point in
-- the 2x2 (issue 194):
--
--   a  they reply       + rate in the email  → rate paragraph only
--   b  they book online + rate in the email  → booking sentence + rate
--   c  they reply       + rate on the call   → neither (nothing to set up)
--   d  they book online + rate on the call   → booking sentence only
--
-- The single 'returning' master seeded on 2026-09-03 carried BOTH blocks, so
-- an owner who had answered "no" to either question saw all three emails
-- held ("Not sending — it asks people to book a time, and your booking link
-- is empty"). This migration:
--
--   1. renames that master to 'returning-b' (its content IS the b variant),
--      along with any location copy of it (none existed at time of writing);
--   2. seeds returning-a, returning-c and returning-d.
--
-- Enrolment (lib/drip-lifecycle.ts enrolReturningSequence) and Settings ›
-- Emails both resolve the letter from locations.default_drip_path via
-- components/hive/shared/returningVariant.js; no default → returning-c.
--
-- Idempotent. Run in the Supabase SQL editor.

-- 1. The existing master becomes the b variant.
UPDATE drip_paths
SET path_key = 'returning-b', name = 'Returning client — Path B', updated_at = now()
WHERE path_key = 'returning'
  AND is_master = true
  AND NOT EXISTS (SELECT 1 FROM drip_paths x WHERE x.is_master = true AND x.path_key = 'returning-b');

UPDATE drip_paths
SET path_key = 'returning-b', updated_at = now()
WHERE path_key = 'returning'
  AND is_master = false;

-- 2. The other three masters.
INSERT INTO drip_paths (location_uuid, path_key, name, is_active, is_default, is_master)
SELECT NULL::uuid, v.path_key, v.name, true, false, true
FROM (VALUES
  ('returning-a', 'Returning client — Path A'),
  ('returning-c', 'Returning client — Path C'),
  ('returning-d', 'Returning client — Path D')
) AS v(path_key, name)
WHERE NOT EXISTS (
  SELECT 1 FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = v.path_key
);

-- ── returning-a: rate in the email, they reply to book ─────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 1, 0, 'email',
  'Good to hear from you again',
  $tpl$Hi {{first_name}},

Thanks for getting back in touch. We've got your enquiry and someone from the {{location_name}} team will reach out shortly.

It's been a while since we worked together, so if anything has changed at your place, feel free to reply here and fill us in. Otherwise we'll pick up where we left off.

Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products on your scheduled project day, and we will include those product costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.

Talk soon,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 2, 3, 'email',
  'Still here when you''re ready',
  $tpl$Hi {{first_name}},

Just making sure this didn't get buried. We'd love to help again.

If now isn't the right time, no problem at all. Reply whenever suits and we'll pick it up.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 3, 10, 'email',
  'One more from us',
  $tpl$Hi {{first_name}},

This is the last you'll hear from us on this one. If you'd still like a hand, just reply and we'll sort out a time.

Either way, it was good to hear from you.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── returning-c: rate on the call, they reply to book (nothing to set up) ──
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 1, 0, 'email',
  'Good to hear from you again',
  $tpl$Hi {{first_name}},

Thanks for getting back in touch. We've got your enquiry and someone from the {{location_name}} team will reach out shortly.

It's been a while since we worked together, so if anything has changed at your place, feel free to reply here and fill us in. Otherwise we'll pick up where we left off.

Talk soon,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 2, 3, 'email',
  'Still here when you''re ready',
  $tpl$Hi {{first_name}},

Just making sure this didn't get buried. We'd love to help again.

If now isn't the right time, no problem at all. Reply whenever suits and we'll pick it up.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 3, 10, 'email',
  'One more from us',
  $tpl$Hi {{first_name}},

This is the last you'll hear from us on this one. If you'd still like a hand, just reply and we'll sort out a time.

Either way, it was good to hear from you.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── returning-d: they book online, rate on the call ────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 1, 0, 'email',
  'Good to hear from you again',
  $tpl$Hi {{first_name}},

Thanks for getting back in touch. We've got your enquiry and someone from the {{location_name}} team will reach out shortly.

It's been a while since we worked together, so if anything has changed at your place, feel free to reply here and fill us in. Otherwise we'll pick up where we left off.

If you'd like to get a time on the calendar now, please click HERE ({{book_assessment_link}}) to select a day and time that will work best for you.

Talk soon,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 2, 3, 'email',
  'Still here when you''re ready',
  $tpl$Hi {{first_name}},

Just making sure this didn't get buried. We'd love to help again.

If now isn't the right time, no problem at all. Reply whenever suits and we'll pick it up. Or, to make it easier to find a time, click here ({{book_assessment_link}}) to select a day and time that works best for you.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 3, 10, 'email',
  'One more from us',
  $tpl$Hi {{first_name}},

This is the last you'll hear from us on this one. If you'd still like a hand, just reply and we'll sort out a time, or click here ({{book_assessment_link}}) to pick one straight away.

Either way, it was good to hear from you.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- Check: expect four masters × three steps = 12 rows, no bare 'returning' left,
-- and the tags only where the variant letter says they belong.
SELECT dp.path_key, s.step_order, s.delay_days,
       (s.body LIKE '%{{rate_per_hour}}%')        AS quotes_rate,
       (s.body LIKE '%{{book_assessment_link}}%') AS has_booking_link
FROM drip_paths dp JOIN drip_path_steps s ON s.drip_path_id = dp.id
WHERE dp.is_master = true AND dp.path_key LIKE 'returning%'
ORDER BY dp.path_key, s.step_order;
