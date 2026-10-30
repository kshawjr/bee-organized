-- migrations/drip_path_steps_paused_undo.sql
-- Reverses drip_path_steps_paused.sql. CAUTION: every paused email starts
-- sending again on the next hourly run.
alter table public.drip_path_steps drop column if exists is_paused;
