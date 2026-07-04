-- HIVE Phase 1 — project type as an engagement field (it describes THE
-- WORK), label text matching the leads.source/leads.project_type
-- convention; the vocabulary is the admin-managed lookups list
-- (category='project_types'). Pre-founding the type lives on the lead
-- (leads.project_type, already exists) and foundEngagement seeds it
-- forward at request-founding, same pattern as description.
-- No backfill: every leads.project_type is NULL in prod (2026-07-04).
-- Idempotent — safe to re-run.

ALTER TABLE public.engagements
  ADD COLUMN IF NOT EXISTS project_type text;
