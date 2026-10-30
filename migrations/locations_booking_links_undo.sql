-- migrations/locations_booking_links_undo.sql
-- Reverses locations_booking_links.sql. Any discovery-call or virtual link an
-- owner typed is lost; an email using those tags would then hold.
alter table public.locations
  drop column if exists discovery_booking_link,
  drop column if exists virtual_booking_link;
