-- migrations/signature_linkedin.sql
--
-- A PERSON'S OWN LINKEDIN, AS A FALLBACK (Kevin, 2026-10-31): "1 linkedin
-- makes sense for all signatures … if not people can do individuals". The
-- location's linkedin_url is in everyone's signature at that location; this
-- is used only where the location has none (lib/email-signature-resolve.ts).
--
-- Beside signature_title and signature_photo_path. Adds an empty column only:
-- nothing is copied or guessed into it, and no signature changes when it runs.
-- Before it runs the field is hidden and the resolver reads it as null.
--
-- Single statement, safe to re-run.
alter table public.hub_users
  add column if not exists signature_linkedin_url text;
