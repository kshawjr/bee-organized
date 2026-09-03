-- migrations/seed_returning_drip_path.sql
--
-- One master drip path, 'returning', three email steps. Enrolled by the
-- intake when a PAST client (imported from Jobber, or with a closed
-- engagement) fills in the website form again and the intake founds a
-- fresh Request engagement for it (lib/drip-lifecycle.ts
-- enrolReturningSequence). Stops on the first logged reach-out or when
-- the engagement moves past Request. Owners edit it under Settings ›
-- Emails ("When a past client gets back in touch"), clone-on-first-edit
-- like every other path. Super-admins edit the master under Admin ›
-- Content.
--
-- The booking link and rate paragraph are the same blocks the ordinary
-- drips carry, in the same places (step 1: booking + rate + reviews;
-- steps 2 and 3: booking only). When the location has no rate or no
-- calendar link the send is HELD exactly as the ordinary drips are —
-- no fallback, no special handling (Kevin, 2026-09-03).
--
-- Idempotent. Run in the Supabase SQL editor.

INSERT INTO drip_paths (location_uuid, path_key, name, is_active, is_default, is_master)
SELECT NULL::uuid, 'returning', 'Returning client', true, false, true
WHERE NOT EXISTS (
  SELECT 1 FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning'
);

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 1, 0, 'email',
  'Good to hear from you again',
  $tpl$Hi {{first_name}},

Thanks for getting back in touch. We've got your enquiry and someone from the {{location_name}} team will reach out shortly.

It's been a while since we worked together, so if anything has changed at your place, feel free to reply here and fill us in. Otherwise we'll pick up where we left off.

If you'd like to get a time on the calendar now, please click HERE ({{book_assessment_link}}) to select a day and time that will work best for you.

Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products on your scheduled project day, and we will include those product costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.

Talk soon,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 2, 3, 'email',
  'Still here when you''re ready',
  $tpl$Hi {{first_name}},

Just making sure this didn't get buried. We'd love to help again.

If now isn't the right time, no problem at all. Reply whenever suits and we'll pick it up. Or, to make it easier to find a time, click here ({{book_assessment_link}}) to select a day and time that works best for you.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active, origin)
SELECT dp.id, 3, 10, 'email',
  'One more from us',
  $tpl$Hi {{first_name}},

This is the last you'll hear from us on this one. If you'd still like a hand, just reply and we'll sort out a time, or click here ({{book_assessment_link}}) to pick one straight away.

Either way, it was good to hear from you.

{{owner_name}}$tpl$,
  true, 'master'
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'returning'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- Check: expect one master path and three steps (days 0, 3, 10).
SELECT dp.path_key, s.step_order, s.delay_days, s.subject
FROM drip_paths dp JOIN drip_path_steps s ON s.drip_path_id = dp.id
WHERE dp.is_master = true AND dp.path_key = 'returning'
ORDER BY s.step_order;
