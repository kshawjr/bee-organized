-- ═══════════════════════════════════════════════════════════════════════════
-- Lead Notification Recipients — who gets emailed when a new client comes in.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Idempotent: safe to
-- re-run; the whole block rolls back if any statement errors.
--
-- Two tables, both keyed by location_id:
--
--   lead_notification_prefs — per-INTERFACE-USER override. Interface users
--     (hub_users at the location: owner, managers) are AUTO-INCLUDED as
--     recipients with NO row needed — absence of a row == default
--     (subscribed = true, category = 'all'). A row is written ONLY when the
--     owner changes a user's category or unsubscribes them (e.g. cutting a
--     terminated manager off from lead emails). PK (location_id, hub_user_id)
--     so each user has at most one override per location.
--
--   lead_notification_externals — non-user recipients added by hand
--     (first/last name, required email, optional phone, category). Stored
--     directly; own uuid PK.
--
-- Category: 'all' (DEFAULT) | 'moving' | 'organizing'.
--
-- location_id TYPE — CRITICAL. hub_users.location_id is TEXT storing the
-- location UUID string (verified in prod 2026-07-03; see
-- migrations/engagement_assignees.sql). Both tables here store location_id as
-- TEXT to match, so the RLS role/location check compares
-- hub_users.location_id = <table>.location_id as TEXT = TEXT — NO ::text cast
-- needed (the cast is only required when the other side is a uuid column).
--
-- PERMISSION MODEL — owner + corporate ONLY, manager DENIED. Mirrors the
-- pending_invites / drip-path owner gates: elevated (super_admin/admin) may
-- touch any location; a franchise OWNER may touch only their own location; a
-- MANAGER (operational lead — they RECEIVE lead emails but must not manage the
-- list) and lite_user are denied on read AND write. RLS below enforces this at
-- the DB layer; the API routes enforce it again server-side (service role
-- bypasses RLS, so the route is the primary gate — RLS is defense-in-depth for
-- any direct authenticated access).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Interface-user preferences (override rows) ───────────────────────────

CREATE TABLE IF NOT EXISTS public.lead_notification_prefs (
  location_id text        NOT NULL,
  hub_user_id uuid        NOT NULL REFERENCES public.hub_users(id) ON DELETE CASCADE,
  category    text        NOT NULL DEFAULT 'all'
                          CHECK (category IN ('all', 'moving', 'organizing')),
  subscribed  boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, hub_user_id)
);

CREATE INDEX IF NOT EXISTS lead_notification_prefs_location_idx
  ON public.lead_notification_prefs (location_id);

-- ── 2. External (non-user) recipients ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lead_notification_externals (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text        NOT NULL,
  first_name  text,
  last_name   text,
  email       text        NOT NULL,
  phone       text,
  category    text        NOT NULL DEFAULT 'all'
                          CHECK (category IN ('all', 'moving', 'organizing')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_notification_externals_location_idx
  ON public.lead_notification_externals (location_id);

-- ── 3. RLS — owner + elevated only, manager/lite denied, location-scoped ────

ALTER TABLE public.lead_notification_prefs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_notification_externals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_notification_prefs rw" ON public.lead_notification_prefs;
CREATE POLICY "lead_notification_prefs rw"
  ON public.lead_notification_prefs FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner'
              AND hub_users.location_id = lead_notification_prefs.location_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner'
              AND hub_users.location_id = lead_notification_prefs.location_id)
        )
    )
  );

DROP POLICY IF EXISTS "lead_notification_externals rw" ON public.lead_notification_externals;
CREATE POLICY "lead_notification_externals rw"
  ON public.lead_notification_externals FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner'
              AND hub_users.location_id = lead_notification_externals.location_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR (hub_users.role = 'owner'
              AND hub_users.location_id = lead_notification_externals.location_id)
        )
    )
  );

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('lead_notification_prefs','lead_notification_externals');
-- SELECT policyname, tablename FROM pg_policies
--   WHERE tablename IN ('lead_notification_prefs','lead_notification_externals');
