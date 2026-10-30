-- migrations/locations_email_style.sql
--
-- The look a location's client emails go out in (Settings → Emails → Look).
-- Five styles, defined in lib/drip-email-layout.ts (EMAIL_STYLES).
--
-- NULL means Soft. Kevin's ruling 2026-10-30: every location is on Soft from
-- the day this ships, so no backfill is needed — NULL and 'soft' render the
-- same email. Only an owner picking another style writes this column.
--
-- The app reads this column tolerantly: until this runs every email renders
-- Soft and the picker refuses to save ("not set up yet").
--
-- Single statement, safe to re-run.
alter table public.locations
  add column if not exists email_style text
    check (email_style is null or email_style in ('soft','outline','bold','rounded','classic'));
