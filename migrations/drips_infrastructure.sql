-- ════════════════════════════════════════════════════════════════════════════
-- DRIPS INFRASTRUCTURE — Session 1
-- ════════════════════════════════════════════════════════════════════════════
--
-- Creates:
--   1. master_templates — system-wide library of email/sms/call templates
--   2. lead_drip_progress — per-lead state through a drip path
--   3. drip_path_steps.master_template_id — indirection from step → template
--   4. Relaxes drip_path_steps.subject/body to NULLABLE
--        (null means: use the linked master_template's content as-is)
--
-- Seeds:
--   - 17 master templates (legacy ids: t1–t9, ta1, ta2, tb1, tb2, tc1, tc2,
--     td1, td2 — mirrors DEFAULT_TEMPLATES in components/BeeHub.jsx)
--   - 2 default drip paths (general-a, move-a) for the 4 launch locations:
--       Palm Beach, Scottsdale, Kansas City, Test Location
--   - Step rows for each path, with master_template_id pointing at the
--     appropriate master template (no per-location override yet)
--
-- ────────────────────────────────────────────────────────────────────────────
-- HOW TO RUN
-- ────────────────────────────────────────────────────────────────────────────
-- Paste this whole file into the Supabase SQL editor and run it. The
-- migration is idempotent (ON CONFLICT DO NOTHING throughout) — re-running
-- it is safe and will not duplicate rows.
--
-- ────────────────────────────────────────────────────────────────────────────
-- PRE-FLIGHT CHECKS (read-only — run these first if you want to verify state)
-- ────────────────────────────────────────────────────────────────────────────
--   -- Confirm drip_paths + drip_path_steps already exist (from
--   -- hive_clients_phase0.sql). Both should return 't'.
--   SELECT to_regclass('public.drip_paths')      IS NOT NULL AS drip_paths_exists;
--   SELECT to_regclass('public.drip_path_steps') IS NOT NULL AS drip_path_steps_exists;
--
--   -- Confirm master_templates does NOT exist yet (first run). After re-run,
--   -- expected to be true.
--   SELECT to_regclass('public.master_templates') IS NOT NULL AS master_templates_exists;
--
--   -- Spot-check the 4 launch locations exist:
--   SELECT id, name FROM locations WHERE id IN (
--     '1b62628f-e3be-4024-be2d-e8179f09f740',
--     '132b42c2-9566-43cc-85dc-f90fae4ba1b1',
--     'dca50888-949f-436d-b24e-b6c8a4984905',
--     'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
--   );
--
-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (manual — copy-paste in Supabase SQL editor if needed)
-- ────────────────────────────────────────────────────────────────────────────
--   -- Wipes everything this migration created. Safe because none of the
--   -- runtime code yet writes to these tables.
--   DELETE FROM drip_path_steps WHERE drip_path_id IN (
--     SELECT id FROM drip_paths WHERE path_key IN ('general-a','move-a')
--       AND location_uuid IN (
--         '1b62628f-e3be-4024-be2d-e8179f09f740',
--         '132b42c2-9566-43cc-85dc-f90fae4ba1b1',
--         'dca50888-949f-436d-b24e-b6c8a4984905',
--         'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
--       )
--   );
--   DELETE FROM drip_paths WHERE path_key IN ('general-a','move-a')
--     AND location_uuid IN (
--       '1b62628f-e3be-4024-be2d-e8179f09f740',
--       '132b42c2-9566-43cc-85dc-f90fae4ba1b1',
--       'dca50888-949f-436d-b24e-b6c8a4984905',
--       'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
--     );
--   ALTER TABLE drip_path_steps DROP COLUMN IF EXISTS master_template_id;
--   ALTER TABLE drip_path_steps ALTER COLUMN body SET NOT NULL;
--   DROP TABLE IF EXISTS lead_drip_progress;
--   DROP TABLE IF EXISTS master_templates;
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 1 — master_templates
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS master_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id   text UNIQUE,                       -- original string id from DEFAULT_TEMPLATES (e.g. 't1', 'ta2')
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('email', 'sms', 'call')),
  tag         text,                              -- 'welcome' | 'nurture' | 'social-proof' | 'cta' | 'follow-up' | 'call'
  subject     text,                              -- null for sms/call
  body        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_master_templates_type   ON master_templates(type);
