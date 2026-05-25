-- ════════════════════════════════════════════════════════════════════════════
-- SEED MASTER DRIP PATHS + STAGE TEMPLATES
-- ════════════════════════════════════════════════════════════════════════════
--
-- Seeds Bee Organized's launch content as masters:
--   * 8 master drip_paths (location_uuid IS NULL, is_master = true)
--       organizing-a, organizing-b, organizing-c, organizing-d,
--       moving-a,     moving-b,     moving-c,     moving-d
--   * 24 drip_path_steps (3 per path: delay_days 0 / 5 / 30; subject+body
--     stored inline on each step row, master_template_id NULL)
--   * 7 standalone master templates (location_uuid IS NULL):
--       welcome                       — auto-fires 24h after Email 1
--       opp_closed_job_3mo            — 90d after stage→Closed Won
--       opp_closed_job_12mo           — 365d after stage→Closed Won
--       opp_organizing_estimate_3d    — 3d after stage→Estimate Sent (organizing)
--       opp_organizing_estimate_30d   — 30d after stage→Estimate Sent (organizing)
--       opp_moving_estimate_3d        — 3d after stage→Estimate Sent (moving)
--       opp_moving_estimate_30d       — 30d after stage→Estimate Sent (moving)
--
-- Source content: docs/bee_organized_email_content.md (verbatim — do not
-- paraphrase). Variable mapping per the same doc.
--
-- DEPLOY ORDER:
--   1. drip_paths_is_master.sql
--   2. cleanup_legacy_drip_paths.sql
--   3. THIS file
--   4. drip_followup_infrastructure.sql (leads.welcome_email_* + scheduled_stage_emails)
--   5. Deploy code changes (variable resolution, welcome scheduling, etc.)
--
-- Idempotent — re-runnable.
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Master drip_paths (8 rows)
-- ──────────────────────────────────────────────────────────────────────────
-- WHERE NOT EXISTS guard makes this idempotent — re-running skips
-- rows already present.

INSERT INTO drip_paths (location_uuid, path_key, name, is_active, is_default, is_master)
SELECT NULL::uuid, v.path_key, v.name, true, false, true
FROM (VALUES
  ('organizing-a', 'Organizing — Path A'),
  ('organizing-b', 'Organizing — Path B'),
  ('organizing-c', 'Organizing — Path C'),
  ('organizing-d', 'Organizing — Path D'),
  ('moving-a',     'Moving — Path A'),
  ('moving-b',     'Moving — Path B'),
  ('moving-c',     'Moving — Path C'),
  ('moving-d',     'Moving — Path D')
) AS v(path_key, name)
WHERE NOT EXISTS (
  SELECT 1 FROM drip_paths dp
  WHERE dp.is_master = true AND dp.path_key = v.path_key
);


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 2 — Master drip_path_steps (3 per path = 24 rows)
-- ──────────────────────────────────────────────────────────────────────────
-- Each step has subject + body stored inline. master_template_id is NULL.
-- Path emails are edited via Admin → Content directly on the step row.

-- ── organizing-a ──────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl$Hello {{first_name}}, and thank you so much for reaching out. We would be HONORED to work with you!

We'd be happy to schedule a complimentary in-home assessment of your project. During this brief (approximately 30-minute) visit, we will discuss what's working well, what isn't, your current challenges and your overall goals. Do you have availability sometime this week?

Following the assessment, we'll be able to provide an estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products on your scheduled project day, and we will include those product costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.

Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!

Thank you,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl${{first_name}},

We would be honored to support you with your project. We'd love to schedule a complimentary assessment where we can meet with you to discuss your needs, priorities and timeline. From there, we'll put together an estimate and outline next steps and timing.

Please let me know if you're still interested and what your availability looks like so we can schedule this time together.

We look forward to connecting with you!

Thank you,

{{location_owner_name}}

Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl$Hi {{first_name}},

Still interested in the benefits of organization? We've been trying to connect with you to schedule a complimentary assessment and wanted to check back in.

It would be our HONOR to connect with you, please let us know your availability so we can schedule time to talk through your goals and see how we can best support you.

We look forward to hearing from you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── organizing-b ──────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl$Hello {{first_name}}, and thank you so much for reaching out. We would be HONORED to work with you!

The first step is to set up a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss what's working well, what isn't, your current challenges and your overall goals. Please click HERE ({{book_assessment_link}}) to select a day and time that will work best for you.

The preferred format of these calls is via video call so she can see the spaces you're interested in organizing. If you'd prefer to chat by phone, or would like to request an in-person assessment, please select a day and time and also send an email indicating that request. We will do our best to accommodate your preference.

