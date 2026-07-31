-- migrations/leads_archived_at.sql
--
-- #122 client path — mark a lead inactive when its Jobber client is archived.
--
-- Archiving a client in Jobber emits a bare CLIENT_UPDATE with Client.isArchived
-- = true (the archive state we never fetched before #122). There is no existing
-- "inactive" flag on leads: is_junk means spam (and drives intake dedup), paused
-- is a drip control, marketing_opt_out is compliance. Archive is a distinct,
-- reversible "this real client is inactive" state, so it gets its own column.
--
-- Nullable timestamp, not a boolean: it records WHEN the archive happened and
-- reverses cleanly (un-archive → set back to NULL). archived_at IS NOT NULL is
-- the inactive predicate. No default: absence means active.
--
-- Run in the Supabase SQL editor BEFORE deploying the #122 client-path code.
-- That code both WRITES this column (handleClientUpdate) and FILTERS on it
-- (the shared lead-active predicate excludes `.is('archived_at', null)` across
-- the Inbox / lead surfaces and the active engagement board). A filter against
-- a missing column errors 42703 and would 500 the leads board — so this
-- migration is a hard prerequisite, not an optional backfill.
--
-- Partial index: the exclusion queries only ever ask "which leads are archived"
-- (a small set), so index just the archived rows.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS leads_archived_at_idx
  ON leads (location_id, archived_at)
  WHERE archived_at IS NOT NULL;
