-- migrations/email_buttons_undo.sql
-- Reverses email_buttons.sql. Every button disappears from every email.
alter table public.drip_path_steps
  drop column if exists button_text,
  drop column if exists button_link;
alter table public.templates
  drop column if exists button_text,
  drop column if exists button_link;
