-- migrations/engagement_bees_undo.sql — undoes migrations/engagement_bees.sql.
-- Drops every bee-on-job assignment made since it ran. Export first if any:
--   select * from public.engagement_bees;
drop table if exists public.engagement_bees;
