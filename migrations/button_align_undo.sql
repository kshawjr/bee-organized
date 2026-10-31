-- migrations/button_align_undo.sql
-- Reverses button_align.sql. Every button goes back to the centre.
alter table public.drip_path_steps drop column if exists button_align;
alter table public.templates drop column if exists button_align;
