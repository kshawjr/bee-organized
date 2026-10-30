-- migrations/email_buttons.sql
--
-- AN OPTIONAL BUTTON PER EMAIL (Kevin, 2026-10-30). "Button text" + "Button
-- link"; the link may be a tag such as {{booking_link}}. Both filled → the
-- email shows a button in the location's style (lib/drip-email-layout.ts).
-- Either blank → no button. Inline links in the wording are untouched.
--
-- On drip steps (each location's own copy and the masters) and on templates
-- (the welcome and the job follow-ups resolve through templates).
--
-- Adds empty columns only. NO live email gains a button from this file:
-- proposed buttons for the existing emails are a separate, reviewed change.
--
-- Single statement each, safe to re-run.
alter table public.drip_path_steps
  add column if not exists button_text text,
  add column if not exists button_link text;
alter table public.templates
  add column if not exists button_text text,
  add column if not exists button_link text;
