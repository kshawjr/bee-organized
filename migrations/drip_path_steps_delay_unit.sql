-- migrations/drip_path_steps_delay_unit.sql
--
-- TIMING IN DAYS, MONTHS OR YEARS. delay_days stays the ONLY thing the sender
-- reads (lib/drip-send.ts advanceOrComplete) — a month is stored as 30 days,
-- a year as 365 (lib/email-timing.ts). This column only remembers which unit
-- the owner chose, so "3 months later" reads back as "3 months later" and
-- not "Day 90", and a real "Day 30" never turns into "A month later".
--
-- NULL = days, which is every row today. No backfill.
--
-- Single statement, safe to re-run.
alter table public.drip_path_steps
  add column if not exists delay_unit text
    check (delay_unit is null or delay_unit in ('days','months','years'));
