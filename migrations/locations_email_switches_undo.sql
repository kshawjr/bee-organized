-- migrations/locations_email_switches_undo.sql
-- Reverses locations_email_switches.sql. CAUTION: a location that switched
-- either off goes back to HOLDING those emails until a rate or link is set.
alter table public.locations
  drop column if exists shows_hourly_rate,
  drop column if exists uses_booking_links;
