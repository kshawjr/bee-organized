-- HIVE Phase 1 — notes architecture: lead_notes gains an optional
-- engagement anchor (same pattern as touchpoints.engagement_id).
-- Client-level notes (buzz) keep engagement_id NULL; engagement notes
-- (kind='job') carry the engagement they belong to.
-- Idempotent — safe to re-run.

ALTER TABLE public.lead_notes
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id);

CREATE INDEX IF NOT EXISTS idx_lead_notes_engagement
  ON public.lead_notes(engagement_id);
