-- migrations/hive_clients_phase4_columns.sql
--
-- Phase 4 additions to public.leads: per-record snooze, marketing opt-out,
-- request details (what the client is looking for), and a drip-paused flag.
-- Run in the Supabase SQL editor.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS snoozed_until      timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_note       text,
  ADD COLUMN IF NOT EXISTS marketing_opt_out  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS request_details    text,
  ADD COLUMN IF NOT EXISTS paused             boolean NOT NULL DEFAULT false;

-- snoozed_until is queried for "who wakes up today" — index only the populated rows.
CREATE INDEX IF NOT EXISTS idx_leads_snoozed_until
  ON leads (snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- paused is filtered when scheduling drip sends — index only true.
CREATE INDEX IF NOT EXISTS idx_leads_paused
  ON leads (paused)
  WHERE paused = true;