CREATE INDEX IF NOT EXISTS idx_master_templates_tag    ON master_templates(tag);
CREATE INDEX IF NOT EXISTS idx_master_templates_active ON master_templates(is_active);

ALTER TABLE master_templates ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_master_templates_updated_at ON master_templates;
CREATE TRIGGER trg_master_templates_updated_at
  BEFORE UPDATE ON master_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 2 — lead_drip_progress
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_drip_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id)      ON DELETE CASCADE,
  drip_path_id    uuid NOT NULL REFERENCES drip_paths(id) ON DELETE CASCADE,
  current_step    int  NOT NULL DEFAULT 1,
  started_at      timestamptz NOT NULL DEFAULT now(),
  next_send_at    timestamptz,
  last_sent_at    timestamptz,
  completed_at    timestamptz,
  stopped_at      timestamptz,
  stopped_reason  text,                          -- 'stage_changed' | 'manual_pause' | 'junk' | 'closed_won' | etc.
  paused_at       timestamptz,                   -- distinct from stopped — paused can resume
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, drip_path_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_drip_progress_lead
  ON lead_drip_progress(lead_id);

-- Cron's hot path: "what's due to send right now?"
CREATE INDEX IF NOT EXISTS idx_lead_drip_progress_due
  ON lead_drip_progress(next_send_at)
  WHERE stopped_at IS NULL AND paused_at IS NULL AND completed_at IS NULL;

ALTER TABLE lead_drip_progress ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_lead_drip_progress_updated_at ON lead_drip_progress;
CREATE TRIGGER trg_lead_drip_progress_updated_at
  BEFORE UPDATE ON lead_drip_progress
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 3 — drip_path_steps: link to master_templates + nullable content
-- ──────────────────────────────────────────────────────────────────────────
-- A step row can either:
--   (a) point at a master_template and leave subject/body NULL → use template as-is
--   (b) point at a master_template AND set subject/body → location-level override
--   (c) set subject/body without a master_template → fully custom one-off step

ALTER TABLE drip_path_steps
  ADD COLUMN IF NOT EXISTS master_template_id uuid
  REFERENCES master_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_drip_path_steps_master_template
  ON drip_path_steps(master_template_id);

-- Drop NOT NULL on body so case (a) above is possible.
ALTER TABLE drip_path_steps ALTER COLUMN body DROP NOT NULL;
-- subject was already nullable.


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 4 — Seed master_templates
-- ──────────────────────────────────────────────────────────────────────────
-- Source: components/BeeHub.jsx, const DEFAULT_TEMPLATES (line 13477+).
-- Bodies use $tpl$...$tpl$ dollar-quoting to avoid escaping headaches around
-- apostrophes and {{variables}}.

INSERT INTO master_templates (legacy_id, name, type, tag, subject, body) VALUES

-- t1 — Welcome Email
('t1', 'Welcome Email', 'email', 'welcome',
 'Welcome, {{first_name}} - let''s get organized 🐝',
 $tpl$Hi {{first_name}},

Thanks so much for reaching out! I'm {{organizer_name}} with Bee Organized {{location_name}} and I'm thrilled you connected with us.

We specialize in creating calm, functional spaces that actually work for your life - from kitchens and closets to whole-home transformations.

I'd love to learn more about what you're working on. Would you be open to a quick call this week?

Talk soon,
{{organizer_name}}
Bee Organized {{location_name}}
{{phone}}$tpl$),

-- t2 — How We Help
('t2', 'How We Help', 'email', 'nurture',
 'What a Bee Organized session looks like',
 $tpl$Hi {{first_name}},

I wanted to share a little more about what working with us actually looks like.

Here's what a typical session includes:
• A walkthrough of your space to understand how you live and work
• Sorting, editing, and categorizing everything together
• Strategic placement so things are easy to find and put back
• A customized system built around your lifestyle

Most clients tell us they feel a weight lifted the moment we finish - not just from the clutter, but from the mental load of knowing where everything is.

Ready to get started? Book a free assessment here:
{{booking_link}}

{{organizer_name}}
Bee Organized {{location_name}}$tpl$),

