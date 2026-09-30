-- migrations/locations_drip_followups_off.sql
--
-- An owner can switch off every drip email AFTER the first one, per location
-- (lib/drip-followups.ts). Step 1 and the welcome email are not affected by
-- this column in any way — nothing that sends them reads it.
--
-- Default false = today's behaviour for all locations. The app reads this
-- column tolerantly, so code can ship before this runs; until it runs the
-- switch in Settings → Emails refuses to save ("not set up yet").
--
-- Single statement, safe to re-run.
alter table public.locations
  add column if not exists drip_followups_off boolean not null default false;
