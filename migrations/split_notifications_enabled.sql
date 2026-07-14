-- ═══════════════════════════════════════════════════════════════════════════
-- Unified "New lead emails" — PART 1 (notifications) project-type routing.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Idempotent: ADD COLUMN /
-- DROP CONSTRAINT IF EXISTS, safe to re-run.
--
-- Two changes, both tiny:
--
--   1. locations.split_notifications_enabled — the PART 1 Advanced toggle
--      ("Notify different people by project type"). Mirrors the existing
--      locations.split_senders_enabled (PART 2). Independent boolean: a
--      location can split notifications without splitting senders, or vice
--      versa. Default false → basic behavior (every subscribed recipient is
--      notified for every lead), so the feature is SAFE TO SHIP BEFORE this
--      migration runs: the app reads a missing column as false.
--
--   2. Widen lead_notification_prefs.category and
--      lead_notification_externals.category from the old single-value CHECK
--      ('all'|'moving'|'organizing') to free text, so the field can hold a
--      project-type SET (a JSON array of lookups labels) or 'all'. The app now
--      writes/reads this field via lib/notification-project-types.ts; legacy
--      'all'/'moving'/'organizing' values still resolve. We DROP the CHECK
--      rather than replace it — the valid set is the admin-managed global
--      lookups list, not a fixed enum, so it's validated in the API layer, not
--      the DB. DROP ... IF EXISTS is a no-op if the CHECK was never applied.
--
-- No RLS / no new table. The recipients tables and their policies are unchanged
-- (see migrations/lead_notification_recipients.sql).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. PART 1 split toggle on the location ──────────────────────────────────
alter table public.locations
  add column if not exists split_notifications_enabled boolean not null default false;

comment on column public.locations.split_notifications_enabled is
  'When true, new-lead NOTIFICATIONS route by the lead project_type via each recipient''s project-type set in lead_notification_prefs/externals.category (unassigned types → whole team; never-drop to whole team). When false (default), every subscribed recipient is notified for every lead. Independent of split_senders_enabled.';

-- ── 2. Widen the category field to a free-text project-type set ─────────────
-- Inline column CHECKs are auto-named <table>_<column>_check by Postgres.
alter table public.lead_notification_prefs
  drop constraint if exists lead_notification_prefs_category_check;

alter table public.lead_notification_externals
  drop constraint if exists lead_notification_externals_category_check;

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='locations' AND column_name='split_notifications_enabled';
-- SELECT conname FROM pg_constraint
--   WHERE conname IN ('lead_notification_prefs_category_check',
--                     'lead_notification_externals_category_check'); -- expect 0 rows
