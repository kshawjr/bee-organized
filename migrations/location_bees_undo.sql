-- migrations/location_bees_undo.sql — undo migrations/location_bees.sql
-- STATUS: WRITTEN, NOT RUN.
-- Drops the bee roster and every bee typed in since. If any exist, export
-- first:  select * from public.location_bees;
-- The Bees screen then shows "Couldn't load your bees" until the table is back.

drop table if exists public.location_bees;