-- t3 — Real Results
('t3', 'Real Results', 'email', 'social-proof',
 'What our clients are saying...',
 $tpl$Hi {{first_name}},

I thought you might enjoy hearing from some of our recent clients:

"I can actually find things now. It sounds simple but it's changed my mornings completely." - Sarah M.

"They transformed our pantry in one afternoon. Worth every penny." - Jennifer T.

We serve {{service_area}} and would love to do the same for you.

Book your free assessment: {{booking_link}}

{{organizer_name}}
Bee Organized {{location_name}}$tpl$),

-- t4 — Ready to Book?
('t4', 'Ready to Book?', 'email', 'cta',
 'Still thinking about it? Let''s chat.',
 $tpl$Hi {{first_name}},

I know life gets busy - no pressure at all.

If you're still thinking about getting organized, I'd love to answer any questions you have. Sometimes it helps to just talk through the space before committing.

You can book a free 20-minute call here: {{booking_link}}

Or just reply to this email - I'm happy to chat.

{{organizer_name}}
Bee Organized {{location_name}}
{{phone}}$tpl$),

-- t5 — Welcome Text
('t5', 'Welcome Text', 'sms', 'welcome',
 NULL,
 $tpl$Hi {{first_name}}! It's {{organizer_name}} from Bee Organized {{location_name}}. So glad you reached out! I'd love to learn more about your space. When's a good time for a quick call? 🐝$tpl$),

-- t6 — Quick Follow-up Text
('t6', 'Quick Follow-up Text', 'sms', 'follow-up',
 NULL,
 $tpl$Hey {{first_name}}, just checking in! Would love to help you get organized. Feel free to book a time here: {{booking_link}}$tpl$),

-- t7 — Booking Link Text
('t7', 'Booking Link Text', 'sms', 'cta',
 NULL,
 $tpl$Hi {{first_name}}! Ready when you are 🐝 Book your free assessment here: {{booking_link}} - takes 2 min!$tpl$),

-- t8 — Call Prompt Script
('t8', 'Call Prompt Script', 'call', 'call',
 NULL,
 $tpl$Hi, may I speak with {{first_name}}?

[If available]: Hi {{first_name}}, this is {{organizer_name}} calling from Bee Organized {{location_name}}. You recently reached out about getting organized - I just wanted to introduce myself and see if you had any questions!

[Goal]: Schedule an in-person or virtual assessment.

[If voicemail]: Hi {{first_name}}, this is {{organizer_name}} from Bee Organized {{location_name}}. I'm just following up on your inquiry - would love to chat! Give me a call back at {{phone}} or book a time at {{booking_link}}. Talk soon!$tpl$),

-- t9 — Personal Follow-up Email
('t9', 'Personal Follow-up Email', 'email', 'nurture',
 '{{first_name}}, I wanted to personally reach out',
 $tpl$Hi {{first_name}},

I wanted to send a personal note rather than just another automated email.

I genuinely believe we could create something special in your space. Every home is different and I love working through the puzzle of what system will work best for you.

If you're ready to take the next step - even just to look around - I'd love to come by for a free assessment.

{{booking_link}}

No pressure, no commitment. Just a conversation.

{{organizer_name}}
Bee Organized {{location_name}}
{{phone}}$tpl$),

-- ta1 — Move · Avail + Rates
('ta1', 'Move · Avail + Rates', 'email', 'cta',
 '{{first_name}}, do you have availability this week?',
 $tpl$Hi {{first_name}},

Moving is a lot - we want to make it as smooth as possible.

Do you have any availability this week for us to come by and get your space organized? Even a few hours can make a huge difference on move day.

Our rates are $X/hr for a two-organizer team, with a 3-hour minimum. Most move projects run 4–6 hours.

What does your week look like?

{{organizer_name}}
Bee Organized {{location_name}}
{{phone}}$tpl$),

-- ta2 — Organizing · Avail + Rates
('ta2', 'Organizing · Avail + Rates', 'email', 'cta',
 '{{first_name}}, do you have availability this week?',
 $tpl$Hi {{first_name}},

Do you have any availability this week to get started?

We work in 3-hour minimum sessions at $X/hr for a two-organizer team. Most clients see significant progress in a single session - and many spaces are fully transformed in one day.

What does your schedule look like?

{{organizer_name}}
Bee Organized {{location_name}}
{{phone}}$tpl$),

-- tb1 — Move · Calendar + Rates
('tb1', 'Move · Calendar + Rates', 'email', 'cta',
 'Book a quick call - let’s plan your move, {{first_name}}',
 $tpl$Hi {{first_name}},

Moving is hectic and we want to make sure we set you up for success.

Book a quick 15-minute discovery call so we can understand your space, timeline, and priorities:
{{booking_link}}

Our rates are $X/hr for a two-organizer team (3-hr minimum). Most move projects run 4–6 hours.

We'd love to help make this move your smoothest one yet.

{{organizer_name}}
Bee Organized {{location_name}}$tpl$),

-- tb2 — Organizing · Calendar + Rates
('tb2', 'Organizing · Calendar + Rates', 'email', 'cta',
 'Book a free discovery call, {{first_name}}',
 $tpl$Hi {{first_name}},

I'd love to learn more about your space before we dive in.

Book a free 15-minute discovery call here - no commitment, just a conversation:
{{booking_link}}

For reference, our rates are $X/hr for a two-organizer team (3-hr minimum).

Looking forward to connecting!

{{organizer_name}}
Bee Organized {{location_name}}$tpl$),

-- tc1 — Move · Availability Only
('tc1', 'Move · Availability Only', 'email', 'cta',
 '{{first_name}} - do you have time this week?',
 $tpl$Hi {{first_name}},

With your move coming up, I just wanted to check - do you have any availability this week?

Even a few hours of organization before or after the move can make the whole experience so much less overwhelming.

What's your schedule looking like?

{{organizer_name}}
Bee Organized {{location_name}}$tpl$),

-- tc2 — Organizing · Availability Only
('tc2', 'Organizing · Availability Only', 'email', 'cta',
 '{{first_name}}, do you have time this week?',
 $tpl$Hi {{first_name}},

Just wanted to check in - do you have any availability this week to get started on your space?

Reply here and we'll find a time that works for you.

{{organizer_name}}
Bee Organized {{location_name}}$tpl$),

-- td1 — Move · Avail + Calendar + Phone
('td1', 'Move · Avail + Calendar + Phone', 'email', 'cta',
 '{{first_name}} - a few ways to connect',
 $tpl$Hi {{first_name}},

Moving week is almost here - let's make sure your space is ready.

A few ways to connect with us:

📅 Do you have availability this week? Just reply and we'll make it work.

🔗 Or book a quick call here: {{booking_link}}

📞 Prefer to just call? Reach us at {{phone}}

Whatever works best for you - we're here!

{{organizer_name}}
Bee Organized {{location_name}}$tpl$),

-- td2 — Organizing · Avail + Calendar + Phone
('td2', 'Organizing · Avail + Calendar + Phone', 'email', 'cta',
 '{{first_name}} - let’s find a time',
 $tpl$Hi {{first_name}},

A few easy ways to connect and get your project started:

📅 Do you have availability this week? Reply here and we'll get it on the calendar.

🔗 Or book a discovery call at your convenience: {{booking_link}}

📞 Prefer to talk it through first? Call us at {{phone}}

Looking forward to working with you!

{{organizer_name}}
Bee Organized {{location_name}}$tpl$)

ON CONFLICT (legacy_id) DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 5 — Seed drip_paths for the 4 launch locations
-- ──────────────────────────────────────────────────────────────────────────
-- Two paths per location: general-a (default) and move-a.

WITH locs(location_uuid) AS (
  VALUES
    ('1b62628f-e3be-4024-be2d-e8179f09f740'::uuid),  -- Palm Beach
    ('132b42c2-9566-43cc-85dc-f90fae4ba1b1'::uuid),  -- Scottsdale
    ('dca50888-949f-436d-b24e-b6c8a4984905'::uuid),  -- Kansas City
    ('a8fe17f6-fd16-4ed3-8730-550a65d69ad6'::uuid)   -- Test Location
)
INSERT INTO drip_paths (location_uuid, path_key, name, is_active, is_default)
SELECT location_uuid, 'general-a', 'General Outreach', true, true FROM locs
ON CONFLICT (location_uuid, path_key, name) DO NOTHING;

WITH locs(location_uuid) AS (
  VALUES
    ('1b62628f-e3be-4024-be2d-e8179f09f740'::uuid),
    ('132b42c2-9566-43cc-85dc-f90fae4ba1b1'::uuid),
    ('dca50888-949f-436d-b24e-b6c8a4984905'::uuid),
    ('a8fe17f6-fd16-4ed3-8730-550a65d69ad6'::uuid)
)
INSERT INTO drip_paths (location_uuid, path_key, name, is_active, is_default)
SELECT location_uuid, 'move-a', 'Move Outreach', true, false FROM locs
ON CONFLICT (location_uuid, path_key, name) DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- SECTION 6 — Seed drip_path_steps
-- ──────────────────────────────────────────────────────────────────────────
-- Steps point at master_templates via master_template_id. subject/body left
-- NULL → renderer pulls content from the linked template.

-- General path: 6 steps over ~11 days (t1, t2, ta2, t3, t4, t9)
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, master_template_id)
SELECT dp.id, s.step_order, s.delay_days, 'email', mt.id
FROM drip_paths dp
JOIN (VALUES
  (1,  0,  't1'),
  (2,  2,  't2'),
  (3,  4,  'ta2'),
  (4,  6,  't3'),
  (5,  8,  't4'),
  (6, 11,  't9')
) AS s(step_order, delay_days, legacy) ON true
JOIN master_templates mt ON mt.legacy_id = s.legacy
WHERE dp.path_key = 'general-a'
  AND dp.location_uuid IN (
    '1b62628f-e3be-4024-be2d-e8179f09f740'::uuid,
    '132b42c2-9566-43cc-85dc-f90fae4ba1b1'::uuid,
    'dca50888-949f-436d-b24e-b6c8a4984905'::uuid,
    'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'::uuid
  )
ON CONFLICT (drip_path_id, step_order) DO NOTHING;

-- Move path: 5 steps over ~8 days (t1, ta1, t2, t3, t9)
INSERT INTO drip_path_steps (drip_path_id, step_order, delay_days, channel, master_template_id)
SELECT dp.id, s.step_order, s.delay_days, 'email', mt.id
FROM drip_paths dp
JOIN (VALUES
  (1, 0, 't1'),
  (2, 2, 'ta1'),
  (3, 4, 't2'),
  (4, 6, 't3'),
  (5, 8, 't9')
) AS s(step_order, delay_days, legacy) ON true
JOIN master_templates mt ON mt.legacy_id = s.legacy
WHERE dp.path_key = 'move-a'
  AND dp.location_uuid IN (
    '1b62628f-e3be-4024-be2d-e8179f09f740'::uuid,
    '132b42c2-9566-43cc-85dc-f90fae4ba1b1'::uuid,
    'dca50888-949f-436d-b24e-b6c8a4984905'::uuid,
    'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'::uuid
  )
ON CONFLICT (drip_path_id, step_order) DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- POST-RUN VERIFICATION (read-only)
-- ──────────────────────────────────────────────────────────────────────────
--   -- Expect 17:
--   SELECT count(*) AS master_templates_count FROM master_templates;
--
--   -- Expect 8 (4 locations × 2 paths):
--   SELECT count(*) AS drip_paths_count FROM drip_paths
--     WHERE path_key IN ('general-a','move-a')
--     AND location_uuid IN (
--       '1b62628f-e3be-4024-be2d-e8179f09f740',
--       '132b42c2-9566-43cc-85dc-f90fae4ba1b1',
--       'dca50888-949f-436d-b24e-b6c8a4984905',
--       'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
--     );
--
--   -- Expect 44 (4 locations × (6 general + 5 move)):
--   SELECT count(*) AS drip_path_steps_count FROM drip_path_steps dps
--   JOIN drip_paths dp ON dp.id = dps.drip_path_id
--   WHERE dp.path_key IN ('general-a','move-a');
--
--   -- Spot-check one location's sequence (Palm Beach, general-a):
--   SELECT step_order, delay_days, mt.legacy_id, mt.name
--   FROM drip_path_steps dps
--   JOIN drip_paths dp ON dp.id = dps.drip_path_id
--   JOIN master_templates mt ON mt.id = dps.master_template_id
--   WHERE dp.location_uuid = '1b62628f-e3be-4024-be2d-e8179f09f740'
--     AND dp.path_key = 'general-a'
--   ORDER BY step_order;
