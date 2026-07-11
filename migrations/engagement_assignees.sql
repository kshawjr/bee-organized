-- Engagement-level Assigned To — plural, multi-user foundation.
-- Idempotent; run manually in the Supabase editor (standing migration-
-- review rule). APPLIED to prod 2026-07-11 — verified via pg_policies
-- (2 policies) + a live select (table present, 0 rows). An earlier paste
-- did not land; the whole block rolls back if any statement errors.
--
-- Assignment used to live on leads.assigned_to (single value). It now lives
-- on the engagement as a many-to-many junction: an engagement can carry
-- several assignees, and a hub_user can be assigned to many engagements.
--
-- FORWARD-ONLY — the junction starts EMPTY. No backfill: the legacy
-- leads.assigned_to is an import blanket-stamp (one value per location =
-- that location's OWNER hub_user, applied to every lead), not real
-- per-lead assignment — flagged for separate cleanup. Existing
-- engagements correctly have no assignee; future ones get real assignees
-- through the masthead picker. leads.assigned_to is legacy-unused (left
-- in place, not dropped here).

-- ── 1. Junction table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.engagement_assignees (
  engagement_id uuid NOT NULL REFERENCES public.engagements(id) ON DELETE CASCADE,
  hub_user_id   uuid NOT NULL REFERENCES public.hub_users(id)   ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, hub_user_id)
);

-- Reverse-lookup index ("what is this user assigned to"). The PK already
-- covers engagement_id → assignees.
CREATE INDEX IF NOT EXISTS idx_engagement_assignees_hub_user
  ON public.engagement_assignees(hub_user_id);

-- ── 2. RLS ──────────────────────────────────────────────────────────────────
-- Mirrors the engagements policy (hive_phase1_engagements.sql §4): super_admin
-- /admin see all; other hub users see their own location. The junction has no
-- location column of its own, so we join through engagements to reach
-- location_uuid.
--
-- CRITICAL cast (same gotcha as engagements): hub_users.location_id is TEXT
-- storing the location UUID (verified in prod 2026-07-03), so the uuid side
-- must be cast — hub_users.location_id = e.location_uuid::text. NEVER omit it.
--
-- As with engagements, the app accesses this table via the service role
-- (bypasses RLS); these policies gate future client-side reads and enforce
-- deny-by-default for anon once RLS is enabled.

ALTER TABLE public.engagement_assignees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "engagement_assignees read" ON public.engagement_assignees;
CREATE POLICY "engagement_assignees read"
  ON public.engagement_assignees FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.hub_users
      JOIN public.engagements e ON e.id = engagement_assignees.engagement_id
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = e.location_uuid::text
        )
    )
  );

DROP POLICY IF EXISTS "engagement_assignees write" ON public.engagement_assignees;
CREATE POLICY "engagement_assignees write"
  ON public.engagement_assignees FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.hub_users
      JOIN public.engagements e ON e.id = engagement_assignees.engagement_id
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = e.location_uuid::text
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.hub_users
      JOIN public.engagements e ON e.id = engagement_assignees.engagement_id
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = e.location_uuid::text
        )
    )
  );

-- ── Pre-flight re-verification (run before applying) ────────────────────────
-- The ::text cast above depends on hub_users.location_id being text. This was
-- prod-verified 2026-07-03 (see hive_phase1_engagements.sql), but partners.sql
-- assumes the opposite type — re-confirm before trusting the cast:
--
--   SELECT data_type FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='hub_users'
--     AND column_name='location_id';           -- expect: text
--
-- Post-apply verification:
--
--   SELECT policyname, cmd, qual FROM pg_policies
--   WHERE tablename = 'engagement_assignees' ORDER BY policyname;
