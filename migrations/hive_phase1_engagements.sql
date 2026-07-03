-- ═══════════════════════════════════════════════════════════════════════════
-- HIVE Phase 1 — Step 1: engagements schema (docs/hive-phase1-engagements.md §8)
--
-- Schema only. Zero behavior change — no code reads or writes engagements yet.
-- Idempotent: safe to re-run. NOT YET APPLIED — run manually in the Supabase
-- SQL editor after review (migration-files-need-review rule).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. engagements ──────────────────────────────────────────────────────────
-- One row per work cycle (request → quote → job → invoices). The single
-- authoritative stage CHECK lives here — do not duplicate these values in
-- other constraints or constants (Phase 0 lesson, §2).

CREATE TABLE IF NOT EXISTS public.engagements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- client_id: no ON DELETE action, intentional — engagements block client
  -- deletion (confirmed 2026-07-03).
  client_id       uuid NOT NULL REFERENCES public.leads(id),
  location_uuid   uuid NOT NULL REFERENCES public.locations(id),
  stage           text NOT NULL CHECK (stage IN
                    ('Request','Estimate','Job in Progress',
                     'Final Processing','Closed Won','Closed Lost')),
  founded_by      text NOT NULL CHECK (founded_by IN
                    ('request','quote','job','manual')),
  title           text,
  stage_entered_at   timestamptz NOT NULL DEFAULT now(),
  nurture_started_at timestamptz,
  closed_at       timestamptz,
  closed_reason   text,
  closed_note     text,
  total_invoiced  numeric DEFAULT 0,
  total_paid      numeric DEFAULT 0,
  balance_owing   numeric DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engagements_location_stage
  ON public.engagements(location_uuid, stage);

CREATE INDEX IF NOT EXISTS idx_engagements_client
  ON public.engagements(client_id);

-- Board query: all open engagements for a location. Partial keeps it small
-- once the closed population (the vast majority long-term) accumulates.
CREATE INDEX IF NOT EXISTS idx_engagements_board
  ON public.engagements(location_uuid)
  WHERE stage NOT IN ('Closed Won','Closed Lost');

-- Day-90 auto-close cron: scan only engagements in nurture condition.
CREATE INDEX IF NOT EXISTS idx_engagements_nurture
  ON public.engagements(nurture_started_at)
  WHERE nurture_started_at IS NOT NULL;

-- ── 2. Children gain nullable engagement_id ─────────────────────────────────
-- Nullable = non-destructive; backfill is a separate pass (migration step 2).

ALTER TABLE public.service_requests
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id);
CREATE INDEX IF NOT EXISTS idx_service_requests_engagement
  ON public.service_requests(engagement_id);

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id);
CREATE INDEX IF NOT EXISTS idx_quotes_engagement
  ON public.quotes(engagement_id);

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id);
CREATE INDEX IF NOT EXISTS idx_jobs_engagement
  ON public.jobs(engagement_id);

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id);
CREATE INDEX IF NOT EXISTS idx_invoices_engagement
  ON public.invoices(engagement_id);

ALTER TABLE public.touchpoints
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_engagement
  ON public.touchpoints(engagement_id);

-- ── 3. jobs.quote_id (job→quote link via Job.quote { id }) ──────────────────

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quotes(id);
CREATE INDEX IF NOT EXISTS idx_jobs_quote
  ON public.jobs(quote_id);

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
-- Mirrors the repo's tenant-scoped pattern (partners.sql / subscription_seats.sql):
-- super_admin/admin see all; other hub users see their own location.
--
-- CRITICAL cast: hub_users.location_id is TEXT storing the location UUID
-- (verified in prod 2026-07-03: Portland owner's row holds a UUID string),
-- so the uuid side must be cast —
-- hub_users.location_id = engagements.location_uuid::text.
--
-- Note the app currently accesses all pipeline tables via the service role
-- (bypasses RLS), so these policies gate future client-side reads only.
-- Deny-by-default holds for anon either way once RLS is enabled.
--
-- KNOWN-LATENT BUG in the live child-table policies (found in pre-flight
-- 2026-07-03, NOT fixed here): the franchise SELECT policies on
-- service_requests / quotes / jobs / invoices compare hub_users.location_id
-- (UUID strings) against those tables' location_id (slugs like
-- 'loc_portland') — they can never match. Harmless today because the app
-- reads via service role. Fix by comparing location_uuid::text instead —
-- scheduled for Phase 1.5 or migration step 6 cleanup (see Phase 1 doc §11).

ALTER TABLE public.engagements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "engagements read" ON public.engagements;
CREATE POLICY "engagements read"
  ON public.engagements FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = engagements.location_uuid::text
        )
    )
  );

DROP POLICY IF EXISTS "engagements write" ON public.engagements;
CREATE POLICY "engagements write"
  ON public.engagements FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = engagements.location_uuid::text
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.hub_users
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = engagements.location_uuid::text
        )
    )
  );

-- ── Pre-flight verification — DONE 2026-07-03 ───────────────────────────────
-- Results (Kevin, Supabase editor):
--   1. hub_users.location_id is text holding UUID strings → the ::text
--      casts above are correct as written.
--   2. Child-table franchise policies confirmed broken-latent (see
--      KNOWN-LATENT BUG note above).
-- Queries kept for re-verification:
--
--   SELECT tablename, policyname, roles, cmd, qual
--   FROM pg_policies
--   WHERE tablename IN ('service_requests','quotes','jobs','invoices',
--                       'touchpoints','leads','companies')
--   ORDER BY tablename, policyname;
--
--   SELECT data_type FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='hub_users'
--     AND column_name='location_id';
--   SELECT DISTINCT location_id FROM public.hub_users LIMIT 5;
