-- HIVE Phase 1 — assessments join the engagement circuit.
-- Idempotent; NOT YET APPLIED — run manually in the Supabase editor
-- (standing migration-review rule). Mirrors the step-1 child columns.

ALTER TABLE public.assessments
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id);

CREATE INDEX IF NOT EXISTS idx_assessments_engagement
  ON public.assessments(engagement_id);
