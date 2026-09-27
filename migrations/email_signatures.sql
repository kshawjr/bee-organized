-- migrations/email_signatures.sql
--
-- REVIEW ARTIFACT — NOT EXECUTED. Run in the Supabase SQL editor after Kevin
-- approves. Additive only: six nullable columns and one storage bucket. No
-- data movement, no backfill, nothing existing changes value.
--
-- ── PURPOSE ────────────────────────────────────────────────────────────
-- The {{signature}} merge tag (lib/email-signature.ts) fills ONE fixed Bee
-- Organized signature layout:
--
--   per PERSON   photo, name, title, email, mobile
--                  name   ← hub_users.full_name        (exists)
--                  email  ← hub_users.email            (exists)
--                  mobile ← hub_users.phone            (exists)
--                  title  ← hub_users.signature_title       NEW
--                  photo  ← hub_users.signature_photo_path  NEW
--   per LOCATION website + Facebook / Instagram / LinkedIn
--                  locations.website_url    NEW
--                  locations.facebook_url   NEW
--                  locations.instagram_url  NEW
--                  locations.linkedin_url   NEW
--
-- Before this runs, locations had NO website or social-link columns at all
-- (Online Presence held only calendar_link and reviews_link), and hub_users
-- had no title or photo.
--
-- ── WHY NULL IS SAFE ───────────────────────────────────────────────────
-- NULL means "leave that line out of the signature". The application code
-- SHIPS BEFORE THIS RUNS and is written for the columns to be absent: every
-- read is its own defensive query that swallows "column does not exist" and
-- returns null (the hub_users_booking_link.sql pattern). Pre-migration a
-- {{signature}} renders name, email and mobile only; the Settings rows for
-- the new fields say plainly that storage isn't enabled yet. And nothing
-- renders a signature at all until an owner types {{signature}} into a
-- template — no master template carries the tag.
--
-- ── THE PHOTO BUCKET ───────────────────────────────────────────────────
-- email-signatures is PUBLIC: a mail client fetches the photo with no login,
-- and a signed URL would expire and break every email already sent. Public
-- here means "readable by exact link"; the link is two random UUIDs
-- (<user id>/<random>.jpg), never a name. Photos are served to clients from
-- beehive.beeorganized.com/email-signature-photos/... (next.config.mjs
-- rewrite), not the Supabase address.
--
-- No storage.objects policy grants anyone INSERT/UPDATE/DELETE. The only way
-- in is the one-shot signed upload token minted by
-- POST /api/signature/photo, which fixes the path under the caller's own id
-- (the help-media pattern). The bucket's own limits re-check every file:
-- 1 MB and JPEG/PNG only. The browser shrinks the photo to 160×160 JPEG
-- before upload (~20–60 KB), so the limit is a backstop, not the plan.
--
-- Replacing a photo uploads a NEW file and re-points the column; the old file
-- is left in place on purpose, because emails already in inboxes point at it.
--
-- ── READ-ONLY DRY ANALYSIS (run 2026-09-26, production) ────────────────
--   hub_users active owner/manager/staff ....... 51
--   locations active ............................ 39
--   locations.website_url / *_url columns ....... do not exist
--   hub_users.signature_title / _photo_path ..... do not exist
--   storage buckets today ....................... feedback-attachments (private),
--                                                 help-media (public)
--   templates / drip steps containing {{signature}} ... 0

alter table public.hub_users
  add column if not exists signature_title text,
  add column if not exists signature_photo_path text;

alter table public.locations
  add column if not exists website_url text,
  add column if not exists facebook_url text,
  add column if not exists instagram_url text,
  add column if not exists linkedin_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('email-signatures', 'email-signatures', true, 1048576, array['image/jpeg','image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── VERIFY ─────────────────────────────────────────────────────────────
-- select column_name from information_schema.columns
--  where table_schema='public'
--    and ((table_name='hub_users' and column_name like 'signature_%')
--      or (table_name='locations' and column_name in ('website_url','facebook_url','instagram_url','linkedin_url')));
--   → 6 rows
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id='email-signatures';
--   → 1 row, public = true
