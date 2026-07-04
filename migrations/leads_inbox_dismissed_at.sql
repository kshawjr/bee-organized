-- migrations/leads_inbox_dismissed_at.sql
--
-- Adds a soft "Dismiss" marker to leads so a real lead can be removed
-- from the Inbox worklist without junking. Dismissal is inbox-scoped
-- only: deriveClientStatus does NOT read this column, so the person
-- still shows their truthful derived status (New/Attempting) in the
-- Client Directory, and drips keep running — dismiss means "handled in
-- my inbox," not "stop nurturing."
--
-- Timestamp rather than boolean: self-documents when the dismissal
-- happened, and restore is simply setting it back to NULL. Nullable,
-- no default — existing rows are untouched.
--
-- Safe to re-run (IF NOT EXISTS).
--
-- Run in the Supabase SQL editor.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS inbox_dismissed_at timestamptz;