Following the Discovery Call and/or assessment, we'll be able to provide an Estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products on your scheduled project day, and we will include those product costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.

Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!

Thank you,

{{owner_first_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-b'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl$Hello {{first_name}},

We're simply following up to see if you'd like to schedule a time to discuss your project.

Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Please note that this will be a video call, if you prefer to chat over the phone or would like to schedule an in-person assessment, please schedule time using the calendar link and email me with your preferences.

We look forward to connecting with you!

Thank you,

{{location_owner_name}}

Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-b'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl$Hello {{first_name}},

Still interested in the benefits of organization? The first step is to set up a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.

It would be our HONOR to connect and see how we can best support you.

We look forward to hearing from you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-b'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── organizing-c ──────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl${{first_name}},

Hello, and thank you so much for reaching out, we would be HONORED to work with you!

We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your project. Do you have availability sometime this week?

Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!

Thank you,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl$Hi {{first_name}},

We would be honored to support your with your project! We'd love to schedule a Discovery Call to learn more about your project and goals. Please let me know if you're still interested and what your availability looks like so we can schedule this time together.

We look forward to connecting with you!

Thank you,

{{location_owner_name}}

Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl${{first_name}},

Still interested in the benefits of organization? We've been trying to connect with you to schedule a discovery call and wanted to check back in.

It would be our HONOR to connect with you, please let us know your availability so we can schedule time to talk through your goals and see how we can best support you.

We look forward to hearing from you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── organizing-d ──────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl${{first_name}},

Hello, and thank you so much for reaching out, we would be HONORED to work with you! We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your project. Do you have availability sometime this week?

To make it easier to find a time, click here ({{book_assessment_link}}) to select a time that works best for you. Or feel free to give me a call or text me at {{location_phone}}.

Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!

Thank you,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl$Hi {{first_name}},

We're simply following up to see if you'd like to schedule a time to discuss your project.

Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your move and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Or feel free to give me a call or text me at {{location_phone}}.

Thank you,

{{location_owner_name}}

Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl${{first_name}},

Still interested in the benefits of organization? The first step is to set up a complimentary "Discovery Call". During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.

It would be our HONOR to connect with you and see how we can best support you.

We look forward to hearing from you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'organizing-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── moving-a ──────────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl$Hello {{first_name}}, and thank you so much for reaching out.

We would be happy to schedule a complimentary assessment of your project. During this brief (approximately 30-minute) visit, we will discuss your move details, priorities and timeline. Do you have availability sometime this week?

Following the assessment, we will provide an estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended supplies needed (boxes, packing paper, etc.) on your scheduled project day, and will include those costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.

Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!

Thank you,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl${{first_name}},

We are checking back to see if you would like to schedule a complimentary assessment to discuss your move, priorities and timeline. From there, an estimate and outline of next steps and timing will be provided. We would be HONORED to work with you!

Please let me know if you're still interested and what your availability looks like so we can schedule this time together.

We look forward to connecting with you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl$Hi {{first_name}},

Still interested in working with us on your upcoming move? We've been trying to connect with you to schedule a complimentary assessment and wanted to check back in.

Please let us know your availability. We would be HONORED to help!

We look forward to hearing from you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-a'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── moving-b ──────────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl$Hello {{first_name}}, and thank you so much for reaching out. We would be HONORED to work with you!

The first step is to set up a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your upcoming move, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.

The preferred format of these calls is via video call so we can see the spaces you will be moving. If you'd prefer to chat by phone, or would like to request an in-person assessment, please select a day and time and also send an email indicating that request. We will do our best to accommodate your preference.

Following the Discovery Call and/or assessment, we'll be able to provide an Estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended supplies needed (boxes, packing paper, etc.) on your scheduled project day, and we will include those costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.

Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!

Thank you,

{{owner_first_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-b'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl$Hello {{first_name}},

We're simply following up to see if you'd like to schedule a time to discuss your project.

Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your move details, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Please note that this will be a video call, if you prefer to chat over the phone or would like to schedule an in-person assessment, please schedule time using the calendar link and email me with your preferences.

We look forward to connecting with you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-b'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl$Hello {{first_name}},

Still interested in working with us on your upcoming move? The first step is to set up a complimentary "Discovery Call". During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.

It would be our HONOR to connect with you and see how we can best support you.

We look forward to hearing from you!

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-b'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── moving-c ──────────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl${{first_name}},

Hello, and thank you so much for reaching out, we would be HONORED to work with you!

We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your project. Do you have availability sometime this week?

Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!

Thank you,

{{owner_name}}

**Be sure to check out our Google Reviews!** ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl$Hi {{first_name}},

We would be honored to support you with your upcoming move. We'd love to schedule a Discovery Call to learn more about your move project and timeline. Please let me know if you're still interested and what your availability looks like so we can schedule this time together.

We look forward to connecting with you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl${{first_name}},

Still interested in working with us on your upcoming move? We've been trying to connect with you to schedule a discovery call and wanted to check back in.

It would be our HONOR to connect with you, please let us know your availability so we can schedule time to talk through your move and see how we can best support you.

We look forward to hearing from you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-c'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- ── moving-d ──────────────────────────────────────────────────────────────
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 1, 0, 'email',
  'Thank you for reaching out!',
  $tpl${{first_name}},

Hello, and thank you so much for reaching out, we would be HONORED to work with you! We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your upcoming move. Do you have availability sometime this week?

To make it easier to find a time, click here ({{book_assessment_link}}) so you can select a time that works best for you. Or feel free to give me a call or text me at {{location_phone}}.

Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!

Thank you,

{{owner_name}}

Be sure to check out our Google Reviews! ({{reviews_link}})$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 2, 5, 'email',
  'Following up on your project',
  $tpl$Hi {{first_name}},

We're simply following up to see if you'd like to schedule a time to discuss your move project.

Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your move and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Or feel free to give me a call or text me at {{location_phone}}.

Thank you,

{{location_owner_name}}

Have you ever considered your relationship with your stuff? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, subject, body, is_active)
SELECT dp.id, 3, 30, 'email',
  'Still interested?',
  $tpl${{first_name}},

Still interested in working with us on your upcoming move? The first step is to set up a complimentary "Discovery Call". During this brief (approximately 30-minute) call, we'll discuss your move project, details and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.

It would be our HONOR to connect with you and see how we can best support you.

We look forward to hearing from you!

Thank you,

{{location_owner_name}}$tpl$,
  true
FROM drip_paths dp WHERE dp.is_master = true AND dp.path_key = 'moving-d'
ON CONFLICT (drip_path_id, step_order) DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 3 — Master templates (Welcome + 6 Opportunity Stages)
-- ──────────────────────────────────────────────────────────────────────────
-- Standalone master templates (location_uuid IS NULL). Welcome is fired
-- 24h after Email 1 of any new lead drip (per leads.welcome_email_scheduled_at
-- — see drip_followup_infrastructure.sql). Opp Stages are fired via the
-- scheduled_stage_emails queue.

INSERT INTO templates (legacy_id, name, type, tag, subject, body) VALUES

-- welcome — auto-fires 24h after Email 1 of any new lead drip
('welcome', 'Welcome Email', 'email', 'welcome',
 'Welcome to the Bee Organized Hive!',
 $tpl$Welcome to the Bee Organized Hive! We're excited to connect with you soon and it would be our HONOR to help you *Simplify Your Hive!*

Check out more info about **Bee Organized** below…

**What's Your Organizing Profile?**
Take our fun Organizing Profile Quiz here (https://beeorganized.com/) to find out who you are in relationship with your stuff!

**How We Came To Bee**
Learn how these best friends got started and built a successful national franchise business here! (https://beeorganized.com/pages/how-we-came-to-bee)$tpl$),

-- opp_closed_job_3mo — 90d after stage→Closed Won
('opp_closed_job_3mo', 'Opportunity · Closed Job — 3 month follow up', 'email', 'opportunity-stage',
 'We hope you''re still loving your space!',
 $tpl${{first_name}},

Hello! We hope you are still thrilled with our services. If you haven't already taken advantage of our offer, as an appreciation of your time and completing the Google Review, we would like to provide 1 Free Hour (with 3 Hours Booked) off your next service booked with Bee Organized!

We would also love to stay connected with our Maintenance Program where we can continue to help you Simplify your home throughout the year. Our Maintenance Program allows you to maintain the work that we did together where we could come as often as each month or quarterly.

It was an HONOR to have worked with you and we look forward to working with you again in the future!

Best,

{{owner_name}}$tpl$),

-- opp_closed_job_12mo — 365d after stage→Closed Won
('opp_closed_job_12mo', 'Opportunity · Closed Job — 12 month follow up', 'email', 'opportunity-stage',
 'It''s been a year — how is your space holding up?',
 $tpl${{first_name}},

We hope you've been doing well! We were thinking of you and wanted to reach out as it's been about a year since we had the pleasure of working with you.

We know life changes quickly, and even the best systems can need a refresh over time. Whether your space is still working beautifully or you've noticed areas that could use a little extra support, we're always happy to help.

If you have any questions, need a seasonal reset, or would like to schedule time to fine-tune your systems, please don't hesitate to reach out. And of course, if everything is still working great, we love hearing that too!

It was truly an HONOR to work with you, and we hope to connect again whenever the time feels right.

Warmly,

{{owner_name}}$tpl$),

-- opp_organizing_estimate_3d — 3d after stage→Estimate Sent (organizing)
('opp_organizing_estimate_3d', 'Opportunity · Organizing Estimate — 3 day follow up', 'email', 'opportunity-stage',
 'Following up on your estimate',
 $tpl${{first_name}},

Hello! It was an HONOR connecting with you and discussing how Bee Organized can help you Simplify Your Hive!

We wanted to follow up as we recently sent over your estimate and haven't heard back yet. Once we receive your approval, we'll be happy to reach out to discuss scheduling and introduce you to your Bees.

Please let us know if you have any questions or if there's anything we can clarify, it would be an HONOR to work with you!

Thank you,

{{owner_name}}$tpl$),

-- opp_organizing_estimate_30d — 30d after stage→Estimate Sent (organizing)
('opp_organizing_estimate_30d', 'Opportunity · Organizing Estimate — 30 day follow up', 'email', 'opportunity-stage',
 'One last note on your estimate',
 $tpl${{first_name}},

We wanted to reach out one last time regarding the estimate we shared for your organizing project.

At Bee Organized, our goal is to help you Simplify Your Hive by creating systems that are functional, sustainable, and tailored to how you live. If you're still interested in moving forward, we'd love the opportunity to schedule your project and introduce you to your Bees.

If now isn't the right season, no worries at all, just let us know. And if you have any questions about the estimate or the process, we're always happy to help.

Thank you again for considering Bee Organized. It would truly be an HONOR to work with you.

Warmly,

{{owner_name}}$tpl$),

-- opp_moving_estimate_3d — 3d after stage→Estimate Sent (moving)
('opp_moving_estimate_3d', 'Opportunity · Moving Estimate — 3 day follow up', 'email', 'opportunity-stage',
 'Following up on your estimate',
 $tpl${{first_name}},

Hello! It was an HONOR connecting with you and discussing how Bee Organized can help you Simplify Your Move!

We wanted to follow up as we recently sent over your estimate and haven't heard back yet. Once we receive your approval, we'll be happy to reach out to discuss scheduling and introduce you to your Bees.

Please let us know if you have any questions or if there's anything we can clarify, it would be an HONOR to work with you!

Thank you,

{{owner_name}}$tpl$),

-- opp_moving_estimate_30d — 30d after stage→Estimate Sent (moving)
('opp_moving_estimate_30d', 'Opportunity · Moving Estimate — 30 day follow up', 'email', 'opportunity-stage',
 'One last note on your estimate',
 $tpl${{first_name}},

We wanted to reach out one last time regarding the estimate we shared for your move project.

At Bee Organized, our goal is to help you Simplify Your Move by creating systems that are functional, sustainable, and tailored to how you live. If you're still interested in moving forward, we'd love the opportunity to schedule your project and introduce you to your Bees.

If you have any questions about the estimate or the process, we're always happy to help.

Thank you again for considering Bee Organized. It would truly be an HONOR to work with you.

Warmly,

{{owner_name}}$tpl$)

ON CONFLICT (legacy_id) DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- POST-RUN VERIFICATION (read-only)
-- ──────────────────────────────────────────────────────────────────────────
--   -- Expect 8:
--   SELECT count(*) FROM drip_paths WHERE is_master = true;
--
--   -- Expect 24 (8 paths × 3 steps):
--   SELECT count(*) FROM drip_path_steps dps
--   JOIN drip_paths dp ON dp.id = dps.drip_path_id
--   WHERE dp.is_master = true;
--
--   -- Expect 7 new templates with these legacy_ids:
--   SELECT legacy_id, name FROM templates
--   WHERE legacy_id IN (
--     'welcome',
--     'opp_closed_job_3mo', 'opp_closed_job_12mo',
--     'opp_organizing_estimate_3d', 'opp_organizing_estimate_30d',
--     'opp_moving_estimate_3d',     'opp_moving_estimate_30d'
--   )
--   ORDER BY legacy_id;
--
--   -- Spot-check Path A (organizing) sequence:
--   SELECT step_order, delay_days, subject, left(body, 50) AS body_preview
--   FROM drip_path_steps dps
--   JOIN drip_paths dp ON dp.id = dps.drip_path_id
--   WHERE dp.is_master = true AND dp.path_key = 'organizing-a'
--   ORDER BY step_order;
