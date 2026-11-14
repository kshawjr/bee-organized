-- migrations/email_body_format.sql
--
-- THE SHAPE OF AN EMAIL BODY (2026-11-13, groundwork for the rich-text email
-- editor). Says whether drip_path_steps.body / templates.body holds plain
-- text ('plain', what every body is today) or the editor's small set of HTML
-- tags ('html'). The send reads it to decide whether a body is text to escape
-- or tags to keep (lib/email-body-html.ts, lib/drip-email-layout.ts).
--
-- NO EMAIL CHANGES WHEN THIS RUNS. Every existing row becomes 'plain', which
-- is how every row is read before the column exists. No body is touched.
--
-- The app works before this runs: a missing column reads as 'plain', a plain
-- save goes without the mark, and an html save is refused with "not set up
-- yet" (lib/email-body-save.ts). Nothing can save html until the editor
-- ships, and the editor must not ship before this has run.
--
-- Adds one column to each table. Single statement each, safe to re-run.
alter table public.drip_path_steps
  add column if not exists body_format text not null default 'plain'
  check (body_format in ('plain','html'));
alter table public.templates
  add column if not exists body_format text not null default 'plain'
  check (body_format in ('plain','html'));
