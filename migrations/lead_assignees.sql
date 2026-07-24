-- ═══════════════════════════════════════════════════════════════════════════
-- Lead-level Assigned To — plural, mirroring engagement_assignees.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Idempotent: CREATE TABLE
-- / CREATE INDEX IF NOT EXISTS, safe to re-run. The whole block rolls back if
-- any statement errors.
--
-- WHY A SECOND JUNCTION. engagement_assignees already models plural assignment
-- — but it hangs off an ENGAGEMENT, and a freshly-captured lead has none. Work
-- is founded later (request / quote / job / manual), so at intake time there is
-- no row to attach an assignee to. Verified in prod 2026-07-23: recent
-- source=web_form / *_assessment leads have zero engagement rows, and only 7 of
-- 6,154 engagements carry any junction row at all.
--
-- So assignment is decided at the LEAD (the moment the lead lands, from the
-- location's project-type notification config) and CARRIED FORWARD onto the
-- engagement when work is founded — lib/engagements.ts seeds
-- engagement_assignees from this table in foundEngagement /
-- foundManualEngagement. The two junctions are the same decision at two
-- lifetimes, not two competing sources of truth.
--
-- RELATIONSHIP TO leads.assigned_to. The legacy singular column is NOT dropped
-- and NOT backfilled from here. It still carries ~7,129 import blanket-stamps
-- (every lead at a location stamped with that location's owner at import time
-- — see ClickUp 868kdy5fm), which is why it is not a trustworthy signal. Going
-- forward the app WRITES it with the first resolved assignee so nothing that
-- still reads it regresses, but the plural truth lives here and no new reader
-- is pointed at the column.
--
-- FORWARD-ONLY at the table level: this starts EMPTY. Existing rows are the
-- backfill's job (scripts/backfill-lead-assignments.mjs), and that script
-- deliberately touches ONLY leads with assigned_to IS NULL — the 106 that came
-- through the intake door with a blank assignment. The 7,129 blanket-stamped
-- rows are left exactly as they are.
--
-- location_id TYPE — this table has NO location column at all, by design. It is
-- scoped through leads.location_uuid the same way lead_contacts / lead_tags are
-- scoped through their parent (see CHILD_LOCATION_SCOPE in lib/hub-scope.ts,
-- where lead_assignees is registered as an explicit `null`). RLS below reaches
-- location by joining leads, and uses the SAME ::text cast the engagements
-- policies use — hub_users.location_id is TEXT holding the location UUID string
-- (prod-verified 2026-07-03), so the uuid side must be cast. NEVER omit it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Junction table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lead_assignees (
  lead_id     uuid NOT NULL REFERENCES public.leads(id)     ON DELETE CASCADE,
  hub_user_id uuid NOT NULL REFERENCES public.hub_users(id) ON DELETE CASCADE,
  -- How this assignment was decided. Diagnostic only — nothing branches on it —
  -- but it is what lets us tell "the owner was chosen because nobody claimed
  -- this project type" apart from "the owner was chosen because the location
  -- does not split by project type", months from now, without re-deriving it.
  --   'project_type'  — a recipient specifically claims the lead's project type
  --   'location_owner'— fallback: split off, or split on with nobody claiming
  --   'manual'        — a human picked this person in the app
  assigned_via text NOT NULL DEFAULT 'manual'
                   CHECK (assigned_via IN ('project_type', 'location_owner', 'manual')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, hub_user_id)
);

-- Reverse lookup ("what is this user assigned to"). The PK already covers
-- lead_id → assignees.
CREATE INDEX IF NOT EXISTS idx_lead_assignees_hub_user
  ON public.lead_assignees(hub_user_id);

-- ── 2. RLS ──────────────────────────────────────────────────────────────────
-- Mirrors engagement_assignees (migrations/engagement_assignees.sql §2):
-- super_admin/admin see all; other hub users see their own location. This
-- junction has no location column, so we join through leads to reach
-- location_uuid.
--
-- CRITICAL cast: hub_users.location_id is TEXT storing the location UUID, so
-- the uuid side must be cast — hub_users.location_id = l.location_uuid::text.
--
-- As with engagement_assignees, the app reaches this table via the service role
-- (bypasses RLS); these policies gate future client-side reads and enforce
-- deny-by-default for anon. NOTE the standing gotcha: leads RLS silently
-- returns 0 rows to an anon browser read — never make a direct client-side read
-- of this table load-bearing.

ALTER TABLE public.lead_assignees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_assignees read" ON public.lead_assignees;
CREATE POLICY "lead_assignees read"
  ON public.lead_assignees FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.hub_users
      JOIN public.leads l ON l.id = lead_assignees.lead_id
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = l.location_uuid::text
        )
    )
  );

DROP POLICY IF EXISTS "lead_assignees write" ON public.lead_assignees;
CREATE POLICY "lead_assignees write"
  ON public.lead_assignees FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.hub_users
      JOIN public.leads l ON l.id = lead_assignees.lead_id
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = l.location_uuid::text
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.hub_users
      JOIN public.leads l ON l.id = lead_assignees.lead_id
      WHERE hub_users.id = auth.uid()
        AND (
          hub_users.role IN ('super_admin', 'admin')
          OR hub_users.location_id = l.location_uuid::text
        )
    )
  );

-- ── Pre-flight re-verification (run before applying) ────────────────────────
-- The ::text cast depends on hub_users.location_id being text. Prod-verified
-- 2026-07-03, but partners.sql assumes the opposite type — re-confirm:
--
--   SELECT data_type FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='hub_users'
--     AND column_name='location_id';           -- expect: text
--
-- ── Post-apply verification (run after) ─────────────────────────────────────
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='lead_assignees';
--
--   SELECT policyname, cmd FROM pg_policies
--   WHERE tablename = 'lead_assignees' ORDER BY policyname;   -- expect 2
--
--   SELECT count(*) FROM public.lead_assignees;               -- expect 0
--
-- THEN, and only then, run the backfill dry-run:
--   node scripts/backfill-lead-assignments.mjs
-- and re-run with --execute once the numbers are approved.
