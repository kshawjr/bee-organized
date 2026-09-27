-- migrations/restore_welcome_master_template.sql
--
-- The Welcome Email master template — restored.
--
-- WHY. The Welcome Email was retired on 2026-08-19 (issue 314, 281ebdf) and
-- restored in 1577853, new leads only. By then its master row had gone from
-- production: on 2026-09-27 the only templates row tagged 'welcome' was the
-- inactive SMS "Welcome Text" (legacy_id 't5'). lib/welcome-email.ts reads
-- the EMAIL master by legacy_id 'welcome' with location_uuid IS NULL. With no
-- such row every welcome is held at send time (template_lookup: missing) and
-- the Welcome row does not show in Settings › Emails. Until this runs, the
-- restored Welcome Email sends NOTHING.
--
-- SHAPE. The same columns and conventions as the standalone masters in
-- migrations/seed_master_drip_paths.sql SECTION 3: (legacy_id, name, type,
-- tag, subject, body), location_uuid left NULL (a master), is_active left to
-- its default (true), body dollar-quoted, ON CONFLICT (legacy_id) DO NOTHING.
-- legacy_id is globally unique (master_templates_legacy_id_key); 't5' keeps
-- its own legacy_id, so the SMS row is untouched.
--
-- COPY. Kevin's, 2026-09-27, verbatim. Notes so nobody "fixes" it:
--   · the quiz link pointing at the homepage is deliberate (Kevin confirmed);
--   · {{signature}} renders the signer's signature — the lead's assignee,
--     else the location's primary owner, else "Bee Organized <Location>"
--     (lib/email-signature-resolve.ts);
--   · no unsubscribe line here: lib/welcome-email.ts appends the CAN-SPAM
--     footer to every welcome, and refuses to send if it cannot.
--
-- Idempotent. Run in the Supabase SQL editor. The SELECT at the end should
-- return exactly one row: type email, tag welcome, is_active true,
-- location_uuid NULL.

INSERT INTO templates (legacy_id, name, type, tag, subject, body) VALUES

-- welcome — auto-fires 24h after Email 1 of a NEW lead's drip (never a
-- returning client's — see lib/welcome-email.ts)
('welcome', 'Welcome Email', 'email', 'welcome',
 'Welcome to the Bee Organized Hive!',
 $tpl${{first_name}},

Welcome to the Bee Organized Hive! We're excited to connect with you soon and it would be our HONOR to help you *Simplify Your Hive!*

Check out more info about **Bee Organized** below…

**What's Your Organizing Profile?**
Take our fun Organizing Profile Quiz here (https://beeorganized.com/) to find out who you are in relationship with your stuff!

**How We Came To Bee**
Learn how these best friends got started and built a successful national franchise business here! (https://beeorganized.com/pages/how-we-came-to-bee)

{{signature}}$tpl$)

ON CONFLICT (legacy_id) DO NOTHING;

SELECT id, legacy_id, name, type, tag, is_active, location_uuid, subject
FROM templates
WHERE legacy_id = 'welcome';
