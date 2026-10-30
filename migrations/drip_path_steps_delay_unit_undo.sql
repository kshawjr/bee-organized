-- migrations/drip_path_steps_delay_unit_undo.sql
-- Reverses drip_path_steps_delay_unit.sql. Send dates do not change (they come
-- from delay_days); timings chosen in months or years display as days again.
alter table public.drip_path_steps drop column if exists delay_unit;
