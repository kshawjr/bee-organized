-- migrations/locations_email_style_undo.sql
-- Reverses locations_email_style.sql. Every location goes back to Soft (the
-- app treats a missing column as Soft). Any style an owner picked is lost.
alter table public.locations drop column if exists email_style;
