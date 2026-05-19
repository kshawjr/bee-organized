-- migrations/onboarding_pass2.sql
-- Task 4 Pass 2 — Per-step content writes for onboarding
--
-- Adds:
--   1. hub_users: first_name, last_name, phone (profile step writes)
--      - We continue writing full_name = "first last" so existing reads keep
--        working; first/last are added for use in UI personalization
--        ("Welcome, {first_name}") and email templates.
--   2. locations: send-from + reply-to + reviews/calendar/sender fields
--      (location step + paths step writes), plus activated_at (launch step).
--      Several already exist (address, city, state, zip, phone, email,
--      timezone) — only the new ones are added here.
--
-- All adds are `if not exists` — safe to re-run; idempotent.

-- ─── hub_users: profile fields ──────────────────────────────────────────────
alter table hub_users
  add column if not exists first_name text,
  add column if not exists last_name  text,
  add column if not exists phone      text;

-- ─── locations: location-step + paths-step + launch fields ──────────────────
alter table locations
  add column if not exists sender_name      text,
  add column if not exists send_from_email  text,
  add column if not exists reply_to_email   text,
  add column if not exists reviews_link     text,
  add column if not exists calendar_link    text,
  add column if not exists activated_at     timestamptz;
