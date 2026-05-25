-- migrations/leads_import_pause.sql
--
-- Adds an origin marker to leads so the drip lifecycle can suppress the
-- day-0 New Lead emails for records that didn't come from a manual
-- create. Imported records (Jobber initial bulk, Jobber webhooks, and
-- any future CSV import) land with import_source != 'manual' AND
-- paused = true; the existing applyDripSideEffects 'paused' branch +
-- the startDripForLead guard added in lib/drip-lifecycle.ts keep them
-- from auto-blasting historical clients with "thanks for reaching out".
--
-- `paused` already exists from hive_clients_phase4_columns.sql; only
-- the column add for import_source is new here. Both the ALTER and the
-- index are IF NOT EXISTS so this migration is safe to re-run.
--
-- Run in the Supabase SQL editor.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS import_source text NOT NULL DEFAULT 'manual';

-- Filtered index — only imported rows need a fast lookup path. Manual
-- creates are the steady-state majority and don't benefit from indexing.
CREATE INDEX IF NOT EXISTS idx_leads_import_source
  ON leads (import_source)
  WHERE import_source <> 'manual';
