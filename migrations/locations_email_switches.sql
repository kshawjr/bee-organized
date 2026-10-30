-- migrations/locations_email_switches.sql
--
-- Two owner switches in Settings → Emails → Your details:
--
--   shows_hourly_rate  false = "I don't show rates". The first email still
--                      goes out, with the price sentence taken out
--                      (lib/rate-guard.ts stripRateSentences). Any other email
--                      that quotes the rate is SKIPPED (not held).
--   uses_booking_links false = "I don't use booking links". The three link
--                      fields are hidden; every email after the first that
--                      asks the client to click a booking link is SKIPPED.
--
-- Defaults true = today's behaviour exactly: a blank rate or link still HOLDS
-- the emails that need it. The app reads both tolerantly.
--
-- Single statement, safe to re-run.
alter table public.locations
  add column if not exists shows_hourly_rate boolean not null default true,
  add column if not exists uses_booking_links boolean not null default true;
