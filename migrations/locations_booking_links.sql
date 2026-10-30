-- migrations/locations_booking_links.sql
--
-- THREE BOOKING LINKS, NOT ONE.
--   calendar_link            (exists)  the IN-HOME ASSESSMENT link. Unchanged:
--                                      {{booking_link}} and
--                                      {{book_assessment_link}} keep reading it,
--                                      so every live email sends exactly as today.
--   discovery_booking_link   (new)     {{discovery_booking_link}}
--   virtual_booking_link     (new)     {{virtual_booking_link}}
--
-- No backfill: nobody's existing link is guessed into a new slot. Both start
-- blank; only an email that uses the new tag waits on them.
--
-- Single statement, safe to re-run.
alter table public.locations
  add column if not exists discovery_booking_link text,
  add column if not exists virtual_booking_link text;
